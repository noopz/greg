/**
 * Greg - Claude Agent SDK Integration
 *
 * Hot-reloads context from disk every call for dynamic self-improvement.
 * Maintains session continuity across Discord interactions.
 * Uses atomic file writes and append-only JSONL transcripts for durability.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  atomicWriteFile,
  appendToTranscript,
  loadTranscript,
  getTranscriptPath,
  getClaudeSessionPath,
  countTokensFromClaudeSession,
  verifyTokenCount,
  loadSessionData as loadSessionDataFromFile,
  saveSessionData as saveSessionDataToFile,
  type TranscriptEntry,
  type SessionData,
} from "./persistence";

// ============================================================================
// Configuration
// ============================================================================

const AGENT_DATA_DIR = path.join(process.cwd(), "agent-data");
const TRANSCRIPTS_DIR = path.join(AGENT_DATA_DIR, "transcripts");
const SESSION_FILE = path.join(AGENT_DATA_DIR, "session.json");
const PROJECT_DIR = process.cwd();

// Context window management constants
const CONTEXT_WINDOW = 128000;
const RESERVE_TOKENS = 8000;
const SOFT_THRESHOLD_TOKENS = CONTEXT_WINDOW - RESERVE_TOKENS - 4000; // ~116k tokens - trigger memory flush
const HARD_THRESHOLD_TOKENS = CONTEXT_WINDOW - RESERVE_TOKENS; // 120k tokens - trigger compaction
const MEMORY_FLUSH_BUFFER = 10000; // Minimum tokens to accumulate before re-triggering flush
const COMPACTION_KEEP_MESSAGES = 10; // Number of recent messages to keep intact during compaction
const COMPACTION_SUMMARIES_DIR = path.join(AGENT_DATA_DIR, "compaction-summaries");

// ============================================================================
// Types
// ============================================================================

export interface AgentContext {
  mustRespond: boolean;
  channelId: string;
  isGroupDm: boolean;
}

// ============================================================================
// Context Loading (Hot-reload from disk every call)
// ============================================================================

async function loadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Load persona from persona.md
 */
export async function loadPersona(): Promise<string> {
  const content = await loadFile(path.join(AGENT_DATA_DIR, "persona.md"));
  return content || "You are Greg, a snarky but helpful AI friend.";
}

/**
 * Load learned patterns from learned-patterns.md
 */
export async function loadLearnedPatterns(): Promise<string> {
  const content = await loadFile(path.join(AGENT_DATA_DIR, "learned-patterns.md"));
  return content || "No patterns learned yet.";
}

/**
 * Load last 5 memory files from memories/
 */
export async function loadRecentMemories(): Promise<string> {
  const memoriesDir = path.join(AGENT_DATA_DIR, "memories");
  try {
    const files = await fs.readdir(memoriesDir);
    const mdFiles = files
      .filter((f) => f.endsWith(".md"))
      .sort()
      .slice(-5);

    if (mdFiles.length === 0) {
      return "No memories yet.";
    }

    const memories = await Promise.all(
      mdFiles.map(async (f) => {
        const content = await fs.readFile(path.join(memoriesDir, f), "utf-8");
        return `### ${f.replace(".md", "")}\n${content}`;
      })
    );

    return memories.join("\n\n");
  } catch {
    return "No memories yet.";
  }
}

/**
 * Load relationship files for specific users
 */
export async function loadRelationships(userIds: string[]): Promise<string> {
  const relDir = path.join(AGENT_DATA_DIR, "relationships");

  if (userIds.length === 0) {
    return "No users in context.";
  }

  try {
    const relationships = await Promise.all(
      userIds.map(async (userId) => {
        const content = await loadFile(path.join(relDir, `${userId}.md`));
        if (content) {
          return `### User ${userId}\n${content}`;
        }
        return null;
      })
    );

    const validRelationships = relationships.filter((r) => r !== null);
    return validRelationships.length > 0
      ? validRelationships.join("\n\n")
      : "No relationship notes for these users yet.";
  } catch {
    return "No relationship notes yet.";
  }
}

// ============================================================================
// Dynamic Context Builder
// ============================================================================

/**
 * Build dynamic context by hot-reloading all context files from disk
 */
