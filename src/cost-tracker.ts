/**
 * Rolling Cost Tracker
 *
 * Tracks per-turn costs in memory and appends to a daily JSONL file.
 * Logs rolling totals (hourly / daily / since boot) for easy eyeballing.
 */

import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR, localDate } from "./paths";
import { log, warn } from "./log";

// In-memory rolling totals (reset on process restart)
let bootCost = 0;
let bootInputTokens = 0;
let bootOutputTokens = 0;
let bootTurns = 0;
const bootTime = Date.now();

// Hourly bucket for rate tracking
let hourBucketStart = Date.now();
let hourCost = 0;
let hourTurns = 0;

// Daily bucket
let dayKey = localDate();
let dayCost = 0;
let dayTurns = 0;

interface CostEntry {
  ts: string;
  source: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  contextTokens?: number;
  cacheHitRate?: number;
}

const COST_LOG_DIR = path.join(LOGS_DIR, "costs");

function ensureDir(): void {
  if (!fs.existsSync(COST_LOG_DIR)) {
    fs.mkdirSync(COST_LOG_DIR, { recursive: true });
  }
}

/**
 * Record a cost event from any source (main turn, idle, followup, memory flush).
 * Appends to daily JSONL and updates rolling totals.
 */
export function recordCost(
  source: string,
  cost: number,
  inputTokens: number,
  outputTokens: number,
  contextTokens?: number,
  cacheHitRate?: number,
): void {
  const now = Date.now();
  const today = localDate();

  // Reset daily bucket on day rollover
  if (today !== dayKey) {
    dayKey = today;
    dayCost = 0;
    dayTurns = 0;
  }

  // Reset hourly bucket
  if (now - hourBucketStart >= 3_600_000) {
    hourBucketStart = now;
    hourCost = 0;
    hourTurns = 0;
  }

  // Update in-memory totals
  bootCost += cost;
  bootInputTokens += inputTokens;
  bootOutputTokens += outputTokens;
  bootTurns++;

  hourCost += cost;
  hourTurns++;

  dayCost += cost;
  dayTurns++;

  // Append to daily JSONL
  const entry: CostEntry = {
    ts: new Date().toISOString(),
    source,
    cost,
    inputTokens,
    outputTokens,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
  };

  try {
    ensureDir();
    fs.appendFileSync(
      path.join(COST_LOG_DIR, `${today}.jsonl`),
      JSON.stringify(entry) + "\n",
    );
  } catch (err) {
    warn("COST", `Failed to write cost log: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Log rolling summary
  const uptimeHrs = ((now - bootTime) / 3_600_000).toFixed(1);
  log(
    "COST",
    `${source}: $${cost.toFixed(4)} | ` +
    `Hour: $${hourCost.toFixed(4)} (${hourTurns} turns) | ` +
    `Day: $${dayCost.toFixed(4)} (${dayTurns} turns) | ` +
    `Boot: $${bootCost.toFixed(4)} (${bootTurns} turns, ${uptimeHrs}h)`,
  );
}

