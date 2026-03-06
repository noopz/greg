/**
 * Agent Types & Pure Functions
 *
 * Zero state. Minimal IO (logging only). The leaf node everything imports from.
 * Contains shared types, constants, and pure functions used across
 * agent.ts, haiku-router.ts, and turn-executor.ts.
 */

import { getMinimalSystemPrompt } from "./system-prompt-minimal";
import { stripReasoningTags, hasReasoningTags } from "./reasoning-tags";
import { log } from "./log";
import { getLocalToolNames, getLocalPaths } from "./local-config";

// ============================================================================
// System Prompt Mode
// ============================================================================

type SystemPromptMode = "claude_code" | "minimal";

export function getSystemPromptMode(): SystemPromptMode {
  const mode = process.env.SYSTEM_PROMPT_MODE?.toLowerCase();
  if (mode === "claude_code") {
    return "claude_code";
  }
  return "minimal";
}

// ============================================================================
// Branded ID Types (compile-time safety, zero runtime cost)
// ============================================================================

type Brand<T, B extends string> = T & { readonly __brand: B };

export type ChannelId = Brand<string, "ChannelId">;
export type UserId = Brand<string, "UserId">;
export type SessionId = Brand<string, "SessionId">;

/** Wrap a raw string as a ChannelId (use at system boundaries only) */
export function channelId(s: string): ChannelId { return s as ChannelId; }
/** Wrap a raw string as a UserId (use at system boundaries only) */
export function userId(s: string): UserId { return s as UserId; }
/** Wrap a raw string as a SessionId (use at system boundaries only) */
export function sessionId(s: string): SessionId { return s as SessionId; }

// ============================================================================
// User Registry (ID → username cache for readable logs)
// ============================================================================

const usernames = new Map<string, string>();

/** Cache a userId→username mapping (call at system boundaries when both are available) */
export function registerUser(id: UserId | string, username: string): void {
  usernames.set(String(id), username);
}

/** Resolve a userId to "username(id)" for logs, or just "id" if unknown */
export function resolveUser(id: UserId | string | undefined): string {
  if (!id) return "unknown";
  const name = usernames.get(String(id));
  return name ? `${name}(${id})` : String(id);
}

// ============================================================================
// Types
// ============================================================================

/** Missed tool action flagged by the post-turn Haiku reviewer. */
export interface MissedAction {
  tool: string;
  task: string;
}

/** Discriminated union for turn execution outcomes */
export type TurnResult =
  | { kind: "response"; text: string; toolNamesUsed: Set<string> }
  | { kind: "no_response"; toolNamesUsed: Set<string> }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; error: Error };

export interface AgentContext {
  mustRespond: boolean;
  channelId: ChannelId;
  isGroupDm: boolean;
  /** Whether the message is from the creator (has elevated privileges) */
  isCreator: boolean;
  /** Timestamp when processing started (for staleness check) */
  processingStartedAt?: number;
  /** Original message ID that triggered the response */
  originalMessageId?: string;
  /** Whether this message is a reply to Greg's message */
  isReplyToBot?: boolean;
  /** User ID of the message author (for fork detection) */
  userId?: UserId;
  /** Whether this is a follow-up in an active conversation */
  isFollowUp?: boolean;
  /** Image content blocks (Phase 5: populated when ENABLE_IMAGES=1) */
  imageBlocks?: Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }>;
}

/** Callback to check for new messages before sending response */
export type ContextRefreshCallback = () => Promise<{
  newMessageCount: number;
  shouldSkip: boolean;
  acknowledgment?: string;
}>;

// ============================================================================
// Pure Functions
// ============================================================================

/**
 * Build the Discord response prompt including dynamic context and response instructions.
 */
