/**
 * Context Loading (Hot-reload from disk every call)
 *
 * Loads persona, patterns, memories, relationships, and impressions
 * from disk and assembles them into a dynamic context string.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { AGENT_DATA_DIR, MEMORIES_DIR, RELATIONSHIPS_DIR, IMPRESSIONS_DIR, AGENTS_DIR, localDate } from "./paths";
import {
  loadFileWithCache,
  getFileMtime,
  MAX_MEMORY_FILE_CHARS,
  MAX_RELATIONSHIP_CHARS,
  MAX_PATTERNS_CHARS,
} from "./context-cache";
import { loadImpressions } from "./impressions";
import { log } from "./log";
import { BOT_NAME } from "./config/identity";

// ============================================================================
// Session Mtime Tracking (deduplication of unchanged context)
// ============================================================================

interface RelSnapshotEntry {
  mtime: number | null;
  content: string;  // raw content sent to session (for delta computation)
}

interface SessionMtimeSnapshot {
  learnedPatterns: number | null;
  persona: number | null;
  relationships: Map<string, RelSnapshotEntry>;  // keyed by userId
  impressions: Map<string, number | null>;        // keyed by userId
}

let sessionSnapshot: SessionMtimeSnapshot | null = null;

/**
 * Snapshot current mtimes (and relationship content) for all tracked context files.
 * Called after the first turn's buildDynamicContext so the cache is warm.
 */
export function snapshotSessionMtimes(userIds: string[]): void {
  const relMap = new Map<string, RelSnapshotEntry>();
  const impMap = new Map<string, number | null>();

  for (const uid of userIds) {
    const relPath = path.join(RELATIONSHIPS_DIR, `${uid}.md`);
    const relResult = loadFileWithCache(relPath, MAX_RELATIONSHIP_CHARS);
    relMap.set(uid, { mtime: getFileMtime(relPath), content: relResult.content });

    const safeUid = uid.replace(/[^a-zA-Z0-9_-]/g, "_");
    impMap.set(uid, getFileMtime(path.join(IMPRESSIONS_DIR, `${safeUid}.jsonl`)));
  }

  sessionSnapshot = {
    learnedPatterns: getFileMtime(path.join(AGENT_DATA_DIR, "learned-patterns.md")),
    persona: getFileMtime(path.join(AGENT_DATA_DIR, "persona.md")),
    relationships: relMap,
    impressions: impMap,
  };

  log("CONTEXT", `Session mtime snapshot taken (${userIds.length} users)`);
}

/**
 * Compare current mtimes against the session snapshot.
 * Returns whether a fresh session is needed (learned-patterns or persona changed).
 */
export function checkContextDirtiness(): { needsFreshSession: boolean } {
  if (!sessionSnapshot) {
    return { needsFreshSession: false };
  }

  const currentLp = getFileMtime(path.join(AGENT_DATA_DIR, "learned-patterns.md"));
  if (currentLp !== sessionSnapshot.learnedPatterns) {
    log("CONTEXT", "learned-patterns.md changed — need fresh session");
    return { needsFreshSession: true };
  }

  const currentPersona = getFileMtime(path.join(AGENT_DATA_DIR, "persona.md"));
  if (currentPersona !== sessionSnapshot.persona) {
    log("CONTEXT", "persona.md changed — need fresh session");
    return { needsFreshSession: true };
  }

  return { needsFreshSession: false };
}

/**
 * Whether a session mtime snapshot currently exists.
 */
export function hasSessionSnapshot(): boolean {
  return sessionSnapshot !== null;
}

/**
 * Reset the session snapshot. Called when the session ID is cleared
 * so the next turn captures fresh mtimes.
 */
export function resetSessionSnapshot(): void {
  sessionSnapshot = null;
  log("CONTEXT", "Session mtime snapshot reset");
}

// ============================================================================
// Per-User Dirty Detection
// ============================================================================

/** Returns user IDs whose relationship files changed since snapshot. */
function getDirtyRelUserIds(userIds: string[]): string[] {
  if (!sessionSnapshot) return userIds; // No snapshot = first turn, all dirty
  return userIds.filter(uid => {
    const snapped = sessionSnapshot!.relationships.get(uid);
    if (snapped === undefined) return true; // New user not in snapshot
    return getFileMtime(path.join(RELATIONSHIPS_DIR, `${uid}.md`)) !== snapped.mtime;
  });
}

