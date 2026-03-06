/**
 * Haiku Conversation Router - Buffer + Classify + Route Pipeline
 *
 * When the queue is busy and multiple messages arrive, we buffer them, then use
 * a Haiku one-shot classifier to determine which belong to the same conversation
 * vs. which are genuinely new topics that should fork.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { PROJECT_DIR } from "./paths";
import { log, warn } from "./log";
import type { AgentContext, TurnResult, ContextRefreshCallback } from "./agent-types";
import { extractMessageContent } from "./agent-types";
import { getTurnQueue, enqueueMessage } from "./turn-queue";
import { executeTurn } from "./turn-executor";

// ============================================================================
// Session Forking Constants
// ============================================================================

const FORK_ELIGIBILITY_THRESHOLD_MS = 5000; // 5 seconds - queue must be busy for this long
const FORK_COOLDOWN_MS = 10000; // 10 seconds - minimum time between forks on same channel

// Track fork state per channel to prevent rapid-fire forks
const forkState = new Map<string, { lastForkTime: number; activeForks: number }>();

// ============================================================================
// Buffer Types and State
// ============================================================================

interface BufferedMessage {
  context: string;          // Discord context string
  options: AgentContext;     // Snapshot of options
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
  contextRefreshCallback?: ContextRefreshCallback;
}

interface ChannelBuffer {
  messages: BufferedMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;        // When first message was buffered
}

const channelBuffers = new Map<string, ChannelBuffer>();

const BUFFER_DEBOUNCE_MS = 2500;      // Wait for more messages after each arrival
const BUFFER_MAX_WAIT_MS = 8000;      // Hard cap - classify after 8s max
const BUFFER_MAX_MESSAGES = 8;        // Hard cap on buffered messages
const CLASSIFIER_TIMEOUT_MS = 3000;   // Haiku must respond within 3s
const MAX_CONCURRENT_FORKS = 2;       // Max parallel forks per channel

// ============================================================================
// Buffer Check
// ============================================================================

/**
 * Check if a message should be buffered for Haiku classification instead of
 * immediately queuing or forking.
 *
 * Returns true when:
 * - Queue is actively processing AND has been for >5s
 * - New message is from a different user than the current turn
 * - Not a reply to Greg (those need continuity)
 */
export function shouldBuffer(sessionKey: string, options: AgentContext): boolean {
  const queue = getTurnQueue(sessionKey);
  if (!queue) return false;

  // Must be actively processing
  if (!queue.processing) return false;

  // Must have been processing for >5 seconds
  const processingDuration = Date.now() - queue.currentTurnStartedAt;
  if (processingDuration < FORK_ELIGIBILITY_THRESHOLD_MS) return false;

  // Must be a different user than the one currently being responded to
  if (!queue.currentTurnUserId || queue.currentTurnUserId === options.userId) return false;

  // Replies to bot need conversation continuity - don't buffer
  if (options.isReplyToBot) return false;

  return true;
}

// ============================================================================
// Buffer Message
// ============================================================================

/**
 * Buffer a message for later classification and routing.
 * Returns a Promise that resolves when the message is eventually processed
 * (either queued normally or forked).
 */
export function bufferMessage(
  sessionKey: string,
  context: string,
  options: AgentContext,
  contextRefreshCallback?: ContextRefreshCallback
): Promise<TurnResult> {
  return new Promise((resolve, reject) => {
    let buffer = channelBuffers.get(sessionKey);

    if (!buffer) {
      buffer = {
        messages: [],
        timer: null,
        startedAt: Date.now(),
      };
      channelBuffers.set(sessionKey, buffer);
    }

    const bufferedMsg: BufferedMessage = {
      context,
      options: structuredClone(options),
      resolve,
      reject,
      enqueuedAt: Date.now(),
      contextRefreshCallback,
    };

    buffer.messages.push(bufferedMsg);
    log("BUFFER", `Buffered message from ${options.userId} on ${sessionKey} (${buffer.messages.length} buffered)`);

    // Clear existing debounce timer
    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }

    // Check hard limits - trigger immediately if hit
    if (buffer.messages.length >= BUFFER_MAX_MESSAGES) {
      log("BUFFER", `Hit message limit (${BUFFER_MAX_MESSAGES}), triggering classification`);
      triggerClassification(sessionKey);
      return;
    }

    const elapsed = Date.now() - buffer.startedAt;
    if (elapsed >= BUFFER_MAX_WAIT_MS) {
      log("BUFFER", `Hit time limit (${BUFFER_MAX_WAIT_MS}ms), triggering classification`);
      triggerClassification(sessionKey);
      return;
    }

    // Set debounce timer - wait for more messages
    const remainingWait = Math.min(BUFFER_DEBOUNCE_MS, BUFFER_MAX_WAIT_MS - elapsed);
    buffer.timer = setTimeout(() => {
      log("BUFFER", `Debounce expired (${remainingWait}ms), triggering classification`);
      triggerClassification(sessionKey);
    }, remainingWait);
  });
}

// ============================================================================
// Haiku Classifier
// ============================================================================

