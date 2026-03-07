/**
 * Reasoning Tag Parser
 *
 * Strips <think>...</think> blocks from responses so internal reasoning
 * is hidden from Discord users. Everything outside <think> tags is kept.
 *
 * Also strips legacy <final> tag markup (preserving content) for backwards
 * compatibility with older sessions that may still use them.
 *
 * Rules:
 * - Content inside <think>...</think> is REMOVED (hidden reasoning)
 * - <final> tag markup is stripped, content preserved (legacy support)
 * - Tags inside code blocks (``` or `) are preserved (not stripped)
 * - If no tags present, returns text as-is
 */

// Tag patterns - case insensitive, whitespace tolerant
const THINKING_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?)\s*>/gi;
const FINAL_TAG_RE = /<\s*\/?\s*final\s*>/gi;
const QUICK_CHECK_RE = /<\s*\/?\s*(?:think(?:ing)?|final)\b/i;

// Code block detection
const FENCED_CODE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;

/**
 * Find all code regions (fenced blocks and inline code) in text.
 * Returns array of [start, end] ranges to protect from tag stripping.
 */
function findCodeRegions(text: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];

  // Find fenced code blocks
  let match;
  const fencedRe = new RegExp(FENCED_CODE_RE.source, 'g');
  while ((match = fencedRe.exec(text)) !== null) {
    regions.push([match.index, match.index + match[0].length]);
  }

  // Find inline code
  const inlineRe = new RegExp(INLINE_CODE_RE.source, 'g');
  while ((match = inlineRe.exec(text)) !== null) {
    regions.push([match.index, match.index + match[0].length]);
  }

  return regions;
}

/**
 * Check if a position is inside a code region.
 */
function isInCodeRegion(pos: number, regions: Array<[number, number]>): boolean {
  for (const [start, end] of regions) {
    if (pos >= start && pos < end) {
      return true;
    }
  }
  return false;
}

/**
 * Strip reasoning tags from text.
 *
 * - Removes <think>...</think> blocks entirely (hidden reasoning)
 * - Removes <final> tag markup but preserves content (user-visible)
 * - Preserves tags inside code blocks
 * - Returns text unchanged if no tags present
 */
export function stripReasoningTags(text: string): string {
  if (!text) {
    return text;
  }

  // Quick check - if no tags at all, return as-is
  if (!QUICK_CHECK_RE.test(text)) {
    return text;
  }

  // Find code regions to protect
  const codeRegions = findCodeRegions(text);

  let result = text;

  // Step 1: Remove <think>...</think> blocks (including content)
  // We need to do this carefully to handle nested/unclosed tags
  let thinkStart = -1;
  let thinkDepth = 0;
  let i = 0;

  while (i < result.length) {
    // Look for opening <think> or <thinking>
    const openMatch = result.slice(i).match(/^<\s*think(?:ing)?\s*>/i);
    if (openMatch && !isInCodeRegion(i, codeRegions)) {
      if (thinkDepth === 0) {
        thinkStart = i;
      }
      thinkDepth++;
      i += openMatch[0].length;
      continue;
    }

    // Look for closing </think> or </thinking>
    const closeMatch = result.slice(i).match(/^<\s*\/\s*think(?:ing)?\s*>/i);
    if (closeMatch && !isInCodeRegion(i, codeRegions)) {
      if (thinkDepth > 0) {
        thinkDepth--;
        if (thinkDepth === 0 && thinkStart !== -1) {
          // Remove the entire block including tags
          const endPos = i + closeMatch[0].length;
          result = result.slice(0, thinkStart) + result.slice(endPos);
          // Adjust code regions after removal
          const removedLength = endPos - thinkStart;
          for (let j = 0; j < codeRegions.length; j++) {
            if (codeRegions[j][0] > thinkStart) {
              codeRegions[j][0] -= removedLength;
              codeRegions[j][1] -= removedLength;
            }
          }
          i = thinkStart; // Reset position to where we removed
          thinkStart = -1;
          continue;
        }
      } else {
        // Orphan closing tag at depth 0 — strip it
        result = result.slice(0, i) + result.slice(i + closeMatch[0].length);
        continue; // Re-check at same position
      }
      i += closeMatch[0].length;
      continue;
    }

    i++;
  }

  // If there's an unclosed <think> tag, remove from that point to end
  if (thinkDepth > 0 && thinkStart !== -1) {
    result = result.slice(0, thinkStart);
  }

  // Step 2: Strip <final> tag markup but preserve content
  // Simply remove the tags themselves
  result = result.replace(FINAL_TAG_RE, (match, offset) => {
    if (isInCodeRegion(offset, codeRegions)) {
      return match; // Preserve in code blocks
    }
    return '';
  });

  // Trim whitespace
  return result.trim();
}

/**
 * Check if text contains reasoning tags.
 * Useful for logging/debugging.
 */
export function hasReasoningTags(text: string): boolean {
  return QUICK_CHECK_RE.test(text);
}
