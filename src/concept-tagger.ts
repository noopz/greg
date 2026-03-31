/**
 * Concept Tagger
 *
 * Processes transcript messages in non-overlapping windows of 10,
 * sends each window to Haiku for thread detection + concept tagging,
 * and stores results in the concept tables.
 *
 * Used by the concept-tagging idle skill.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { PROJECT_DIR } from "./paths";
import { log, error as logError } from "./log";
import { recordCost } from "./cost-tracker";
import {
  getConceptCursor,
  setConceptCursor,
  getMessagesAfter,
  insertTaggedThread,
  getExistingConceptNames,
} from "./transcript-index";

const WINDOW_SIZE = 10;
const HAIKU_TIMEOUT_MS = 15_000;

const TAGGER_SYSTEM_PROMPT = `You identify conversation threads and tag them with concepts.
Respond ONLY with valid JSON. No markdown, no explanation.`;

interface HaikuThread {
  messages: number[];
  concepts: string[];
}

interface HaikuResponse {
  threads: HaikuThread[];
}

/**
 * Call Haiku to identify threads and concepts in a window of messages.
 */
interface TagWindowResult {
  response: HaikuResponse;
  cost: number;
}

async function tagWindow(
  messages: Array<{ index: number; author: string; content: string }>,
  existingConcepts: string[],
): Promise<TagWindowResult | null> {
  const formatted = messages
    .map((m) => `[${m.index}] ${m.author}: ${m.content}`)
    .join("\n");

  const conceptList = existingConcepts.length > 0
    ? `\nExisting concepts (STRONGLY prefer reusing these over inventing new ones):\n${existingConcepts.join(", ")}\n\nOnly create a new concept if NONE of the above fit. New concepts should be broad and reusable — not specific to this one conversation.`
    : "";

  const prompt = `These are ${messages.length} consecutive messages from a group chat. Multiple conversations may be interleaved. Identify distinct conversation threads, tag each with 1-4 concept labels.

A message can belong to multiple threads. Labels should be broad, reusable categories — think "what folder would I file this under?" not "what is this specific conversation about."
${conceptList}

${formatted}

Respond as JSON:
{"threads": [{"messages": [1, 3, 5], "concepts": ["concept-a", "concept-b"]}]}`;

  let responseText = "";
  let cost = 0;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), HAIKU_TIMEOUT_MS);

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: PROJECT_DIR,
        model: "haiku",
        systemPrompt: TAGGER_SYSTEM_PROMPT,
        allowedTools: [],
        abortController,
      },
    })) {
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block) {
            responseText += block.text;
          }
        }
      }
      // Capture cost from result message
      cost = (message as { total_cost_usd?: number }).total_cost_usd ?? cost;
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      logError("CONCEPT", "Haiku tagger timed out");
    } else {
      logError("CONCEPT", "Haiku tagger failed", err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }

  // Parse JSON — strip markdown fences if Haiku wraps it
  try {
    const cleaned = responseText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned) as HaikuResponse;
    if (!parsed.threads || !Array.isArray(parsed.threads)) return null;

    // Validate structurally — don't trust LLM self-reported confidence
    const validated = validateTaggerResponse(parsed, messages.length);
    if (validated.threads.length === 0) {
      log("CONCEPT", `All threads in window failed validation, skipping`);
      return null;
    }
    if (validated.threads.length < parsed.threads.length) {
      log("CONCEPT", `Filtered ${parsed.threads.length - validated.threads.length}/${parsed.threads.length} invalid threads`);
    }
    return { response: validated, cost };
  } catch {
    logError("CONCEPT", `Failed to parse Haiku response: ${responseText.substring(0, 200)}`);
    return null;
  }
}

/** Validate tagger response structurally. Filters out invalid threads. */
function validateTaggerResponse(response: HaikuResponse, windowSize: number): HaikuResponse {
  const validThreads = response.threads.filter((thread) => {
    // Message indices must be in range [1, windowSize]
    if (!thread.messages || !Array.isArray(thread.messages)) return false;
    const validIndices = thread.messages.every((i) => typeof i === "number" && i >= 1 && i <= windowSize);
    if (!validIndices) return false;

    // Must have at least 1 message and 1 concept
    if (thread.messages.length === 0) return false;
    if (!thread.concepts || !Array.isArray(thread.concepts) || thread.concepts.length === 0) return false;

    // Concepts must be reasonable strings (2-50 chars, lowercase alphanum + hyphens)
    thread.concepts = thread.concepts
      .map((c) => String(c).toLowerCase().trim().replace(/\s+/g, "-"))
      .filter((c) => c.length >= 2 && c.length <= 50 && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(c));
    if (thread.concepts.length === 0) return false;

    // Cap at 4 concepts per thread
    thread.concepts = thread.concepts.slice(0, 4);

    return true;
  });

  return { threads: validThreads };
}

