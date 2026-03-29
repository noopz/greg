/**
 * Extension Loader
 *
 * Discovers, loads, composes, and hot-reloads extensions from local/extensions/*.ts.
 * Each extension is an independent file exporting a default Extension object.
 * Hooks are composed using per-hook strategies (additive, first-match, override, pipeline).
 */

import fs from "node:fs/promises";
import { watch, type FSWatcher, existsSync } from "node:fs";
import path from "node:path";
import { EXTENSIONS_DIR } from "../paths";
import { log, warn, error as logError } from "../log";
import type { Client } from "../discord";
import type { BotConfig } from "../bot-types";
import type { GateInput } from "../gates/gate";
import type { AgentContext, TurnResult, ContextRefreshCallback } from "../agent-types";
import type { TypingCallback } from "../streaming-session";
import type {
  Extension,
  ExtensionContext,
  ContextSection,
  ResponseEnvelope,
  DefaultExecuteTurn,
} from "./types";

const LOG_TAG = "EXT";
const DEBOUNCE_MS = 500;

// ============================================================================
// Internal State
// ============================================================================

interface LoadedExtension {
  name: string;
  filename: string;
  priority: number;
  ext: Extension;
}

/** Composed hooks — pre-built functions that encapsulate composition logic */
export interface ComposedHooks {
  onReady: (client: Client, config: BotConfig) => Promise<void>;
  shouldRespond: (input: GateInput) => Promise<boolean | null>;
  systemPrompt: (persona: string) => Promise<string | null>;
  contextSections: (ctx: ExtensionContext) => Promise<ContextSection[]>;
  executeTurn: (
    discordContext: string,
    options: AgentContext,
    defaultExecutor: DefaultExecuteTurn,
    contextRefreshCallback?: ContextRefreshCallback,
    typingCallback?: TypingCallback,
  ) => Promise<TurnResult | null>;
  postResponse: (envelope: ResponseEnvelope) => Promise<ResponseEnvelope>;
  memoryFlush: (recentConversation: string, ctx: ExtensionContext) => Promise<string | null>;
  reviewCriteria: (toolNames: string[], responseText: string, ctx: ExtensionContext) => Promise<string | null>;
  selectIdleBehavior: (behaviorNames: string[], ctx: ExtensionContext) => Promise<string | null>;
  classifyMessage: (
    messages: Array<{ userId: string; content: string }>,
    queueContext: { currentTurnUserId: string },
  ) => Promise<{ queue: number[]; fork: number[][] } | null>;
  onReaction: (reaction: { emoji: string; userId: string; messageText: string; channelId: string }) => Promise<void>;
  onSkillComplete: (result: { skillName: string; success: boolean; cost: number; toolCalls: number; durationMs: number; responseText: string | null }) => Promise<void>;
  contextFilter: (context: string, ctx: ExtensionContext) => Promise<string>;
}

let currentHooks: ComposedHooks = buildEmptyHooks();
let watcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let clientRef: Client | null = null;
let configRef: BotConfig | null = null;

// ============================================================================
// Public API
// ============================================================================

/** Get the current composed hooks. Always returns a valid object (empty hooks if no extensions). */
export function getHooks(): ComposedHooks {
  return currentHooks;
}

/** Initialize the extension system: discover, load, compose, start watching. */
export async function initExtensions(client: Client, config: BotConfig): Promise<void> {
  clientRef = client;
  configRef = config;

  // Ensure directory exists
  if (!existsSync(EXTENSIONS_DIR)) {
    await fs.mkdir(EXTENSIONS_DIR, { recursive: true });
  }

  await reloadAll();

  // Watch for changes
  try {
    watcher = watch(EXTENSIONS_DIR, (_event, filename) => {
      if (!filename?.endsWith(".ts")) return;
      // Debounce rapid changes (editor save events, etc.)
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        log(LOG_TAG, `File changed: ${filename}, reloading extensions...`);
        reloadAll().catch(err => {
          logError(LOG_TAG, "Reload failed", err);
        });
      }, DEBOUNCE_MS);
    });
  } catch {
    warn(LOG_TAG, "Could not watch extensions directory — hot-reload disabled");
  }
}

/** Stop the file watcher. Called during graceful shutdown. */
export function stopExtensions(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  watcher?.close();
  watcher = null;
}

// ============================================================================
// Discovery & Loading
// ============================================================================

