/**
 * Timestamped Logging Utility
 *
 * Logs to both console and optionally a daily log file for debugging.
 * Log files: logs/{botname}-YYYY-MM-DD.log
 *
 * Environment variables:
 * - LOG_TO_FILE: "true" or "false" (default: true)
 * - LOG_MAX_SIZE_MB: max file size before rotation (default: 50)
 */

import { appendFileSync, mkdirSync, existsSync, renameSync, statSync } from "fs";
import { join } from "path";
import pc from "picocolors";
import { localDate, LOGS_DIR } from "./paths";
import { redactCredentials } from "./security";
const LOG_BOT_NAME = (process.env.BOT_NAME || "Greg").toLowerCase();
const LOG_TO_FILE = process.env.LOG_TO_FILE !== "false";
const MAX_LOG_SIZE_BYTES = (parseInt(process.env.LOG_MAX_SIZE_MB || "50", 10)) * 1024 * 1024;
const ROTATION_CHECK_INTERVAL_MS = 60_000;
let lastRotationCheck = 0;

// Ensure logs directory exists (only if file logging enabled)
if (LOG_TO_FILE && !existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true });
}

const TAG_COLORS: Record<string, (s: string) => string> = {
  // Core pipeline
  MSG: pc.blue,    PIPELINE: pc.blue,  SEND: pc.blue,
  STREAM: pc.cyan, QUEUE: pc.cyan,
  // Routing
  BUFFER: pc.yellow, CLASSIFY: pc.yellow, ROUTE: pc.yellow, GATE: pc.yellow,
  // Agent/SDK
  SDK: pc.green,   MCP: pc.green,  CONTEXT: pc.green,
  CONVO: pc.green, ENERGY: pc.green,
  // Idle
  IDLE: pc.magenta, FOLLOWUP: pc.magenta,
  // Safety
  SECURITY: pc.red, REVIEWER: pc.red,
  // Infrastructure
  CONFIG: pc.gray,  READY: pc.green, SHUTDOWN: pc.red,
  KILL: pc.red,     TYPING: pc.gray, STARTUP: pc.red,
  // Data
  FTS: pc.gray, Impressions: pc.gray, Config: pc.gray,
  AUDIT: pc.gray, TRIGGERS: pc.gray,
  // Errors
  DISCORD: pc.red, PROCESS: pc.red,
};

/**
 * Get the current log file path (daily rotation)
 */
function getLogFilePath(): string {
  return join(LOGS_DIR, `${LOG_BOT_NAME}-${localDate()}.log`);
}

/**
 * Check if log file exceeds max size, rotate if needed
 */
function rotateIfNeeded(filePath: string): void {
  try {
    const stats = statSync(filePath);
    if (stats.size >= MAX_LOG_SIZE_BYTES) {
      // Rotate: rename current to .1, .2, etc.
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const rotatedPath = filePath.replace(".log", `-${timestamp}.log`);
      renameSync(filePath, rotatedPath);
    }
  } catch {
    // Ignore rotation errors
  }
}

/**
 * Write a line to the log file (credentials are redacted)
 */
function writeToFile(line: string): void {
  if (!LOG_TO_FILE) return;

  try {
    const filePath = getLogFilePath();
    const now = Date.now();
    if (now - lastRotationCheck >= ROTATION_CHECK_INTERVAL_MS) {
      rotateIfNeeded(filePath);
      lastRotationCheck = now;
    }
    appendFileSync(filePath, redactCredentials(line) + "\n");
  } catch {
    // Silently fail file writes - don't crash on logging issues
  }
}

/**
 * Format a timestamp for log output.
 * Uses HH:MM:SS.mmm format for readability.
 */
function formatTimestamp(): string {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, "0");
  const minutes = now.getMinutes().toString().padStart(2, "0");
  const seconds = now.getSeconds().toString().padStart(2, "0");
  const millis = now.getMilliseconds().toString().padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

/**
 * Get the color function for a tag, defaulting to white
 */
function colorForTag(tag: string): (s: string) => string {
  return TAG_COLORS[tag] || pc.white;
}

/**
 * Log an info message with timestamp
 */
export function log(tag: string, message: string): void {
  const timestamp = formatTimestamp();
  const plain = `[${timestamp}] [${tag}] ${message}`;
  writeToFile(plain);
  console.log(`${pc.dim(`[${timestamp}]`)} ${colorForTag(tag)(`[${tag}]`)} ${redactCredentials(message)}`);
}

/**
 * Log a warning message with timestamp
 */
export function warn(tag: string, message: string, err?: unknown): void {
  const timestamp = formatTimestamp();
  const plain = `[${timestamp}] [${tag}] ${message}`;
  if (err) {
    const errStr = err instanceof Error ? err.stack || err.message : String(err);
    console.warn(`${pc.dim(`[${timestamp}]`)} ${pc.yellow(`[${tag}]`)} ${pc.yellow(redactCredentials(message))}`, redactCredentials(errStr));
    writeToFile(`${plain} ${errStr}`);
  } else {
    console.warn(`${pc.dim(`[${timestamp}]`)} ${pc.yellow(`[${tag}]`)} ${pc.yellow(redactCredentials(message))}`);
    writeToFile(plain);
  }
}

/**
 * Log a message, truncating only in console output. File log gets the full message.
 */
export function logFull(tag: string, prefix: string, fullMessage: string, consoleMaxChars: number = 300): void {
  const timestamp = formatTimestamp();
  const fileLine = `[${timestamp}] [${tag}] ${prefix}${fullMessage}`;
  writeToFile(fileLine);

  const truncated = fullMessage.length > consoleMaxChars
    ? fullMessage.substring(0, consoleMaxChars) + `... (${fullMessage.length} chars total, see log file for full output)`
    : fullMessage;
  console.log(`${pc.dim(`[${timestamp}]`)} ${colorForTag(tag)(`[${tag}]`)} ${redactCredentials(`${prefix}${truncated}`)}`);
}

/**
 * Log an error message with timestamp
 */
export function error(tag: string, message: string, err?: unknown): void {
  const timestamp = formatTimestamp();
  const plain = `[${timestamp}] [${tag}] ${message}`;
  if (err) {
    const errStr = err instanceof Error ? err.stack || err.message : String(err);
    console.error(`${pc.dim(`[${timestamp}]`)} ${pc.red(`[${tag}]`)} ${pc.red(redactCredentials(message))}`, redactCredentials(errStr));
    writeToFile(`${plain} ${errStr}`);
  } else {
    console.error(`${pc.dim(`[${timestamp}]`)} ${pc.red(`[${tag}]`)} ${pc.red(redactCredentials(message))}`);
    writeToFile(plain);
  }
}
