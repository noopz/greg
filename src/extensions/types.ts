/**
 * Extension System Types
 *
 * Defines the contract for composable extensions in local/extensions/*.ts.
 * Each extension exports a default object matching the Extension interface.
 */

import type { GateInput } from "../gates/gate";
import type { Client } from "../discord";
import type { BotConfig } from "../bot-types";
import type { AgentContext, TurnResult, ContextRefreshCallback } from "../agent-types";
import type { TypingCallback } from "../streaming-session";

// ============================================================================
// Hook Parameter Types
// ============================================================================

/** Context passed to per-turn hooks */
export interface ExtensionContext {
  channelId: string;
  userId: string;
  isCreator: boolean;
  isGroupDm: boolean;
}

/** A context section to inject into dynamic context */
export interface ContextSection {
  /** Section heading (e.g., "## GAME STATE") */
  heading: string;
  /** Section body content */
  body: string;
}

/** Response envelope for the postResponse pipeline */
export interface ResponseEnvelope {
  /** The response text (transform this to modify the response) */
  text: string;
  /** Set to true to suppress sending entirely */
  suppress: boolean;
  channelId: string;
  userId: string;
  isCreator: boolean;
}

/** Signature of the default turn executor (passed for wrap-and-delegate) */
export type DefaultExecuteTurn = (
  discordContext: string,
  options: AgentContext,
  contextRefreshCallback?: ContextRefreshCallback,
  typingCallback?: TypingCallback,
) => Promise<TurnResult>;

// ============================================================================
// Extension Interface
// ============================================================================

/** The shape of a single extension file's default export. Every field is optional. */
export interface Extension {
  /** Human-readable name (defaults to filename stem) */
  name?: string;
  /** Description for logging/debugging */
  description?: string;
  /** Lower runs first. Default 0. */
  priority?: number;

  // --- Lifecycle (additive: all run) ---

  /** Called once at startup and on hot-reload */
  onReady?: (client: Client, config: BotConfig) => void | Promise<void>;

  // --- Gate (first-match: first non-null wins) ---

  /** Return true (force respond), false (force skip), or null (pass to next) */
  shouldRespond?: (input: GateInput) => boolean | null | Promise<boolean | null>;

  // --- Prompt (override: one winner, lowest priority) ---

  /** Return a complete system prompt string, or null to not override */
  systemPrompt?: (persona: string) => string | null | Promise<string | null>;

  // --- Context (additive: all results combined) ---

  /** Return context sections to inject, or empty array */
  contextSections?: (ctx: ExtensionContext) => ContextSection[] | Promise<ContextSection[]>;

  // --- Turn Execution (override: one winner, receives default for delegation) ---

  /**
   * Override the entire turn executor.
   * - Replace: ignore defaultExecutor, return your own TurnResult
   * - Wrap: call defaultExecutor with pre/post processing
   * - Conditional: check context, either handle or delegate
   */
  executeTurn?: (
    discordContext: string,
    options: AgentContext,
    defaultExecutor: DefaultExecuteTurn,
    contextRefreshCallback?: ContextRefreshCallback,
    typingCallback?: TypingCallback,
  ) => Promise<TurnResult>;

  // --- Response (pipeline: chained in priority order) ---

  /** Transform or suppress the response before sending to Discord */
  postResponse?: (envelope: ResponseEnvelope) => ResponseEnvelope | Promise<ResponseEnvelope>;

  // --- Meta-cognitive hooks (self-modification capabilities) ---

  /** Override the memory flush prompt. Return custom prompt or null for default. (override) */
  memoryFlush?: (recentConversation: string, ctx: ExtensionContext) =>
    string | null | Promise<string | null>;

  /** Return additional review criteria for the post-turn reviewer. (additive) */
  reviewCriteria?: (toolNames: string[], responseText: string, ctx: ExtensionContext) =>
    string | null | Promise<string | null>;

  /** Override idle behavior selection. Return a behavior name or null for default. (override) */
  selectIdleBehavior?: (behaviorNames: string[], ctx: ExtensionContext) =>
    string | null | Promise<string | null>;

  /** Override message classification (queue vs fork). Return routing or null for default. (override) */
  classifyMessage?: (
    messages: Array<{ userId: string; content: string }>,
    queueContext: { currentTurnUserId: string },
  ) => { queue: number[]; fork: number[][] } | null | Promise<{ queue: number[]; fork: number[][] } | null>;

  /** Called when a reaction is added to one of the bot's messages. (additive) */
  onReaction?: (reaction: {
    emoji: string; userId: string; messageText: string; channelId: string;
  }) => void | Promise<void>;

  /** Called after an idle skill finishes. Track effectiveness for learning loops. (additive) */
  onSkillComplete?: (result: {
    skillName: string; success: boolean; cost: number;
    toolCalls: number; durationMs: number; responseText: string | null;
  }) => void | Promise<void>;

  /** Transform the assembled context string. Remove sections, reorder, truncate. (pipeline) */
  contextFilter?: (context: string, ctx: ExtensionContext) =>
    string | Promise<string>;
}