/** Returns user IDs whose impression files changed since snapshot. */
function getDirtyImpUserIds(userIds: string[]): string[] {
  if (!sessionSnapshot) return userIds;
  return userIds.filter(uid => {
    const snapped = sessionSnapshot!.impressions.get(uid);
    if (snapped === undefined) return true;
    const safeUid = uid.replace(/[^a-zA-Z0-9_-]/g, "_");
    return getFileMtime(path.join(IMPRESSIONS_DIR, `${safeUid}.jsonl`)) !== snapped;
  });
}

// ============================================================================
// Relationship Delta Computation
// ============================================================================

/**
 * Load only the changed parts of relationship files for dirty users.
 * Compares new content with snapshot to extract deltas (appended lines).
 * Falls back to full content if the file was edited (not just appended).
 * Updates the snapshot after loading.
 */
function loadRelationshipDeltas(dirtyUserIds: string[], updateSnapshot: boolean): string | null {
  const sections: string[] = [];

  for (const userId of dirtyUserIds) {
    const filePath = path.join(RELATIONSHIPS_DIR, `${userId}.md`);
    const result = loadFileWithCache(filePath, MAX_RELATIONSHIP_CHARS);
    if (!result.content) continue;

    const oldContent = sessionSnapshot?.relationships.get(userId)?.content ?? "";

    if (oldContent.length > 0 && result.content.startsWith(oldContent)) {
      // Append case: extract only the new lines
      const delta = result.content.slice(oldContent.length).trim();
      if (delta) {
        sections.push(`### User ${userId}\n${delta}`);
        log("CONTEXT", `Relationship delta for ${userId}: +${delta.length} chars (appended)`);
      }
    } else {
      // Edit case: send full content
      sections.push(`### User ${userId}\n${result.content}`);
      log("CONTEXT", `Relationship revised for ${userId}: ${result.content.length} chars (full re-send)`);
    }

    // Update snapshot so this user is clean next turn (main mode only —
    // fork mode must not consume deltas meant for the main session)
    if (updateSnapshot && sessionSnapshot) {
      sessionSnapshot.relationships.set(userId, { mtime: getFileMtime(filePath), content: result.content });
    }
  }

  if (sections.length === 0) return null;
  return sections.join("\n\n");
}

/**
 * Update impression snapshot entries for dirty users after re-insertion.
 * Only called in main mode — fork mode must not consume deltas.
 */
function updateImpressionSnapshot(dirtyUserIds: string[]): void {
  if (!sessionSnapshot) return;
  for (const uid of dirtyUserIds) {
    const safeUid = uid.replace(/[^a-zA-Z0-9_-]/g, "_");
    sessionSnapshot.impressions.set(uid, getFileMtime(path.join(IMPRESSIONS_DIR, `${safeUid}.jsonl`)));
  }
}

// ============================================================================
// Hypothesis Injection (probabilistic per compaction window)
// ============================================================================

const HYPOTHESIS_REVIEW_PROBABILITY = 1 / 3;
let _hypothesisReviewPending = false;

/**
 * Roll whether to trigger a background hypothesis review this session.
 * Called when a fresh session starts (at compaction boundaries).
 * Over 3 compaction windows (~420k tokens), review triggers roughly once.
 */
export function rollHypothesisInclusion(): void {
  _hypothesisReviewPending = Math.random() < HYPOTHESIS_REVIEW_PROBABILITY;
  log("CONTEXT", `Hypothesis review roll: ${_hypothesisReviewPending ? "YES" : "no"} (p=${HYPOTHESIS_REVIEW_PROBABILITY.toFixed(2)})`);
}

/**
 * Check and consume the hypothesis review trigger.
 * Returns true exactly once per session when the roll succeeded.
 * Called from bot.ts to schedule a background followup — hypotheses
 * are never injected into conversation context (they distract from
 * the actual user message).
 */
export function consumeHypothesisReviewTrigger(): boolean {
  if (!_hypothesisReviewPending) return false;
  _hypothesisReviewPending = false;
  return true;
}

/**
 * Load persona from persona.md
 * No truncation - persona should stay small
 */
export async function loadPersona(): Promise<string> {
  const filePath = path.join(AGENT_DATA_DIR, "persona.md");
  const result = loadFileWithCache(filePath);
  if (result.content) {
    if (!result.fromCache) {
      log("CONTEXT", `Loaded persona.md (${result.originalLength} chars)`);
    }
    return result.content;
  }
  return `You are ${BOT_NAME}, a snarky but helpful AI friend.`;
}

/**
 * Load learned patterns from learned-patterns.md
 * Truncated to MAX_PATTERNS_CHARS to prevent context bloat
 */
