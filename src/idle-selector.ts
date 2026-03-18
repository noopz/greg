/**
 * Idle Behavior Selector
 *
 * Chooses which idle behavior to run from eligible candidates.
 * Supports both Haiku-powered selection and deterministic fallback.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { log, warn, error } from "./log";
import { loadIdleState } from "./idle-state";
import { PROJECT_DIR } from "./paths";
import type { IdleBehavior } from "./skill-loader";
import type { PreconditionData } from "./idle-preconditions";
import { IDLE_SELECTOR_SYSTEM_PROMPT, buildIdleChoicePrompt, parseIdleChoice } from "./gates/idle-selector";

// ============================================================================
// Behavior Selection
// ============================================================================

/**
 * Choose which idle behavior to run using a Haiku one-shot.
 *
 * Uses a throwaway Haiku call (no session resume) to let Greg pick
 * what he wants to do. This is cheap (~500 tokens) and maintains agency.
 */
export async function chooseBehaviorWithHaiku(eligibleBehaviors: IdleBehavior[], idleMinutes: number, preconditions?: PreconditionData): Promise<IdleBehavior[]> {
  // Load state to show last run times
  const state = await loadIdleState();

  // Format options with last run info
  const optionsList = eligibleBehaviors.map((b, i) => {
    const lastRun = state.lastRuns[b.name];
    const lastRunInfo = lastRun
      ? `${Math.round((Date.now() - lastRun) / 1000 / 60)} min ago`
      : "never";
    const source = b.skillPath ? "[skill]" : "[builtin]";
    return `${i + 1}. ${b.name} ${source} (last run: ${lastRunInfo})\n   ${b.prompt.split('\n')[0].substring(0, 80)}`;
  }).join("\n");

  const choicePrompt = buildIdleChoicePrompt(optionsList, idleMinutes, preconditions?.globalSummary);

  const SELECTOR_TIMEOUT_MS = 10_000;
  let response = "";
  let timedOut = false;
  const abortController = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, SELECTOR_TIMEOUT_MS);

  try {
    log("IDLE", "Asking Haiku to choose behavior (one-shot)...");

    for await (const message of query({
      prompt: choicePrompt,
      options: {
        cwd: PROJECT_DIR,
        model: "haiku", // Cheap and fast
        maxTurns: 1,
        // No resume - throwaway context
        systemPrompt: IDLE_SELECTOR_SYSTEM_PROMPT,
        allowedTools: [], // No tools needed for this choice
        abortController,
      },
    })) {
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block) {
            // Add newline between text blocks (for consistency)
            if (response.length > 0 && !response.endsWith("\n")) {
              response += "\n\n";
            }
            response += block.text;
          }
        }
      }
    }

    const trimmed = response.trim().toLowerCase();
    log("IDLE", `Haiku chose: "${trimmed}"`);

    const choices = parseIdleChoice(response, eligibleBehaviors.length);
    if (choices.length === 0 && (trimmed === "skip" || trimmed.includes("skip"))) {
      return [];
    }
    if (choices.length > 0) {
      return choices.map(c => eligibleBehaviors[c - 1]);
    }

    // Fallback to first if parsing fails
    log("IDLE", `Couldn't parse choice, falling back to first behavior`);
    return [eligibleBehaviors[0]];
  } catch (err) {
    if (timedOut) {
      warn("IDLE", `Selector timed out (${SELECTOR_TIMEOUT_MS}ms), using fallback`);
    } else {
      error("IDLE", "Haiku choice failed, using fallback", err);
    }
    // Fallback to weighted rotation on error
    return fallbackBehaviorChoice(eligibleBehaviors);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fallback behavior selection if Haiku fails.
 * Returns all eligible behaviors sorted by oldest-run-first.
 */
export async function fallbackBehaviorChoice(eligibleBehaviors: IdleBehavior[]): Promise<IdleBehavior[]> {
  const state = await loadIdleState();

  return [...eligibleBehaviors].sort((a, b) => {
    const aTime = state.lastRuns[a.name] ?? 0;
    const bTime = state.lastRuns[b.name] ?? 0;
    return aTime - bTime;
  });
}
