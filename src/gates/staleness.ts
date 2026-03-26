/**
 * Staleness Gate — Pure Logic
 *
 * System prompt, prompt builder, and response parser for the Haiku staleness check.
 * Decides whether a pending response should still be sent after the conversation moved on.
 */

import { BOT_NAME } from "../config/identity";

// ============================================================================
// Constants
// ============================================================================

export const STALENESS_SYSTEM_PROMPT = `You decide whether ${BOT_NAME}'s pending response should still be sent.
${BOT_NAME} took too long to respond and new messages arrived in the channel. You must decide: is the response still relevant, or has the conversation moved on?

SEND if: the response answers a question still unanswered, adds genuinely useful info to the current topic, or directly addresses something people are still discussing.
DROP if: the topic changed, someone else already covered what the response says, or it would feel like a non sequitur.

When in doubt, lean DROP — a human would just let it go. Reply with only SEND or DROP.`;

// ============================================================================
// Prompt Building
// ============================================================================

export function buildStalenessPrompt(
  pendingResponse: string,
  triggerMessage: { author: string; content: string },
  newerMessages: Array<{ author: string; content: string }>,
  elapsedSeconds: number,
): string {
  const newerLines = newerMessages
    .map((m) => `${m.author}: ${m.content}`)
    .join("\n");

  return `${BOT_NAME} was responding to this message (${elapsedSeconds}s ago):
${triggerMessage.author}: ${triggerMessage.content}

${BOT_NAME}'s pending response:
${pendingResponse.substring(0, 500)}

Messages that arrived since:
${newerLines}

Should ${BOT_NAME} still send this response?`;
}

// ============================================================================
// Response Parsing
// ============================================================================

export function parseStalenessResponse(text: string): boolean {
  const trimmed = text.trim().toUpperCase();
  if (trimmed.startsWith("DROP")) return false;
  if (trimmed.startsWith("SEND")) return true;
  // Ambiguous = send (safe default)
  return true;
}