async function loadLearnedPatterns(): Promise<string> {
  const filePath = path.join(AGENT_DATA_DIR, "learned-patterns.md");
  const result = loadFileWithCache(filePath, MAX_PATTERNS_CHARS);
  if (result.content) {
    if (result.truncated && !result.fromCache) {
      log("CONTEXT", `Truncated learned-patterns.md: ${result.originalLength} -> ${result.content.length} chars`);
    } else if (!result.fromCache) {
      log("CONTEXT", `Loaded learned-patterns.md (${result.originalLength} chars)`);
    }
    return result.content;
  }
  return "No patterns learned yet.";
}

/**
 * Load last 5 memory files from memories/
 * Each file truncated to MAX_MEMORY_FILE_CHARS to prevent context bloat
 */
async function loadRecentMemories(): Promise<string> {
  try {
    const files = await fs.readdir(MEMORIES_DIR);
    const mdFiles = files
      .filter((f) => f.endsWith(".md"))
      .sort()
      .slice(-5);

    if (mdFiles.length === 0) {
      return "No memories yet.";
    }

    const memories = mdFiles.map((f) => {
      const filePath = path.join(MEMORIES_DIR, f);
      // Memories are append-only chronological — tail-biased truncation keeps
      // the most recent entries which are most relevant to the current conversation.
      const result = loadFileWithCache(filePath, MAX_MEMORY_FILE_CHARS, true);
      if (result.truncated && !result.fromCache) {
        log("CONTEXT", `Truncated ${f}: ${result.originalLength} -> ${result.content.length} chars`);
      }
      return `### ${f.replace(".md", "")}\n${result.content}`;
    });

    return memories.join("\n\n");
  } catch {
    return "No memories yet.";
  }
}

// Hypothesis review is now handled as a background followup (see bot.ts).
// No longer injected into conversation context — it distracted Greg from
// the actual user message and caused leaked reasoning.

/**
 * Load relationship files for specific users
 * Each file truncated to MAX_RELATIONSHIP_CHARS to prevent context bloat
 */
async function loadRelationships(userIds: string[]): Promise<string | null> {
  if (userIds.length === 0) return null;

  try {
    const relationships = userIds.map((userId) => {
      const filePath = path.join(RELATIONSHIPS_DIR, `${userId}.md`);
      const result = loadFileWithCache(filePath, MAX_RELATIONSHIP_CHARS);
      if (result.content) {
        if (result.truncated && !result.fromCache) {
          log("CONTEXT", `Truncated ${userId}.md: ${result.originalLength} -> ${result.content.length} chars`);
        }
        return `### User ${userId}\n${result.content}`;
      }
      return null;
    });

    const validRelationships = relationships.filter((r) => r !== null);
    return validRelationships.length > 0
      ? validRelationships.join("\n\n")
      : null;
  } catch {
    return null;
  }
}

/**
 * Discover custom agents from .claude/agents/ by parsing frontmatter.
 * Returns a formatted list for injection into the system prompt.
 */
async function discoverAgents(): Promise<string> {
  try {
    const entries = await fs.readdir(AGENTS_DIR);
    const agents: string[] = [];
    for (const file of entries) {
      if (!file.endsWith(".md") || file === "TEMPLATE.md") continue;
      const content = await fs.readFile(path.join(AGENTS_DIR, file), "utf-8");
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatter) {
        const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
        const desc = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
        const model = frontmatter[1].match(/^model:\s*(.+)$/m)?.[1]?.trim();
        if (name && desc) agents.push(`- **${name}**: ${desc}${model ? ` (${model})` : ""}`);
      }
    }
    return agents.length > 0
      ? `You have custom agents in .claude/agents/ that are more efficient than the general-purpose agent:\n${agents.join("\n")}\n`
      : "You have no custom agents yet. Create one in .claude/agents/ if you notice recurring task patterns.\n";
  } catch {
    return "";
  }
}

/**
 * Build dynamic context by hot-reloading all context files from disk.
 * Uses session mtime snapshot to skip unchanged sections and send deltas.
 *
 * Dedup strategy per section:
 *   learned-patterns / persona: dirty → fresh session (handled in turn-executor)
 *   relationships: per-user delta (appended lines) or full re-send (edited)
 *   impressions: per-user re-send (sorting makes deltas impractical)
 *   memories / discord / time: always included (volatile)
 */
