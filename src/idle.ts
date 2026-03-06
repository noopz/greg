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

import { Client } from "discord.js-selfbot-v13";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { BotConfig, dmCreator } from "./bot-types";
import { isAgentBusy } from "./agent";
import { log, logFull, error } from "./log";
import { getEffectiveConfig } from "./config/runtime-config";
import { type IdleConfig, setDebugMode, isDebugMode, isOnCooldown, recordBehaviorRun } from "./idle-state";
import { getAllIdleBehaviors, formatCooldown } from "./skill-loader";
import { executeIdleBehavior } from "./idle-executor";
import { chooseBehaviorWithHaiku, fallbackBehaviorChoice } from "./idle-selector";
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

    log("IDLE", `${eligibleBehaviors.length} eligible behaviors (of ${allBehaviors.length} total)`);

    const behaviors = await chooseBehaviorWithHaiku(eligibleBehaviors, idleMinutes);

    if (behaviors.length === 0) {
      log("IDLE", "No behaviors selected this cycle");
      return;
    }

    log("IDLE", `Selected ${behaviors.length} behavior(s): ${behaviors.map(b => b.name).join(", ")}`);

    this.isRunningIdleBehavior = true;

    try {
      for (const behavior of behaviors) {
        // Yield to real conversations if main agent became busy
        if (isAgentBusy()) {
          log("IDLE", "Main agent became busy, stopping idle batch");
          break;
        }

        const source = behavior.skillPath ? `skill:${behavior.name}` : `builtin:${behavior.name}`;
        log("IDLE", `Running: ${source}`);

        try {
          const response = await executeIdleBehavior(behavior, idleMinutes, this.toolsServer);
          await recordBehaviorRun(behavior.name);

          if (response) {
            logFull("IDLE", `${behavior.name} completed: `, response);
          } else {
            log("IDLE", `${behavior.name} completed (no output)`);
          }

          if (this.client && this.config) {
            const auditMsg = response
              ? `[IDLE] **${behavior.name}** completed:\n${response.substring(0, 1800)}`
              : `[IDLE] **${behavior.name}** completed (no output)`;
            await dmCreator(this.client, this.config.creatorId, auditMsg).catch(err => {
              error("IDLE", "Failed to send idle audit DM", err);
            });
          }
        } catch (err) {
          error("IDLE", `Error during idle behavior '${behavior.name}'`, err);
          // Continue with remaining behaviors
        }
      }
    } finally {
      this.isRunningIdleBehavior = false;
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
