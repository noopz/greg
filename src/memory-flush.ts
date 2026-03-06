/**
 * Memory Flush Before Compaction
 *
 * When context approaches capacity, Greg saves important memories to disk
 * before SDK auto-compaction. This preserves context that would otherwise be lost.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs/promises";
import { PROJECT_DIR, TRANSCRIPTS_DIR, localDate } from "./paths";
import {
  appendToTranscript,
  getTranscriptPath,
  type SessionData,
} from "./persistence";
import { log, warn, error as logError } from "./log";
import { loadSessionData, saveSessionData } from "./session-manager";
import type { SessionId } from "./agent-types";
import { BOT_NAME } from "./config/identity";

// Track if a memory flush is currently running (to avoid starting multiple)
let memoryFlushInProgress = false;

// After a successful memory flush, start a fresh session to avoid SDK auto-compaction delay
let shouldStartFreshSession = false;

// Constants
const SOFT_THRESHOLD_TOKENS = 140000; // 140k tokens - trigger memory flush (raised from 116k to reduce unnecessary flushes)
const MEMORY_FLUSH_BUFFER = 10000; // Minimum tokens to accumulate before re-triggering flush

/** Check if a fresh session should be started (set after memory flush completes) */
export function getShouldStartFreshSession(): boolean {
  return shouldStartFreshSession;
}

/** Clear the fresh session flag (called when a fresh session is actually started) */
export function clearShouldStartFreshSession(): void {
  shouldStartFreshSession = false;
}

/**
 * Read recent entries from a transcript file for memory flush context.
 * Returns last N user/assistant entries formatted as conversation summary.
 */
async function getRecentTranscriptSummary(
  sessionId: SessionId,
  maxEntries: number = 30
): Promise<string> {
  const transcriptFile = getTranscriptPath(TRANSCRIPTS_DIR, sessionId);

  try {
    const content = await fs.readFile(transcriptFile, "utf-8");
    const lines = content.trim().split("\n").filter(line => line.trim());

    // Parse entries, filter to user/assistant only
    const entries: Array<{ type: string; content: string; timestamp: number }> = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "user" || entry.type === "assistant") {
          entries.push(entry);
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Take last N entries
    const recent = entries.slice(-maxEntries);

    if (recent.length === 0) {
      return "No recent conversation to review.";
    }

    // Format as readable summary
    return recent.map(entry => {
      const role = entry.type === "user" ? "[User/Discord]" : `[${BOT_NAME}]`;
      // Truncate long content
      const content = entry.content.length > 500
        ? entry.content.substring(0, 500) + "..."
        : entry.content;
      return `${role}: ${content}`;
    }).join("\n\n");
  } catch (error) {
    warn("SDK", `Failed to read transcript for memory flush: ${error}`);
    return "Could not load conversation history.";
  }
}

const MEMORY_FLUSH_PROMPT_TEMPLATE = (recentConversation: string) => `Self-learning checkpoint. Your context is approaching capacity - time to consolidate what you've learned.

## RECENT CONVERSATION (last ~30 exchanges)
${recentConversation}

---

Review the conversation above and update your knowledge:

1. **Memories** (agent-data/memories/${localDate()}.md)
   - Key facts, events, or information worth remembering
   - Append, don't overwrite

2. **Relationships** (agent-data/relationships/<user-id>.md)
   - New things learned about specific people
   - Communication preferences, boundaries, interests
   - Notable interactions (positive or negative)

3. **Patterns** (agent-data/learned-patterns.md)
   - What responses worked well? What fell flat?
   - New insights about the group dynamics
   - Mistakes to avoid repeating

4. **Impressions** (agent-data/impressions/<user-id>.jsonl)
   - Significant relationship moments (format: {"who", "what", "when", "weight", "context_type"})
   - Only log meaningful moments, not routine exchanges

Think about: What would future-you want to know from this conversation?

If genuinely nothing worth saving, reply: [NO_REPLY]`;

/**
 * Check if memory flush should be triggered based on token usage.
 * Triggers when we cross the soft threshold AND have accumulated enough new tokens since last flush.
 */
export async function shouldTriggerMemoryFlush(sessionData: SessionData): Promise<boolean> {
  const totalTokens = sessionData.totalTokens ?? 0;
  const lastFlushTokenCount = sessionData.lastMemoryFlushTokenCount ?? 0;

  // Check if we're above the soft threshold
  const aboveThreshold = totalTokens >= SOFT_THRESHOLD_TOKENS;

  // Check if we've accumulated enough tokens since the last flush
  const accumulatedSinceLastFlush = totalTokens - lastFlushTokenCount;
  const hasEnoughNewTokens = accumulatedSinceLastFlush >= MEMORY_FLUSH_BUFFER;

  if (aboveThreshold && hasEnoughNewTokens) {
    log("SDK", `Memory flush triggered: ${totalTokens} tokens (threshold: ${SOFT_THRESHOLD_TOKENS}, last flush at: ${lastFlushTokenCount})`);
    return true;
  }

  return false;
}

