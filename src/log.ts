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

import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from "fs";
import { join } from "path";
import { LOGS_DIR } from "./paths";
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

/**
 * Get the current log file path (daily rotation)
 */
function getLogFilePath(): string {
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  return join(LOGS_DIR, `${LOG_BOT_NAME}-${date}.log`);
}

/**
 * Check if log file exceeds max size, rotate if needed
 */
function rotateIfNeeded(filePath: string): void {
  try {
    if (!existsSync(filePath)) return;

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
 * Log an info message with timestamp
 */
export function log(tag: string, message: string): void {
  const line = `[${formatTimestamp()}] [${tag}] ${message}`;
  console.log(redactCredentials(line));
  writeToFile(line);
}

/**
 * Log a warning message with timestamp
 */
export function warn(tag: string, message: string): void {
  const line = `[${formatTimestamp()}] [${tag}] ⚠️  ${message}`;
  console.warn(redactCredentials(line));
  writeToFile(line);
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
  console.log(redactCredentials(`[${timestamp}] [${tag}] ${prefix}${truncated}`));
}

/**
 * Log an error message with timestamp
 */
export function error(tag: string, message: string, err?: unknown): void {
  const line = `[${formatTimestamp()}] [${tag}] ❌ ${message}`;
  if (err) {
    const errStr = err instanceof Error ? err.stack || err.message : String(err);
    console.error(redactCredentials(line), redactCredentials(errStr));
    writeToFile(`${line} ${errStr}`);
  } else {
    console.error(redactCredentials(line));
    writeToFile(line);
  }
}
