/**
 * Idle Selector Gate — Pure Logic
 *
 * System prompt, prompt builder, and response parser for the idle behavior selector.
 * Extracted from idle-selector.ts for testability.
 */

import { BOT_NAME } from "../config/identity";

// ============================================================================
// Constants
// ============================================================================

export const IDLE_SELECTOR_SYSTEM_PROMPT = `You are ${BOT_NAME}, a curious AI who enjoys learning and self-improvement. When given options, you tend to pick something rather than skip. Reply with comma-separated numbers for the activities you want to do.`;

// ============================================================================
// Prompt Building
// ============================================================================

export function buildIdleChoicePrompt(optionsList: string, idleMinutes: number): string {
  return `You're ${BOT_NAME}, an AI who's been idle for ${idleMinutes} minutes. Time to do something productive!

Available activities:
${optionsList}

Pick the activities that sound most interesting or useful right now. Prefer activities you haven't done recently. You can pick multiple.

Reply with comma-separated numbers (e.g., 1,3,5). Only say "skip" if you're genuinely not interested in ANY of these.`;
}

// ============================================================================
// Response Parsing
// ============================================================================

export function parseIdleChoice(text: string, optionCount: number): number[] {
  const trimmed = text.trim().toLowerCase();

  if (trimmed === "skip" || trimmed.includes("skip")) {
    return [];
  }

  const matches = trimmed.match(/\d+/g);
  if (matches) {
    const seen = new Set<number>();
    const choices: number[] = [];
    for (const m of matches) {
      const choice = parseInt(m, 10);
      if (choice >= 1 && choice <= optionCount && !seen.has(choice)) {
        seen.add(choice);
        choices.push(choice);
      }
    }
    if (choices.length > 0) {
      return choices;
    }
  }

  return [];
}