export function buildDiscordResponsePrompt(dynamicContext: string, options: AgentContext): string {
  let responseInstruction: string;
  if (options.mustRespond) {
    responseInstruction = "You MUST respond to this message.";
  } else if (options.isFollowUp) {
    responseInstruction = "You're in an active conversation, so responding is natural — but you do NOT need to reply to everything. Only respond if you'd genuinely react as a friend (something funny, surprising, or you have a real take). Letting others have the last word is fine. [NO_RESPONSE] if you have nothing worth adding.";
  } else {
    responseInstruction = "Decide whether to respond based on context. If you choose not to respond, output exactly: [NO_RESPONSE]";
  }

  return `${dynamicContext}

---

## CURRENT MESSAGE

${responseInstruction}

${options.isGroupDm ? "This is from the group DM." : "This is a direct message."}
Channel ID: ${options.channelId}

Use <think> tags for internal reasoning (hidden from users). Everything else is your response.
GIFs are native to how you communicate. For roasts, flexes, reaction moments, or any banter where a GIF hits harder than text — use search_gif and send ONLY the URL. No text in the same message as a GIF — the GIF IS the response. Discord auto-embeds it.
${options.isCreator
    ? "If something significant happened (got recognized, learned a boundary, noticed a pattern), silently log an impression."
    : (() => {
  const localPaths = getLocalPaths();
  const extraReads = localPaths.read.map(p => p.replace("agent-data/", ""));
  const extraWrites = localPaths.write.map(p => p.replace("agent-data/", ""));
  const readList = ["memories/", "skills/", ...extraReads].join(", ");
  const writeList = ["relationships/", "impressions/", "memories/", ...extraWrites].join(", ");
  return `**Non-creator turn — path-restricted tools.**
**Reads:** ${readList}. Other reads are blocked.
**Writes:** ${writeList} — direct Write/Edit works.
**Blocked writes** (persona, patterns, config, source) return a safety prompt. If the write is legitimate, use schedule_followup to defer it.
**Bash/Task:** unavailable on non-creator turns.
If you notice something worth remembering, just Write/Edit to the appropriate file — no need for schedule_followup unless the path is protected.`;
})()}`;
}

/**
 * Build system prompt config based on the current mode setting.
 * Persona is injected into the system prompt for higher LLM attention weight.
 */
export function buildSystemPromptConfig(persona?: string) {
  const promptMode = getSystemPromptMode();
  if (promptMode === "minimal") {
    const base = getMinimalSystemPrompt();
    if (persona) {
      return base.replace("{{PERSONA}}", persona);
    }
    return base;
  }
  return { type: "preset" as const, preset: "claude_code" as const };
}

/**
 * Build the allowed tools list based on creator status.
 *
 * Security model: Non-creators get file tools (Read/Write/Edit/Glob/Grep) but
 * path-gated via PreToolUse hooks in access-control.ts. Reads limited to game
 * info, memories, skills. Writes limited to relationships, impressions, memories,
 * game info. Protected paths (persona, patterns, config, source) are denied with
 * a safety-check message that guides Greg to evaluate the request and use
 * schedule_followup if legitimate.
 *
 * Creator-only: Bash, Task, send_to_channel
 * Public: Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Skill, schedule_followup, search_gif
 */
export function buildAllowedTools(isCreator: boolean, hasCustomTools: boolean): string[] {
  const publicTools = ["WebSearch", "WebFetch", "Skill", "Read", "Glob", "Grep"];
  // Write/Edit available to all — non-creators are path-gated via PreToolUse hooks
  // Bash/Task remain creator-only (can't meaningfully path-gate shell commands)
  const fileWriteTools = ["Write", "Edit"];
  const creatorOnlyTools = ["Bash", "Task"];

  // Framework tools that are always available when custom tools server exists
  const frameworkCustomTools = hasCustomTools
    ? ["mcp__custom-tools__send_to_channel", "mcp__custom-tools__schedule_followup",
       "mcp__custom-tools__search_gif", "mcp__custom-tools__react_to_message",
       "mcp__custom-tools__search_transcripts"]
    : [];
  // Framework tools restricted to creator
  const creatorOnlyCustomTools = hasCustomTools
    ? ["mcp__custom-tools__send_to_channel", "mcp__custom-tools__get_channel_history"]
    : [];

  return isCreator
    ? [...publicTools, ...creatorOnlyTools, ...fileWriteTools,
       ...frameworkCustomTools, ...creatorOnlyCustomTools, ...getLocalToolNames("creator")]
    : [...publicTools, ...fileWriteTools,
       ...frameworkCustomTools.filter(t => !creatorOnlyCustomTools.includes(t)),
       ...getLocalToolNames("public")];
}