export async function buildDynamicContext(
  discordContext: string,
  userIds: string[]
): Promise<string> {
  const [persona, patterns, memories, relationships, compactionSummary] = await Promise.all([
    loadPersona(),
    loadLearnedPatterns(),
    loadRecentMemories(),
    loadRelationships(userIds),
    getCompactionSummaryForSession(),
  ]);

  const today = new Date().toISOString().split("T")[0];

  // Build compaction context if we have a summary from a previous session
  const compactionContext = compactionSummary
    ? `
## PREVIOUS CONVERSATION CONTEXT
Your previous conversation was compacted due to context window limits. Here's a summary of what was discussed:

${compactionSummary}

---
`
    : "";

  return `
## YOUR IDENTITY
${persona}

## PATTERNS YOU'VE LEARNED
${patterns}

## YOUR RECENT MEMORIES
${memories}

## RELATIONSHIPS WITH USERS IN THIS CONVERSATION
${relationships}
${compactionContext}
## SELF-IMPROVEMENT INSTRUCTIONS
You can improve yourself by writing to files. Changes take effect on your next response.

1. **Memories**: Write to agent-data/memories/${today}.md to remember important things from today
2. **Patterns**: Update agent-data/learned-patterns.md when you notice what works/doesn't work
3. **Skills**: Create .claude/skills/<skill-name>/SKILL.md for new capabilities
4. **Relationships**: Write to agent-data/relationships/<user-id>.md to remember things about specific people

## SEARCHING YOUR MEMORIES
Use Grep to search your past memories, patterns, and relationships when you need to recall something:
- Search all memories: Grep with pattern="keyword" path="agent-data/memories"
- Search patterns: Grep with pattern="keyword" path="agent-data/learned-patterns.md"
- Search relationships: Grep with pattern="keyword" path="agent-data/relationships"
This lets you recall things from weeks or months ago that aren't in your recent context.

## DISCORD CONTEXT
${discordContext}

## CURRENT TIME
- Date: ${today}
- Time: ${new Date().toLocaleTimeString()}
`;
}

// ============================================================================
// Session Management (using atomic writes)
// ============================================================================

/**
 * Load session data from disk for session continuity.
 * Wraps generic persistence function with hardcoded session file path.
 */
export async function loadSessionData(): Promise<SessionData | null> {
  return loadSessionDataFromFile(SESSION_FILE);
}

/**
 * Load session ID from disk (convenience wrapper)
 */
export async function loadSessionId(): Promise<string | undefined> {
  const data = await loadSessionData();
  return data?.sessionId;
}

/**
 * Save session data to disk using atomic write.
 * Wraps generic persistence function with hardcoded session file path.
 */
export async function saveSessionData(data: SessionData): Promise<void> {
  return saveSessionDataToFile(SESSION_FILE, data);
}

/**
 * Save session ID to disk using atomic write
 */
export async function saveSessionId(sessionId: string): Promise<void> {
  const existing = await loadSessionData();
  const transcriptFile = getTranscriptPath(TRANSCRIPTS_DIR, sessionId);

  await saveSessionData({
    sessionId,
    updatedAt: Date.now(),
    totalTokens: existing?.totalTokens,
    transcriptFile,
  });
}

/**
 * Update token usage in session data after a query completes
 * Extracts input and output tokens from the SDK result message and persists to session.json
 */
async function updateTokenUsage(result: SDKResultMessage): Promise<void> {
  const existing = await loadSessionData();
  if (!existing) {
    console.warn(`[SDK] Cannot update token usage: no session data found`);
    return;
  }

  // Extract tokens from the result's usage field
  // NonNullableUsage has input_tokens and output_tokens from the Anthropic API
  const inputTokens = result.usage.input_tokens ?? 0;
  const outputTokens = result.usage.output_tokens ?? 0;
  const turnTokens = inputTokens + outputTokens;

  // Add to cumulative total
  const previousTotal = existing.totalTokens ?? 0;
  const newTotal = previousTotal + turnTokens;

  console.log(`[SDK] Token usage this turn: ${inputTokens} input + ${outputTokens} output = ${turnTokens} total`);
  console.log(`[SDK] Cumulative tokens: ${previousTotal} -> ${newTotal}`);

  await saveSessionData({
    ...existing,
    totalTokens: newTotal,
    updatedAt: Date.now(),
  });
}

/**
 * Sync token count from the Claude SDK's JSONL session file.
 * This is useful for recovery after restarts or to verify our tracking is accurate.
 * Returns the verified token count.
 */
export async function syncTokenCountFromJSONL(): Promise<number | null> {
  const sessionData = await loadSessionData();
  if (!sessionData?.sessionId) {
    console.log(`[SDK] Cannot sync tokens: no session data`);
    return null;
  }

  const verifiedCount = await verifyTokenCount(
    PROJECT_DIR,
    sessionData.sessionId,
    sessionData.totalTokens ?? 0
  );

  // Update session data if the verified count differs significantly
  if (verifiedCount !== sessionData.totalTokens) {
    console.log(`[SDK] Syncing token count from JSONL: ${sessionData.totalTokens ?? 0} -> ${verifiedCount}`);
    await saveSessionData({
      ...sessionData,
      totalTokens: verifiedCount,
      updatedAt: Date.now(),
    });
  }

  return verifiedCount;
}

