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
import { GateInput, GATE_SYSTEM_PROMPT, buildGatePrompt, parseGateResponse } from "./gates/gate";
export type { GateInput };

// ============================================================================
// Constants
// ============================================================================

const GATE_TIMEOUT_MS = 10_000;

// ============================================================================
// Haiku Gate Call
// ============================================================================

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
