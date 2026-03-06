/**
 * Idle Behavior Selector
 *
 * Chooses which idle behavior to run from eligible candidates.
 * Supports both Haiku-powered selection and deterministic fallback.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { log, error } from "./log";
import { loadIdleState } from "./idle-state";
import { BOT_NAME } from "./config/identity";
import { PROJECT_DIR } from "./paths";
import type { IdleBehavior } from "./skill-loader";

// ============================================================================
// Behavior Selection
// ============================================================================

/**
 * Choose which idle behavior to run using a Haiku one-shot.
 *
 * Uses a throwaway Haiku call (no session resume) to let Greg pick
 * what he wants to do. This is cheap (~500 tokens) and maintains agency.
 */
export async function chooseBehaviorWithHaiku(eligibleBehaviors: IdleBehavior[], idleMinutes: number): Promise<IdleBehavior[]> {
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

  const choicePrompt = `You're ${BOT_NAME}, an AI who's been idle for ${idleMinutes} minutes. Time to do something productive!

Available activities:
${optionsList}

Pick the activities that sound most interesting or useful right now. Prefer activities you haven't done recently. You can pick multiple.

Reply with comma-separated numbers (e.g., 1,3,5). Only say "skip" if you're genuinely not interested in ANY of these.`;

  try {
    log("IDLE", "Asking Haiku to choose behavior (one-shot)...");

    let response = "";

    for await (const message of query({
      prompt: choicePrompt,
      options: {
        cwd: PROJECT_DIR,
        model: "haiku", // Cheap and fast
        // No resume - throwaway context
        systemPrompt: `You are ${BOT_NAME}, a curious AI who enjoys learning and self-improvement. When given options, you tend to pick something rather than skip. Reply with comma-separated numbers for the activities you want to do.`,
        allowedTools: [], // No tools needed for this choice
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

    if (trimmed === "skip" || trimmed.includes("skip")) {
      return [];
    }

    // Parse all numbers, deduplicate, map to behaviors
    const matches = trimmed.match(/\d+/g);
    if (matches) {
      const seen = new Set<number>();
      const behaviors: IdleBehavior[] = [];
      for (const m of matches) {
        const choice = parseInt(m, 10);
        if (choice >= 1 && choice <= eligibleBehaviors.length && !seen.has(choice)) {
          seen.add(choice);
          behaviors.push(eligibleBehaviors[choice - 1]);
        }
      }
      if (behaviors.length > 0) {
        return behaviors;
      }
    }

    // Fallback to first if parsing fails
    log("IDLE", `Couldn't parse choice, falling back to first behavior`);
    return [eligibleBehaviors[0]];
  } catch (err) {
    error("IDLE", "Haiku choice failed, using fallback", err);
    // Fallback to weighted rotation on error
    return fallbackBehaviorChoice(eligibleBehaviors);
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
