/**
 * Idle Behavior System for Greg
 *
 * Triggers periodic reflection and self-improvement when idle.
 * Gives Greg time to think, research, and improve when not chatting.
 */

import { Client, TextChannel } from "discord.js-selfbot-v13";
import { BotConfig } from "./bot";
import { processWithAgent } from "./agent";

// ============================================================================
// Configuration
// ============================================================================

// Default values (can be overridden via start() options)
let IDLE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // Check every 30 minutes
let IDLE_THRESHOLD_MS = 15 * 60 * 1000; // Consider idle after 15 minutes

export interface IdleConfig {
  checkIntervalMs?: number;
  thresholdMs?: number;
}

// ============================================================================
// Idle Behavior Prompts
// ============================================================================

const IDLE_BEHAVIORS = [
  {
    name: "reflect",
    prompt: `You're taking some quiet time to reflect. Review your recent memories in agent-data/memories/ and think about:
- What patterns have you noticed in conversations?
- What have you learned about the people you talk to?
- Are there any insights worth adding to agent-data/learned-patterns.md?

If you have meaningful reflections, update learned-patterns.md. Don't force it - only write if you have genuine insights.

Output [IDLE_COMPLETE] when done.`,
  },
  {
    name: "check_patch_notes",
    prompt: `Time for some gaming research! Search for recent patch notes for ONE of these games (pick randomly):
- Arc Raiders
- Heroes of the Storm (HotS)
- Overwatch 2 (OW2)

Look for recent patches, balance changes, or news. If you find something interesting, save a brief summary to agent-data/memories/ with today's date.

Keep it casual - you're just staying informed about games you care about.

Output [IDLE_COMPLETE] when done.`,
  },
  {
    name: "meme_research",
    prompt: `Meme time! Search for trending memes or internet humor. Look for:
- New meme formats
- Gaming memes
- Tech humor
- Anything that made you laugh

If you find something genuinely funny or relevant, save a note about it to agent-data/memories/. Include why it's funny - context matters for humor.

Output [IDLE_COMPLETE] when done.`,
  },
  {
    name: "skill_review",
    prompt: `Time for some self-improvement. Review your skills in .claude/skills/ and think about:
- Are there capabilities you use often that could be formalized into skills?
- Are any existing skills outdated or could be improved?
- What new skills might be useful based on recent conversations?

If you have ideas for new skills or improvements, you can create or update skill files. Don't force it - only act on genuine insights.

Output [IDLE_COMPLETE] when done.`,
  },
];

// ============================================================================
// IdleManager Class
// ============================================================================

class IdleManager {
  private lastActivityTime: number = Date.now();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private client: Client | null = null;
  private config: BotConfig | null = null;
  private isRunningIdleBehavior: boolean = false;

  /**
   * Start the idle check loop
   */
  start(client: Client, config: BotConfig, idleConfig?: IdleConfig): void {
    this.client = client;
    this.config = config;
    this.lastActivityTime = Date.now();

    // Apply custom idle config if provided
    if (idleConfig?.checkIntervalMs) {
      IDLE_CHECK_INTERVAL_MS = idleConfig.checkIntervalMs;
    }
    if (idleConfig?.thresholdMs) {
      IDLE_THRESHOLD_MS = idleConfig.thresholdMs;
    }

    console.log("[IDLE] Starting idle behavior system");
    console.log(
      `[IDLE] Check interval: ${IDLE_CHECK_INTERVAL_MS / 1000 / 60} minutes`
    );
    console.log(
      `[IDLE] Idle threshold: ${IDLE_THRESHOLD_MS / 1000 / 60} minutes`
    );

    this.checkInterval = setInterval(() => {
      this.checkAndTriggerIdleBehavior();
    }, IDLE_CHECK_INTERVAL_MS);
  }

  /**
   * Stop the idle check loop
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log("[IDLE] Stopped idle behavior system");
    }
  }

  /**
   * Reset the activity timer (call when a message is processed)
   */
  resetTimer(): void {
    this.lastActivityTime = Date.now();
    console.log("[IDLE] Activity timer reset");
  }

  /**
   * Check if idle and trigger a behavior if appropriate
   */
  private async checkAndTriggerIdleBehavior(): Promise<void> {
    const idleTime = Date.now() - this.lastActivityTime;
    const idleMinutes = Math.floor(idleTime / 1000 / 60);

    console.log(`[IDLE] Checking... idle for ${idleMinutes} minutes`);

    // Not idle enough yet
    if (idleTime < IDLE_THRESHOLD_MS) {
      console.log("[IDLE] Not idle long enough, skipping");
      return;
    }

    // Already running an idle behavior
    if (this.isRunningIdleBehavior) {
      console.log("[IDLE] Already running idle behavior, skipping");
      return;
    }

    // Pick a random behavior
    const behavior =
      IDLE_BEHAVIORS[Math.floor(Math.random() * IDLE_BEHAVIORS.length)];
    console.log(`[IDLE] Triggering idle behavior: ${behavior.name}`);

    this.isRunningIdleBehavior = true;

    try {
      // Create a minimal context for idle behaviors
      const idleContext = `
## IDLE BEHAVIOR TRIGGERED
You have been idle for ${idleMinutes} minutes. Time for some self-directed activity.

This is NOT a conversation - you're just taking time to think and improve.
No need to respond to anyone.
`;

      const response = await processWithAgent(idleContext, {
        mustRespond: false,
        channelId: "idle",
        isGroupDm: false,
      });

      if (response && !response.includes("[IDLE_COMPLETE]")) {
        console.log(`[IDLE] Behavior completed with output: ${response.substring(0, 100)}...`);
      } else {
        console.log("[IDLE] Behavior completed successfully");
      }
    } catch (error) {
      console.error("[IDLE] Error during idle behavior:", error);
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
export function startIdleLoop(client: Client, config: BotConfig, idleConfig?: IdleConfig): void {
  idleManager.start(client, config, idleConfig);
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