/**
 * Execute a memory flush turn - runs in background, doesn't block queue.
 * Gives the agent a chance to save important memories before compaction.
 */
export async function executeMemoryFlush(): Promise<void> {
  if (memoryFlushInProgress) {
    log("SDK", "Memory flush already in progress, skipping");
    return;
  }

  memoryFlushInProgress = true;
  log("SDK", "Starting memory flush in background...");

  const sessionData = await loadSessionData();
  if (!sessionData?.sessionId) {
    warn("SDK", "Cannot execute memory flush: no session data");
    return;
  }

  // Mark the current token count so we can re-trigger after accumulating more tokens
  const currentTokens = sessionData.totalTokens ?? 0;
  await saveSessionData({
    ...sessionData,
    lastMemoryFlushTokenCount: currentTokens,
    updatedAt: Date.now(),
  });

  // Get recent conversation summary (NOT resuming session - much cheaper!)
  const recentConversation = await getRecentTranscriptSummary(sessionData.sessionId, 30);
  const memoryFlushPrompt = MEMORY_FLUSH_PROMPT_TEMPLATE(recentConversation);

  // Build minimal context for memory flush
  const today = localDate();

  let response = "";

  // Build minimal system prompt for memory flush (much cheaper than claude_code preset)
  const cwd = PROJECT_DIR;
  const memoryFlushSystemPrompt = `You are ${BOT_NAME}'s memory system. Your job is to save important information before context compaction.

## Tools Available
- **Read**: Read files (use absolute paths based on working directory: ${cwd})
- **Write**: Create or overwrite files
- **Edit**: Make targeted edits to files

## File Locations
- ${cwd}/agent-data/memories/ - Store important memories
- ${cwd}/agent-data/impressions/ - Store impressions of people
- ${cwd}/agent-data/learned-patterns.md - Update learned patterns
- ${cwd}/agent-data/relationships/ - Update relationship files

## CURRENT TIME
- Date: ${today}
- Time: ${new Date().toLocaleTimeString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})

Be efficient - only update files if there's something genuinely new to record. Reply [NO_REPLY] if nothing worth saving.`;

  try {
    // Run ISOLATED - no resume! This dramatically reduces cost from ~$0.80 to ~$0.05
    for await (const message of query({
      prompt: memoryFlushPrompt,
      options: {
        cwd: PROJECT_DIR,
        model: "sonnet", // Isolated session — only needs to save memories, not converse
        // NO resume - run isolated with just the recent transcript summary
        systemPrompt: memoryFlushSystemPrompt,
        settingSources: ["project"],
        allowedTools: ["Read", "Write", "Edit"],
      },
    })) {
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block) {
            // Add newline between text blocks
            if (response.length > 0 && !response.endsWith("\n")) {
              response += "\n\n";
            }
            response += block.text;
          } else if ("name" in block) {
            log("SDK", `Memory flush tool call: ${block.name}`);
          }
        }
      } else if (message.type === "result") {
        // Log memory flush cost (don't update main session - this is isolated)
        const usage = message.usage;
        if (usage) {
          const inputTokens = usage.input_tokens || 0;
          const outputTokens = usage.output_tokens || 0;
          const cacheRead = usage.cache_read_input_tokens || 0;
          const cacheHitRate = inputTokens > 0 ? ((cacheRead / inputTokens) * 100).toFixed(1) : "0";
          log("SDK", `Memory flush billing: ${inputTokens} input, ${outputTokens} output (${cacheHitRate}% cache)`);
        }
      }
    }

    const isNoReply = response.trim() === "[NO_REPLY]" || response.includes("[NO_REPLY]");
    if (isNoReply) {
      log("SDK", "Memory flush complete: nothing to store");
    } else {
      log("SDK", "Memory flush complete: memories saved");
    }

    // Signal that the next turn should start a fresh session instead of resuming
    // This avoids the ~30s SDK auto-compaction delay that would happen if context keeps growing
    shouldStartFreshSession = true;
    log("SDK", "Will start fresh session on next turn (avoiding compaction delay)");

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
  } catch (err) {
    logError("SDK", "Memory flush failed", err);
    // Don't throw - we don't want memory flush failure to block normal operation
  } finally {
    memoryFlushInProgress = false;
    log("SDK", "Memory flush finished");
  }
}
