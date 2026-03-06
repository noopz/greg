/**
 * Context caching and truncation utilities for managing large content in agent context.
 * Uses mtime-based caching to avoid re-reading unchanged files.
 */

import { statSync, readFileSync } from "fs";

// Character limits for different content types
export const MAX_MEMORY_FILE_CHARS = 3000;
export const MAX_RELATIONSHIP_CHARS = 4000;
export const MAX_PATTERNS_CHARS = 8000;

interface TruncationResult {
  content: string;
  truncated: boolean;
  originalLength: number;
}

interface CacheEntry {
  content: string;
  mtimeMs: number;
  truncated: boolean;
}

// In-memory cache keyed by file path
const fileCache = new Map<string, CacheEntry>();

/**
 * Get the mtime of a file without reading its contents.
 * Returns mtimeMs or null if the file doesn't exist.
 */
export function getFileMtime(filePath: string): number | null {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Truncate content using head/tail strategy with 10% marker.
 * Default: 70% head / 20% tail (preserves beginning context).
 * tailBiased: 20% head / 70% tail (for chronological append-only files
 * like memories where recent entries at the bottom matter most).
 */
export function truncateWithHeadTail(
  content: string,
  maxChars: number,
  label: string = "content",
  tailBiased: boolean = false
): TruncationResult {
  const originalLength = content.length;

  if (content.length <= maxChars) {
    return { content, truncated: false, originalLength };
  }

  const markerBudget = Math.floor(maxChars * 0.1);
  const headBudget = Math.floor(maxChars * (tailBiased ? 0.2 : 0.7));
  const tailBudget = maxChars - headBudget - markerBudget;

  const omittedChars = originalLength - headBudget - tailBudget;
  const marker = `\n\n... [${label}: ${omittedChars.toLocaleString()} chars omitted] ...\n\n`;

  // Adjust if marker is larger than budget
  const actualMarker =
    marker.length <= markerBudget
      ? marker
      : `\n\n... [${omittedChars} omitted] ...\n\n`;

  const head = content.slice(0, headBudget);
  const tail = content.slice(-tailBudget);

  return {
    content: head + actualMarker + tail,
    truncated: true,
    originalLength,
  };
}

/**
 * Section-aware truncation that splits on `## ` boundaries.
 *
 * Default (head-biased): Keeps first 2 sections (preamble + first ##) at the head,
 * fills remaining budget from the tail. Good for structured docs where the top
 * sections contain the most important content (e.g. patterns, relationships).
 *
 * tailBiased: Keeps last 2 sections at the tail, fills remaining budget from the
 * head. Good for chronological append-only files (e.g. daily memories) where the
 * most recent sections at the bottom are most relevant.
 *
 * Falls back to truncateWithHeadTail if anchor + opposite-end section exceed budget.
 */
export function truncateBySections(
  content: string,
  maxChars: number,
  label: string = "content",
  tailBiased: boolean = false
): TruncationResult {
  const originalLength = content.length;

  if (content.length <= maxChars) {
    return { content, truncated: false, originalLength };
  }

  // Split on ## boundaries, keeping the delimiter with each section
  const parts = content.split(/(?=^## )/m);
  if (parts.length < 2) {
    return truncateWithHeadTail(content, maxChars, label, tailBiased);
  }

  // Anchor = the sections we always keep (2 from the priority end)
  // Fill = sections we pack in from the opposite end until budget runs out
  const anchorCount = Math.min(2, parts.length);

  let anchor: string;
  let fillSections: string[];

  if (tailBiased) {
    anchor = parts.slice(-anchorCount).join("");
    fillSections = parts.slice(0, parts.length - anchorCount);
  } else {
    anchor = parts.slice(0, anchorCount).join("");
    fillSections = parts.slice(anchorCount);
  }

  if (fillSections.length === 0) {
    return truncateWithHeadTail(content, maxChars, label, tailBiased);
  }

  const markerTemplate = `\n\n... [${fillSections.length} sections omitted] ...\n\n`;
  const markerSize = markerTemplate.length;

  // Check if even anchor + nearest fill section + marker exceeds budget
  const nearestFill = tailBiased ? fillSections[fillSections.length - 1] : fillSections[0];
  if (anchor.length + nearestFill.length + markerSize > maxChars) {
    return truncateWithHeadTail(content, maxChars, label, tailBiased);
  }

  // Fill from the opposite end, reserving space for anchor + marker
  let budgetLeft = maxChars - anchor.length - markerSize;
  const keptFill: string[] = [];

  if (tailBiased) {
    // Fill from the end of fillSections (closest to the anchor at tail)
    for (let i = fillSections.length - 1; i >= 0; i--) {
      if (fillSections[i].length <= budgetLeft) {
        keptFill.unshift(fillSections[i]);
        budgetLeft -= fillSections[i].length;
      } else {
        break;
      }
    }
  } else {
    // Fill from the end of fillSections (tail = most recent)
    for (let i = fillSections.length - 1; i >= 0; i--) {
      if (fillSections[i].length <= budgetLeft) {
        keptFill.unshift(fillSections[i]);
        budgetLeft -= fillSections[i].length;
      } else {
        break;
      }
    }
  }

  const omittedCount = fillSections.length - keptFill.length;
  if (omittedCount === 0) {
    return { content, truncated: false, originalLength };
  }

  const marker = `\n\n... [${omittedCount} sections omitted] ...\n\n`;

  // Assemble: for tail-biased, fill comes before anchor; for head-biased, anchor comes first
  const result = tailBiased
    ? keptFill.join("") + marker + anchor
    : anchor + marker + keptFill.join("");

  return { content: result, truncated: true, originalLength };
}

/**
 * Load a file with mtime-based caching.
 * Returns cached content if file hasn't changed.
 * Optionally truncates content before caching.
 *
 * @param tailBiased - When true, truncation prioritizes the tail (end) of the file.
 *   Use for chronological append-only files where recent content matters most.
 */
export function loadFileWithCache(
  filePath: string,
  maxChars?: number,
  tailBiased: boolean = false
): TruncationResult & { fromCache: boolean } {
  try {
    const stats = statSync(filePath);
    const currentMtime = stats.mtimeMs;

    // Check cache — key includes tailBiased since the same file may be loaded
    // with different strategies (unlikely but defensive)
    const cacheKey = tailBiased ? `${filePath}:tail` : filePath;
    const cached = fileCache.get(cacheKey);
    if (cached && cached.mtimeMs === currentMtime) {
      return {
        content: cached.content,
        truncated: cached.truncated,
        originalLength: cached.content.length,
        fromCache: true,
      };
    }

    // Read fresh content
    const rawContent = readFileSync(filePath, "utf-8");

    // Truncate if maxChars specified
    let finalContent: string;
    let truncated = false;

    if (maxChars && rawContent.length > maxChars) {
      const label = filePath.split("/").pop() || "file";
      // Use section-aware truncation when content has ## headers
      const hasSections = rawContent.includes("\n## ") || rawContent.startsWith("## ");
      const result = hasSections
        ? truncateBySections(rawContent, maxChars, label, tailBiased)
        : truncateWithHeadTail(rawContent, maxChars, label, tailBiased);
      finalContent = result.content;
      truncated = result.truncated;
    } else {
      finalContent = rawContent;
    }

    // Update cache
    fileCache.set(cacheKey, {
      content: finalContent,
      mtimeMs: currentMtime,
      truncated,
    });

    return {
      content: finalContent,
      truncated,
      originalLength: rawContent.length,
      fromCache: false,
    };
  } catch (error) {
    // File doesn't exist or can't be read
    return {
      content: "",
      truncated: false,
      originalLength: 0,
      fromCache: false,
    };
  }
}

