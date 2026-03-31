/**
 * Transcript FTS5 Index
 *
 * Full-text search over conversation transcripts using SQLite FTS5.
 * The DB (agent-data/transcript-index.db) is a derived artifact —
 * delete it and restart to rebuild from the JSONL source of truth.
 *
 * Exports:
 * - initTranscriptIndex() — create DB, backfill from JSONL (call once at startup)
 * - indexTranscriptEntry()  — insert a single entry (call from appendToTranscript)
 * - searchTranscripts()     — FTS5 MATCH search with optional channel filter
 */

import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { AGENT_DATA_DIR, TRANSCRIPTS_DIR } from "./paths";
import { log, error as logError } from "./log";
import { BOT_NAME_LOWER } from "./config/identity";

// Inline type to avoid circular dep with persistence.ts (which calls indexTranscriptEntry)
type TranscriptEntry = {
  type: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
};

const FTS_STOP_WORDS = new Set([
  // Articles & determiners
  "a", "an", "the", "this", "that", "these", "those",
  // Pronouns
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it", "they", "them",
  // Common verbs
  "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "can", "may", "might",
  // Prepositions
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "about",
  "into", "through", "during", "before", "after", "above", "below", "between", "under", "over",
  // Conjunctions & question words
  "and", "or", "but", "if", "then", "because", "as", "while",
  "when", "where", "what", "which", "who", "how", "why",
  // Vague references
  "thing", "things", "stuff", "something", "anything", "everything", "nothing",
  // Misc
  "just", "now", "so", "not", "no", "up", "out",
  // Discord filler & slang
  "lol", "lmao", "lmfao", "rofl", "bruh", "bro", "dude", "like", "literally",
  "tbh", "imo", "ngl", "idk", "smh", "omg", "wtf", "wth", "fr",
  // Greetings & acknowledgments
  "hey", "hi", "hello", "yo", "sup",
  "ok", "okay", "sure", "right", "yep", "yea", "yeah", "nah", "cool", "nice",
]);

// ============================================================================
// Module State
// ============================================================================

let db: Database | null = null;

const DB_PATH = path.join(AGENT_DATA_DIR, "transcript-index.db");

// Per-turn context for security enforcement (set by turn-executor before each turn)
// Global fallback (used by fork mode)
let turnChannelId: string | null = null;
let turnIsCreator = true;
let turnIsGroupDm = false;

// Session-keyed search context for streaming sessions
// Isolates search context per session to prevent race conditions
interface SearchContext {
  channelId: string | null;
  isCreator: boolean;
  isGroupDm: boolean;
}
const sessionSearchContexts = new Map<string, SearchContext>();

// Known DM channel ID — set at runtime when a creator DM is first seen.
// Used as a fallback when channelAliases["dm"] is not configured.
let knownDmChannelId: string | null = null;

/** Store the DM channel ID for use in search filtering. */
export function setDmChannelId(channelId: string): void {
  knownDmChannelId = channelId;
}

/** Get the known DM channel ID (set from creator DM interactions). */
export function getDmChannelId(): string | null {
  return knownDmChannelId;
}

/** Set the current turn's context for search access control. */
export function setSearchContext(channelId: string, isCreator: boolean, isGroupDm = false): void {
  turnChannelId = channelId;
  turnIsCreator = isCreator;
  turnIsGroupDm = isGroupDm;
}

/** Set search context for a specific streaming session (concurrent-safe). */
export function setSearchContextForSession(sessionId: string, channelId: string, isCreator: boolean, isGroupDm = false): void {
  sessionSearchContexts.set(sessionId, { channelId, isCreator, isGroupDm });
}

/** Get search context for a specific streaming session. */
export function getSearchContextForSession(sessionId: string): SearchContext | undefined {
  return sessionSearchContexts.get(sessionId);
}

/** Get the current turn's search context (used by MCP tool handler). */
export function getSearchContext(): { channelId: string | null; isCreator: boolean; isGroupDm: boolean } {
  return { channelId: turnChannelId, isCreator: turnIsCreator, isGroupDm: turnIsGroupDm };
}

// ============================================================================
// Schema & Init
// ============================================================================