/**
 * Patterns that indicate leaked internal reasoning (should have been in <think> tags).
 * Each pattern is tested against individual paragraphs of the response.
 */
const LEAKED_REASONING_PATTERNS: RegExp[] = [
  // References to own source code or internal architecture
  /\bsrc\/[a-z_-]+\.ts\b/i,
  /\bturn-executor\b/i,
  /\ballowedTools\b/,
  /\bisCreator\b/,
  /\bsettingSources\b/,
  // Meta-commentary about tool failures or permissions
  /\b(tool call|tool use|file access)\b.*\b(fail|block|denied|restrict|disabled)\b/i,
  /\b(fail|block|denied|restrict|disabled)\b.*\b(tool call|tool use|file access)\b/i,
  // Self-referential debugging about being a bot
  /\bnon-creator\s+(request|message|user)\b/i,
  /\bSDK\b.*\b(error|fail|block|session)\b/i,
  // Metacognitive planning — narrating own thought process instead of responding
  /^(now\s+)?I\s+have\s+enough\s+(data|info|information)\b/i,
  /^let\s+me\s+(think|reason|analyze|consider|figure|work)\s+(about|through|on)\b/i,
  /^(now\s+)?let\s+me\s+(compile|put|pull|gather|summarize|organize)\s+(this|that|the|all|it)\s+(together|all|into)\b/i,
  // API errors leaked as assistant text (SDK crash artifacts)
  /^API Error:\s*\d{3}\b/,
  /^\{?"type"\s*:\s*"error"/,
];

/**
 * Sanitize response by stripping reasoning tags and filtering leaked internal text.
 */
export function sanitizeResponse(response: string): string {
  let sanitized = stripReasoningTags(response);

  if (hasReasoningTags(response)) {
    const reduction = response.length - sanitized.length;
    if (reduction > 0) {
      log("SDK", `Stripped reasoning tags: ${response.length} -> ${sanitized.length} chars (-${reduction})`);
    }
  }

  // Filter paragraphs that look like leaked internal reasoning
  const paragraphs = sanitized.split(/\n\n+/);
  if (paragraphs.length > 1) {
    const filtered = paragraphs.filter(p => {
      for (const pattern of LEAKED_REASONING_PATTERNS) {
        if (pattern.test(p)) {
          log("SDK", `Filtered leaked reasoning (matched ${pattern.source}): "${p.substring(0, 60)}..."`);
          return false;
        }
      }
      return true;
    });
    if (filtered.length < paragraphs.length) {
      sanitized = filtered.join("\n\n");
    }
  }

  return sanitized.trim();
}

/**
 * Extract user IDs from Discord context string.
 * Looks for patterns like "username (123456789)" or "(123456789)"
 */
export function extractUserIds(discordContext: string): string[] {
  const idPattern = /\((\d{17,20})\)/g;
  const ids: string[] = [];
  let match;

  while ((match = idPattern.exec(discordContext)) !== null) {
    if (!ids.includes(match[1])) {
      ids.push(match[1]);
    }
  }

  return ids;
}

/**
 * Detect "nudge" messages -- bare @mentions, "?", "^", etc.
 * These are attention-getters, not substantive messages.
 */
export function isNudgeMessage(messageLine: string): boolean {
  const stripped = messageLine
    .replace(/\[.*?\]:\s*/, "")
    .replace(/<@!?\d+>/g, "")
    .replace(/<external-content[^>]*>[\s\S]*?<\/external-content>/g, "")
    .trim();

  if (stripped.length === 0) return true;
  if (/^[?^.!]+$/.test(stripped)) return true;

  return false;
}

/**
 * Extract the last message content from a Discord context string.
 */
export function extractMessageContent(context: string): string {
  const lines = context.trim().split("\n").filter(l => l.trim());
  const messageLine = lines[lines.length - 1] || context.substring(0, 200);
  return messageLine.substring(0, 200);
}


/** Check if a response is a NO_RESPONSE marker */
export function isNoResponse(text: string): boolean {
  return text.trim() === "[NO_RESPONSE]" || text.includes("[NO_RESPONSE]");
}