// ============================================================================
// Memory Flush Before Compaction
// ============================================================================

const MEMORY_FLUSH_PROMPT = `Pre-compaction memory flush. Your context window is approaching capacity and will be compacted soon.

IMPORTANT: Store any important memories NOW before they are lost to compaction.

What to save:
- Key facts learned in this conversation
- Important user preferences or context
- Decisions made or conclusions reached
- Anything you'd want to remember after compaction

Save to: agent-data/memories/${new Date().toISOString().split("T")[0]}.md (append, don't overwrite)

If you have nothing important to store, reply with exactly: [NO_REPLY]`;

/**
 * Check if memory flush should be triggered based on token usage.
 * Triggers when we cross the soft threshold AND have accumulated enough new tokens since last flush.
 */
async function shouldTriggerMemoryFlush(sessionData: SessionData): Promise<boolean> {
  const totalTokens = sessionData.totalTokens ?? 0;
  const lastFlushTokenCount = sessionData.lastMemoryFlushTokenCount ?? 0;

  // Check if we're above the soft threshold
  const aboveThreshold = totalTokens >= SOFT_THRESHOLD_TOKENS;

  // Check if we've accumulated enough tokens since the last flush
  const accumulatedSinceLastFlush = totalTokens - lastFlushTokenCount;
  const hasEnoughNewTokens = accumulatedSinceLastFlush >= MEMORY_FLUSH_BUFFER;

  if (aboveThreshold && hasEnoughNewTokens) {
    console.log(`[SDK] Memory flush triggered: ${totalTokens} tokens (threshold: ${SOFT_THRESHOLD_TOKENS}, last flush at: ${lastFlushTokenCount})`);
    return true;
  }

  return false;
}

/**
 * Execute a memory flush turn - bypasses the normal queue.
 * Gives the agent a chance to save important memories before compaction.
 */
async function executeMemoryFlush(): Promise<void> {
  console.log(`[SDK] Executing memory flush before compaction...`);

  const sessionData = await loadSessionData();
  if (!sessionData?.sessionId) {
    console.warn(`[SDK] Cannot execute memory flush: no session data`);
    return;
  }

  // Mark the current token count so we can re-trigger after accumulating more tokens
  const currentTokens = sessionData.totalTokens ?? 0;
  await saveSessionData({
    ...sessionData,
    lastMemoryFlushTokenCount: currentTokens,
    updatedAt: Date.now(),
  });

  // Build minimal context for memory flush
  const today = new Date().toISOString().split("T")[0];
  const flushContext = `
## MEMORY FLUSH MODE
You are in pre-compaction memory flush mode. Your context will be compacted after this turn.

## CURRENT TIME
- Date: ${today}
- Time: ${new Date().toLocaleTimeString()}
`;

  let response = "";

  try {
    for await (const message of query({
      prompt: MEMORY_FLUSH_PROMPT,
      options: {
        cwd: PROJECT_DIR,
        resume: sessionData.sessionId,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: flushContext,
        },
        settingSources: ["project"],
        allowedTools: ["Read", "Write", "Edit"],
      },
    })) {
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block) {
            response += block.text;
          } else if ("name" in block) {
            console.log(`[SDK] Memory flush tool call: ${block.name}`);
          }
        }
      } else if (message.type === "result") {
        // Update token usage after memory flush
        try {
          await updateTokenUsage(message);
        } catch (error) {
          console.error(`[SDK] Failed to update token usage after memory flush:`, error);
        }
      }
    }

    const isNoReply = response.trim() === "[NO_REPLY]" || response.includes("[NO_REPLY]");
    if (isNoReply) {
      console.log(`[SDK] Memory flush complete: nothing to store`);
    } else {
      console.log(`[SDK] Memory flush complete: memories saved`);
    }

    // Append memory flush to transcript
    const transcriptFile = getTranscriptPath(TRANSCRIPTS_DIR, sessionData.sessionId);
    await appendToTranscript(transcriptFile, {
      type: "system",
      content: `[MEMORY_FLUSH] ${isNoReply ? "No memories to store" : "Memories saved before compaction"}`,
      timestamp: Date.now(),
      metadata: {
        tokensAtFlush: currentTokens,
      },
    });
  } catch (error) {
    console.error(`[SDK] Memory flush failed:`, error);
    // Don't throw - we don't want memory flush failure to block normal operation
  }
}

// ============================================================================
// Context Compaction
// ============================================================================