/**
 * Build the Haiku classifier prompt from buffered messages and current queue context.
 */
function buildClassifierPrompt(
  sessionKey: string,
  messages: BufferedMessage[]
): string {
  const queue = getTurnQueue(sessionKey);

  // Build message list for Haiku
  const messageList = messages.map((msg, i) => {
    const content = extractMessageContent(msg.context);
    return `[${i}] ${content}`;
  }).join("\n");

  // Get info about what the queue is currently processing
  const currentUserId = queue?.currentTurnUserId || "unknown";
  const processingDuration = queue?.currentTurnStartedAt
    ? Math.floor((Date.now() - queue.currentTurnStartedAt) / 1000)
    : 0;

  return `Messages buffered while Greg was responding (queue busy for ${processingDuration}s, responding to user ${currentUserId}):

${messageList}

Classify each message index into one of two categories:
- "queue": Messages that should wait for the main queue. This includes:
  - Follow-ups to the current conversation (agreements, reactions, "yes", "do it", "YEA", etc.)
  - Messages on a different topic that are NOT time-sensitive and can wait
  - Most messages belong here. Default to queue when uncertain.
- "fork": Groups of message indices that are genuinely separate conversations AND need an immediate response. Only fork when:
  - The message is a direct question or request to Greg about something completely unrelated
  - Waiting would make the response feel stale or unresponsive
  - NEVER fork agreement/reaction messages ("yes", "YEA", "do it", "lets go", etc.)

Output JSON only, no explanation: {"queue": [0, 1], "fork": [[2]]}
If all messages should queue: {"queue": [0, 1, 2], "fork": []}`;
}

/**
 * Call Haiku to classify buffered messages.
 * Returns classification result, or a safe default (all queue) on failure.
 */
async function classifyWithHaiku(
  sessionKey: string,
  messages: BufferedMessage[]
): Promise<{ queue: number[]; fork: number[][] }> {
  const allIndices = messages.map((_, i) => i);
  const safeDefault = { queue: allIndices, fork: [] as number[][] };

  // Single message - no need to classify, just queue it
  if (messages.length === 1) {
    return safeDefault;
  }

  const classifierPrompt = buildClassifierPrompt(sessionKey, messages);

  let responseText = "";

  try {
    // Race the classifier against a timeout
    const classifyPromise = (async () => {
      for await (const message of query({
        prompt: classifierPrompt,
        options: {
          cwd: PROJECT_DIR,
          model: "haiku",
          systemPrompt: "You classify Discord messages into queue vs fork categories. Output only valid JSON.",
          allowedTools: [], // No tools needed
        },
      })) {
        if (message.type === "assistant" && message.message?.content) {
          for (const block of message.message.content) {
            if ("text" in block) {
              responseText += block.text;
            }
          }
        }
      }
      return responseText;
    })();

    const timeoutPromise = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error("Classifier timeout")), CLASSIFIER_TIMEOUT_MS);
    });

    responseText = await Promise.race([classifyPromise, timeoutPromise]);
  } catch (err) {
    warn("CLASSIFY", `Haiku classifier failed (${err}), defaulting all to queue`);
    return safeDefault;
  }

  // Parse JSON response
  try {
    // Extract JSON from response (Haiku might add some text around it)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      warn("CLASSIFY", `No JSON found in classifier response: "${responseText.substring(0, 100)}"`);
      return safeDefault;
    }

    const parsed = JSON.parse(jsonMatch[0]) as { queue?: number[]; fork?: number[][] };

    // Validate structure
    const queueIndices = Array.isArray(parsed.queue) ? parsed.queue.filter(i => typeof i === "number" && i >= 0 && i < messages.length) : [];
    const forkGroups = Array.isArray(parsed.fork) ? parsed.fork.filter(g => Array.isArray(g)).map(g => g.filter(i => typeof i === "number" && i >= 0 && i < messages.length)).filter(g => g.length > 0) : [];

    // Ensure every index is accounted for - unclassified go to queue
    const classified = new Set([...queueIndices, ...forkGroups.flat()]);
    for (const idx of allIndices) {
      if (!classified.has(idx)) {
        queueIndices.push(idx);
      }
    }

    // Enforce max concurrent forks
    const state = forkState.get(sessionKey);
    const activeForks = state?.activeForks ?? 0;
    const availableForkSlots = MAX_CONCURRENT_FORKS - activeForks;

    if (forkGroups.length > availableForkSlots) {
      // Move excess fork groups to queue
      const excess = forkGroups.splice(availableForkSlots);
      for (const group of excess) {
        queueIndices.push(...group);
      }
      log("CLASSIFY", `Capped forks: ${forkGroups.length + excess.length} -> ${forkGroups.length} (${activeForks} active, ${MAX_CONCURRENT_FORKS} max)`);
    }

    // Check fork cooldown
    if (forkGroups.length > 0 && state) {
      const timeSinceLastFork = Date.now() - state.lastForkTime;
      if (timeSinceLastFork < FORK_COOLDOWN_MS) {
        log("CLASSIFY", `Fork cooldown active (${Math.floor(timeSinceLastFork / 1000)}s < ${FORK_COOLDOWN_MS / 1000}s), moving all forks to queue`);
        for (const group of forkGroups) {
          queueIndices.push(...group);
        }
        return { queue: queueIndices, fork: [] };
      }
    }

    log("CLASSIFY", `Classification: ${queueIndices.length} to queue, ${forkGroups.length} fork groups`);
    return { queue: queueIndices, fork: forkGroups };
  } catch (err) {
    warn("CLASSIFY", `JSON parse failed: ${err}, defaulting all to queue`);
    return safeDefault;
  }
}

