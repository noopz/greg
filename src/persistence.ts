/**
 * Persistence utilities for Greg
 *
 * Implements atomic file writes and append-only JSONL transcripts
 * following Pattern 1: Session Persistence from long-running agents guide.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SessionId } from "./agent-types";

// ============================================================================
// Types
// ============================================================================

export type TranscriptEntry = {
  type: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
};

// ============================================================================
// Atomic File Operations
// ============================================================================

/**
 * Atomic write using tmp file + rename pattern.
 * Prevents corruption from crashes or concurrent writes.
 *
 * Uses process.pid in temp filename for uniqueness across processes.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string
): Promise<void> {
  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    // Ignore EEXIST errors
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  // Write to temp file first
  const tmpPath = `${filePath}.${process.pid}.tmp`;

  try {
    await fs.writeFile(tmpPath, content, "utf-8");
    // Atomic rename (on POSIX systems, rename is atomic within same filesystem)
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Atomic write for JSON data with pretty printing.
 */
async function atomicWriteJSON(
  filePath: string,
  data: unknown
): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await atomicWriteFile(filePath, content);
}

// ============================================================================
// Transcript Operations (Append-Only JSONL)
// ============================================================================

/**
 * Append to JSONL transcript (never modify existing lines).
 *
 * Each entry is written as a single JSON line followed by newline.
 * This is crash-safe: partial writes result in incomplete lines
 * that can be detected and skipped on load.
 */
export async function appendToTranscript(
  sessionFile: string,
  entry: TranscriptEntry
): Promise<void> {
  // Ensure parent directory exists
  const dir = path.dirname(sessionFile);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  // Serialize entry as single JSON line
  const line = JSON.stringify(entry) + "\n";

  // Append to file (creates if doesn't exist)
  await fs.appendFile(sessionFile, line, "utf-8");

  // Live-index into FTS (lazy import to avoid circular deps)
  try {
    const { indexTranscriptEntry } = await import("./transcript-index");
    indexTranscriptEntry(entry);
  } catch {
    // Index not initialized yet or import failed — not fatal
  }
}

/**
 * Append a single JSON line to any JSONL file.
 * Creates the file if it doesn't exist.
 */
export async function appendJsonl(filePath: string, entry: Record<string, unknown>): Promise<void> {
  await fs.appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Get the transcript file path for a session.
 */
export function getTranscriptPath(
  transcriptsDir: string,
  sessionId: SessionId
): string {
  return path.join(transcriptsDir, `${sessionId}.jsonl`);
}

// ============================================================================
// Session File Operations
// ============================================================================

export type SessionData = {
  sessionId: SessionId;
  updatedAt: number;
  totalTokens?: number;
  transcriptFile?: string;
  /** Token count when last memory flush was performed - used to determine when to trigger next flush */
  lastMemoryFlushTokenCount?: number;
  /** @deprecated Use lastMemoryFlushTokenCount instead */
  memoryFlushCompactionCount?: number;
  /** Number of times context has been compacted for this session lineage */
  compactionCount?: number;
  /** Session ID that this session was compacted from (for lineage tracking) */
  compactedFromSessionId?: SessionId;
};

/**
 * Load session data from JSON file.
 * Returns null if file doesn't exist.
 */
export async function loadSessionData(
  sessionFile: string
): Promise<SessionData | null> {
  try {
    const content = await fs.readFile(sessionFile, "utf-8");
    return JSON.parse(content) as SessionData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Save session data atomically.
 * Ensures parent directory exists before writing.
 */
export async function saveSessionData(
  sessionFile: string,
  data: SessionData
): Promise<void> {
  const dir = path.dirname(sessionFile);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteJSON(sessionFile, data);
}

// ============================================================================
// Claude SDK JSONL Session Token Counting
// ============================================================================