/**
 * Process pending messages and tag them with concepts.
 * Returns the number of windows processed.
 * @internal Runtime-invoked by concept-tagging idle skill, not statically imported.
 */
export async function tagPendingConcepts(batchSize: number = 20): Promise<number> {
  const cursor = getConceptCursor();

  // Fetch messages after cursor (get more than we need to form windows)
  const messages = getMessagesAfter(cursor, batchSize * WINDOW_SIZE);
  if (messages.length === 0) {
    log("CONCEPT", "No new messages to tag");
    return 0;
  }

  // Only tag messages older than 5 minutes (let threads settle)
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const settled = messages.filter((m) => Number(m.timestamp) < fiveMinAgo);
  if (settled.length === 0) {
    log("CONCEPT", "All new messages are too recent (< 5 min), waiting");
    return 0;
  }

  // Group by channel
  const byChannel = new Map<string, typeof settled>();
  for (const msg of settled) {
    const arr = byChannel.get(msg.channel_id) ?? [];
    arr.push(msg);
    byChannel.set(msg.channel_id, arr);
  }

  let windowsProcessed = 0;
  let totalCost = 0;
  // Track per-channel max timestamp to avoid skipping messages in later channels
  const perChannelMaxTs: number[] = [];

  // Fetch existing concepts for reuse — refreshed after each window
  let existingConcepts = getExistingConceptNames(50);

  for (const [channelId, channelMsgs] of byChannel) {
    // Sort by timestamp
    channelMsgs.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    let channelMax = cursor;

    // Form non-overlapping windows
    for (let i = 0; i < channelMsgs.length && windowsProcessed < batchSize; i += WINDOW_SIZE) {
      const window = channelMsgs.slice(i, i + WINDOW_SIZE);
      if (window.length < 2) continue; // Skip windows with < 2 messages

      // Build indexed messages for Haiku
      const indexed = window.map((m, idx) => ({
        index: idx + 1,
        author: m.author.split("@")[0] || m.author, // Strip Discord ID for cleaner prompt
        content: m.content.substring(0, 300), // Truncate long messages
      }));

      const tagResult = await tagWindow(indexed, existingConcepts);
      if (!tagResult) continue;

      totalCost += tagResult.cost;

      // Store each thread
      for (const thread of tagResult.response.threads) {
        if (!thread.messages || !thread.concepts || thread.concepts.length === 0) continue;

        // Map Haiku's 1-indexed message references back to actual messages
        const threadMsgs = thread.messages
          .filter((idx) => idx >= 1 && idx <= window.length)
          .map((idx) => window[idx - 1]);

        if (threadMsgs.length === 0) continue;

        const timestamps = threadMsgs.map((m) => m.timestamp);
        const participants = [...new Set(threadMsgs.map((m) => m.author.split("@")[0] || m.author))].join(",");
        const tsStart = timestamps.reduce((a, b) => (a < b ? a : b));
        const tsEnd = timestamps.reduce((a, b) => (a > b ? a : b));

        insertTaggedThread(channelId, tsStart, tsEnd, participants, thread.concepts, timestamps);
      }

      // Refresh concepts so the next window can reuse what we just stored
      existingConcepts = getExistingConceptNames(50);

      // Track highest timestamp in this channel's processed windows
      const windowMax = Number(window[window.length - 1].timestamp);
      if (windowMax > channelMax) channelMax = windowMax;

      windowsProcessed++;
    }

    if (channelMax > cursor) perChannelMaxTs.push(channelMax);
  }

  // Advance cursor to the MINIMUM of per-channel maximums.
  // This ensures we never skip unprocessed messages in a channel that
  // wasn't fully processed due to batchSize limits.
  if (perChannelMaxTs.length > 0) {
    const safeCursor = Math.min(...perChannelMaxTs);
    setConceptCursor(safeCursor);
    log("CONCEPT", `Tagged ${windowsProcessed} windows, cost: $${totalCost.toFixed(4)} (cursor: ${cursor} → ${safeCursor})`);
  } else {
    log("CONCEPT", `Tagged ${windowsProcessed} windows (cursor unchanged: ${cursor})`);
  }

  if (totalCost > 0) {
    recordCost("concept-tagger", totalCost, 0, 0);
  }

  return windowsProcessed;
}
