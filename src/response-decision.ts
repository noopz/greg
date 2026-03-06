import { loadResponseTriggers } from "./response-triggers";

// ============================================================================
// Response Decision
// ============================================================================

/**
 * Quick heuristics to determine if the bot should respond.
 * Agent can override this decision.
 *
 * Requires MULTIPLE signals to respond (prevents responding to everything):
 * - Must have BOTH a question mark AND a keyword match
 *
 * Keywords are loaded from agent-data/response-triggers.json
 * which Greg can edit to learn new topics!
 */
export async function shouldRespond(context: string): Promise<boolean> {
  const lowerContext = context.toLowerCase();

  // Check for question mark
  const hasQuestion = context.includes("?");

  // Load keywords from disk (Greg can edit these!)
  const keywords = await loadResponseTriggers();

  // Check for keyword match
  let hasKeyword = false;
  for (const keyword of keywords) {
    if (lowerContext.includes(keyword.toLowerCase())) {
      hasKeyword = true;
      break;
    }
  }

  // Require BOTH signals to respond
  return hasQuestion && hasKeyword;
}
