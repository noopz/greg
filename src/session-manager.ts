/**
 * Session Management
 *
 * Handles session lifecycle: loading/saving session data, tracking token usage,
 * and syncing token counts from Claude SDK JSONL files.
 */

import path from "node:path";
import fs from "node:fs";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { AGENT_DATA_DIR, TRANSCRIPTS_DIR } from "./paths";
import {
  getTranscriptPath,
  loadSessionData as loadSessionDataFromFile,
  saveSessionData as saveSessionDataToFile,
  type SessionData,
} from "./persistence";
import { log, warn } from "./log";
import { recordCost } from "./cost-tracker";
import type { SessionId } from "./agent-types";

export const SESSION_FILE = path.join(AGENT_DATA_DIR, "session.json");

// Track previous cumulative values per SDK session to compute per-turn deltas.
// SDK result fields (modelUsage, total_cost_usd) are session-cumulative, not per-yield.
const previousCumulatives = new Map<string, { cost: number; inputTokens: number; outputTokens: number }>();


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
export async function loadSessionId(): Promise<SessionId | undefined> {
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
export async function saveSessionId(sessionId: SessionId): Promise<void> {
  const existing = await loadSessionData();
  const transcriptFile = getTranscriptPath(TRANSCRIPTS_DIR, sessionId);

  await saveSessionData({
    ...existing,
    sessionId,
    updatedAt: Date.now(),
    transcriptFile,
  });
}

/**
 * Clear the persisted session file so stall recovery doesn't resume a broken session.
 */
export function clearPersistedSession(): void {
  try {
    fs.unlinkSync(SESSION_FILE);
    log("SDK", "Cleared persisted session file");
  } catch {
    // File didn't exist — that's fine
  }
}

/**
 * Update token usage in session data after a query completes.
 *
 * contextTokens: the actual context window size from the last API call
 * in the turn (tracked via SDKAssistantMessage.message.usage). This is
 * what determines when the session teardown threshold should trigger.
 *
 * result.modelUsage is cumulative across all agentic sub-turns (tool calls),
 * so it overcounts — we only use it for billing logs.
 */
export async function updateTokenUsage(
  result: SDKResultMessage,
  contextTokens: number,
): Promise<void> {
  const existing = await loadSessionData();
  if (!existing?.sessionId) {
    warn("SDK", "Cannot update token usage: no session data found");
    return;
  }

  const cumulativeCost = result.total_cost_usd ?? 0;
  const previousSize = existing.totalTokens ?? 0;
  const sessionId = result.session_id ?? existing.sessionId;

  // Sum billing across all models (SDK values are session-cumulative)
  let cumulativeInput = 0;
  let cumulativeOutput = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let uncachedTokens = 0;
  let webSearches = 0;

  if (result.modelUsage) {
    for (const [modelName, modelData] of Object.entries(result.modelUsage)) {
      if (modelData) {
        uncachedTokens += modelData.inputTokens ?? 0;
        cacheReadTokens += modelData.cacheReadInputTokens ?? 0;
        cacheWriteTokens += modelData.cacheCreationInputTokens ?? 0;
        cumulativeOutput += modelData.outputTokens ?? 0;
        webSearches += modelData.webSearchRequests ?? 0;

        if (Object.keys(result.modelUsage).length > 1) {
          log("SDK", `  ${modelName}: $${(modelData.costUSD ?? 0).toFixed(4)} (${modelData.inputTokens ?? 0} in, ${modelData.outputTokens ?? 0} out)`);
        }
      }
    }
  }

  cumulativeInput = uncachedTokens + cacheReadTokens + cacheWriteTokens;

  // Compute per-turn deltas from session-cumulative values
  const prev = previousCumulatives.get(sessionId) ?? { cost: 0, inputTokens: 0, outputTokens: 0 };
  const turnCost = cumulativeCost - prev.cost;
  const turnInput = cumulativeInput - prev.inputTokens;
  const turnOutput = cumulativeOutput - prev.outputTokens;
  previousCumulatives.set(sessionId, { cost: cumulativeCost, inputTokens: cumulativeInput, outputTokens: cumulativeOutput });

  const cacheHitRate = turnInput > 0 ? ((cacheReadTokens / cumulativeInput) * 100).toFixed(1) : "0.0";

  log("SDK", `Billing: ${turnInput} input + ${turnOutput} output (session total: ${cumulativeInput} in, ${cumulativeOutput} out)`);
  log("SDK", `Cache: ${cacheHitRate}% hit rate | Cost: $${turnCost.toFixed(4)} (session: $${cumulativeCost.toFixed(4)})${webSearches > 0 ? ` | Web searches: ${webSearches}` : ""}`);
  log("SDK", `Context size: ${previousSize} -> ${contextTokens} tokens`);

  // Record to rolling cost tracker
  recordCost("turn", turnCost, turnInput, turnOutput, contextTokens, parseFloat(cacheHitRate));

  // Cost guardrails: warn on expensive turns or rapid context growth
  if (turnCost > 0.30) {
    warn("SDK", `HIGH TURN COST: $${turnCost.toFixed(4)} — check for cache misses or large tool output`);
  }
  const contextGrowth = contextTokens - previousSize;
  if (contextGrowth > 50000) {
    warn("SDK", `LARGE CONTEXT GROWTH: +${contextGrowth} tokens this turn (${previousSize} -> ${contextTokens})`);
  }

  await saveSessionData({
    ...existing,
    totalTokens: contextTokens,
    updatedAt: Date.now(),
  });
}
