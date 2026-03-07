/**
 * Turn Queue - Concurrency Control & Message Batching
 *
 * Owns ALL mutable queue state. Single source of truth for turn management.
 * Uses registerTurnExecutor pattern to call executeAgentTurn without importing agent.ts.
 */

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { log, warn, error as logError } from "./log";
import { loadSessionData } from "./session-manager";
import {
  shouldTriggerMemoryFlush,
  executeMemoryFlush,
} from "./memory-flush";
import type { AgentContext, TurnResult, ContextRefreshCallback, SessionId, UserId } from "./agent-types";
import { isNudgeMessage, extractMessageContent, resolveUser } from "./agent-types";
import type { TypingCallback } from "./streaming-session";

// ============================================================================
// Types
// ============================================================================

type QueuedTurn = {
  context: string;
  options: AgentContext;
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
  contextRefreshCallback?: ContextRefreshCallback;
  typingCallback?: TypingCallback;
  mergeCount: number;
};

export type TurnQueue = {
  items: QueuedTurn[];
  processing: boolean;
  lastProcessedAt: number;
  currentTurnStartedAt: number;
  currentTurnUserId?: UserId;
};

/** Executor function signature for processing a turn */
export type TurnExecutor = (
  discordContext: string,
  options: AgentContext,
  contextRefreshCallback?: ContextRefreshCallback,
  typingCallback?: TypingCallback
) => Promise<TurnResult>;

/** Buffer check function signature (injected to avoid circular dep with haiku-router) */
type BufferCheck = (sessionKey: string, options: AgentContext) => boolean;
type BufferAction = (
  sessionKey: string,
  context: string,
  options: AgentContext,
  contextRefreshCallback?: ContextRefreshCallback
) => Promise<TurnResult>;

// ============================================================================
// Configuration
// ============================================================================

const SAME_USER_DEBOUNCE_MS = 3_000;
const DEFAULT_DEBOUNCE_MS = 500;
const MAX_MERGED_MESSAGES = 5;
const MAX_MERGED_CONTENT_LENGTH = 2000;
const STALE_QUEUE_THRESHOLD_MS = 5 * 60 * 1000;
const CANCEL_TTL_MS = 5 * 60 * 1000;
const RETRY_DELAY_MS = 2_000;

/**
 * Detect transient errors worth retrying (API 500s, SDK process crashes).
 * Conservative — only retries errors that look like server-side transients,
 * not config errors or permission failures.
 */
function isTransientError(error: Error): boolean {
  const msg = error.message;
  // SDK process crash (covers API 500/502/503 that kill the process)
  if (/exited with code [1-9]/.test(msg)) return true;
  // Explicit HTTP status codes in error messages
  if (/\b(500|502|503|529)\b/.test(msg)) return true;
  // Anthropic overload
  if (/overloaded/i.test(msg)) return true;
  // Streaming session stalls and unexpected closures
  if (/SDK stalled/.test(msg)) return true;
  if (/^Session closed$/.test(msg)) return true;
  if (/Session ended unexpectedly/.test(msg)) return true;
  return false;
}

// ============================================================================
// Mutable State
// ============================================================================

let currentSessionId: SessionId | undefined;

// Cancelled message tracking (messageId → timestamp)
const cancelledMessages = new Map<string, number>();
const TURN_QUEUES = new Map<string, TurnQueue>();

// Greg Tools MCP server - set once at startup, used by all agent executions
let toolsServer: McpSdkServerConfigWithInstance | null = null;

// Registered executor (set by agent.ts at import time)
let registeredExecutor: TurnExecutor | null = null;

// Registered buffer functions (set by agent.ts to avoid haiku-router circular dep)
let registeredBufferCheck: BufferCheck | null = null;
let registeredBufferAction: BufferAction | null = null;

// ============================================================================
// Registration (dependency injection to avoid circular imports)
// ============================================================================

/** Register the turn executor function (called once from agent.ts) */
export function registerTurnExecutor(executor: TurnExecutor): void {
  registeredExecutor = executor;
}

/** Register the buffer check/action functions (called once from agent.ts) */
export function registerBufferFunctions(check: BufferCheck, action: BufferAction): void {
  registeredBufferCheck = check;
  registeredBufferAction = action;
}

// ============================================================================
// Custom Tools MCP Server State
// ============================================================================

export function setToolsServer(server: McpSdkServerConfigWithInstance | null): void {
  toolsServer = server;
}

export function getToolsServer(): McpSdkServerConfigWithInstance | null {
  return toolsServer;
}

// ============================================================================
// Session ID State
// ============================================================================

export function getCurrentSessionId(): SessionId | undefined {
  return currentSessionId;
}

export function setCurrentSessionId(id: SessionId | undefined): void {
  currentSessionId = id;
}

// ============================================================================
// Queue Accessors
// ============================================================================

