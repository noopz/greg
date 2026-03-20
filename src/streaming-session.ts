/**
 * Streaming Session - Persistent SDK Query Lifecycle
 *
 * Manages a long-lived streaming connection to the Claude Agent SDK.
 * Two instances at runtime: one for creator DMs (full tools) and one
 * for public channels (restricted tools with access control hooks).
 *
 * Replaces per-turn query() calls with a single persistent session
 * that accepts messages via yieldMessage() and returns responses
 * via waitForResponse().
 *
 * Lifecycle: create → start() → [yield → waitForResponse → yield]* → close()
 * Concurrency: acquire()/release() mutex ensures one turn at a time.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  Query,
  McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { log, warn, error as logError } from "./log";
import type { SessionId } from "./agent-types";
import { sessionId as toSessionId } from "./agent-types";

// ============================================================================
// Types
// ============================================================================

/** Result returned by waitForResponse() */
export interface ResponseBoundary {
  /** Accumulated assistant text across all content blocks */
  responseText: string;
  /** Tool names used during this turn */
  toolNamesUsed: Set<string>;
  /** SDK result message (for token tracking, cost) */
  resultMessage: SDKResultMessage | null;
  /** Individual assistant message content blocks for auditing */
  toolInputs: Array<{ name: string; input?: Record<string, unknown> }>;
  /** Context size from the last API call (input + cache tokens). Use for teardown threshold. */
  lastCallInputTokens: number;
}

/** Options for starting a streaming session */
export interface StreamingSessionOptions {
  cwd: string;
  model: string;
  systemPrompt: string | { type: "preset"; preset: "claude_code"; append?: string };
  allowedTools: string[];
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  maxBudgetUsd?: number;
  env?: Record<string, string | undefined>;
  /** Session ID to resume from a previous JSONL conversation. */
  resumeSessionId?: SessionId;
}

/** Typing callback invoked during streaming output */
export type TypingCallback = (chunk: string) => void;

// ============================================================================
// MessageChannel - Async Generator Queue
// ============================================================================

/**
 * Bridges push-based yieldMessage() calls to the pull-based AsyncIterable
 * consumed by the SDK's query() function. At most 1 message is in the queue
 * at a time (bounded by the session lock), plus up to 2 ReAct continuations.
 */
class MessageChannel {
  private queue: SDKUserMessage[] = [];
  private waiter: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) {
      warn("STREAM", "Attempted to push message to closed channel");
      return;
    }
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.closed) {
        return;
      } else {
        const result = await new Promise<IteratorResult<SDKUserMessage>>(
          (resolve) => { this.waiter = resolve; }
        );
        if (result.done) return;
        yield result.value;
      }
    }
  }
}

// ============================================================================
// StreamingSession
// ============================================================================

export class StreamingSession {
  readonly label: string;

  private channel: MessageChannel | null = null;
  private queryHandle: Query | null = null;
  private _sessionId: SessionId | undefined;
  private _lastSessionId: SessionId | undefined;
  private _alive = false;
  private _idle = true;
  private outputConsumerDone: Promise<void> | null = null;

  // Response boundary detection (FIFO resolver queue)
  private pendingResolvers: Array<{
    resolve: (boundary: ResponseBoundary) => void;
    reject: (err: Error) => void;
  }> = [];

  // Current turn accumulation
  private currentResponse = "";
  private currentToolNames = new Set<string>();
  private currentToolInputs: Array<{ name: string; input?: Record<string, unknown> }> = [];
  private toolsSinceLastText = false;
  private lastCallInputTokens = 0;

  // Typing callback for the current turn (set by yieldMessage, cleared by waitForResponse)
  private currentTypingCallback: TypingCallback | null = null;

  // Stall detection: timestamp of last SDK message received by consumeOutput
  private lastMessageAt = 0;

  // Session-level mutex (promise-chaining pattern)
  private _lock: Promise<void> = Promise.resolve();
  private _unlock: (() => void) | null = null;

  constructor(label: string) {
    this.label = label;
  }

  // ==========================================================================
  // Mutex
  // ==========================================================================

  /** Acquire exclusive access. Caller MUST call release(). */
  async acquire(): Promise<void> {
    let release!: () => void;
    const next = new Promise<void>(r => { release = r; });
    const prev = this._lock;
    this._lock = next;       // Chain: future callers await THIS promise
    await prev;              // Wait for previous holder to release
    this._unlock = release;  // Store our release function
  }

