/**
 * Haiku Response Gate
 *
 * Cheap pre-filter (~$0.005) that prevents wasted Sonnet calls ($0.13) for
 * messages the bot has nothing to say about. Uses a two-layer approach:
 *
 * 1. Free keyword heuristic: For cold starts with no mention/reply, runs the
 *    existing shouldRespond() check. No keyword match = skip for free.
 * 2. Haiku one-shot: Quick YES/NO decision on whether the bot should engage.
 *
 * Every failure defaults to "respond" — never drops messages silently.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { PROJECT_DIR } from "./paths";
import { shouldRespond } from "./response-decision";
import { log, warn } from "./log";
import type { ChannelId, UserId } from "./agent-types";
import type { ConversationConfidence } from "./conversation";
import { BOT_NAME, BOT_NAME_LOWER } from "./config/identity";

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

const GATE_TIMEOUT_MS = 10_000;

const GATE_SYSTEM_PROMPT = `You decide whether ${BOT_NAME} should respond to a Discord message. ${BOT_NAME} is a snarky AI in a friend group.
He responds to: direct questions, mentions, replies to his messages, interesting topics, things he'd genuinely react to.
He does NOT respond to: random chatter between others, 'lol'/'lmao' reactions, GIF/image-only messages (he can't see them), people talking ABOUT him without addressing him, or messages where he'd have nothing to add.
When in an active conversation, lean YES unless the message is truly just noise. When cold start, lean NO unless clearly directed at ${BOT_NAME}.
Reply with only YES or NO.`;

// ============================================================================
// Prompt Building
// ============================================================================

function buildGatePrompt(input: GateInput): string {
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
// Haiku Gate Call
// ============================================================================

function parseGateResponse(text: string): boolean {
  const trimmed = text.trim().toUpperCase();
  if (trimmed.startsWith("NO")) return false;
  if (trimmed.startsWith("YES")) return true;
  // Ambiguous = respond (safe default)
  warn("GATE", `Ambiguous gate response: "${text.substring(0, 50)}", defaulting to YES`);
  return true;
}

async function callHaikuGate(prompt: string): Promise<boolean> {
  let responseText = "";
  let gateTimedOut = false;
  const abortController = new AbortController();
  const timer = setTimeout(() => {
    gateTimedOut = true;
    abortController.abort();
  }, GATE_TIMEOUT_MS);

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: PROJECT_DIR,
        model: "haiku",
        systemPrompt: GATE_SYSTEM_PROMPT,
        allowedTools: [],
        abortController,
      },
    })) {
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block) {
            responseText += block.text;
          }
        }
      }
    }
  } catch (err) {
    if (gateTimedOut) {
      warn("GATE", `Gate timed out (${GATE_TIMEOUT_MS}ms), defaulting to YES`);
    } else {
      warn("GATE", `Haiku gate failed (${err instanceof Error ? err.message : String(err)}), defaulting to YES`);
    }
    return true;
  } finally {
    clearTimeout(timer);
  }

  return parseGateResponse(responseText);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Decide whether the bot should respond to a message via Haiku pre-filter.
 *
 * For cold starts (no conversation, no mention, no reply), runs the free
 * keyword heuristic first. Only calls Haiku if there's a keyword match.
 *
 * Returns true = proceed to Sonnet, false = skip.
 */
export async function shouldRespondViaGate(input: GateInput): Promise<boolean> {
  // Direct mentions, name mentions, replies, and active conversation follow-ups are
  // unambiguous — skip the Haiku call entirely.
  // Name mention = someone said the bot's name in the message. In a friend group, that's addressing it.
  // High convo confidence = the bot just responded to this person. Their next message is a continuation.
  if (input.isDirectMention || input.isReplyToBot || input.isNameMentioned) {
    log("GATE", "Direct mention, name mention, or reply to bot — skipping gate");
    return true;
  }
  if (input.convoConfidence === "high") {
    log("GATE", "Active conversation (high confidence) — skipping gate");
    return true;
  }

  const isColdStart =
    input.convoConfidence === "none" &&
    !input.isDirectMention &&
    !input.isNameMentioned &&
    !input.isReplyToBot;

  // Free pre-filter for cold starts: use keyword heuristic
  if (isColdStart) {
    const keywordMatch = await shouldRespond(input.messageContent);
    if (!keywordMatch) {
      log("GATE", `Cold start, no keyword match — skipped (free)`);
      return false;
    }
    log("GATE", `Cold start with keyword match — confirming with Haiku`);
  }

  // Haiku gate
  const prompt = buildGatePrompt(input);
  const shouldReply = await callHaikuGate(prompt);
  log("GATE", `Haiku decision: ${shouldReply ? "YES" : "NO"} for "${input.messageContent.substring(0, 80)}"`);
  return shouldReply;
}
