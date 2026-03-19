/**
 * Idle Behavior System
 *
 * Triggers periodic reflection and self-improvement when idle.
 * Gives the bot time to think, research, and improve when not chatting.
 *
 * Idle behaviors are loaded from skills in .claude/skills/<name>/SKILL.md
 * Skills can define an optional "## Idle Behavior" section with optional cooldown.
 *
 * Features:
 * - Tracks last run time for each behavior in agent-data/idle-state.json
 * - Respects cooldowns defined in skills (e.g., "Cooldown: 1 hour")
 * - Uses the bot to choose from eligible behaviors based on what feels most useful
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "discord.js-selfbot-v13";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { BotConfig, dmCreator } from "./bot-types";
import { isAgentBusy } from "./agent";
import { log, logFull, error } from "./log";
import { getEffectiveConfig } from "./config/runtime-config";
import { type IdleConfig, setDebugMode, isDebugMode, isOnCooldown, recordBehaviorRun, loadIdleState, hasNewTranscriptsSince } from "./idle-state";
import { getAllIdleBehaviors, formatCooldown } from "./skill-loader";
import { StreamingSession } from "./streaming-session";
import { executeIdleBehaviorOnSession, executeIdleBehaviorStandalone, buildIdleStats } from "./idle-executor";
import { chooseBehaviorWithHaiku } from "./idle-selector";
import { gatherPreconditions } from "./idle-preconditions";
import { AGENT_DATA_DIR, PROJECT_DIR, localDate } from "./paths";
import { BOT_NAME } from "./config/identity";
import { getLocalToolNames } from "./local-config";
import type { IdleBehavior } from "./skill-loader";

// Re-export IdleConfig for index.ts
export type { IdleConfig } from "./idle-state";

// ============================================================================
// IdleManager Class
// ============================================================================

class IdleManager {
  private lastActivityTime: number = Date.now();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private client: Client | null = null;
  private config: BotConfig | null = null;
  private isRunningIdleBehavior: boolean = false;
  private toolsServer: McpSdkServerConfigWithInstance | null = null;

  /**
   * Start the idle check loop
   */
  async start(client: Client, config: BotConfig, idleConfig?: IdleConfig, toolsServer?: McpSdkServerConfigWithInstance): Promise<void> {
    this.client = client;
    this.config = config;
    this.toolsServer = toolsServer ?? null;
    this.lastActivityTime = Date.now();

    // Apply debug mode if provided (reduces cooldowns to 1/60th)
    if (idleConfig?.debugMode) {
      setDebugMode(true);
      log("IDLE", "Debug mode: cooldowns reduced to 1/60th (hours -> minutes)");
    }

    // Read initial config values
    const { config: runtimeConfig } = await getEffectiveConfig();
    let checkIntervalMs = runtimeConfig.idle.checkIntervalMinutes * 60000;

    // Apply debug reduction if enabled
    if (isDebugMode()) {
      checkIntervalMs = Math.max(checkIntervalMs / 60, 1000); // At least 1 second
    }

    log("IDLE", "Starting idle behavior system");
    log("IDLE", `Check interval: ${checkIntervalMs / 1000 / 60} minutes (from config)`);
    log("IDLE", `Idle threshold: ${runtimeConfig.idle.thresholdMinutes} minutes (from config)`);

    // Load and log all idle behaviors at startup
    const allBehaviors = await getAllIdleBehaviors();
    log("IDLE", `Registered ${allBehaviors.length} idle behaviors:`);
    for (const behavior of allBehaviors) {
      const cooldown = behavior.cooldownMs
        ? formatCooldown(behavior.cooldownMs)
        : "none";
      const source = behavior.skillPath ? "skill" : "built-in";
      log("IDLE", `  - ${behavior.name} (${source}, cooldown: ${cooldown})`);
    }

    this.checkInterval = setInterval(() => {
      this.checkAndTriggerIdleBehavior();
    }, checkIntervalMs);
  }

  /**
   * Stop the idle check loop
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      log("IDLE", "Stopped idle behavior system");
    }
  }

  /**
   * Reset the activity timer (call when a message is processed)
   */
  resetTimer(): void {
    this.lastActivityTime = Date.now();
    log("IDLE", "Activity timer reset");
  }

  /**
   * Check if idle and trigger a behavior if appropriate
   */
  private async checkAndTriggerIdleBehavior(): Promise<void> {
    // Re-read config each cycle to pick up changes
    const { config: runtimeConfig } = await getEffectiveConfig();
    let idleThresholdMs = runtimeConfig.idle.thresholdMinutes * 60000;

    // Apply debug reduction if enabled
    if (isDebugMode()) {
      idleThresholdMs = Math.max(idleThresholdMs / 60, 1000); // At least 1 second
    }

    const idleTime = Date.now() - this.lastActivityTime;
    const idleMinutes = Math.floor(idleTime / 1000 / 60);

    log("IDLE", `Checking... idle for ${idleMinutes} minutes (threshold: ${idleThresholdMs / 1000 / 60} min)`);

    // Not idle enough yet
    if (idleTime < idleThresholdMs) {
      log("IDLE", "Not idle long enough, skipping");
      return;
    }

    // Main agent is busy processing a turn
    if (isAgentBusy()) {
      log("IDLE", "Main agent is busy, skipping idle behavior");
      return;
    }

    // Already running an idle behavior
    if (this.isRunningIdleBehavior) {
      log("IDLE", "Already running idle behavior, skipping");
      return;
    }

    // Set flag immediately to prevent overlapping cycles (before any await)
    this.isRunningIdleBehavior = true;

    try {
      await this.runIdleCycle(idleMinutes);
    } finally {
      this.isRunningIdleBehavior = false;
    }
  }

  /**
   * Core idle cycle logic — separated so the busy flag can wrap it cleanly.
   */
  private async runIdleCycle(idleMinutes: number): Promise<void> {
    // Load all behaviors (built-in + skills) - reloads each time to pick up new skills
    const allBehaviors = await getAllIdleBehaviors();

    // Filter out behaviors that are on cooldown
    const eligibleBehaviors = [];
    for (const behavior of allBehaviors) {
      if (!(await isOnCooldown(behavior))) {
        eligibleBehaviors.push(behavior);
      }
    }

    if (eligibleBehaviors.length === 0) {
      log("IDLE", "All behaviors are on cooldown, skipping");
      return;
    }

    // Filter out behaviors that have no new data to process
    const state = await loadIdleState();
    const freshBehaviors: typeof eligibleBehaviors = [];
    for (const behavior of eligibleBehaviors) {
      if (behavior.name === "conversation-logging") {
        const lastRun = state.lastRuns[behavior.name] ?? 0;
        if (!(await hasNewTranscriptsSince(lastRun))) {
          log("IDLE", "conversation-logging skipped: no new transcripts since last run");
          continue;
        }
      }
      freshBehaviors.push(behavior);
    }

    if (freshBehaviors.length === 0) {
      log("IDLE", "All behaviors filtered (cooldown or no new data), skipping");
      return;
    }

    log("IDLE", `${freshBehaviors.length} eligible behaviors (of ${allBehaviors.length} total)`);

    // Skip selector when only 1 behavior is eligible — not worth a Haiku call
    let behaviors: typeof freshBehaviors;
    if (freshBehaviors.length === 1) {
      log("IDLE", "Single eligible behavior, skipping selector");
      behaviors = freshBehaviors;
    } else {
      // Gather preconditions for informed selection
      let preconditions;
      try {
        preconditions = await gatherPreconditions();
        log("IDLE", `Preconditions gathered:\n${preconditions.globalSummary}`);
      } catch (err) {
        error("IDLE", "Failed to gather preconditions", err);
      }

      behaviors = await chooseBehaviorWithHaiku(freshBehaviors, idleMinutes, preconditions);
    }

    if (behaviors.length === 0) {
      log("IDLE", "No behaviors selected this cycle");
      return;
    }

    log("IDLE", `Selected ${behaviors.length} behavior(s): ${behaviors.map(b => b.name).join(", ")}`);

    // Create a local streaming session for the idle batch
    const session = new StreamingSession("idle");
    let sessionStarted = false;

    try {
      // Build system prompt for shared session
      let persona = `You are ${BOT_NAME}, a snarky but helpful AI.`;
      try {
        const personaContent = await fs.readFile(
          path.join(AGENT_DATA_DIR, "persona.md"),
          "utf-8"
        );
        persona = personaContent;
      } catch {
        // Use default
      }

      let idleStats = "";
      try {
        idleStats = await buildIdleStats();
      } catch {
        // Non-critical
      }

      const cwd = PROJECT_DIR;
      const timestamp = `${new Date().toLocaleString()} (${localDate()}, ${Intl.DateTimeFormat().resolvedOptions().timeZone})`;

      const systemPrompt = `## YOUR IDENTITY
${persona}

## WORKING DIRECTORY
${cwd} — all file paths must be absolute, rooted here.

## CUSTOM TOOLS
See agent-data/tools.md for available custom tools.

## CURRENT TIME
${timestamp}

${idleStats}

## CONTEXT
You've been idle for ${idleMinutes} minutes. You are running a batch of self-directed tasks.
Each task will be given to you as a user message. Context accumulates — you can
reference what you learned or read in earlier tasks. When you finish a task,
briefly summarize what you did.`;

      const allowedTools = [
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "Bash",
        "WebSearch",
        "WebFetch",
        ...(this.toolsServer ? ["mcp__custom-tools__send_to_channel", "mcp__custom-tools__get_channel_history", "mcp__custom-tools__search_transcripts"] : []),
        ...getLocalToolNames("creator"),
      ];

      session.start({
        cwd,
        model: "claude-sonnet-4-6",
        systemPrompt,
        allowedTools,
        maxBudgetUsd: 5.0,
        mcpServers: this.toolsServer ? { "custom-tools": this.toolsServer } : undefined,
        env: {
          ...process.env,
          KLIPY_API_KEY: process.env.KLIPY_API_KEY,
        },
      });
      sessionStarted = true;
      log("IDLE", "Started shared idle session");

      for (const behavior of behaviors) {
        // Yield to real conversations if main agent became busy
        if (isAgentBusy()) {
          log("IDLE", "Main agent became busy, stopping idle batch");
          break;
        }

        // Check if session is still alive (may have died from previous skill error)
        if (!session.isAlive()) {
          log("IDLE", "Session died, falling back to standalone for remaining skills");
          // Fall back to standalone for this and remaining behaviors
          const ok = await this.runStandalone(behavior, idleMinutes);
          if (ok) await recordBehaviorRun(behavior.name);
          continue;
        }

        const source = behavior.skillPath ? `skill:${behavior.name}` : `builtin:${behavior.name}`;
        log("IDLE", `Running on shared session: ${source}`);

        try {
          const { responseText, inputTokens } = await executeIdleBehaviorOnSession(behavior, session);
          await recordBehaviorRun(behavior.name);

          if (responseText) {
            logFull("IDLE", `${behavior.name} completed: `, responseText);
          } else {
            log("IDLE", `${behavior.name} completed (no output)`);
          }

          // Send per-skill audit DM
          if (this.client && this.config) {
            const auditMsg = responseText
              ? `[IDLE] **${behavior.name}** completed:\n${responseText.substring(0, 1800)}`
              : `[IDLE] **${behavior.name}** completed (no output)`;
            await dmCreator(this.client, this.config.creatorId, auditMsg).catch(err => {
              error("IDLE", "Failed to send idle audit DM", err);
            });
          }

          // Token watchdog: stop batch early if context is getting too large
          if (inputTokens > 150_000) {
            log("IDLE", `Context size exceeds 150k (${inputTokens} tokens), stopping batch early`);
            break;
          }
        } catch (err) {
          error("IDLE", `Error during idle behavior '${behavior.name}'`, err);
          // If session died, remaining skills will fall back to standalone via the isAlive check
        }
      }
    } finally {
      if (sessionStarted) {
        session.close();
        log("IDLE", "Closed idle session");
      }
    }
  }

  /**
   * Fallback: run a single behavior in standalone mode (no shared session).
   */
  private async runStandalone(behavior: IdleBehavior, idleMinutes: number): Promise<boolean> {
    const source = behavior.skillPath ? `skill:${behavior.name}` : `builtin:${behavior.name}`;
    log("IDLE", `Running standalone: ${source}`);

    try {
      const response = await executeIdleBehaviorStandalone(behavior, idleMinutes, this.toolsServer);

      if (response) {
        logFull("IDLE", `${behavior.name} completed: `, response);
      } else {
        log("IDLE", `${behavior.name} completed (no output)`);
      }

      if (this.client && this.config) {
        const auditMsg = response
          ? `[IDLE] **${behavior.name}** (standalone) completed:\n${response.substring(0, 1800)}`
          : `[IDLE] **${behavior.name}** (standalone) completed (no output)`;
        await dmCreator(this.client, this.config.creatorId, auditMsg).catch(err => {
          error("IDLE", "Failed to send idle audit DM", err);
        });
      }
      return true;
    } catch (err) {
      error("IDLE", `Error during standalone behavior '${behavior.name}'`, err);
      return false;
    }
  }
}

// ============================================================================
// Singleton Instance and Exports
// ============================================================================

const idleManager = new IdleManager();

/**
 * Start the idle behavior loop
 */
export async function startIdleLoop(client: Client, config: BotConfig, idleConfig?: IdleConfig, toolsServer?: McpSdkServerConfigWithInstance): Promise<void> {
  await idleManager.start(client, config, idleConfig, toolsServer);
}

/**
 * Stop the idle behavior loop
 */
export function stopIdleLoop(): void {
  idleManager.stop();
}

/**
 * Reset the idle timer (call when processing a message)
 */
export function resetIdleTimer(): void {
  idleManager.resetTimer();
}