async function discoverAndLoad(): Promise<LoadedExtension[]> {
  let files: string[];
  try {
    files = await fs.readdir(EXTENSIONS_DIR);
  } catch {
    return []; // Directory doesn't exist or can't be read
  }

  const tsFiles = files.filter(f => f.endsWith(".ts") && !f.startsWith("."));
  const loaded: LoadedExtension[] = [];

  for (const filename of tsFiles) {
    const filePath = path.join(EXTENSIONS_DIR, filename);
    try {
      // Cache-busting: append timestamp to force Bun to re-evaluate ESM modules
      const mod = await import(filePath + "?t=" + Date.now());
      const ext: Extension = mod.default ?? mod;

      // Basic validation
      if (typeof ext !== "object" || ext === null) {
        warn(LOG_TAG, `${filename}: default export is not an object, skipping`);
        continue;
      }

      const name = ext.name ?? filename.replace(/\.ts$/, "");
      const priority = ext.priority ?? 0;

      loaded.push({ name, filename, priority, ext });
      log(LOG_TAG, `Loaded: ${name} (priority ${priority})`);
    } catch (err) {
      warn(LOG_TAG, `Failed to load ${filename}: ${err instanceof Error ? err.message : String(err)}`);
      // Skip this extension, continue loading others
    }
  }

  // Sort by priority (ascending — lower number = higher priority)
  loaded.sort((a, b) => a.priority - b.priority);
  return loaded;
}

async function reloadAll(): Promise<void> {
  const newLoaded = await discoverAndLoad();
  const newHooks = compose(newLoaded);

  // Atomic swap
  currentHooks = newHooks;

  if (newLoaded.length > 0) {
    log(LOG_TAG, `${newLoaded.length} extension(s) active: ${newLoaded.map(e => e.name).join(", ")}`);
  } else {
    log(LOG_TAG, "No extensions loaded");
  }

  // Run onReady for all extensions (on initial load and hot-reload)
  if (clientRef && configRef) {
    await newHooks.onReady(clientRef, configRef);
  }
}

// ============================================================================
// Composition
// ============================================================================

