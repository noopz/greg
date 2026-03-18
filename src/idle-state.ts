/**
 * Idle State Persistence
 *
 * Manages the idle-state.json file that tracks when each idle behavior was last run.
 * Used for cooldown enforcement and behavior selection.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { AGENT_DATA_DIR } from "./paths";
import { atomicWriteFile } from "./persistence";
import { log, warn } from "./log";

// ============================================================================
// Configuration
// ============================================================================

const IDLE_STATE_FILE = path.join(AGENT_DATA_DIR, "idle-state.json");

// Debug mode flag - when true, cooldowns are reduced to 1/60th (hours -> minutes)
let DEBUG_MODE = false;

export function setDebugMode(enabled: boolean): void {
  DEBUG_MODE = enabled;
}

export function isDebugMode(): boolean {
  return DEBUG_MODE;
}

// ============================================================================
// Types
// ============================================================================

export interface IdleState {
  lastRuns: Record<string, number>; // behavior name -> timestamp
  createdAt?: string;
}

export interface IdleConfig {
  checkIntervalMs?: number;
  thresholdMs?: number;
  debugMode?: boolean; // Reduces cooldowns to 1/60th (hours -> minutes)
}

// ============================================================================
// Persistence
// ============================================================================

/**
 * Load idle state from disk
 */
export async function loadIdleState(): Promise<IdleState> {
  try {
    const content = await fs.readFile(IDLE_STATE_FILE, "utf-8");
    return JSON.parse(content) as IdleState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { lastRuns: {} };
    }
    warn("IDLE", `Failed to parse idle state: ${err instanceof Error ? err.message : String(err)}`);
    return { lastRuns: {} };
  }
}

/**
 * Save idle state to disk
 */
export async function saveIdleState(state: IdleState): Promise<void> {
  await fs.mkdir(AGENT_DATA_DIR, { recursive: true });
  await atomicWriteFile(IDLE_STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Record that a behavior was run
 */
export async function recordBehaviorRun(behaviorName: string): Promise<void> {
  const state = await loadIdleState();
  state.lastRuns[behaviorName] = Date.now();
  await saveIdleState(state);
  log("IDLE", `Recorded run for behavior: ${behaviorName}`);
}

// ============================================================================
// Cooldown Checking
// ============================================================================

export interface CooldownCheckable {
  name: string;
  cooldownMs?: number;
}

/**
 * Check if a behavior is on cooldown.
 * In debug mode, cooldowns are reduced to 1/60th (hours -> minutes).
 */
export async function isOnCooldown(behavior: CooldownCheckable): Promise<boolean> {
  if (!behavior.cooldownMs) {
    return false; // No cooldown defined
  }

  const state = await loadIdleState();
  const lastRun = state.lastRuns[behavior.name];

  if (!lastRun) {
    return false; // Never run before
  }

  // In debug mode, reduce cooldowns to 1/60th (e.g., 60 min -> 1 min)
  const effectiveCooldown = DEBUG_MODE ? behavior.cooldownMs / 60 : behavior.cooldownMs;

  const elapsed = Date.now() - lastRun;
  const onCooldown = elapsed < effectiveCooldown;

  if (onCooldown) {
    const remainingMs = effectiveCooldown - elapsed;
    const remainingMins = Math.ceil(remainingMs / 1000 / 60);
    const remainingSecs = Math.ceil(remainingMs / 1000);
    const displayTime = DEBUG_MODE ? `${remainingSecs}s` : `${remainingMins} min`;
    log("IDLE", `${behavior.name} is on cooldown (${displayTime} remaining${DEBUG_MODE ? " [debug]" : ""})`);
  }

  return onCooldown;
}