  /** Release exclusive access. */
  release(): void {
    if (this._unlock) {
      const unlock = this._unlock;
      this._unlock = null;
      unlock();
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** Start (or restart) the streaming session with the given options. */
  start(options: StreamingSessionOptions): void {
    if (this._alive) {
      warn("STREAM", `[${this.label}] start() called while alive — closing first`);
      this.close();
    }

    this.channel = new MessageChannel();
    this._alive = true;
    this._idle = true;
    if (this._sessionId) this._lastSessionId = this._sessionId;
    this._sessionId = undefined;
    this.pendingResolvers = [];
    this.currentResponse = "";
    this.currentToolNames.clear();
    this.currentToolInputs = [];
    this.toolsSinceLastText = false;
    this.currentTypingCallback = null;
    this.lastMessageAt = 0;

    log("STREAM", `[${this.label}] Starting streaming session...${options.resumeSessionId ? ` (resuming ${options.resumeSessionId})` : ""}`);

    this.queryHandle = query({
      prompt: this.channel,
      options: {
        cwd: options.cwd,
        model: options.model,
        systemPrompt: options.systemPrompt,
        settingSources: ["project"],
        allowedTools: options.allowedTools,
        ...(options.hooks ? { hooks: options.hooks } : {}),
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options.maxBudgetUsd !== undefined ? { maxBudgetUsd: options.maxBudgetUsd } : {}),
        ...(options.resumeSessionId ? { resume: options.resumeSessionId } : {}),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        env: {
          ...process.env,
          ...options.env,
        },
      },
    });

    // Start background output consumer
    this.outputConsumerDone = this.consumeOutput();
  }

  /** Close the streaming session. */
  close(): void {
    log("STREAM", `[${this.label}] Closing session (sid=${this._sessionId ?? "none"}, pending=${this.pendingResolvers.length})`);
    this._alive = false;
    this._idle = true;

    // Close the message channel (terminates the async iterable)
    try {
      this.channel?.close();
    } catch {
      // Already closed
    }
    this.channel = null;

    // Close the query handle (kills subprocess)
    try {
      this.queryHandle?.close();
    } catch {
      // Already closed
    }
    this.queryHandle = null;

    // Release mutex so any queued acquirer can proceed (and fail on dead session)
    this.release();

    // Reject any pending resolvers
    for (const resolver of this.pendingResolvers) {
      resolver.reject(new Error("Session closed"));
    }
    this.pendingResolvers = [];
  }

  // ==========================================================================
  // Message Input
  // ==========================================================================

  /**
   * Push a user message into the streaming session.
   * The message content can be a string or content blocks (for images).
   *
   * On the first message (before init), uses empty string for session_id.
   * The SDK bootstraps the session and returns the real ID in the init message.
   */
  yieldMessage(
    content: string | Array<{ type: string; [key: string]: unknown }>,
    typingCallback?: TypingCallback
  ): void {
    if (!this._alive || !this.channel) {
      throw new Error(`[${this.label}] Cannot yield message: session not alive`);
    }

    this.currentTypingCallback = typingCallback ?? null;
    this._idle = false;
    this.lastMessageAt = Date.now();

    // Reset per-turn accumulation
    this.currentResponse = "";
    this.currentToolNames.clear();
    this.currentToolInputs = [];
    this.toolsSinceLastText = false;
    this.lastCallInputTokens = 0;

    const messageContent = content;

    // Use empty string for session_id before init — SDK bootstraps the session
    const sessionIdValue = this._sessionId ?? "";

    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: messageContent },
      parent_tool_use_id: null,
      session_id: sessionIdValue,
    };