// ============================================================================
// Classification Trigger and Routing
// ============================================================================

/**
 * Trigger classification of all buffered messages for a channel.
 * Takes the buffer, classifies with Haiku, then routes each message.
 */
async function triggerClassification(sessionKey: string): Promise<void> {
  const buffer = channelBuffers.get(sessionKey);
  if (!buffer || buffer.messages.length === 0) return;

  // Clear timer and take ownership of messages
  if (buffer.timer) {
    clearTimeout(buffer.timer);
  }
  const messages = [...buffer.messages];
  channelBuffers.delete(sessionKey);

  log("CLASSIFY", `Classifying ${messages.length} buffered messages for ${sessionKey}`);

  try {
    const classification = await classifyWithHaiku(sessionKey, messages);
    await routeClassifiedMessages(sessionKey, messages, classification);
  } catch (err) {
    // Ultimate fallback - queue everything normally
    warn("CLASSIFY", `Classification pipeline failed: ${err}, queuing all messages`);
    for (const msg of messages) {
      try {
        const result = await enqueueMessage(sessionKey, msg.context, msg.options, msg.contextRefreshCallback);
        msg.resolve(result);
      } catch (queueErr) {
        msg.reject(queueErr instanceof Error ? queueErr : new Error(String(queueErr)));
      }
    }
  }
}

/**
 * Route classified messages to their destinations (queue or fork).
 */
async function routeClassifiedMessages(
  sessionKey: string,
  messages: BufferedMessage[],
  classification: { queue: number[]; fork: number[][] }
): Promise<void> {
  // Route "queue" messages - enqueue normally
  for (const idx of classification.queue) {
    const msg = messages[idx];
    if (!msg) continue;

    log("ROUTE", `Message [${idx}] from ${msg.options.userId} -> queue`);
    // Use enqueueMessage which will trigger drainQueue if needed
    enqueueMessage(sessionKey, msg.context, msg.options, msg.contextRefreshCallback)
      .then(result => msg.resolve(result))
      .catch(err => msg.reject(err instanceof Error ? err : new Error(String(err))));
  }

  // Route "fork" groups - each group gets a forked session
  for (const group of classification.fork) {
    if (group.length === 0) continue;

    // Pick first message as representative for the fork
    const representative = messages[group[0]];
    if (!representative) continue;

    log("ROUTE", `Fork group [${group.join(", ")}] -> forking with representative from ${representative.options.userId}`);

    // Track active fork
    const state = forkState.get(sessionKey) || { lastForkTime: 0, activeForks: 0 };
    state.activeForks++;
    state.lastForkTime = Date.now();
    forkState.set(sessionKey, state);

    // Execute fork and resolve all messages in the group with the same response
    (async () => {
      try {
        const forkResult = await executeTurn(
          representative.context,
          representative.options,
          { mode: "fork" }
        );

        switch (forkResult.kind) {
          case "response":
            // Fork succeeded with a response - resolve all messages in the group
            for (const idx of group) {
              const msg = messages[idx];
              if (msg) msg.resolve(forkResult);
            }
            break;
          case "no_response":
          case "skipped":
          case "error":
            // Fork didn't produce a usable response - fall back to queue
            log("ROUTE", `Fork returned ${forkResult.kind} for group [${group.join(", ")}], falling back to queue`);
            for (const idx of group) {
              const msg = messages[idx];
              if (!msg) continue;
              enqueueMessage(sessionKey, msg.context, msg.options, msg.contextRefreshCallback)
                .then(result => msg.resolve(result))
                .catch(queueErr => msg.reject(queueErr instanceof Error ? queueErr : new Error(String(queueErr))));
            }
            break;
          default: {
            const _exhaustive: never = forkResult;
            warn("ROUTE", `Unhandled TurnResult kind from fork: ${JSON.stringify(_exhaustive)}`);
          }
        }
      } catch (err) {
        // Unexpected error - fall back to queue for all messages in the group
        warn("ROUTE", `Fork failed for group [${group.join(", ")}], falling back to queue: ${err}`);
        for (const idx of group) {
          const msg = messages[idx];
          if (!msg) continue;
          enqueueMessage(sessionKey, msg.context, msg.options, msg.contextRefreshCallback)
            .then(result => msg.resolve(result))
            .catch(queueErr => msg.reject(queueErr instanceof Error ? queueErr : new Error(String(queueErr))));
        }
      } finally {
        // Release fork slot
        const s = forkState.get(sessionKey);
        if (s) s.activeForks = Math.max(0, s.activeForks - 1);
      }
    })();
  }
}
