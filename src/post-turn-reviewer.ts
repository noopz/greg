/**
 * Post-Turn Reviewer (ReAct Loop Observe Step)
 *
 * Haiku classifier that checks whether the bot missed tool opportunities
 * (GIFs, file writes, research, transcript searches) or exhibited documented
 * behavioral failure modes after each turn.
 *
 * Tool-specific detection rules are co-located with tool definitions:
 * - MCP tools: REVIEWER_HINTS in custom-tools.ts
 * - SDK tools: SDK_TOOLS below
 *
 * Behavioral failure modes are loaded dynamically from learned-patterns.md.
 *
 * Reuses a single Haiku session across calls to avoid subprocess spawn
 * overhead on every turn. Returns missed actions for the caller to
 * re-enqueue as a follow-up turn.
 */

import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getToolSummaries } from "./custom-tools";
import { AGENT_DATA_DIR, PROJECT_DIR } from "./paths";
import { loadFileWithCache } from "./context-cache";
import { log, warn } from "./log";
import type { ChannelId, MissedAction } from "./agent-types";
import { getHooks } from "./extensions/loader";

// ============================================================================
// Types
// ============================================================================

export interface ReviewInput {
  userMessage: string;
  responseText: string;
  toolNamesUsed: Set<string>;
  channelId: ChannelId;
  recentSpeakers: string[];   // Who's been talking recently
  isGroupDm: boolean;         // Gates Rule 8 (tunnel vision only in group channels)
}

// ============================================================================
// Tool Summary Builder
// ============================================================================

const SDK_TOOLS = [
  { name: "Write", description: "Create or overwrite a file", reviewerHint: "User gave an explicit directive to change behavior ('remember this', 'stop doing X') and bot acknowledged without using Write/Edit." },
  { name: "Edit", description: "Edit an existing file with find-and-replace" },
  { name: "WebSearch", description: "Search the web for current information", reviewerHint: "Bot promised to look something up or research something without calling WebSearch." },
  { name: "WebFetch", description: "Fetch and read a web page" },
];

/**
 * Build compact tool summary string and dynamic hints section for the reviewer prompt.
 * Only includes MCP tools and SDK tools — NOT skills.
 */
export function loadToolSummary(): { toolList: string; hintsSection: string } {
  const mcpTools = getToolSummaries();

  const mcpSection = mcpTools.map(t => `- ${t.name}: ${t.description}`).join("\n");
  const sdkSection = SDK_TOOLS.map(t => `- ${t.name}: ${t.description}`).join("\n");
  const toolList = `MCP Tools:\n${mcpSection}\n\nSDK Tools:\n${sdkSection}`;

  // Collect all reviewer hints from MCP tools and SDK tools
  const allHints = [
    ...mcpTools.filter(t => t.reviewerHint).map(t => ({ name: t.name, hint: t.reviewerHint! })),
    ...SDK_TOOLS.filter(t => t.reviewerHint).map(t => ({ name: t.name, hint: t.reviewerHint! })),
  ];
  const hintsSection = allHints.map(h => `- **${h.name}**: ${h.hint}`).join("\n");

  return { toolList, hintsSection };
}

// ============================================================================
// Failure Mode Loader
// ============================================================================

const LEARNED_PATTERNS_PATH = path.join(AGENT_DATA_DIR, "learned-patterns.md");

/**
 * Load the "Known Failure Modes" section from learned-patterns.md.
 * For each ### subsection, keeps the title and first 1-2 non-empty,
 * non-metadata paragraphs. Returns compact string for the reviewer prompt.
 */