/**
 * Check if compaction should be triggered based on token usage.
 * Triggers when we reach the hard threshold (120k tokens).
 */
function shouldTriggerCompaction(sessionData: SessionData): boolean {
  const totalTokens = sessionData.totalTokens ?? 0;

  if (totalTokens >= HARD_THRESHOLD_TOKENS) {
    console.log(`[SDK] Compaction triggered: ${totalTokens} tokens >= ${HARD_THRESHOLD_TOKENS} threshold`);
    return true;
  }

  return false;
}

/**
 * Load a compaction summary file if it exists for the current session lineage.
 */
async function loadCompactionSummary(sessionId: string | undefined): Promise<string | null> {
  if (!sessionId) return null;

  const summaryPath = path.join(COMPACTION_SUMMARIES_DIR, `${sessionId}.md`);
  try {
    const content = await fs.readFile(summaryPath, "utf-8");
    return content;
  } catch {
    return null;
  }
}

/**
 * Get the compaction summary path for a session.
 * Checks the current session and any compactedFromSessionId in the lineage.
 */
async function getCompactionSummaryForSession(): Promise<string | null> {
  const sessionData = await loadSessionData();
  if (!sessionData) return null;

  // First check if there's a summary for the session we were compacted from
  if (sessionData.compactedFromSessionId) {
    const summary = await loadCompactionSummary(sessionData.compactedFromSessionId);
    if (summary) {
      return summary;
    }
  }

  return null;
}

/**
 * Generate a summary of conversation history using the Claude Agent SDK.
 * Uses a fresh session (no resume) to avoid contaminating the main conversation.
 */
async function generateCompactionSummary(prompt: string): Promise<string> {
  let summaryText = "";

  for await (const message of query({
    prompt,
    options: {
      cwd: PROJECT_DIR,
      // No resume - use a fresh session for summarization
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: `
## SUMMARIZATION MODE
You are in summarization mode. Your ONLY task is to read the conversation history and produce a concise summary.
Do NOT use any tools. Do NOT take any actions. Just output a markdown summary.
`,
      },
      settingSources: ["project"],
      allowedTools: [], // No tools allowed - pure text generation
    },
  })) {
    if (message.type === "assistant" && message.message?.content) {
      for (const block of message.message.content) {
        if ("text" in block) {
          summaryText += block.text;
        }
      }
    }
  }

  return summaryText.trim();
}

/**
 * Execute context compaction:
 * 1. Load the transcript from the Claude SDK JSONL file
 * 2. Keep recent messages intact
 * 3. Summarize older messages using Claude Agent SDK
 * 4. Save summary to compaction-summaries/<session-id>.md
 * 5. Increment compactionCount
 * 6. Reset the session so next query starts fresh with summary
 */