function createSchema(database: Database): void {
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
      author,
      content,
      channel_id UNINDEXED,
      timestamp UNINDEXED,
      entry_type UNINDEXED
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Dedup table — same message can appear in multiple session JSONL files
  database.exec(`
    CREATE TABLE IF NOT EXISTS _seen (
      timestamp TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      UNIQUE(timestamp, content_hash)
    );
  `);

  // Concept tagging tables — threads of messages tagged with semantic concepts
  database.exec(`
    CREATE TABLE IF NOT EXISTS concepts (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_concept_name ON concepts(name);`);

  database.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY,
      channel_id TEXT NOT NULL,
      ts_start TEXT NOT NULL,
      ts_end TEXT NOT NULL,
      participants TEXT NOT NULL
    );
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_thread_channel_time ON threads(channel_id, ts_start);`);

  database.exec(`
    CREATE TABLE IF NOT EXISTS thread_concepts (
      thread_id INTEGER NOT NULL REFERENCES threads(id),
      concept_id INTEGER NOT NULL REFERENCES concepts(id),
      PRIMARY KEY (thread_id, concept_id)
    );
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_tc_concept ON thread_concepts(concept_id);`);

  database.exec(`
    CREATE TABLE IF NOT EXISTS thread_messages (
      thread_id INTEGER NOT NULL REFERENCES threads(id),
      timestamp TEXT NOT NULL,
      PRIMARY KEY (thread_id, timestamp)
    );
  `);
}

/** Simple string hash for dedup (not crypto, just collision-resistant enough). */
function contentHash(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

/** Returns true if this entry is new (not seen before). Inserts into _seen table. */
function markSeen(database: Database, timestamp: string, content: string): boolean {
  try {
    database
      .query("INSERT INTO _seen (timestamp, content_hash) VALUES (?, ?)")
      .run(timestamp, contentHash(content));
    return true; // New entry
  } catch {
    return false; // UNIQUE constraint violation — already seen
  }
}

function getLastIndexedTs(database: Database): number {
  const row = database.query("SELECT value FROM _meta WHERE key = 'last_indexed_ts'").get() as
    | { value: string }
    | null;
  return row ? Number(row.value) : 0;
}

function setLastIndexedTs(database: Database, ts: number): void {
  database
    .query("INSERT OR REPLACE INTO _meta (key, value) VALUES ('last_indexed_ts', ?)")
    .run(String(ts));
}

// ============================================================================
// Concept Tagging — storage and query helpers
// ============================================================================

/** Get the timestamp cursor for concept tagging progress. */
export function getConceptCursor(): number {
  if (!db) return 0;
  const row = db.query("SELECT value FROM _meta WHERE key = 'last_concept_tagged_ts'").get() as
    | { value: string }
    | null;
  return row ? Number(row.value) : 0;
}

/** Advance the concept tagging cursor. */
export function setConceptCursor(ts: number): void {
  if (!db) return;
  db.query("INSERT OR REPLACE INTO _meta (key, value) VALUES ('last_concept_tagged_ts', ?)")
    .run(String(ts));
}

/** Get messages from transcript_fts after a timestamp, grouped by channel. */
export function getMessagesAfter(
  sinceTs: number,
  limit: number = 200,
): Array<{ author: string; content: string; channel_id: string; timestamp: string }> {
  if (!db) return [];
  return db.query(`
    SELECT author, content, channel_id, timestamp
    FROM transcript_fts
    WHERE CAST(timestamp AS INTEGER) > ?
    ORDER BY CAST(timestamp AS INTEGER) ASC
    LIMIT ?
  `).all(sinceTs, limit) as Array<{ author: string; content: string; channel_id: string; timestamp: string }>;
}

/** Insert a tagged thread with its concepts and message timestamps. */
export function insertTaggedThread(
  channelId: string,
  tsStart: string,
  tsEnd: string,
  participants: string,
  concepts: string[],
  messageTimestamps: string[],
): void {
  if (!db) return;
  const database = db;

  const transaction = database.transaction(() => {
    // Insert thread
    const result = database.query(
      "INSERT INTO threads (channel_id, ts_start, ts_end, participants) VALUES (?, ?, ?, ?)"
    ).run(channelId, tsStart, tsEnd, participants);
    const threadId = Number(result.lastInsertRowid);

    // Insert concepts (dedup via INSERT OR IGNORE)
    const insertConcept = database.query(
      "INSERT OR IGNORE INTO concepts (name) VALUES (?)"
    );
    const getConcept = database.query(
      "SELECT id FROM concepts WHERE name = ?"
    );
    const insertThreadConcept = database.query(
      "INSERT OR IGNORE INTO thread_concepts (thread_id, concept_id) VALUES (?, ?)"
    );

    for (const concept of concepts) {
      const normalized = concept.toLowerCase().trim().replace(/\s+/g, "-");
      if (!normalized) continue;
      insertConcept.run(normalized);
      const row = getConcept.get(normalized) as { id: number } | null;
      if (row) insertThreadConcept.run(threadId, row.id);
    }

    // Insert message timestamps
    const insertMsg = database.query(
      "INSERT OR IGNORE INTO thread_messages (thread_id, timestamp) VALUES (?, ?)"
    );
    for (const ts of messageTimestamps) {
      insertMsg.run(threadId, ts);
    }
  });

  transaction();
}

export interface ConceptSearchResult {
  threadId: number;
  channelId: string;
  tsStart: number;
  tsEnd: number;
  participants: string;
  concepts: string[];
  messages: TranscriptSearchResult[];
}

/** Search by concept with optional facets (who, when, channel). */
export function searchByConcept(
  conceptTerm: string,
  opts: {
    who?: string;
    whenStart?: string;
    whenEnd?: string;
    channelId?: string;
    limit?: number;
  } = {},
): ConceptSearchResult[] {
  if (!db) return [];

  const limit = opts.limit ?? 10;

  // Expand synonyms
  const terms = [conceptTerm];
  const synonymGroup = CONCEPT_SYNONYMS[conceptTerm.toLowerCase()];
  if (synonymGroup) terms.push(...synonymGroup);
  // Also check if the search term IS a synonym pointing to a canonical name
  for (const [canonical, syns] of Object.entries(CONCEPT_SYNONYMS)) {
    if (syns.includes(conceptTerm.toLowerCase()) && !terms.includes(canonical)) {
      terms.push(canonical);
    }
  }

  // Build LIKE conditions for concept matching
  const conceptConditions = terms.map(() => "c.name LIKE ?").join(" OR ");
  const conceptParams = terms.map((t) => `%${t}%`);

  let sql = `
    SELECT t.id, t.channel_id, t.ts_start, t.ts_end, t.participants,
           GROUP_CONCAT(DISTINCT c.name) as concepts
    FROM threads t
    JOIN thread_concepts tc ON t.id = tc.thread_id
    JOIN concepts c ON tc.concept_id = c.id
    WHERE (${conceptConditions})
  `;
  const params: (string | number)[] = [...conceptParams];

  if (opts.who) {
    sql += " AND t.participants LIKE ?";
    params.push(`%${opts.who}%`);
  }
  if (opts.whenStart) {
    sql += " AND CAST(t.ts_start AS INTEGER) >= ?";
    params.push(opts.whenStart);
  }
  if (opts.whenEnd) {
    sql += " AND CAST(t.ts_end AS INTEGER) <= ?";
    params.push(opts.whenEnd);
  }
  if (opts.channelId) {
    sql += " AND t.channel_id = ?";
    params.push(opts.channelId);
  }

  sql += " GROUP BY t.id ORDER BY CAST(t.ts_end AS INTEGER) DESC LIMIT ?";
  params.push(limit);

  try {
    const threads = db.query(sql).all(...params) as Array<{
      id: number;
      channel_id: string;
      ts_start: string;
      ts_end: string;
      participants: string;
      concepts: string;
    }>;

    return threads.map((t) => {
      // Get messages for this thread
      const msgs = db!.query(`
        SELECT f.author, f.content as snippet, f.channel_id, f.timestamp, f.entry_type
        FROM thread_messages tm
        JOIN transcript_fts f ON tm.timestamp = f.timestamp
        WHERE tm.thread_id = ?
        ORDER BY CAST(f.timestamp AS INTEGER) ASC
      `).all(t.id) as Array<{
        author: string;
        snippet: string;
        channel_id: string;
        timestamp: string;
        entry_type: string;
      }>;

      return {
        threadId: t.id,
        channelId: t.channel_id,
        tsStart: Number(t.ts_start),
        tsEnd: Number(t.ts_end),
        participants: t.participants,
        concepts: t.concepts.split(","),
        messages: msgs.map((m) => ({
          author: m.author,
          snippet: m.snippet,
          channelId: m.channel_id,
          timestamp: Number(m.timestamp),
          entryType: m.entry_type,
        })),
      };
    });
  } catch (err) {
    logError("FTS", "Concept search failed", err);
    return [];
  }
}

/** Get top existing concept names for reuse in tagger prompts. */
export function getExistingConceptNames(limit: number = 50): string[] {
  if (!db) return [];
  const rows = db.query(`
    SELECT c.name, COUNT(tc.thread_id) as cnt
    FROM concepts c
    JOIN thread_concepts tc ON c.id = tc.concept_id
    GROUP BY c.name
    ORDER BY cnt DESC
    LIMIT ?
  `).all(limit) as Array<{ name: string; cnt: number }>;
  return rows.map((r) => r.name);
}

/** Get a per-channel concept index for the memory selector. */
export function getConceptIndex(channelId: string): {
  conceptCounts: Array<{ name: string; count: number }>;
  participantConcepts: Array<{ participant: string; concepts: string }>;
} {
  if (!db) return { conceptCounts: [], participantConcepts: [] };

  const conceptCounts = db.query(`
    SELECT c.name, COUNT(DISTINCT tc.thread_id) as count
    FROM concepts c
    JOIN thread_concepts tc ON c.id = tc.concept_id
    JOIN threads t ON tc.thread_id = t.id
    WHERE t.channel_id = ?
    GROUP BY c.name
    ORDER BY count DESC
    LIMIT 30
  `).all(channelId) as Array<{ name: string; count: number }>;

  const participantConcepts = db.query(`
    SELECT t.participants as participant, GROUP_CONCAT(DISTINCT c.name) as concepts
    FROM threads t
    JOIN thread_concepts tc ON t.id = tc.thread_id
    JOIN concepts c ON tc.concept_id = c.id
    WHERE t.channel_id = ?
    GROUP BY t.participants
    ORDER BY COUNT(DISTINCT tc.thread_id) DESC
    LIMIT 20
  `).all(channelId) as Array<{ participant: string; concepts: string }>;

  return { conceptCounts, participantConcepts };
}

/** Format concept search results for display. */
export function formatConceptResults(results: ConceptSearchResult[]): string {
  if (results.length === 0) return "No concept matches found.";

  const sections = results.map((r) => {
    const startDate = new Date(r.tsStart);
    const endDate = new Date(r.tsEnd);
    const dateStr = startDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const header = `[${dateStr}] Thread: ${r.concepts.join(", ")} — ${r.participants}`;
    const msgs = r.messages.map((m) => {
      const time = new Date(m.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      return `  [${time}] ${m.author}: ${m.snippet.substring(0, 200)}`;
    });
    return `${header}\n${msgs.join("\n")}`;
  });

  return sections.join("\n\n") + `\n\n${results.length} thread${results.length === 1 ? "" : "s"} found`;
}

const CONCEPT_SYNONYMS: Record<string, string[]> = {
  "roast": ["burn", "insult", "trash-talk", "banter"],
  "coding": ["code-help", "programming", "debugging"],
  "argument": ["debate", "disagreement"],
  "recommendation": ["game-recommendation", "suggestion"],
  "help": ["tech-help", "code-help", "assistance"],
};

// ============================================================================
// Content Extraction
// ============================================================================

/**
 * Extract author and cleaned content from a "user" transcript entry.
 * Parses the "=== Current Message ===" section for the actual message.
 */
function extractUserContent(raw: string): { author: string; content: string; channelId: string } | null {
  // Extract channel ID from the Channel Info section
  const channelMatch = raw.match(/Channel ID:\s*(\d+)/);
  const channelId = channelMatch?.[1] ?? "";

  // Find the "Current Message" section
  const currentMsgIdx = raw.indexOf("=== Current Message ===");
  if (currentMsgIdx === -1) return null;

  const section = raw.slice(currentMsgIdx);

  // Extract author — handles both "username@id" (new) and "username (id)" (old) formats
  const authorMatch = section.match(/Author:\s*(\S+?)@(\d+)/) ?? section.match(/Author:\s*([^\n(]+?)(?:\s*\((\d+)\))?[\s\n]/);
  const authorName = authorMatch?.[1]?.trim() ?? "unknown";
  const authorId = authorMatch?.[2] ?? "";
  const author = authorId ? `${authorName}@${authorId}` : authorName;

  // Extract content — everything after "Content: " up to the next field or section
  const contentMatch = section.match(/Content:\s*([\s\S]*?)(?:\nMessage ID:|\n===|$)/);
  const content = contentMatch?.[1]?.trim() ?? "";

  if (!content) return null;

  return { author, content, channelId };
}

// ============================================================================
// Indexing
// ============================================================================

/**
 * Index a single transcript entry into FTS5.
 * Only indexes "user" entries — assistant responses are derivative of user messages
 * and add noise without meaningful search value.
 * Called both during backfill and live from appendToTranscript.
 */
export function indexTranscriptEntry(entry: TranscriptEntry): void {
  if (!db) return;
  if (entry.type !== "user") return;

  try {
    const extracted = extractUserContent(entry.content);
    if (!extracted) return;

    const ts = String(entry.timestamp);
    if (!markSeen(db, ts, extracted.content)) return; // Already indexed

    db.query(
      "INSERT INTO transcript_fts (author, content, channel_id, timestamp, entry_type) VALUES (?, ?, ?, ?, ?)"
    ).run(extracted.author, extracted.content, extracted.channelId, ts, "user");
  } catch (err) {
    logError("FTS", "Failed to index entry", err);
  }
}

/**
 * Index Greg's sanitized sent text into FTS5.
 * Called from bot.ts after a response is successfully sent to Discord,
 * ensuring only the clean, Discord-visible text gets indexed — no
 * internal reasoning, <think> tags, or tool call artifacts.
 */
export function indexBotResponse(text: string, channelId: string): void {
  if (!db) return;
  if (!text.trim()) return;

  try {
    const ts = String(Date.now());
    if (!markSeen(db, ts, text)) return; // Already indexed

    db.query(
      "INSERT INTO transcript_fts (author, content, channel_id, timestamp, entry_type) VALUES (?, ?, ?, ?, ?)"
    ).run(BOT_NAME_LOWER, text, channelId, ts, "assistant");
  } catch (err) {
    logError("FTS", "Failed to index Greg response", err);
  }
}

/**
 * Backfill the index from all JSONL transcript files.
 * Skips entries with timestamp <= last_indexed_ts.
 */
function backfill(database: Database): number {
  const lastTs = getLastIndexedTs(database);
  let indexed = 0;
  let maxTs = lastTs;

  let files: string[];
  try {
    files = fs.readdirSync(TRANSCRIPTS_DIR).filter((f) => f.endsWith(".jsonl"));
  } catch {
    log("FTS", "No transcripts directory found, skipping backfill");
    return 0;
  }

  // Use a transaction for bulk inserts
  const insertFts = database.query(
    "INSERT INTO transcript_fts (author, content, channel_id, timestamp, entry_type) VALUES (?, ?, ?, ?, ?)"
  );

  const transaction = database.transaction(() => {
    for (const file of files) {
      const filePath = path.join(TRANSCRIPTS_DIR, file);
      let fileContent: string;
      try {
        fileContent = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      for (const line of fileContent.split("\n")) {
        if (!line.trim()) continue;

        let entry: TranscriptEntry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue; // Skip malformed lines
        }

        // Skip already-indexed entries
        if (entry.timestamp <= lastTs) continue;

        // Only index user entries — assistant responses add noise without search value
        if (entry.type !== "user") continue;

        const extracted = extractUserContent(entry.content);
        if (!extracted) continue;

        const ts = String(entry.timestamp);
        if (!markSeen(database, ts, extracted.content)) continue; // Dedup

        insertFts.run(extracted.author, extracted.content, extracted.channelId, ts, "user");
        indexed++;
        if (entry.timestamp > maxTs) maxTs = entry.timestamp;
      }
    }
  });

  transaction();

  if (maxTs > lastTs) {
    setLastIndexedTs(database, maxTs);
  }

  return indexed;
}

// ============================================================================
// Search
// ============================================================================

export interface TranscriptSearchResult {
  author: string;
  snippet: string;
  channelId: string;
  timestamp: number;
  entryType: string;
}

export interface SearchOptions {
  limit?: number;
  channelId?: string;
}

/**
 * Search transcripts using FTS5 MATCH.
 * Returns snippets with BM25 ranking.
 */
export function searchTranscripts(
  query: string,
  opts: SearchOptions = {}
): TranscriptSearchResult[] {
  if (!db) return [];

  const limit = opts.limit ?? 5;

  try {
    // Try the raw query first (Greg can write FTS5 syntax directly).
    // Fall back to OR-tokenized query if FTS5 rejects it.
    const tokens = query.split(/\s+/).filter(Boolean);
    const filtered = tokens.filter((t) => !FTS_STOP_WORDS.has(t.toLowerCase()));
    const effective = filtered.length > 0 ? filtered : tokens;
    const fallbackQuery = effective
      .map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");

    let sql: string;
    let params: (string | number)[];

    if (opts.channelId) {
      sql = `
        SELECT
          author,
          snippet(transcript_fts, 1, '»', '«', '...', 40) as snippet,
          channel_id,
          timestamp,
          entry_type
        FROM transcript_fts
        WHERE transcript_fts MATCH ?
          AND channel_id = ?
        ORDER BY bm25(transcript_fts)
        LIMIT ?
      `;
      params = [query, opts.channelId, limit];
    } else {
      sql = `
        SELECT
          author,
          snippet(transcript_fts, 1, '»', '«', '...', 40) as snippet,
          channel_id,
          timestamp,
          entry_type
        FROM transcript_fts
        WHERE transcript_fts MATCH ?
        ORDER BY bm25(transcript_fts)
        LIMIT ?
      `;
      params = [query, limit];
    }

    let rows: Array<{
      author: string;
      snippet: string;
      channel_id: string;
      timestamp: string;
      entry_type: string;
    }>;

    try {
      rows = db.query(sql).all(...params) as typeof rows;
      // FTS5 implicit AND is too restrictive for multi-word queries —
      // if raw query returns nothing and has multiple tokens, retry with OR
      if (rows.length === 0 && effective.length > 1) {
        log("FTS", `Raw query returned 0 results, retrying with OR-tokenized: ${fallbackQuery}`);
        params[0] = fallbackQuery;
        rows = db.query(sql).all(...params) as typeof rows;
      }
    } catch {
      // FTS5 rejected the raw query — fall back to OR-tokenized version
      log("FTS", `Raw query failed, falling back to OR-tokenized: ${fallbackQuery}`);
      params[0] = fallbackQuery;
      rows = db.query(sql).all(...params) as typeof rows;
    }

    return rows.map((row) => ({
      author: row.author,
      snippet: row.snippet,
      channelId: row.channel_id,
      timestamp: Number(row.timestamp),
      entryType: row.entry_type,
    }));
  } catch (err) {
    logError("FTS", "Search failed", err);
    return [];
  }
}

/**
 * Format search results for display in Discord.
 */
export function formatSearchResults(results: TranscriptSearchResult[]): string {
  if (results.length === 0) return "No results found.";

  const lines = results.map((r) => {
    const date = new Date(r.timestamp);
    const formatted = date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    const time = date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });

    return `[${formatted}, ${time}] ${r.author}: ${r.snippet}`;
  });

  return lines.join("\n\n") + `\n\n${results.length} result${results.length === 1 ? "" : "s"}`;
}

// ============================================================================
// Lifecycle
// ============================================================================

/**
 * Initialize the transcript FTS5 index.
 * Creates the DB, schema, and backfills from existing JSONL files.
 * Call once at startup.
 */
export function initTranscriptIndex(): void {
  try {
    db = new Database(DB_PATH);
    // WAL mode for better concurrent read/write performance
    db.exec("PRAGMA journal_mode=WAL");
    createSchema(db);

    const count = backfill(db);
    log("FTS", `Transcript index ready (backfilled ${count} entries)`);
  } catch (err) {
    logError("FTS", "Failed to initialize transcript index", err);
    db = null;
  }
}

/**
 * Close the transcript index DB and checkpoint WAL.
 * Call on graceful shutdown to prevent WAL file growth.
 */
export function closeTranscriptIndex(): void {
  if (!db) return;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // DB may have been deleted manually — checkpoint failure is non-fatal
  }
  try {
    db.close();
  } catch {
    // Already closed or file gone
  }
  db = null;
  log("FTS", "Transcript index closed");
}
