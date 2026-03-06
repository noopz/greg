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

  // Extract author (just the username, not the ID)
  const authorMatch = section.match(/Author:\s*([^\n(]+)/);
  const author = authorMatch?.[1]?.trim() ?? "unknown";

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
    const fallbackQuery = query.split(/\s+/).filter(Boolean)
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
