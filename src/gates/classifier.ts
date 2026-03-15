/**
 * Classifier Gate — Pure Logic
 *
 * System prompt, prompt builder, and response parser for the Haiku message classifier.
 * Extracted from haiku-router.ts for testability.
 */

// ============================================================================
// Types
// ============================================================================

export interface ClassifierContext {
  currentTurnUserId: string;
  processingDurationSec: number;
}

// ============================================================================
// Constants
// ============================================================================

export const CLASSIFIER_SYSTEM_PROMPT = "You classify Discord messages into queue vs fork categories. Output only valid JSON.";

// ============================================================================
// Prompt Building
// ============================================================================

export function buildClassifierPrompt(
  context: ClassifierContext,
  messages: Array<{ index: number; content: string }>
): string {
  const messageList = messages.map(m => `[${m.index}] ${m.content}`).join("\n");

  return `Messages buffered while Greg was responding (queue busy for ${context.processingDurationSec}s, responding to user ${context.currentTurnUserId}):

${messageList}

Classify each message index into one of two categories:
- "queue": Messages that should wait for the main queue. This includes:
  - Follow-ups to the current conversation (agreements, reactions, "yes", "do it", "YEA", etc.)
  - Messages on a different topic that are NOT time-sensitive and can wait
  - Most messages belong here. Default to queue when uncertain.
- "fork": Groups of message indices that are genuinely separate conversations AND need an immediate response. Only fork when:
  - The message is a direct question or request to Greg about something completely unrelated
  - Waiting would make the response feel stale or unresponsive
  - NEVER fork agreement/reaction messages ("yes", "YEA", "do it", "lets go", etc.)

Output JSON only, no explanation: {"queue": [0, 1], "fork": [[2]]}
If all messages should queue: {"queue": [0, 1, 2], "fork": []}`;
}

// ============================================================================
// Response Parsing
// ============================================================================

export function parseClassifierResponse(
  text: string,
  messageCount: number
): { queue: number[]; fork: number[][] } {
  const allIndices = Array.from({ length: messageCount }, (_, i) => i);

  // Extract JSON from response (Haiku might add some text around it)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { queue: allIndices, fork: [] };
  }

  const parsed = JSON.parse(jsonMatch[0]) as { queue?: number[]; fork?: number[][] };

  // Validate structure
  const queueIndices = Array.isArray(parsed.queue)
    ? parsed.queue.filter(i => typeof i === "number" && i >= 0 && i < messageCount)
    : [];
  const forkGroups = Array.isArray(parsed.fork)
    ? parsed.fork
        .filter(g => Array.isArray(g))
        .map(g => g.filter(i => typeof i === "number" && i >= 0 && i < messageCount))
        .filter(g => g.length > 0)
    : [];

  // Ensure every index is accounted for - unclassified go to queue
  const classified = new Set([...queueIndices, ...forkGroups.flat()]);
  for (const idx of allIndices) {
    if (!classified.has(idx)) {
      queueIndices.push(idx);
    }
  }

  return { queue: queueIndices, fork: forkGroups };
}