async function executeCompaction(): Promise<void> {
  console.log(`[SDK] Executing context compaction...`);

  const sessionData = await loadSessionData();
  if (!sessionData?.sessionId) {
    console.warn(`[SDK] Cannot execute compaction: no session data`);
    return;
  }

  const oldSessionId = sessionData.sessionId;

  try {
    // Load the transcript from our JSONL transcript file
    const transcriptFile = getTranscriptPath(TRANSCRIPTS_DIR, oldSessionId);
    const transcript = await loadTranscript(transcriptFile);

    if (transcript.length === 0) {
      console.log(`[SDK] No transcript entries to compact`);
      return;
    }

    console.log(`[SDK] Loaded ${transcript.length} transcript entries`);

    // Split into older messages to summarize and recent messages to keep
    const cutoffIndex = Math.max(0, transcript.length - COMPACTION_KEEP_MESSAGES);
    const olderMessages = transcript.slice(0, cutoffIndex);
    const recentMessages = transcript.slice(cutoffIndex);

    if (olderMessages.length === 0) {
      console.log(`[SDK] Not enough messages to compact (only ${transcript.length} messages)`);
      return;
    }

    console.log(`[SDK] Summarizing ${olderMessages.length} older messages, keeping ${recentMessages.length} recent`);

    // Format older messages for summarization
    const messagesText = olderMessages.map(entry => {
      const role = entry.type === "user" ? "User" : entry.type === "assistant" ? "Assistant" : "System";
      const timestamp = new Date(entry.timestamp).toISOString();
      return `[${timestamp}] ${role}: ${entry.content}`;
    }).join("\n\n");

    // Also include any existing compaction summary to maintain full history
    const existingSummary = await getCompactionSummaryForSession();
    const existingSummaryContext = existingSummary
      ? `\n\n## Previous Compaction Summary\n${existingSummary}\n\n## Messages Since Last Compaction\n`
      : "";

    // Build the summarization prompt
    const summarizationPrompt = `You are summarizing a conversation history for context compaction. This summary will be used to maintain continuity when the conversation context is reset.

Create a comprehensive but concise summary that captures:
1. Key topics discussed
2. Important decisions or conclusions reached
3. Relevant facts about users (preferences, context shared)
4. Any ongoing tasks or topics that might continue
5. The overall tone and relationship dynamics

${existingSummaryContext}## Conversation to Summarize

${messagesText}

---

Write a summary in markdown format. Be thorough but concise. Focus on information that would be useful for continuing the conversation.`;

    // Call Claude to summarize the older messages using SDK
    const summaryText = await generateCompactionSummary(summarizationPrompt);

    if (!summaryText) {
      console.error(`[SDK] Compaction failed: no summary text generated`);
      return;
    }

    console.log(`[SDK] Generated summary (${summaryText.length} chars)`);

    // Ensure compaction summaries directory exists
    await fs.mkdir(COMPACTION_SUMMARIES_DIR, { recursive: true });

    // Save the summary with metadata
    const compactionCount = (sessionData.compactionCount ?? 0) + 1;
    const summaryWithMetadata = `# Compaction Summary #${compactionCount}

**Session ID:** ${oldSessionId}
**Compacted At:** ${new Date().toISOString()}
**Messages Summarized:** ${olderMessages.length}
**Messages Preserved:** ${recentMessages.length}

---

${summaryText}

---

## Recent Messages (Preserved)

${recentMessages.map(entry => {
  const role = entry.type === "user" ? "User" : entry.type === "assistant" ? "Assistant" : "System";
  return `**${role}:** ${entry.content.substring(0, 500)}${entry.content.length > 500 ? "..." : ""}`;
}).join("\n\n")}
`;

    const summaryPath = path.join(COMPACTION_SUMMARIES_DIR, `${oldSessionId}.md`);
    await atomicWriteFile(summaryPath, summaryWithMetadata);
    console.log(`[SDK] Saved compaction summary to ${summaryPath}`);

    // Update session data: increment compactionCount and clear sessionId to start fresh
    await saveSessionData({
      ...sessionData,
      sessionId: "", // Clear session ID to start fresh
      compactionCount,
      compactedFromSessionId: oldSessionId,
      totalTokens: 0, // Reset token count for new session
      lastMemoryFlushTokenCount: 0,
      updatedAt: Date.now(),
    });

    // Clear the in-memory session ID so next query creates a new session
    currentSessionId = undefined;

    // Append compaction event to the old transcript
    await appendToTranscript(transcriptFile, {
      type: "system",
      content: `[COMPACTION] Context compacted. Summary saved to ${summaryPath}. Starting new session.`,
      timestamp: Date.now(),
      metadata: {
        compactionCount,
        messagesSummarized: olderMessages.length,
        messagesPreserved: recentMessages.length,
        summaryLength: summaryText.length,
      },
    });

    console.log(`[SDK] Compaction complete. Compaction count: ${compactionCount}. Session will restart fresh.`);
  } catch (error) {
    console.error(`[SDK] Compaction failed:`, error);
    // Don't throw - compaction failure shouldn't block normal operation
  }
}

// ============================================================================
// User ID Extraction
// ============================================================================

/**
 * Extract user IDs from Discord context string
 * Looks for patterns like "username (123456789)" or "(123456789)"
 */
function extractUserIds(discordContext: string): string[] {
  // Match Discord snowflake IDs in parentheses - 17-20 digit numbers
  const idPattern = /\((\d{17,20})\)/g;
  const ids: string[] = [];
  let match;

  while ((match = idPattern.exec(discordContext)) !== null) {
    if (!ids.includes(match[1])) {
      ids.push(match[1]);
    }
  }

  return ids;
}

// ============================================================================
// Turn Queue Types (Pattern 3: Concurrency Control)
// ============================================================================

type QueuedTurn = {
  prompt: string;
  context: string;
  options: AgentContext;
  resolve: (response: string | null) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
};

type TurnQueue = {
  items: QueuedTurn[];
  processing: boolean;
  lastProcessedAt: number;
};

// ============================================================================
// Turn Queue State
// ============================================================================

let currentSessionId: string | undefined;
const TURN_QUEUES = new Map<string, TurnQueue>();
const STALE_QUEUE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Turn Queue Implementation
// ============================================================================

/**
 * Get session key from options
 * Uses channelId to allow independent queues per channel
 */
function getSessionKey(options: AgentContext): string {
  return options.channelId || "idle";
}

/**
 * Get or create a queue for a session
 */
