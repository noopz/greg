/**
 * Persistence utilities for Greg
 *
 * Implements atomic file writes and append-only JSONL transcripts
 * following Pattern 1: Session Persistence from long-running agents guide.
 */

import fs from "node:fs/promises";
import path from "node:path";

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
export async function atomicWriteJSON(
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
}

/**
 * Load transcript from JSONL file.
 *
 * Handles:
 * - Empty files
 * - Partial/corrupted lines (skipped with warning)
 * - Missing files (returns empty array)
 */
export async function loadTranscript(
  sessionFile: string
): Promise<TranscriptEntry[]> {
  try {
    const content = await fs.readFile(sessionFile, "utf-8");

    if (!content.trim()) {
      return [];
    }

    const lines = content.trim().split("\n");
    const entries: TranscriptEntry[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const entry = JSON.parse(line) as TranscriptEntry;

        // Validate entry has required fields
        if (
          entry.type &&
          typeof entry.content === "string" &&
          typeof entry.timestamp === "number"
        ) {
          entries.push(entry);
        } else {
          console.warn(
            `[Persistence] Skipping malformed transcript entry at line ${i + 1}: missing required fields`
          );
        }
      } catch (parseError) {
        // Log corrupted line but continue loading
        console.warn(
          `[Persistence] Skipping corrupted transcript line ${i + 1}: ${parseError instanceof Error ? parseError.message : String(parseError)}`
        );
      }
    }

    return entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // File doesn't exist yet - return empty array
      return [];
    }
    throw error;
  }
}

/**
 * Get the transcript file path for a session.
 */
export function getTranscriptPath(
  transcriptsDir: string,
  sessionId: string
): string {
  return path.join(transcriptsDir, `${sessionId}.jsonl`);
}

// ============================================================================
// Session File Operations
// ============================================================================

export type SessionData = {
  sessionId: string;
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
  compactedFromSessionId?: string;
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

/**
 * Token usage extracted from a Claude SDK JSONL session file.
 */
export type SessionTokenUsage = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  messageCount: number;
};

/**
 * Get the path to the Claude SDK's JSONL session file for a given session ID.
 * The SDK stores sessions in ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
 */
export function getClaudeSessionPath(
  projectDir: string,
  sessionId: string
): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  // Claude SDK encodes project paths by replacing / with -
  const encodedPath = projectDir.replace(/\//g, "-");
  return path.join(homeDir, ".claude", "projects", encodedPath, `${sessionId}.jsonl`);
}

/**
 * Count total tokens from a Claude SDK JSONL session file.
 *
 * The SDK stores each message as a JSONL line with a usage field containing:
 * - input_tokens: tokens used for input
 * - output_tokens: tokens used for output
 * - cache_creation_input_tokens: tokens for cache creation
 * - cache_read_input_tokens: tokens read from cache
 *
 * IMPORTANT: The SDK writes multiple JSONL entries per streaming response,
 * all sharing the same message.id but with duplicate token counts.
 * We must group by message.id and only count the LAST entry per unique
 * API message to avoid massive over-counting (e.g., 27M instead of 7M).
 */
export async function countTokensFromClaudeSession(
  sessionFile: string
): Promise<SessionTokenUsage | null> {
  try {
    const content = await fs.readFile(sessionFile, "utf-8");

    if (!content.trim()) {
      return { totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0, messageCount: 0 };
    }

    const lines = content.trim().split("\n");

    // Group by message.id to deduplicate streaming chunks
    // Each streaming chunk has the same message.id but identical token counts
    // We keep the last one per message.id
    const usageByMessageId = new Map<string, { input: number; output: number }>();

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);

        // Only count assistant messages with usage data and a message ID
        if (entry.type === "assistant" && entry.message?.usage && entry.message?.id) {
          const usage = entry.message.usage;
          const messageId = entry.message.id;

          // Sum all input token types
          const inputTokens = (usage.input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0);

          const outputTokens = usage.output_tokens ?? 0;

          // Store/overwrite - last entry per message.id wins
          usageByMessageId.set(messageId, { input: inputTokens, output: outputTokens });
        }
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    // Sum the deduplicated usage
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const usage of usageByMessageId.values()) {
      totalInputTokens += usage.input;
      totalOutputTokens += usage.output;
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      messageCount: usageByMessageId.size,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null; // File doesn't exist
    }
    console.error(`[Persistence] Error reading Claude session file:`, error);
    return null;
  }
}

/**
 * Verify and reconcile token counts between our tracking and the Claude SDK's JSONL.
 * Returns the token count from the JSONL file if available, otherwise returns tracked count.
 * Logs a warning if there's a significant discrepancy.
 */
export async function verifyTokenCount(
  projectDir: string,
  sessionId: string,
  trackedTokens: number
): Promise<number> {
  const sessionFile = getClaudeSessionPath(projectDir, sessionId);
  const jsonlUsage = await countTokensFromClaudeSession(sessionFile);

  if (!jsonlUsage) {
    console.log(`[Persistence] Could not read JSONL session file, using tracked count: ${trackedTokens}`);
    return trackedTokens;
  }

  // The JSONL file contains cumulative input tokens per turn (context grows each turn)
  // So we use our tracked count but can verify against the latest input_tokens in JSONL
  const discrepancy = Math.abs(jsonlUsage.totalTokens - trackedTokens);
  const discrepancyPercent = trackedTokens > 0 ? (discrepancy / trackedTokens) * 100 : 0;

  if (discrepancyPercent > 20 && discrepancy > 5000) {
    console.warn(
      `[Persistence] Token count discrepancy: tracked=${trackedTokens}, JSONL=${jsonlUsage.totalTokens} ` +
      `(${discrepancyPercent.toFixed(1)}% difference)`
    );
  }

  // Return the JSONL count as it's the source of truth
  return jsonlUsage.totalTokens;
}