export function getTurnQueue(sessionKey: string): TurnQueue | undefined {
  return TURN_QUEUES.get(sessionKey);
}

export function isAgentBusy(): boolean {
  for (const queue of TURN_QUEUES.values()) {
    if (queue.processing || queue.items.length > 0) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// Message Cancellation
// ============================================================================

export function cancelMessage(messageId: string): void {
  cancelledMessages.set(messageId, Date.now());
  // Clean up old entries
  const cutoff = Date.now() - CANCEL_TTL_MS;
  for (const [id, ts] of cancelledMessages) {
    if (ts < cutoff) cancelledMessages.delete(id);
  }
  // Also remove from queue if still pending
  for (const queue of TURN_QUEUES.values()) {
    const idx = queue.items.findIndex(t => t.options.originalMessageId === messageId);
    if (idx !== -1) {
      const removed = queue.items.splice(idx, 1)[0];
      removed.resolve({ kind: "skipped", reason: "message deleted" });
      log("SDK", `Cancelled queued turn for deleted message ${messageId}`);
    }
  }
}

export function isMessageCancelled(messageId: string | undefined): boolean {
  if (!messageId) return false;
  return cancelledMessages.has(messageId);
}

/**
 * Cancel a queued turn for an edited message. Unlike cancelMessage, this does NOT
 * add to cancelledMessages — if the turn is already processing, let it finish
 * (the edit was probably a typo fix). Returns true if a queued turn was removed.
 */
export function cancelQueuedMessage(messageId: string): boolean {
  for (const queue of TURN_QUEUES.values()) {
    const idx = queue.items.findIndex(t => t.options.originalMessageId === messageId);
    if (idx !== -1) {
      const removed = queue.items.splice(idx, 1)[0];
      removed.resolve({ kind: "skipped", reason: "message edited" });
      log("SDK", `Cancelled queued turn for edited message ${messageId}`);
      return true;
    }
  }
  return false;
}

// ============================================================================
// Queue Implementation
// ============================================================================

function getSessionKey(options: AgentContext): string {
  return options.channelId || "idle";
}

function getOrCreateQueue(sessionKey: string): TurnQueue {
  let queue = TURN_QUEUES.get(sessionKey);
  if (!queue) {
    queue = {
      items: [],
      processing: false,
      lastProcessedAt: 0,
      currentTurnStartedAt: 0,
      currentTurnUserId: undefined,
    };
    TURN_QUEUES.set(sessionKey, queue);
  }
  return queue;
}

function checkStaleQueues(): void {
  const now = Date.now();
  for (const [sessionKey, queue] of TURN_QUEUES.entries()) {
    if (queue.items.length > 0 && !queue.processing) {
      const oldestItem = queue.items[0];
      const waitTime = now - oldestItem.enqueuedAt;
      if (waitTime > STALE_QUEUE_THRESHOLD_MS) {
        warn("SDK", `Stale queue detected for session "${sessionKey}". Oldest item waiting for ${Math.floor(waitTime / 1000)}s. Queue depth: ${queue.items.length}, processing: ${queue.processing}`);
      }
    }

    if (queue.processing && queue.currentTurnStartedAt > 0) {
      const currentTurnDuration = now - queue.currentTurnStartedAt;
      const EXCESSIVE_TURN_THRESHOLD_MS = 10 * 60 * 1000;
      if (currentTurnDuration > EXCESSIVE_TURN_THRESHOLD_MS) {
        warn("SDK", `Queue "${sessionKey}" current turn running for ${Math.floor(currentTurnDuration / 1000)}s (may be stuck)`);
      }
    }
  }
}

/**
 * Enqueue a message for processing.
 * Returns a Promise that resolves when the turn completes.
 */
export function enqueueMessage(
  sessionKey: string,
  context: string,
  options: AgentContext,
  contextRefreshCallback?: ContextRefreshCallback,
  typingCallback?: TypingCallback
): Promise<TurnResult> {
  return new Promise((resolve, reject) => {
    const queue = getOrCreateQueue(sessionKey);

    const turn: QueuedTurn = {
      context,
      options: structuredClone(options),
      resolve,
      reject,
      enqueuedAt: Date.now(),
      contextRefreshCallback,
      typingCallback,
      mergeCount: 1,
    };

    queue.items.push(turn);
    log("QUEUE", `Enqueued msg=${options.originalMessageId ?? "unknown"} user=${resolveUser(options.userId)} session="${sessionKey}" (depth: ${queue.items.length})`);

    checkStaleQueues();

    if (!queue.processing) {
      drainQueue(sessionKey);
    }
  });
}

async function drainQueue(sessionKey: string): Promise<void> {
  const queue = TURN_QUEUES.get(sessionKey);
  if (!queue || queue.processing) {
    return;
  }

  if (!registeredExecutor) {
    warn("SDK", "No turn executor registered - cannot drain queue");
    return;
  }

  const executor = registeredExecutor;
  queue.processing = true;

  try {
    while (queue.items.length > 0) {
      const turn = queue.items.shift()!;
      const waitTime = Date.now() - turn.enqueuedAt;
      const turnMsgId = turn.options.originalMessageId ?? "unknown";
      const turnUserId = turn.options.userId ?? "unknown";

      queue.currentTurnStartedAt = Date.now();
      queue.currentTurnUserId = turn.options.userId;

      log("QUEUE", `Processing turn msg=${turnMsgId} user=${resolveUser(turnUserId)} session=${sessionKey}${waitTime > 1000 ? ` (waited ${Math.floor(waitTime / 1000)}s)` : ""} remaining=${queue.items.length}`);

      // Skip turns for cancelled messages (deleted/edited while queued)
      if (isMessageCancelled(turn.options.originalMessageId)) {
        log("QUEUE", `Skipping cancelled msg=${turnMsgId}`);
        turn.resolve({ kind: "skipped", reason: "message deleted" });
        continue;
      }

      // Coalesce same-user messages waiting in the queue.
      // Rapid-fire messages (e.g. "no" / "NO" / "NOO" / "greg cant read that")
      // arrive as separate queue entries. Merge them into one turn using the
      // latest context (which includes all prior messages from Discord).
      while (queue.items.length > 0) {
        const next = queue.items[0];
        if (next.options.userId !== turn.options.userId) break;

        queue.items.shift();

        const nextMsgId = next.options.originalMessageId ?? "unknown";

        // Skip cancelled messages during coalescing
        if (isMessageCancelled(next.options.originalMessageId)) {
          next.resolve({ kind: "skipped", reason: "message deleted" });
          log("QUEUE", `Coalesce: skipped cancelled msg=${nextMsgId}`);
          continue;
        }

        // Use the latest context (includes all previous messages from Discord)
        turn.context = next.context;
        turn.mergeCount += next.mergeCount;

        // Inherit response-forcing flags from any merged message
        if (next.options.mustRespond) turn.options.mustRespond = true;
        if (next.options.isReplyToBot) turn.options.isReplyToBot = true;
        if (next.options.isFollowUp) turn.options.isFollowUp = true;

        // Use latest contextRefreshCallback (most recent timestamp)
        if (next.contextRefreshCallback) {
          turn.contextRefreshCallback = next.contextRefreshCallback;
        }

        // Primary turn handles delivery; coalesced messages resolve as skipped
        // to avoid duplicate sends from their own executePipeline callers.
        next.resolve({ kind: "skipped", reason: "coalesced" });

        log("QUEUE", `Coalesced msg=${nextMsgId} into msg=${turnMsgId} (${turn.mergeCount} total)`);
      }

      // Check if memory flush should be triggered - runs in background, doesn't block
      try {
        const sessionData = await loadSessionData();
        if (sessionData && await shouldTriggerMemoryFlush(sessionData)) {
          executeMemoryFlush().catch(err => {
            logError("SDK", "Background memory flush failed", err);
          });
        }
      } catch (err) {
        logError("SDK", "Memory flush check failed", err);
      }

      let result = await executor(turn.context, turn.options, turn.contextRefreshCallback, turn.typingCallback);

      // Retry once on transient errors (API 500s, SDK crashes) or empty responses
      // when we're obligated to respond (mustRespond = direct mention/name/reply)
      const shouldRetry =
        (result.kind === "error" && isTransientError(result.error)) ||
        (result.kind === "skipped" && result.reason === "empty after sanitize" && turn.options.mustRespond);

      if (shouldRetry) {
        const reason = result.kind === "error" ? "transient error" : "empty response on mustRespond";
        warn("QUEUE", `Retrying msg=${turnMsgId}: ${reason}`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        result = await executor(turn.context, turn.options, turn.contextRefreshCallback, turn.typingCallback);
        if (result.kind === "error" || (result.kind === "skipped" && result.reason === "empty after sanitize")) {
          logError("QUEUE", `Retry also failed for msg=${turnMsgId}`, result.kind === "error" ? result.error : undefined);
        } else {
          log("QUEUE", `Retry succeeded for msg=${turnMsgId}`);
        }
      }

      switch (result.kind) {
        case "response":
          log("QUEUE", `Turn done msg=${turnMsgId} → response (${result.text.length} chars)`);
          break;
        case "no_response":
          log("QUEUE", `Turn done msg=${turnMsgId} → no_response`);
          break;
        case "skipped":
          log("QUEUE", `Turn done msg=${turnMsgId} → skipped: ${result.reason}`);
          break;
        case "error":
          logError("QUEUE", `Turn done msg=${turnMsgId} → error`, result.error);
          break;
        default: {
          const _exhaustive: never = result;
          logError("QUEUE", `Unhandled TurnResult kind: ${JSON.stringify(_exhaustive)}`);
        }
      }
      turn.resolve(result);

      queue.lastProcessedAt = Date.now();
    }
  } finally {
    queue.processing = false;
  }
}

/**
 * Enqueue with debounce - merges rapid messages within debounceMs.
 * Both callers will receive the same response.
 * Also checks for buffer eligibility - if queue is busy and message is from a
 * different user, we buffer it for Haiku classification before routing.
 */
export async function enqueueWithDebounce(
  sessionKey: string,
  context: string,
  options: AgentContext,
  debounceMs = 500,
  contextRefreshCallback?: ContextRefreshCallback,
  typingCallback?: TypingCallback
): Promise<TurnResult> {
  const queue = getOrCreateQueue(sessionKey);

  // Drop "nudge" messages when the queue is already processing a turn from the same user
  if (queue.processing && queue.currentTurnUserId === options.userId) {
    const lastLine = extractMessageContent(context);
    if (isNudgeMessage(lastLine)) {
      log("QUEUE", `Dropping nudge msg=${options.originalMessageId ?? "unknown"} from ${resolveUser(options.userId)} (already processing their turn): "${lastLine.substring(0, 60)}"`);
      return { kind: "skipped", reason: "nudge while processing" };
    }
  }

  // Check if this message should be buffered for Haiku classification
  if (registeredBufferCheck && registeredBufferAction && registeredBufferCheck(sessionKey, options)) {
    log("QUEUE", `[BUFFER] Buffering msg=${options.originalMessageId ?? "unknown"} from ${resolveUser(options.userId)} for classification`);
    return registeredBufferAction(sessionKey, context, options, contextRefreshCallback);
  }

  return new Promise((resolve, reject) => {
    const lastItem = queue.items[queue.items.length - 1];

    const isSameUser = lastItem?.options.userId === options.userId;
    const debounceWindow = isSameUser ? SAME_USER_DEBOUNCE_MS : DEFAULT_DEBOUNCE_MS;

    const withinMergeLimit = lastItem && lastItem.mergeCount < MAX_MERGED_MESSAGES;
    const withinCharLimit = lastItem && (lastItem.context.length + context.length) <= MAX_MERGED_CONTENT_LENGTH;
    const canMerge = lastItem &&
                     isSameUser &&
                     Date.now() - lastItem.enqueuedAt < debounceWindow &&
                     withinMergeLimit &&
                     withinCharLimit;

    if (canMerge) {
      lastItem.context += "\n" + context;
      lastItem.mergeCount += 1;

      if (contextRefreshCallback) {
        lastItem.contextRefreshCallback = contextRefreshCallback;
      }
      if (typingCallback) {
        lastItem.typingCallback = typingCallback;
      }

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

      log("QUEUE", `Debounce-merged msg=${options.originalMessageId ?? "unknown"} into queued msg=${lastItem.options.originalMessageId ?? "unknown"} session="${sessionKey}" (${lastItem.mergeCount} messages, ${lastItem.context.length} chars)`);
      return;
    }

    if (lastItem && Date.now() - lastItem.enqueuedAt < SAME_USER_DEBOUNCE_MS) {
      const newMsgId = options.originalMessageId ?? "unknown";
      const queuedMsgId = lastItem.options.originalMessageId ?? "unknown";
      if (!isSameUser) {
        log("QUEUE", `Not merging msg=${newMsgId}: different user (${resolveUser(lastItem.options.userId)} vs ${resolveUser(options.userId)}), queued=${queuedMsgId}`);
      } else if (!withinMergeLimit) {
        log("QUEUE", `Not merging msg=${newMsgId}: hit message limit (${lastItem.mergeCount}/${MAX_MERGED_MESSAGES})`);
      } else if (!withinCharLimit) {
        log("QUEUE", `Not merging msg=${newMsgId}: hit char limit (${lastItem.context.length + context.length}/${MAX_MERGED_CONTENT_LENGTH})`);
      }
    }

    enqueueMessage(sessionKey, context, options, contextRefreshCallback, typingCallback).then(resolve).catch(reject);
  });
}

/**
 * Process a Discord message through the Claude Agent SDK.
 * Uses per-session turn queues to prevent concurrent calls.
 */
export async function processWithAgent(
  discordContext: string,
  options: AgentContext,
  contextRefreshCallback?: ContextRefreshCallback,
  typingCallback?: TypingCallback
): Promise<TurnResult> {
  const sessionKey = getSessionKey(options);

  if (sessionKey !== "idle") {
    return enqueueWithDebounce(sessionKey, discordContext, options, 500, contextRefreshCallback, typingCallback);
  }
  return enqueueMessage(sessionKey, discordContext, options, contextRefreshCallback, typingCallback);
}