function getOrCreateQueue(sessionKey: string): TurnQueue {
  let queue = TURN_QUEUES.get(sessionKey);
  if (!queue) {
    queue = {
      items: [],
      processing: false,
      lastProcessedAt: 0,
    };
    TURN_QUEUES.set(sessionKey, queue);
  }
  return queue;
}

/**
 * Check for stale queues and log warnings
 */
function checkStaleQueues(): void {
  const now = Date.now();
  for (const [sessionKey, queue] of TURN_QUEUES.entries()) {
    if (queue.items.length > 0) {
      const oldestItem = queue.items[0];
      const waitTime = now - oldestItem.enqueuedAt;
      if (waitTime > STALE_QUEUE_THRESHOLD_MS) {
        console.warn(
          `[SDK] WARNING: Stale queue detected for session "${sessionKey}". ` +
          `Oldest item waiting for ${Math.floor(waitTime / 1000)}s. ` +
          `Queue depth: ${queue.items.length}, processing: ${queue.processing}`
        );
      }
    }
    // Also check if queue hasn't processed in a while when it has items
    if (queue.lastProcessedAt > 0 && queue.items.length > 0) {
      const timeSinceLastProcess = now - queue.lastProcessedAt;
      if (timeSinceLastProcess > STALE_QUEUE_THRESHOLD_MS) {
        console.warn(
          `[SDK] WARNING: Queue "${sessionKey}" hasn't processed in ${Math.floor(timeSinceLastProcess / 1000)}s`
        );
      }
    }
  }
}

/**
 * Enqueue a message for processing
 * Returns a Promise that resolves when the turn completes
 */
export function enqueueMessage(
  sessionKey: string,
  context: string,
  options: AgentContext
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const queue = getOrCreateQueue(sessionKey);

    const turn: QueuedTurn = {
      prompt: context,
      context,
      options: structuredClone(options), // Snapshot options to prevent mutation
      resolve,
      reject,
      enqueuedAt: Date.now(),
    };

    queue.items.push(turn);
    console.log(`[SDK] Queued turn for session "${sessionKey}" (queue size: ${queue.items.length})`);

    // Check for stale queues periodically
    checkStaleQueues();

    // Start draining if not already processing
    if (!queue.processing) {
      drainQueue(sessionKey);
    }
  });
}

/**
 * Drain the queue for a session, processing items one at a time
 */
async function drainQueue(sessionKey: string): Promise<void> {
  const queue = TURN_QUEUES.get(sessionKey);
  if (!queue || queue.processing) {
    return;
  }

  queue.processing = true;

  try {
    while (queue.items.length > 0) {
      const turn = queue.items.shift()!;
      const waitTime = Date.now() - turn.enqueuedAt;

      if (waitTime > 1000) {
        console.log(`[SDK] Processing turn after ${Math.floor(waitTime / 1000)}s wait`);
      }

      // Check if memory flush should be triggered before processing this turn
      try {
        const sessionData = await loadSessionData();
        if (sessionData && await shouldTriggerMemoryFlush(sessionData)) {
          await executeMemoryFlush();
        }
      } catch (error) {
        console.error(`[SDK] Memory flush check failed:`, error);
        // Continue processing - don't let memory flush issues block the queue
      }

      // Check if compaction should be triggered (after memory flush, before turn)
      try {
        const sessionData = await loadSessionData();
        if (sessionData && shouldTriggerCompaction(sessionData)) {
          await executeCompaction();
        }
      } catch (error) {
        console.error(`[SDK] Compaction check failed:`, error);
        // Continue processing - don't let compaction issues block the queue
      }

      try {
        const response = await executeAgentTurn(turn.context, turn.options);
        turn.resolve(response);
      } catch (error) {
        turn.reject(error instanceof Error ? error : new Error(String(error)));
      }

      queue.lastProcessedAt = Date.now();
    }
  } finally {
    queue.processing = false;
  }
}

/**
 * Enqueue with debounce - merges rapid messages within debounceMs
 * Both callers will receive the same response
 */
export function enqueueWithDebounce(
  sessionKey: string,
  context: string,
  options: AgentContext,
  debounceMs = 500
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const queue = getOrCreateQueue(sessionKey);

    // Check if there's a recent pending message we can merge with
    const lastItem = queue.items[queue.items.length - 1];
    if (lastItem && Date.now() - lastItem.enqueuedAt < debounceMs) {
      // Merge: append to existing message
      lastItem.prompt += "\n" + context;
      lastItem.context += "\n" + context;

      // Chain the promise so both callers get the response
      const originalResolve = lastItem.resolve;
      const originalReject = lastItem.reject;

      lastItem.resolve = (response) => {
        originalResolve(response);
        resolve(response);
      };
      lastItem.reject = (error) => {
        originalReject(error);
        reject(error);
      };

      console.log(`[SDK] Merged message into existing queued turn for session "${sessionKey}"`);
      return;
    }

    // Normal enqueue
    enqueueMessage(sessionKey, context, options).then(resolve).catch(reject);
  });
}