    this.channel.push(msg);
    log("STREAM", `[${this.label}] Yielded message (${typeof content === "string" ? content.length + " chars" : content.length + " blocks"}, sid=${sessionIdValue ? "set" : "bootstrap"})`);
  }

  // ==========================================================================
  // Response Waiting
  // ==========================================================================

  /**
   * Wait for the SDK to complete a response turn.
   * Returns the accumulated response boundary.
   * Supports re-entrant calls (FIFO resolver queue for ReAct continuations).
   *
   * Includes stall detection: if no SDK messages arrive for STALL_TIMEOUT_MS,
   * the turn is killed (matches classic mode's stallInterval behavior).
   */
  waitForResponse(timeoutMs = 180_000): Promise<ResponseBoundary> {
    const STALL_TIMEOUT_MS = 60_000; // 60s of silence = stall

    return new Promise<ResponseBoundary>((resolve, reject) => {
      this.pendingResolvers.push({ resolve, reject });

      // Hard timeout: absolute max wait time
      const timer = setTimeout(() => {
        cleanup();
        const idx = this.pendingResolvers.findIndex(r => r.resolve === wrappedResolve);
        if (idx !== -1) {
          this.pendingResolvers.splice(idx, 1);
          reject(new Error(`[${this.label}] waitForResponse timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      // Stall detector: checks every 10s for prolonged silence from the SDK
      const stallInterval = setInterval(() => {
        if (this.lastMessageAt === 0) return; // Not yet started
        const silence = Date.now() - this.lastMessageAt;
        if (silence > STALL_TIMEOUT_MS) {
          cleanup();
          const idx = this.pendingResolvers.findIndex(r => r.resolve === wrappedResolve);
          if (idx !== -1) {
            this.pendingResolvers.splice(idx, 1);
            warn("STREAM", `[${this.label}] SDK stalled (${Math.floor(silence / 1000)}s silence) — killing turn`);
            reject(new Error(`[${this.label}] SDK stalled (${Math.floor(silence / 1000)}s silence)`));
          }
        }
      }, 10_000);

      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(stallInterval);
      };

      // Store cleanup reference on the resolver
      const originalResolve = resolve;
      const wrappedResolve = (boundary: ResponseBoundary) => {
        cleanup();
        originalResolve(boundary);
      };
      this.pendingResolvers[this.pendingResolvers.length - 1].resolve = wrappedResolve;
      const originalReject = reject;
      this.pendingResolvers[this.pendingResolvers.length - 1].reject = (err) => {
        cleanup();
        originalReject(err);
      };
    });
  }

  // ==========================================================================
  // Interruption
  // ==========================================================================

  /** Interrupt the current response without killing the session. */
  async interrupt(): Promise<void> {
    if (!this.queryHandle) return;
    try {
      log("STREAM", `[${this.label}] Interrupting current response`);
      await this.queryHandle.interrupt();
    } catch (err) {
      warn("STREAM", `[${this.label}] Interrupt failed: ${err}`);
    }
  }

  // ==========================================================================
  // State Accessors
  // ==========================================================================

  get sessionId(): SessionId | undefined {
    return this._sessionId;
  }

  get lastSessionId(): SessionId | undefined {
    return this._lastSessionId;
  }

  isAlive(): boolean {
    return this._alive;
  }

  isIdle(): boolean {
    return this._idle;
  }

  // ==========================================================================
  // Background Output Consumer
  // ==========================================================================

  private async consumeOutput(): Promise<void> {
    if (!this.queryHandle) return;

    try {
      for await (const message of this.queryHandle) {
        if (!this._alive) break;

        this.handleSdkMessage(message);
      }
    } catch (err) {
      if (this._alive) {
        logError("STREAM", `[${this.label}] Output consumer error`, err);
      }
    } finally {
      this._alive = false;
      this._idle = true;

      // Reject remaining resolvers
      for (const resolver of this.pendingResolvers) {
        resolver.reject(new Error(`[${this.label}] Session ended unexpectedly`));
      }
      this.pendingResolvers = [];

      log("STREAM", `[${this.label}] Output consumer finished`);
    }
  }

  private handleSdkMessage(message: SDKMessage): void {
    this.lastMessageAt = Date.now();

    // Init message — capture session ID
    if (message.type === "system") {
      const sysMsg = message as SDKSystemMessage;
      if (sysMsg.subtype === "init") {
        this._sessionId = toSessionId(sysMsg.session_id);
        log("STREAM", `[${this.label}] Init: session=${this._sessionId} model=${sysMsg.model}`);

        if (sysMsg.plugins?.length) {
          log("STREAM", `[${this.label}] Plugins: ${sysMsg.plugins.map((p) => p.name).join(", ")}`);
        }
        if (sysMsg.mcp_servers?.length) {
          log("STREAM", `[${this.label}] MCP servers: ${sysMsg.mcp_servers.map((s) => `${s.name}(${s.status})`).join(", ")}`);
        }
        return;
      }

      // Other system messages (status, compact_boundary, etc.)
      log("STREAM", `[${this.label}] System: ${sysMsg.subtype}`);
      return;
    }

    // Partial assistant messages (streaming output for typing indicator)
    if (message.type === "stream_event") {
      const partial = message as SDKPartialAssistantMessage;
      const event = partial.event;
      if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta") {
        const text = (event.delta as { text?: string }).text ?? "";
        if (text && this.currentTypingCallback) {
          this.currentTypingCallback(text);
        }
      }
      return;
    }

    // Full assistant messages — accumulate response text and tool calls
    if (message.type === "assistant") {
      const assistantMsg = message as SDKAssistantMessage;
      if (assistantMsg.message?.content) {
        for (const block of assistantMsg.message.content) {
          if (block.type === "text") {
            // If tools were used since the last text block, the new text is the
            // post-tool summary — replace the pre-tool narration to avoid
            // near-duplicate "I'm about to do X" / "I did X" responses.
            // Only replace on the FIRST tool boundary (not subsequent rounds
            // where intermediate text may be substantive).
            if (this.currentResponse.length > 0 && this.toolsSinceLastText) {
              log("STREAM", `[${this.label}] Replacing pre-tool text (${this.currentResponse.length} chars) with post-tool text (${block.text.length} chars)`);
              this.currentResponse = block.text;
            } else if (this.currentResponse.length > 0 && !this.currentResponse.endsWith("\n")) {
              this.currentResponse += "\n\n";
              this.currentResponse += block.text;
            } else {
              this.currentResponse += block.text;
            }
            this.toolsSinceLastText = false;
            log("STREAM", `[${this.label}] Assistant text: ${block.text.length} chars (total: ${this.currentResponse.length})`);
          } else if (block.type === "tool_use") {
            this.toolsSinceLastText = true;
            this.currentToolNames.add(block.name);
            const input = block.input as Record<string, unknown>;
            this.currentToolInputs.push({ name: block.name, input });
            // Log file path/pattern/query for tool calls
            const target = input?.file_path ?? input?.command ?? input?.pattern ?? input?.query ?? "";
            const suffix = target ? `: ${String(target).substring(0, 120)}` : "";
            log("STREAM", `[${this.label}] Tool call: ${block.name}${suffix}`);
          }
        }
      }
      // Track usage from this API call (last one = actual context size)
      const usage = assistantMsg.message?.usage;
      if (usage) {
        this.lastCallInputTokens = (usage.input_tokens ?? 0) +
          ((usage as Record<string, unknown>).cache_creation_input_tokens as number ?? 0) +
          ((usage as Record<string, unknown>).cache_read_input_tokens as number ?? 0);
      }
      return;
    }

    // Result message — turn boundary!
    if (message.type === "result") {
      const resultMessage = message as SDKResultMessage;
      const cost = (resultMessage.total_cost_usd ?? 0).toFixed(4);
      const inputTokens = resultMessage.usage.input_tokens;
      const outputTokens = resultMessage.usage.output_tokens;
      log("STREAM", `[${this.label}] Result: subtype=${resultMessage.subtype} cost=$${cost} tokens=${inputTokens}in/${outputTokens}out response=${this.currentResponse.length}chars tools=[${[...this.currentToolNames].join(",")}]`);

      this._idle = true;
      this.currentTypingCallback = null;

      const boundary: ResponseBoundary = {
        responseText: this.currentResponse,
        toolNamesUsed: new Set(this.currentToolNames),
        resultMessage,
        toolInputs: [...this.currentToolInputs],
        lastCallInputTokens: this.lastCallInputTokens,
      };

      // Reset accumulation for next turn
      this.currentResponse = "";
      this.currentToolNames.clear();
      this.currentToolInputs = [];
      this.toolsSinceLastText = false;

      // Resolve the oldest pending waiter (FIFO)
      if (this.pendingResolvers.length > 0) {
        const resolver = this.pendingResolvers.shift()!;
        resolver.resolve(boundary);
      } else {
        // No one waiting for this result (e.g., init turn or orphaned)
        log("STREAM", `[${this.label}] Result with no pending resolver (init turn?)`);
      }
      return;
    }

    // Other message types (hooks, tool progress, etc.) — log for debugging
    if (message.type === "tool_progress") {
      // Minimal logging for tool progress
      return;
    }

    // Tool result messages (SDK echoes after tool execution) — expected, ignore
    if (message.type === "user") return;

    log("STREAM", `[${this.label}] Unhandled message type=${message.type}`);
  }
}

// ============================================================================
// Singleton Instances (created at boot)
// ============================================================================

export const creatorSession = new StreamingSession("creator");
export const publicSession = new StreamingSession("public");

/**
 * Get the streaming session for the given context.
 * Creator DMs use the creator session (full tools).
 * Public channels use the public session (restricted tools).
 */
export function getStreamingSession(isCreator: boolean): StreamingSession {
  return isCreator ? creatorSession : publicSession;
}