export async function buildDynamicContext(
  discordContext: string,
  userIds: string[],
  updateSnapshot = true,
  streamingContinuation = false
): Promise<string> {
  const patternsClean = sessionSnapshot !== null &&
    getFileMtime(path.join(AGENT_DATA_DIR, "learned-patterns.md")) === sessionSnapshot.learnedPatterns;

  // Per-user dirty detection
  const dirtyRelUserIds = getDirtyRelUserIds(userIds);
  const dirtyImpUserIds = getDirtyImpUserIds(userIds);

  // Load patterns and memories (always needed or always skipped)
  const [patterns, memories] = await Promise.all([
    patternsClean ? Promise.resolve(null) : loadLearnedPatterns(),
    loadRecentMemories(), // Always volatile
  ]);

  // Relationships: first turn loads all users; subsequent turns compute deltas
  let relationshipsBlock: string | null = null;
  if (dirtyRelUserIds.length === 0) {
    log("CONTEXT", "Skipping relationships (unchanged)");
  } else if (!sessionSnapshot) {
    // First turn: full section with all users
    const rels = await loadRelationships(userIds);
    if (rels) {
      relationshipsBlock = `## RELATIONSHIPS WITH USERS IN THIS CONVERSATION\n${rels}`;
    }
  } else {
    // Subsequent turn: per-user deltas only
    const deltas = loadRelationshipDeltas(dirtyRelUserIds, updateSnapshot);
    if (deltas) {
      relationshipsBlock = `## UPDATED RELATIONSHIP NOTES\n${deltas}`;
    }
    log("CONTEXT", `Relationship updates: ${dirtyRelUserIds.length}/${userIds.length} users`);
  }

  // Impressions: first turn loads all; subsequent turns load only dirty users
  let impressionsBlock: string | null = null;
  if (dirtyImpUserIds.length === 0) {
    log("CONTEXT", "Skipping impressions (unchanged)");
  } else if (!sessionSnapshot) {
    // First turn: full section
    const imps = await loadImpressions(userIds);
    if (imps) {
      impressionsBlock = `## YOUR IMPRESSIONS OF PEOPLE HERE\n${imps}`;
    }
  } else {
    // Subsequent turn: only dirty users
    const imps = await loadImpressions(dirtyImpUserIds);
    if (imps) {
      impressionsBlock = `## UPDATED IMPRESSIONS\n${imps}`;
    }
    if (updateSnapshot) updateImpressionSnapshot(dirtyImpUserIds);
    log("CONTEXT", `Impression updates: ${dirtyImpUserIds.length}/${userIds.length} users`);
  }

  if (patternsClean) log("CONTEXT", "Skipping learned-patterns (unchanged)");

  const today = localDate();

  // ORDERING FOR PROMPT CACHE OPTIMIZATION:
  // Maximizes cache prefix matching - stable prefix = cache hit
  //
  // NOTE: Persona (YOUR IDENTITY) is now in the system prompt for higher LLM weight.
  //
  // 1. SEMI-STABLE (mtime cached, rarely changes):
  //    - PATTERNS YOU'VE LEARNED - mtime cached
  //
  // 2. STATIC (never changes between requests):
  //    - SELF-IMPROVEMENT INSTRUCTIONS (no ${today} - moved to CURRENT TIME)
  //    - SELF-CONFIGURATION, SEARCHING MEMORIES, SUBAGENT DOCS
  //
  // 3. PER-CONVERSATION (changes by participants):
  //    - RELATIONSHIPS, IMPRESSIONS - mtime cached per user
  //
  // 4. VOLATILE (changes every request):
  //    - RECENT MEMORIES, DISCORD CONTEXT, CURRENT TIME (has ${today})

  // Static instruction blocks (~3.5k chars) — only needed on first turn of a streaming
  // session. On continuation turns they're already in SDK history from turn 1.
  const staticInstructions = streamingContinuation ? "" : `
## YOUR KNOWLEDGE FILES
You maintain research files that are updated during idle time. **Check these BEFORE answering factual questions.**

- **Learned patterns**: agent-data/learned-patterns.md — behavioral insights from past interactions
- **Relationships**: agent-data/relationships/<user-id>.md — per-person notes and context

## SELF-IMPROVEMENT INSTRUCTIONS
You can improve yourself by writing to files. Changes take effect on your next response.

1. **Memories**: Write to agent-data/memories/<date>.md to remember important things (see CURRENT TIME for today's date)
2. **Patterns**: Update agent-data/learned-patterns.md when you notice what works/doesn't work
3. **Skills**: Create .claude/skills/<skill-name>/SKILL.md (see CREATING SKILLS below)
4. **Relationships**: Write to agent-data/relationships/<user-id>.md to remember things about specific people
5. **Response Triggers**: Edit agent-data/response-triggers.json to add new topics/games you want to engage with
6. **Custom Subagents**: Create .claude/agents/<agent-name>.md for specialized helpers (see below)

## SELF-CONFIGURATION
You can edit agent-data/runtime-config.json to adjust your own behavior settings.
**If you tell someone you're changing a setting, you MUST actually edit the file in the same turn. Don't just talk about it.**

Available settings:
- **idle.checkIntervalMinutes**: How often to check for idle conditions
- **idle.thresholdMinutes**: How long before triggering idle behavior
- **skills.disabled**: Array of skill names to disable (e.g., ["some-skill"])
- **keywords**: Array of additional words that trigger responses (e.g., ["gaming", "code"])

Important notes:
- All settings have operator-defined limits - values outside these limits will be clamped
- Some skills are locked and cannot be disabled
- Keywords have limits on count and format (lowercase alphanumeric)
- Check agent-data/runtime-config-effective.json to see actual applied values and any adjustments that were made
- All config changes are logged - make them thoughtfully with clear reasoning

## SEARCHING YOUR PAST

Two systems, different purposes:

**Transcripts** (\`search_transcripts\`): What people actually said in Discord. Use for: "remember when...", "you said...", "didn't you talk to [person]?", "what did [person] say?", quotes, past conversations.

**Memories** (Grep on \`agent-data/memories/\`): Your own notes and reflections. Use for: "check your memories", "what do you remember about...", your own observations, things you wrote down.

**When unsure which to search:** Try search_transcripts first (covers the conversation record), then Grep memories if transcripts don't have it. They're complementary — transcripts have what was said, memories have what you thought about it.

**Your notes (non-transcript):**
- Memories: Grep with pattern="keyword" path="agent-data/memories"
- Patterns: Grep with pattern="keyword" path="agent-data/learned-patterns.md"
- Relationships: Grep with pattern="keyword" path="agent-data/relationships"

## CREATING SKILLS
**Before creating or editing a skill, invoke the \`skill-creation\` skill** to load the required format. Skills missing required sections (like \`## Idle Behavior\`) will silently fail to register with the idle system.

## CREATING CUSTOM SUBAGENTS
You can create specialized subagents by writing markdown files to .claude/agents/<name>.md
These are helpers that run in isolated context with specific tools and expertise.

Format:
\`\`\`markdown
---
name: agent-name
description: When to use this agent (Claude uses this to decide when to delegate)
tools: Read, Grep, Glob  # Optional: limit tools (omit to inherit all)
model: sonnet  # Optional: haiku, sonnet, opus, or inherit
---
System prompt for the agent...
\`\`\`

Example: Create .claude/agents/game-researcher.md to research patch notes:
\`\`\`markdown
---
name: game-researcher
description: Researches game updates, patch notes, and meta changes. Use for gaming news lookups.
tools: WebSearch, WebFetch, Read
model: haiku
---
You research gaming news and patch notes. Find accurate, up-to-date information.
Summarize key changes concisely. Cite your sources.
\`\`\`

Then use it: "Use the game-researcher agent to find Arc Raiders patch notes"

## YOUR CUSTOM AGENTS
${await discoverAgents()}
Prefer these over general-purpose for matching tasks - they're faster and cheaper.

## CREATING NEW AGENTS
If you notice recurring task patterns, create a new agent:
1. Copy .claude/agents/TEMPLATE.md
2. Customize for the specific task
3. Use minimal tools and a focused prompt (~200-500 tokens)

## USING SUBAGENTS
Spawn subagents using the Task tool. Choose model based on complexity:
- **haiku**: Quick lookups, simple tasks
- **sonnet**: Research, analysis, code review
- **opus**: Complex reasoning (expensive, use sparingly)

Your custom agents in .claude/agents/ are automatically available via Task tool.

`;

  return `${staticInstructions}${patterns !== null ? `## PATTERNS YOU'VE LEARNED
${patterns}
` : ""}${relationshipsBlock !== null ? `${relationshipsBlock}
` : ""}${impressionsBlock !== null ? `
${impressionsBlock}
` : ""}
## YOUR RECENT MEMORIES (last 5 days — Grep agent-data/memories/ for older entries)
${memories}

## DISCORD CONTEXT
${discordContext}

## CURRENT TIME
- Date: ${today}
- Time: ${new Date().toLocaleTimeString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})
- Today's memory file: agent-data/memories/${today}.md

## WORKING DIRECTORY
${process.cwd()}
All file tool calls must use absolute paths rooted here (e.g. ${process.cwd()}/agent-data/memories/${today}.md).
`;
}

// Note: buildContextDelta was removed — streaming continuation turns now use
// buildDynamicContext(streamingContinuation=true) which handles dirty section
// detection inline, avoiding the separate delta pre-yield step and its 30s timeout.
