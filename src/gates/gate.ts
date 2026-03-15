/**
 * Response Gate — Pure Logic
 *
 * System prompt, prompt builder, and response parser for the Haiku response gate.
 * Extracted from response-gate.ts for testability.
 */

import { BOT_NAME, BOT_NAME_LOWER } from "../config/identity";
import type { ConversationConfidence } from "../conversation";
import type { ChannelId, UserId } from "../agent-types";

// ============================================================================
// Types
// ============================================================================

export interface GateInput {
  messageContent: string;
  messageAuthorUsername: string;
  recentMessages: Array<{ author: string; content: string; isBot: boolean }>;
  replyContext?: { author: string; content: string; isBot: boolean };
  isDirectMention: boolean;
  isNameMentioned: boolean;
  isReplyToBot: boolean;
  convoConfidence: ConversationConfidence;
  channelId: ChannelId;
  userId: UserId;
}

// ============================================================================
// Constants
// ============================================================================

export const GATE_SYSTEM_PROMPT = `You decide whether ${BOT_NAME} should respond to a Discord message. ${BOT_NAME} is a snarky AI in a friend group.
He responds to: direct questions, mentions, replies to his messages, interesting topics, things he'd genuinely react to.
He does NOT respond to: random chatter between others, 'lol'/'lmao' reactions, GIF/image-only messages (he can't see them), people talking ABOUT him without addressing him, or messages where he'd have nothing to add.
When in an active conversation, lean YES unless the message is truly just noise. When cold start, lean NO unless clearly directed at ${BOT_NAME}.
Reply with only YES or NO.`;

// ============================================================================
// Prompt Building
// ============================================================================

export function buildGatePrompt(input: GateInput): string {
  const chatLines = input.recentMessages
    .map((m) => `${m.isBot ? BOT_NAME : m.author}: ${m.content}`)
    .join("\n");

  let prompt = "";
  if (chatLines) {
    prompt += `Recent chat:\n${chatLines}\n\n`;
  }

  prompt += `New message from ${input.messageAuthorUsername}: ${input.messageContent}`;

  if (input.replyContext) {
    const replyAuthor = input.replyContext.isBot ? BOT_NAME : input.replyContext.author;
    const truncated = input.replyContext.content.substring(0, 200);
    prompt += `\n↳ replying to ${replyAuthor}: ${truncated}`;
  }

  // Build signals
  const signals: string[] = [];
  if (input.isDirectMention) signals.push(`@mentioned ${BOT_NAME}`);
  if (input.isNameMentioned) signals.push(`said '${BOT_NAME_LOWER}'`);
  if (input.isReplyToBot) signals.push(`replying to ${BOT_NAME}'s message`);
  if (input.convoConfidence === "high") signals.push(`in active conversation with ${BOT_NAME}`);
  if (input.convoConfidence === "low") signals.push(`${BOT_NAME} recently spoke in channel`);

  prompt += `\n\nSignals: ${signals.length > 0 ? signals.join(", ") : "none (cold start)"}`;
  prompt += `\n\nShould ${BOT_NAME} respond?`;

  return prompt;
}

// ============================================================================
// Response Parsing
// ============================================================================

export function parseGateResponse(text: string): boolean {
  const trimmed = text.trim().toUpperCase();
  if (trimmed.startsWith("NO")) return false;
  if (trimmed.startsWith("YES")) return true;
  // Ambiguous = respond (safe default)
  return true;
}
