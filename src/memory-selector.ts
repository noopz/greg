/**
 * Memory Selector
 *
 * Pre-response Haiku agent that generates awareness hints — short pointers
 * telling Greg what relevant knowledge exists and exactly how to retrieve it.
 * No content is dumped into context, only pointers with retrieval paths.
 *
 * Fires on conversation entry + every N turns. Hints are stable between runs
 * to protect prompt cache.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import { AGENT_DATA_DIR, PROJECT_DIR } from "./paths";
import { log, error as logError } from "./log";
import { getConceptIndex } from "./transcript-index";

const SELECTOR_TIMEOUT_MS = 10_000;
const TURNS_BETWEEN_RUNS = 5;

// Per-channel state: turn count and cached hints
const channelState = new Map<string, { turnCount: number; cachedHints: string | null }>();

const SELECTOR_SYSTEM_PROMPT = `You generate memory hints for a Discord bot. Respond ONLY with valid JSON. No markdown, no explanation.`;


/**
 * Build a compact index of available memory sources for the selector.
 * Channel-scoped for concept data, global for relationships/memories/hypotheses.
 */
function buildSelectorIndex(channelId: string, activeParticipantIds: string[]): string {
  const sections: string[] = [];

  // 1. Concept index for this channel
  try {
    const { conceptCounts, participantConcepts } = getConceptIndex(channelId);
    if (conceptCounts.length > 0) {
      const topConcepts = conceptCounts
        .slice(0, 20)
        .map((c) => `${c.name}(${c.count})`)
        .join(", ");
      sections.push(`[concepts in this channel] ${topConcepts}`);

      if (participantConcepts.length > 0) {
        const perParticipant = participantConcepts
          .slice(0, 10)
          .map((p) => `${p.participant}: ${p.concepts}`)
          .join(". ");
        sections.push(`[concepts-by-participant in this channel] ${perParticipant}`);
      }
    }
  } catch {
    // Concept tables may not have data yet
  }

  // 2. Non-participant relationship files
  try {
    const relDir = path.join(AGENT_DATA_DIR, "relationships");
    if (fs.existsSync(relDir)) {
      const files = fs.readdirSync(relDir).filter((f) => f.endsWith(".md"));
      const nonParticipant = files.filter(
        (f) => !activeParticipantIds.includes(f.replace(".md", ""))
      );
      if (nonParticipant.length > 0) {
        const entries = nonParticipant.slice(0, 10).map((f) => {
          const userId = f.replace(".md", "");
          // Read first line for a quick description
          try {
            const content = fs.readFileSync(path.join(relDir, f), "utf-8");
            const firstLine = content.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";
            return `${userId}.md — ${firstLine.substring(0, 80)}`;
          } catch {
            return `${userId}.md`;
          }
        });
        sections.push(`[non-participant relationship files] ${entries.join("; ")}`);
      }
    }
  } catch {
    // Non-critical
  }

  // 3. Older memory files (beyond last 5 days)
  try {
    const memDir = path.join(AGENT_DATA_DIR, "memories");
    if (fs.existsSync(memDir)) {
      const files = fs.readdirSync(memDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse();
      // Skip the most recent 5 (already loaded in context)
      const older = files.slice(5, 15);
      if (older.length > 0) {
        const entries = older.map((f) => {
          try {
            const content = fs.readFileSync(path.join(memDir, f), "utf-8");
            const firstLine = content.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";
            return `${f} — ${firstLine.substring(0, 60)}`;
          } catch {
            return f;
          }
        });
        sections.push(`[older-memories] ${entries.join("; ")}`);
      }
    }
  } catch {
    // Non-critical
  }

  // 4. Active hypotheses
  try {
    const hypFile = path.join(AGENT_DATA_DIR, "hypotheses.md");
    if (fs.existsSync(hypFile)) {
      const content = fs.readFileSync(hypFile, "utf-8");
      const activeMatch = content.match(/## Active[\s\S]*?(?=## |$)/);
      if (activeMatch) {
        const hypotheses = activeMatch[0]
          .split("\n")
          .filter((l) => l.match(/^###?\s+H\d+/))
          .slice(0, 5)
          .map((l) => l.replace(/^#+\s*/, "").substring(0, 80));
        if (hypotheses.length > 0) {
          sections.push(`[hypotheses] ${hypotheses.join("; ")}`);
        }
      }
    }
  } catch {
    // Non-critical
  }

  return sections.join("\n");
}

/**
 * Call Haiku to generate memory hints based on current message and index.
 */
async function callSelector(
  author: string,
  messageContent: string,
  activeParticipants: string[],
  channelId: string,
  selectorIndex: string,
): Promise<string | null> {
  if (!selectorIndex.trim()) return null;

  const prompt = `You are generating memory hints for Greg (a Discord bot). Given the current message and available memory sources, produce 0-3 short hints about things Greg might want to recall. Each hint MUST include the exact search_transcripts call or file read command to retrieve details.

Rules:
- Only hint at things you're CERTAIN are relevant based on the index
- Never fabricate — only reference concepts/counts that appear in the index
- Greg already has relationship + impression files for active participants loaded
- Only hint at things NOT already in Greg's context
- **Channel-scoped**: only reference concept threads from the current channel
- Non-participant files only if the person is explicitly mentioned in the current message
- If nothing is clearly relevant, return {"hints": []}

Current message:
Author: ${author}
Content: "${messageContent.substring(0, 500)}"
Active participants: ${activeParticipants.join(", ")}
Channel: ${channelId}

Available memory index:
${selectorIndex}

Return JSON: {"hints": ["hint text with search_transcripts(...) call", ...]}`;

  let responseText = "";
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), SELECTOR_TIMEOUT_MS);

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: PROJECT_DIR,
        model: "haiku",
        systemPrompt: SELECTOR_SYSTEM_PROMPT,
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
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  try {
    const cleaned = responseText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned) as { hints: string[] };
    if (!parsed.hints || !Array.isArray(parsed.hints) || parsed.hints.length === 0) return null;

    // Validate hints against actual index — drop any referencing non-existent concepts
    const validated = validateHints(parsed.hints.slice(0, 3), selectorIndex);
    if (validated.length === 0) return null;

    const hintsBlock = validated
      .map((h) => `- ${h}`)
      .join("\n");

    return `## YOU MIGHT REMEMBER\n**Always call search_transcripts to verify before referencing past events. These are pointers, not facts.**\n${hintsBlock}\n`;
  } catch {
    logError("MEMORY-SEL", `Failed to parse selector response: ${responseText.substring(0, 200)}`);
    return null;
  }
}

/** Validate hints against the actual selector index. Drop hints referencing non-existent concepts. */
function validateHints(hints: string[], selectorIndex: string): string[] {
  return hints.filter((hint) => {
    // Extract concept names referenced in search_transcripts calls
    const conceptRefs = hint.match(/concept:([a-z0-9-]+)/gi) ?? [];
    for (const ref of conceptRefs) {
      const conceptName = ref.replace(/^concept:/i, "");
      if (!selectorIndex.includes(conceptName)) {
        log("MEMORY-SEL", `Hint references non-existent concept "${conceptName}", dropping`);
        return false;
      }
    }
    return true;
  });
}

/**
 * Get memory hints for the current turn.
 * Returns a context block to append, or null if no hints / not time to run.
 *
 * Runs on:
 * 1. Conversation entry (first turn, !isStreamingContinuation)
 * 2. Every TURNS_BETWEEN_RUNS turns thereafter
 *
 * Between runs, returns cached hints (stable for prompt cache).
 */
export async function getMemoryHints(
  channelId: string,
  author: string,
  messageContent: string,
  activeParticipantIds: string[],
  activeParticipantNames: string[],
  isStreamingContinuation: boolean,
): Promise<string | null> {
  // Get or create channel state
  let state = channelState.get(channelId);
  if (!state) {
    state = { turnCount: 0, cachedHints: null };
    channelState.set(channelId, state);
  }

  state.turnCount++;

  // Decide whether to run the selector
  const isConversationEntry = !isStreamingContinuation && state.turnCount === 1;
  const isNthTurn = state.turnCount > 1 && state.turnCount % TURNS_BETWEEN_RUNS === 0;

  if (!isConversationEntry && !isNthTurn) {
    // Return cached hints (or null) — stable for prompt cache
    return state.cachedHints;
  }

  // Build index (channel-scoped concepts + global sources)
  const selectorIndex = buildSelectorIndex(channelId, activeParticipantIds);
  if (!selectorIndex.trim()) {
    state.cachedHints = null;
    return null;
  }

  log("MEMORY-SEL", `Running selector (turn ${state.turnCount}, ${isConversationEntry ? "entry" : "nth-turn"})`);

  const hints = await callSelector(
    author,
    messageContent,
    activeParticipantNames,
    channelId,
    selectorIndex,
  );

  state.cachedHints = hints;
  if (hints) {
    log("MEMORY-SEL", `Generated hints for channel ${channelId}`);
  } else {
    log("MEMORY-SEL", `No relevant hints for channel ${channelId}`);
  }

  return hints;
}

/**
 * Reset channel state (call when a session is restarted).
 */
export function resetChannelMemoryState(channelId: string): void {
  channelState.delete(channelId);
}
