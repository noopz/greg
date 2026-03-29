/**
 * Greg - Claude Agent SDK Integration (Public API)
 *
 * Thin public API layer. Re-exports from:
 * - agent-types.ts: Types and pure functions
 * - turn-queue.ts: Queue state and concurrency control
 * - turn-executor.ts: SDK execution
 * - streaming-session.ts: Persistent streaming sessions
 *
 * Registers the turn executor and buffer functions at import time
 * to wire up the dependency-injected modules.
 */

import { executeAgentTurn } from "./turn-executor";
import { shouldBuffer, bufferMessage } from "./haiku-router";
import {
  registerTurnExecutor,
  registerBufferFunctions,
  processWithAgent as _processWithAgent,
} from "./turn-queue";
import type { TurnExecutor } from "./turn-queue";
import { log } from "./log";
import { getHooks } from "./extensions/loader";

// ============================================================================
// Module Initialization (runs once at import time)
// ============================================================================

// Wrap executeAgentTurn with the extension executeTurn hook.
// If an extension provides executeTurn, it runs instead (with the default as a parameter).
const wrappedExecutor: TurnExecutor = async (discordContext, options, contextRefreshCallback, typingCallback) => {
  const extResult = await getHooks().executeTurn(
    discordContext, options, executeAgentTurn, contextRefreshCallback, typingCallback,
  );
  // Extension returned a result → use it. Null → run default.
  return extResult ?? executeAgentTurn(discordContext, options, contextRefreshCallback, typingCallback);
};

// Wire up turn-queue -> turn-executor (with extension override support)
registerTurnExecutor(wrappedExecutor);

// Wire up turn-queue -> haiku-router (avoids circular dep)
registerBufferFunctions(shouldBuffer, bufferMessage);

log("STREAM", "Streaming mode enabled — sessions started lazily on first message");

// ============================================================================
// Public API Re-exports
// ============================================================================

// Main entry point for processing messages
export const processWithAgent = _processWithAgent;

// Types (re-exported for consumers like bot.ts)
export type { AgentContext, ContextRefreshCallback } from "./agent-types";

// Queue state accessors (used by idle.ts, index.ts, etc.)
export { isAgentBusy } from "./turn-queue";
export { setToolsServer } from "./turn-queue";

// Streaming session exports (for bot.ts interrupt support)
export { getStreamingSession } from "./streaming-session";
export type { TypingCallback } from "./streaming-session";