/**
 * Process a Discord message through the Claude Agent SDK
 * Uses per-session turn queues to prevent concurrent calls
 */
export async function processWithAgent(
  discordContext: string,
  options: AgentContext
): Promise<string | null> {
  const sessionKey = getSessionKey(options);

  // Use debounce for Discord messages to merge rapid-fire messages
  // Don't debounce idle behaviors
  if (sessionKey !== "idle") {
    return enqueueWithDebounce(sessionKey, discordContext, options);
  }
  return enqueueMessage(sessionKey, discordContext, options);
}

// ============================================================================
// Main Agent Function
// ============================================================================

/**
 * Execute a single agent turn (internal, called by queue)
 * Appends user message and assistant response to transcript.
 */
async function executeAgentTurn(
  discordContext: string,
  options: AgentContext
): Promise<string | null> {
  console.log(`[SDK] Starting executeAgentTurn`);

  // Extract user IDs from the context
  const userIds = extractUserIds(discordContext);
  console.log(`[SDK] Extracted ${userIds.length} user IDs: ${userIds.join(', ')}`);

  // Build dynamic context (hot-reload from disk!)
  console.log(`[SDK] Building dynamic context (hot-reload)...`);
  const dynamicContext = await buildDynamicContext(discordContext, userIds);
  console.log(`[SDK] Dynamic context built (${dynamicContext.length} chars)`);

  // Load session ID if not already loaded
  if (!currentSessionId) {
    currentSessionId = await loadSessionId();
    console.log(`[SDK] Loaded session ID: ${currentSessionId || 'none (new session)'}`);

    // Sync token count from JSONL on first load to recover from any drift
    if (currentSessionId) {
      const syncedTokens = await syncTokenCountFromJSONL();
      if (syncedTokens !== null) {
        console.log(`[SDK] Token count synced from JSONL: ${syncedTokens}`);
      }
    }
  } else {
    console.log(`[SDK] Using existing session: ${currentSessionId}`);
  }

  // Build the prompt with response instructions
  const responseInstruction = options.mustRespond
    ? "You MUST respond to this message."
    : `Decide whether to respond based on context. If you choose not to respond, output exactly: [NO_RESPONSE]`;

  const prompt = `${responseInstruction}

${options.isGroupDm ? "This is from the group DM." : "This is a direct message."}
Channel ID: ${options.channelId}

Respond naturally as Greg. Keep it short unless explaining something.`;

  // Append user message to transcript BEFORE calling the model
  const transcriptFile = currentSessionId
    ? getTranscriptPath(TRANSCRIPTS_DIR, currentSessionId)
    : null;

  if (transcriptFile) {
    try {
      const userEntry: TranscriptEntry = {
        type: "user",
        content: discordContext,
        timestamp: Date.now(),
        metadata: {
          channelId: options.channelId,
          isGroupDm: options.isGroupDm,
          mustRespond: options.mustRespond,
        },
      };
      await appendToTranscript(transcriptFile, userEntry);
      console.log(`[SDK] Appended user message to transcript`);
    } catch (error) {
      console.error(`[SDK] Failed to append user message to transcript:`, error);
      // Continue processing - transcript failure shouldn't block response
    }
  }

  console.log(`[SDK] Calling query()...`);
  let response = "";
  let resultMessage: SDKResultMessage | null = null;

  for await (const message of query({
    prompt,
    options: {
      cwd: PROJECT_DIR,
      resume: currentSessionId,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: dynamicContext,
      },
      settingSources: ["project"],
      allowedTools: [
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "Bash",
        "WebSearch",
        "Skill",
      ],
    },
  })) {
    // Capture session ID from init message
    if (message.type === "system" && message.subtype === "init") {
      currentSessionId = message.session_id;
      console.log(`[SDK] Got session ID: ${currentSessionId}`);
      await saveSessionId(currentSessionId);

      // If we didn't have a session before, append the user message now
      if (!transcriptFile) {
        try {
          const newTranscriptFile = getTranscriptPath(TRANSCRIPTS_DIR, currentSessionId);
          const userEntry: TranscriptEntry = {
            type: "user",
            content: discordContext,
            timestamp: Date.now(),
            metadata: {
              channelId: options.channelId,
              isGroupDm: options.isGroupDm,
              mustRespond: options.mustRespond,
            },
          };
          await appendToTranscript(newTranscriptFile, userEntry);
          console.log(`[SDK] Appended user message to new transcript`);
        } catch (error) {
          console.error(`[SDK] Failed to append user message to transcript:`, error);
        }
      }
    }

    // Log message types for debugging
    if (message.type === "system") {
      console.log(`[SDK] System message: ${message.subtype}`);
    } else if (message.type === "assistant") {
      if (message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block) {
            response += block.text;
            console.log(`[SDK] Assistant text: "${block.text.substring(0, 50)}..."`);
          } else if ("name" in block) {
            // Log tool call with details
            const toolBlock = block as { name: string; input?: Record<string, unknown> };
            const input = toolBlock.input || {};
            let details = "";

            // Format details based on tool type
            const checkFilePath = async (filePath: unknown) => {
              const fp = String(filePath || "");
              const { isPathSafe } = await import("./security");

              // Check if path escapes project directory
              if (!isPathSafe(PROJECT_DIR, fp)) {
                console.warn(`[SDK] ⚠️  PATH ESCAPES PROJECT: ${fp}`);
              }

              // Also check for sensitive paths
              const sensitivePatterns = [
                /^\/etc\//,
                /^\/usr\//,
                /^\/var\//,
                /^\/root\//,
                /\.ssh\//,
                /\.env$/,
                /\.git\/config$/,
                /credentials/i,
                /secrets?/i,
                /password/i,
              ];
              for (const pattern of sensitivePatterns) {
                if (pattern.test(fp)) {
                  console.warn(`[SDK] ⚠️  SENSITIVE PATH ACCESS: ${fp}`);
                  break;
                }
              }
            };

            switch (toolBlock.name) {
              case "WebSearch":
                details = `query="${input.query}"`;
                break;
              case "WebFetch":
                details = `url="${input.url}"`;
                break;
              case "Read":
                details = `file="${input.file_path}"`;
                await checkFilePath(input.file_path);
                break;
              case "Write":
                details = `file="${input.file_path}"`;
                await checkFilePath(input.file_path);
                break;
              case "Edit":
                details = `file="${input.file_path}"`;
                await checkFilePath(input.file_path);
                break;
              case "Grep":
                details = `pattern="${input.pattern}" path="${input.path || "."}"`;
                break;
              case "Glob":
                details = `pattern="${input.pattern}"`;
                break;
              case "Bash": {
                const cmd = String(input.command || "");
                details = `cmd="${cmd.substring(0, 80)}"`;
                // Check for dangerous patterns
                const { checkBashCommand } = await import("./security");
                const check = checkBashCommand(cmd);
                if (!check.safe) {
                  console.error(`[SDK] ⚠️  DANGEROUS COMMAND DETECTED: ${cmd}`);
                  console.error(`[SDK] ⚠️  Warnings: ${check.warnings.join(", ")}`);
                }
                break;
              }
              default:
                details = JSON.stringify(input).substring(0, 100);
            }
            console.log(`[SDK] Tool call: ${toolBlock.name} - ${details}`);
          }
        }
      }
    } else if (message.type === "result") {
      console.log(`[SDK] Result: ${message.subtype}`);
      resultMessage = message;
    }
  }

  console.log(`[SDK] Query complete. Response length: ${response.length}`);

  // Update token usage tracking
  if (resultMessage) {
    try {
      await updateTokenUsage(resultMessage);
    } catch (error) {
      console.error(`[SDK] Failed to update token usage:`, error);
      // Continue processing - token tracking failure shouldn't block response
    }
  } else {
    console.warn(`[SDK] No result message received - token usage not tracked`);
  }

  // Check for NO_RESPONSE
  const isNoResponse = response.trim() === "[NO_RESPONSE]" || response.includes("[NO_RESPONSE]");

  // Append assistant response to transcript AFTER model completes
  if (currentSessionId) {
    try {
      const finalTranscriptFile = getTranscriptPath(TRANSCRIPTS_DIR, currentSessionId);
      const assistantEntry: TranscriptEntry = {
        type: "assistant",
        content: isNoResponse ? "[NO_RESPONSE]" : response.trim(),
        timestamp: Date.now(),
        metadata: {
          channelId: options.channelId,
          responseLength: response.length,
        },
      };
      await appendToTranscript(finalTranscriptFile, assistantEntry);
      console.log(`[SDK] Appended assistant response to transcript`);
    } catch (error) {
      console.error(`[SDK] Failed to append assistant response to transcript:`, error);
      // Continue - transcript failure shouldn't block response
    }
  }

  if (isNoResponse) {
    console.log(`[SDK] Returning null (NO_RESPONSE)`);
    return null;
  }

  return response.trim() || null;
}
