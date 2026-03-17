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

export function buildIdleChoicePrompt(optionsList: string, idleMinutes: number, systemState?: string): string {
  let prompt = `You're ${BOT_NAME}, an AI who's been idle for ${idleMinutes} minutes. Time to do something productive!`;
  if (systemState) {
    prompt += `\n\nCurrent system state:\n${systemState}`;
  }
  prompt += `\n\nAvailable activities:\n${optionsList}`;
  prompt += `\n\nPick the activities that would be most impactful given the current state. Prefer activities you haven't done recently. You can pick multiple.`;
  prompt += `\n\nReply with comma-separated numbers (e.g., 1,3,5). Only say "skip" if you're genuinely not interested in ANY of these.`;
  return prompt;
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