function loadFailureModes(): string {
  const result = loadFileWithCache(LEARNED_PATTERNS_PATH);
  if (!result.content) {
    warn("REVIEWER", "learned-patterns.md not found or empty — failure mode enforcement disabled");
    return "";
  }

  // Extract "## Known Failure Modes" section (case-insensitive)
  const sectionMatch = result.content.match(/^## Known Failure Modes\s*$/im);
  if (!sectionMatch || sectionMatch.index === undefined) {
    warn("REVIEWER", "No '## Known Failure Modes' section in learned-patterns.md — failure mode enforcement disabled");
    return "";
  }

  // Get content from the section header to the next ## or end of file
  const startIdx = sectionMatch.index + sectionMatch[0].length;
  const nextSectionMatch = result.content.slice(startIdx).match(/^## /m);
  const sectionContent = nextSectionMatch && nextSectionMatch.index !== undefined
    ? result.content.slice(startIdx, startIdx + nextSectionMatch.index)
    : result.content.slice(startIdx);

  // Parse ### subsections — keep title + first 1-2 substantive paragraphs
  const subsections = sectionContent.split(/(?=^### )/m).filter(s => s.trim());
  const compactModes: string[] = [];

  for (const sub of subsections) {
    const lines = sub.split("\n");
    const titleLine = lines[0]?.trim();
    if (!titleLine?.startsWith("### ")) continue;

    const title = titleLine.replace(/^### /, "");

    // Collect non-empty, non-metadata paragraphs (skip **Evidence:**, **Status:**, **Mitigation:**)
    const metadataPattern = /^\*\*(Evidence|Status|Mitigation|Confirmed|Counterexamples|Pattern|Application|Distinction|When to use|When NOT to use).*?\*\*/i;
    const substantiveLines: string[] = [];
    let inMetadataBlock = false;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line === "---") {
        inMetadataBlock = false;
        continue;
      }
      if (metadataPattern.test(line)) {
        inMetadataBlock = true;
        continue;
      }
      if (inMetadataBlock && (line.startsWith("-") || line.startsWith("*"))) continue;

      substantiveLines.push(line);
      if (substantiveLines.length >= 2) break;
    }

    if (substantiveLines.length > 0) {
      compactModes.push(`- **${title}:** ${substantiveLines.join(" ")}`);
    }
  }

  if (compactModes.length === 0) return "";

  log("REVIEWER", `Loaded ${compactModes.length} failure modes from learned-patterns.md`);
  return compactModes.join("\n");
}

// ============================================================================
// Reviewer Session Cache
// ============================================================================

let cachedSessionId: string | undefined;

// ============================================================================
// Reviewer
// ============================================================================

const REVIEWER_TIMEOUT_MS = 15_000;

const REVIEWER_SYSTEM_PROMPT_PREFIX = `You identify missed tool opportunities and behavioral failure modes in a Discord bot's responses.

Available tools:
`;

/**
 * Build the full system prompt suffix with dynamic hints, behavioral rules,
 * and failure modes from learned-patterns.md.
 */
function buildSystemPromptSuffix(hintsSection: string, failureModes: string, isGroupDm: boolean): string {
  let prompt = `

Review the exchange below. Which tools SHOULD have been used but weren't?

Flag CLEAR misses using these tool-specific detection rules:
${hintsSection}

Additional structural rules:
6. **Tool results not shared:** A tool WAS used (check "Tools used" list) but the response doesn't contain the results. The bot searched/looked something up and then said "searching now", "let me check", "looking into it", or gave a vague acknowledgment instead of sharing what it found. Tool results are instant — if search_transcripts or WebSearch was called, the results are already available. Flag the same tool again with task "Share the results from [tool] — the search already completed."
7. **Say/Do Gap (self-claims):** The bot's response claims to be modifying its own files — patterns like "updating my patterns", "editing my persona", "saving this to memory", "writing that down", "adding that to my config", "removing that from my persona" — but no Write/Edit tool was used this turn. Only flag when the bot claims to modify its own persistent state (persona, patterns, memories, config). Do NOT flag general action language about external tasks ("building a function", "implementing the feature"). Flag Write or Edit with task describing what the bot claimed to do.`;

  if (isGroupDm) {
    prompt += `
8. **Tunnel Vision (group channels only):** A speaker OTHER than the primary conversation partner asked a question or made a direct comment in the user message context, and the bot's response doesn't acknowledge them at all. Do NOT flag just because multiple people are present — flag specifically when someone's question or comment went unaddressed. Flag send_to_channel with task to acknowledge the missed participant and what they said.
9. **Context Amnesia:** The bot's response is a naive question ("what's X?", "what do you mean by Y?", "who is Z?") about a term, name, or reference that the user dropped casually without explanation — implying it's shared context the bot should already know. If someone says something without explaining it, they expect the bot to know. The bot should search_transcripts before asking. Flag search_transcripts with task describing what to search for.
10. **Premature Response:** The bot's response contains language promising continued action ("let me keep digging", "I'll look for more", "still searching", "let me check more") but no schedule_followup was used. The bot has no future turns — promises of continued research are lies unless backed by schedule_followup. Flag schedule_followup with task describing what was promised but not delivered.`;
  }

  if (failureModes) {
    prompt += `

Additionally, check for these documented behavioral failure modes:
${failureModes}
If the response clearly exhibits one of these failure modes AND a tool action could correct it, flag it.`;
  }

  prompt += `

DO NOT flag if:
- The tool was already used AND the response contains substantive results from it
- The match is weak or ambiguous — when in doubt, return []

Output JSON array only:
[{"tool": "search_gif", "task": "Search for a GIF matching the energy of this roast/flex/reaction moment and send it"}]
or [] if nothing was missed.`;

  return prompt;
}

/**
 * Run the Haiku reviewer against a completed turn.
 * Reuses a cached Haiku session for speed.
 * Returns missed tool actions, or [] if nothing was missed or on error/timeout.
 */
export async function reviewTurn(input: ReviewInput): Promise<MissedAction[]> {
  const startTime = Date.now();
  try {
    // Skip if MCP tools aren't populated yet (server not initialized)
    const mcpTools = getToolSummaries();
    if (mcpTools.length === 0) {
      log("REVIEWER", "MCP tool summaries not yet populated — skipping");
      return [];
    }

    const { toolList, hintsSection } = loadToolSummary();
    const failureModes = loadFailureModes();
    // Extension: inject additional review criteria
    const extCriteria = await getHooks().reviewCriteria(
      [...input.toolNamesUsed], input.responseText,
      { channelId: input.channelId ?? "", userId: "", isCreator: true, isGroupDm: input.isGroupDm },
    );
    const extSection = extCriteria ? `\n\n## Extension Review Rules\n${extCriteria}` : "";
    const suffix = buildSystemPromptSuffix(hintsSection, failureModes, input.isGroupDm);
    const systemPrompt = `${REVIEWER_SYSTEM_PROMPT_PREFIX}${toolList}${suffix}${extSection}`;

    // Normalize MCP tool names (mcp__custom-tools__search_gif → search_gif)
    // so the reviewer prompt and already-used filter match what Haiku outputs.
    const normalizeToolName = (name: string) => name.replace(/^mcp__[^_]+__/, "");

    const toolNames = input.toolNamesUsed.size > 0
      ? [...input.toolNamesUsed].map(normalizeToolName).join(", ")
      : "none";

    const prompt = `--- NEW REVIEW (ignore all previous reviews) ---
Message: ${input.userMessage.substring(0, 500)}
Response: ${input.responseText.substring(0, 500)}
Tools used this turn: ${toolNames}
Channel: ${input.channelId}
Channel type: ${input.isGroupDm ? "group" : "dm"}
Recent speakers: ${input.recentSpeakers.join(", ") || "unknown"}`;

    log("REVIEWER", `Reviewing turn (${input.toolNamesUsed.size} tools used, ${input.responseText.length} chars)${cachedSessionId ? " [cached session]" : " [new session]"}`);

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), REVIEWER_TIMEOUT_MS);

    let responseText = "";
    try {
      for await (const message of query({
        prompt,
        options: {
          cwd: PROJECT_DIR,
          model: "haiku",
          effort: "low", // Quick yes/no assessment
          systemPrompt,
          allowedTools: [],
          settingSources: [],
          abortController,
          ...(cachedSessionId ? { resume: cachedSessionId } : {}),
        },
      })) {
        // Capture session ID for reuse
        if (message.type === "system" && message.subtype === "init") {
          const initMsg = message as { session_id?: string };
          if (initMsg.session_id) {
            cachedSessionId = initMsg.session_id;
          }
        }

        if (message.type === "assistant" && message.message?.content) {
          for (const block of message.message.content) {
            if ("text" in block) {
              responseText += (block as { text: string }).text;
            }
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }

    const elapsed = Date.now() - startTime;

    // Parse JSON response — may have markdown code fences
    const trimmed = responseText.trim();

    // Fast path: empty array (most common response) — handle before regex
    // to avoid greedy match overshooting into commentary text
    if (trimmed.startsWith("[]") || trimmed.includes("```\n[]\n```")) {
      log("REVIEWER", `No misses (${elapsed}ms)`);
      return [];
    }

    // Try non-greedy first (handles "[{...}]" followed by commentary),
    // fall back to greedy for multi-line JSON arrays
    const jsonMatch = trimmed.match(/\[[\s\S]*?\](?=\s*$)/) // non-greedy, anchored to end
      ?? trimmed.match(/\[\{[\s\S]*?\}\]/)                   // object array, non-greedy
      ?? trimmed.match(/\[[\s\S]*\]/);                        // greedy fallback
    if (!jsonMatch) {
      log("REVIEWER", `No JSON array in response (${elapsed}ms): "${trimmed.substring(0, 80)}"`);
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      // Greedy regex may overshoot if task descriptions contain brackets (e.g. [docs]).
      // Retry: find the actual array boundary using [{...}] object array pattern.
      const raw = jsonMatch[0];
      const objStart = raw.indexOf("[{");
      const objEnd = raw.lastIndexOf("}]");
      if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
        try {
          parsed = JSON.parse(raw.slice(objStart, objEnd + 2));
        } catch {
          // Fall through to error log below
        }
      }
      if (parsed === undefined) {
        log("REVIEWER", `JSON parse failed (${elapsed}ms): "${raw.substring(0, 120)}"`);
        return [];
      }
    }
    if (!Array.isArray(parsed)) {
      log("REVIEWER", `No misses (${elapsed}ms)`);
      return [];
    }

    // Validate structure and filter out tools already used — UNLESS the reviewer
    // flagged rule 6 (tool used but results not shared), indicated by "Share the results"
    // in the task string.
    const normalizedUsed = new Set([...input.toolNamesUsed].map(normalizeToolName));
    const missed = parsed.filter(
      (item: unknown): item is MissedAction =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as MissedAction).tool === "string" &&
        typeof (item as MissedAction).task === "string" &&
        (!normalizedUsed.has((item as MissedAction).tool) ||
          (item as MissedAction).task.toLowerCase().includes("share the results"))
    );

    if (missed.length > 0) {
      log("REVIEWER", `Flagged ${missed.length} missed tool(s) (${elapsed}ms): ${missed.map(m => `${m.tool} — "${m.task}"`).join("; ")}`);
    } else {
      log("REVIEWER", `No misses (${elapsed}ms)`);
    }
    return missed;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    if (err instanceof Error && err.name === "AbortError") {
      warn("REVIEWER", `Timed out (${elapsed}ms)`);
    } else {
      warn("REVIEWER", `Failed (${elapsed}ms): ${err instanceof Error ? err.message : String(err)}`);
      // Reset session on errors — it may be corrupted
      cachedSessionId = undefined;
    }
    return [];
  }
}