function compose(extensions: LoadedExtension[]): ComposedHooks {
  return {
    // ADDITIVE: all run, errors isolated
    onReady: async (client, config) => {
      for (const le of extensions) {
        if (!le.ext.onReady) continue;
        try {
          await le.ext.onReady(client, config);
        } catch (err) {
          logError(LOG_TAG, `${le.name}.onReady failed`, err);
        }
      }
    },

    // FIRST-MATCH: first non-null wins, ordered by priority
    shouldRespond: async (input) => {
      for (const le of extensions) {
        if (!le.ext.shouldRespond) continue;
        try {
          const result = await le.ext.shouldRespond(input);
          if (result !== null) {
            log(LOG_TAG, `${le.name}.shouldRespond: ${result ? "YES" : "NO"}`);
            return result;
          }
        } catch (err) {
          logError(LOG_TAG, `${le.name}.shouldRespond failed`, err);
        }
      }
      return null; // No extension had an opinion → fall through to default gate
    },

    // OVERRIDE: lowest priority provider wins, warn if multiple
    systemPrompt: async (persona) => {
      const providers = extensions.filter(le => le.ext.systemPrompt);
      if (providers.length > 1) {
        warn(LOG_TAG, `Multiple systemPrompt providers: ${providers.map(p => p.name).join(", ")}. Using ${providers[0].name} (priority ${providers[0].priority})`);
      }
      if (providers.length === 0) return null;
      try {
        return await providers[0].ext.systemPrompt!(persona);
      } catch (err) {
        logError(LOG_TAG, `${providers[0].name}.systemPrompt failed`, err);
        return null;
      }
    },

    // ADDITIVE: all results concatenated
    contextSections: async (ctx) => {
      const allSections: ContextSection[] = [];
      for (const le of extensions) {
        if (!le.ext.contextSections) continue;
        try {
          const sections = await le.ext.contextSections(ctx);
          allSections.push(...sections);
        } catch (err) {
          logError(LOG_TAG, `${le.name}.contextSections failed`, err);
        }
      }
      return allSections;
    },

    // OVERRIDE: lowest priority provider wins, receives default executor
    executeTurn: async (discordContext, options, defaultExecutor, contextRefreshCallback, typingCallback) => {
      const providers = extensions.filter(le => le.ext.executeTurn);
      if (providers.length > 1) {
        warn(LOG_TAG, `Multiple executeTurn providers: ${providers.map(p => p.name).join(", ")}. Using ${providers[0].name} (priority ${providers[0].priority})`);
      }
      if (providers.length === 0) return null; // No override → caller uses default
      try {
        return await providers[0].ext.executeTurn!(discordContext, options, defaultExecutor, contextRefreshCallback, typingCallback);
      } catch (err) {
        logError(LOG_TAG, `${providers[0].name}.executeTurn failed`, err);
        return null; // Fall back to default executor
      }
    },

    // PIPELINE: chained in priority order, short-circuit on suppress
    postResponse: async (envelope) => {
      let current = envelope;
      for (const le of extensions) {
        if (!le.ext.postResponse) continue;
        try {
          current = await le.ext.postResponse(current);
          if (current.suppress) {
            log(LOG_TAG, `${le.name}.postResponse suppressed`);
            break;
          }
        } catch (err) {
          logError(LOG_TAG, `${le.name}.postResponse failed`, err);
          // Error → pass envelope through unmodified
        }
      }
      return current;
    },

    // OVERRIDE: custom memory flush prompt
    memoryFlush: async (recentConversation, ctx) => {
      const providers = extensions.filter(le => le.ext.memoryFlush);
      if (providers.length > 1) {
        warn(LOG_TAG, `Multiple memoryFlush providers: ${providers.map(p => p.name).join(", ")}. Using ${providers[0].name}`);
      }
      if (providers.length === 0) return null;
      try {
        return await providers[0].ext.memoryFlush!(recentConversation, ctx);
      } catch (err) {
        logError(LOG_TAG, `${providers[0].name}.memoryFlush failed`, err);
        return null;
      }
    },

    // ADDITIVE: all review criteria concatenated
    reviewCriteria: async (toolNames, responseText, ctx) => {
      const allCriteria: string[] = [];
      for (const le of extensions) {
        if (!le.ext.reviewCriteria) continue;
        try {
          const criteria = await le.ext.reviewCriteria(toolNames, responseText, ctx);
          if (criteria) allCriteria.push(criteria);
        } catch (err) {
          logError(LOG_TAG, `${le.name}.reviewCriteria failed`, err);
        }
      }
      return allCriteria.length > 0 ? allCriteria.join("\n") : null;
    },

    // OVERRIDE: custom idle behavior selection
    selectIdleBehavior: async (behaviorNames, ctx) => {
      const providers = extensions.filter(le => le.ext.selectIdleBehavior);
      if (providers.length > 1) {
        warn(LOG_TAG, `Multiple selectIdleBehavior providers: ${providers.map(p => p.name).join(", ")}. Using ${providers[0].name}`);
      }
      if (providers.length === 0) return null;
      try {
        return await providers[0].ext.selectIdleBehavior!(behaviorNames, ctx);
      } catch (err) {
        logError(LOG_TAG, `${providers[0].name}.selectIdleBehavior failed`, err);
        return null;
      }
    },

    // OVERRIDE: custom message classification
    classifyMessage: async (messages, queueContext) => {
      const providers = extensions.filter(le => le.ext.classifyMessage);
      if (providers.length > 1) {
        warn(LOG_TAG, `Multiple classifyMessage providers: ${providers.map(p => p.name).join(", ")}. Using ${providers[0].name}`);
      }
      if (providers.length === 0) return null;
      try {
        return await providers[0].ext.classifyMessage!(messages, queueContext);
      } catch (err) {
        logError(LOG_TAG, `${providers[0].name}.classifyMessage failed`, err);
        return null;
      }
    },

    // ADDITIVE: all reaction handlers run
    onReaction: async (reaction) => {
      for (const le of extensions) {
        if (!le.ext.onReaction) continue;
        try {
          await le.ext.onReaction(reaction);
        } catch (err) {
          logError(LOG_TAG, `${le.name}.onReaction failed`, err);
        }
      }
    },

    // ADDITIVE: all skill completion handlers run
    onSkillComplete: async (result) => {
      for (const le of extensions) {
        if (!le.ext.onSkillComplete) continue;
        try {
          await le.ext.onSkillComplete(result);
        } catch (err) {
          logError(LOG_TAG, `${le.name}.onSkillComplete failed`, err);
        }
      }
    },

    // PIPELINE: chained context transforms
    contextFilter: async (context, ctx) => {
      let current = context;
      for (const le of extensions) {
        if (!le.ext.contextFilter) continue;
        try {
          current = await le.ext.contextFilter(current, ctx);
        } catch (err) {
          logError(LOG_TAG, `${le.name}.contextFilter failed`, err);
        }
      }
      return current;
    },
  };
}

function buildEmptyHooks(): ComposedHooks {
  return {
    onReady: async () => {},
    shouldRespond: async () => null,
    systemPrompt: async () => null,
    contextSections: async () => [],
    executeTurn: async () => null,
    postResponse: async (e) => e,
    memoryFlush: async () => null,
    reviewCriteria: async () => null,
    selectIdleBehavior: async () => null,
    classifyMessage: async () => null,
    onReaction: async () => {},
    onSkillComplete: async () => {},
    contextFilter: async (c) => c,
  };
}
