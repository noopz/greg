/**
 * Impressions Module
 *
 * Storage and loading logic for user impressions.
 * Impressions are observations about users that help personalize interactions.
 *
 * Uses append-only JSONL files per user for durability and simplicity.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { IMPRESSIONS_DIR } from "./paths";
import { log, warn, error } from "./log";

// ============================================================================
// Types
// ============================================================================

export interface Impression {
  /** Who this impression is about (user ID) */
  who: string;
  /** What was observed/noted */
  what: string;
  /** When this impression was recorded (ISO timestamp) */
  when: string;
  /** Weight/importance of this impression (higher = more important) */
  weight: number;
  /** Optional context type (e.g., "discord", "conversation", "explicit") */
  context_type?: string;
  /** SHA256 hash of who+what for deduplication */
  hash?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum impressions to load per user */
const MAX_IMPRESSIONS_PER_USER = 10;

/** Tag for logging */
const LOG_TAG = "Impressions";

// ============================================================================
// Mtime Cache
// ============================================================================

interface CachedImpressions {
  mtime: number;
  impressions: Impression[];
}

/** Cache of parsed impressions per user, keyed by file path */
const impressionsCache = new Map<string, CachedImpressions>();

// ============================================================================
// File Path Helpers
// ============================================================================

/**
 * Get the file path for a user's impressions file.
 */
function getImpressionsFilePath(userId: string): string {
  // Sanitize userId to prevent path traversal
  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(IMPRESSIONS_DIR, `${safeUserId}.jsonl`);
}

// ============================================================================
// Loading Impressions
// ============================================================================

/**
 * Load impressions from a single user's JSONL file.
 * Uses mtime caching to avoid re-reading unchanged files.
 * Returns empty array if file doesn't exist or is empty.
 */
async function loadUserImpressions(userId: string): Promise<Impression[]> {
  const filePath = getImpressionsFilePath(userId);

  try {
    // Check mtime for cache validity
    const stat = await fs.stat(filePath);
    const currentMtime = stat.mtimeMs;

    const cached = impressionsCache.get(filePath);
    if (cached && cached.mtime === currentMtime) {
      return cached.impressions;
    }

    const content = await fs.readFile(filePath, "utf-8");

    if (!content.trim()) {
      impressionsCache.set(filePath, { mtime: currentMtime, impressions: [] });
      return [];
    }

    const lines = content.trim().split("\n");
    const impressions: Impression[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const impression = JSON.parse(line) as Impression;

        // Validate required fields
        if (
          typeof impression.who === "string" &&
          typeof impression.what === "string" &&
          typeof impression.when === "string" &&
          typeof impression.weight === "number"
        ) {
          impressions.push(impression);
        } else {
          warn(LOG_TAG, `Skipping malformed impression at line ${i + 1} in ${userId}.jsonl`);
        }
      } catch (parseErr) {
        warn(LOG_TAG, `Skipping corrupted line ${i + 1} in ${userId}.jsonl: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
      }
    }

    // Cache parsed impressions
    impressionsCache.set(filePath, { mtime: currentMtime, impressions });
    return impressions;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File doesn't exist - return empty array
      return [];
    }
    error(LOG_TAG, `Failed to load impressions for user ${userId}`, err);
    throw err;
  }
}

/**
 * Load and format impressions for given users.
 *
 * - Reads each user's .jsonl file
 * - Parses JSON lines, sorts by weight (desc) then recency (desc)
 * - Caps at 10 impressions per user
 * - Formats as markdown
 * - Returns combined string or "No impressions yet." if empty
 * - Target ~200 tokens per user max
 */
export async function loadImpressions(userIds: string[]): Promise<string | null> {
  if (!userIds || userIds.length === 0) {
    return null;
  }

  const sections: string[] = [];

  for (const userId of userIds) {
    try {
      const impressions = await loadUserImpressions(userId);

      if (impressions.length === 0) {
        continue;
      }

      // Sort by weight (desc) then by recency (desc)
      // Copy before sorting to avoid mutating the cached array
      const sorted = [...impressions].sort((a, b) => {
        if (b.weight !== a.weight) {
          return b.weight - a.weight;
        }
        // Sort by when (ISO string comparison works for recency)
        return b.when.localeCompare(a.when);
      });

      // Cap at MAX_IMPRESSIONS_PER_USER
      const capped = sorted.slice(0, MAX_IMPRESSIONS_PER_USER);

      // Format as markdown bullet points
      const bullets = capped.map((imp) => {
        // Truncate long impressions to stay within token budget
        const truncatedWhat = imp.what.length > 150
          ? imp.what.substring(0, 147) + "..."
          : imp.what;
        return `- ${truncatedWhat} (weight: ${imp.weight})`;
      });

      sections.push(`### ${userId}\n${bullets.join("\n")}`);
    } catch (err) {
      warn(LOG_TAG, `Failed to load impressions for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
      // Continue with other users
    }
  }

  if (sections.length === 0) {
    return null;
  }

  return sections.join("\n\n");
}

