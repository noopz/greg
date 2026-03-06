/**
 * Audit Trail - Self-Modification Detection & Creator DMs
 *
 * Watches for Greg's self-modifications and notifies the creator:
 * - .claude/skills/ - new skills or skill updates
 * - .claude/agents/ - new subagents or agent updates
 * - agent-data/relationships/ - relationship file changes
 * - agent-data/impressions/ - new impressions logged
 * - agent-data/learned-patterns.md - significant pattern updates
 */

import { Client } from "discord.js-selfbot-v13";
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { SKILLS_DIR, LOCAL_SKILLS_DIR, AGENTS_DIR, AGENT_DATA_DIR, RELATIONSHIPS_DIR, IMPRESSIONS_DIR } from "./paths";
import { dmCreator } from "./bot-types";
import { createFileWatcher, closeAllWatchers, type ChangeParams } from "./file-watcher";
import type { UserId } from "./agent-types";

// ============================================================================
// Configuration
// ============================================================================

const LEARNED_PATTERNS_FILE = path.join(AGENT_DATA_DIR, "learned-patterns.md");

// Minimum file size change (in bytes) to consider "significant"
const SIGNIFICANT_CHANGE_THRESHOLD = 100;

// ============================================================================
// Diff Helpers
// ============================================================================

/**
 * Get lines added between old and new content
 */
function getAddedLines(oldContent: string, newContent: string): string[] {
  const oldLines = new Set(oldContent.split('\n').map(l => l.trim()).filter(l => l));
  const newLines = newContent.split('\n').map(l => l.trim()).filter(l => l);
  return newLines.filter(line => !oldLines.has(line));
}

/**
 * Discord message character limit
 */
const DISCORD_CHAR_LIMIT = 2000;

/**
 * Format all changes for audit messages.
 * Truncates if necessary to fit Discord's 2000 char limit.
 */
function summarizeChanges(addedLines: string[]): string {
  if (addedLines.length === 0) return "minor formatting changes";

  // Filter out markdown headers and empty-ish lines
  const meaningful = addedLines.filter(l =>
    !l.startsWith('#') &&
    !l.startsWith('<!--') &&
    !l.startsWith('```') &&
    l.length > 10
  );

  if (meaningful.length === 0) return "structural changes";

  // Build the summary, but respect a reasonable limit
  // Leave room for the audit message prefix (~100 chars)
  const MAX_SUMMARY_LENGTH = DISCORD_CHAR_LIMIT - 150;

  const lines: string[] = [];
  let totalLength = 0;

  for (const line of meaningful) {
    const formatted = `- ${line}`;
    if (totalLength + formatted.length + 1 > MAX_SUMMARY_LENGTH) {
      const remaining = meaningful.length - lines.length;
      if (remaining > 0) {
        lines.push(`... and ${remaining} more line(s)`);
      }
      break;
    }
    lines.push(formatted);
    totalLength += formatted.length + 1; // +1 for newline
  }

  return lines.join('\n');
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse YAML frontmatter from a markdown file
 */
function parseYamlFrontmatter(content: string): Record<string, string> {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return {};
  }

  const yaml = frontmatterMatch[1];
  const result: Record<string, string> = {};

  for (const line of yaml.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).trim();
      const value = line.substring(colonIndex + 1).trim().replace(/^["']|["']$/g, "");
      result[key] = value;
    }
  }

  return result;
}

/**
 * Extract a description from markdown content (first paragraph after frontmatter)
 */
function extractDescription(content: string): string {
  // Remove frontmatter
  const withoutFrontmatter = content.replace(/^---\n[\s\S]*?\n---\n*/, "");

  // Find first non-empty paragraph
  const paragraphs = withoutFrontmatter.split(/\n\n+/);
  for (const para of paragraphs) {
    const trimmed = para.trim();
    // Skip headers
    if (trimmed && !trimmed.startsWith("#")) {
      // Limit to first 200 chars
      return trimmed.length > 200 ? trimmed.substring(0, 200) + "..." : trimmed;
    }
  }

  return "No description available.";
}

// ============================================================================
// Change Handlers
// ============================================================================

/**
 * Handle skill file changes
 */
async function handleSkillChange({ filename, content, oldContent, isNew }: ChangeParams): Promise<string | null> {
  const frontmatter = parseYamlFrontmatter(content);
  const skillName = frontmatter.name || path.basename(path.dirname(filename)) || filename.replace("/SKILL.md", "");

  if (isNew) {
    const description = frontmatter.description || extractDescription(content);
    const desc = description.length > 100 ? description.substring(0, 97) + "..." : description;
    console.log(`[AUDIT] New skill: ${skillName}`);
    return `[Audit] New skill: **${skillName}** - ${desc}`;
  }

  const addedLines = getAddedLines(oldContent, content);
  if (addedLines.length === 0) return null;
  const summary = summarizeChanges(addedLines);
  console.log(`[AUDIT] Skill updated: ${skillName}`);
  return `[Audit] Skill **${skillName}** updated: ${summary}`;
}

/**
 * Handle agent file changes
 */
async function handleAgentChange({ filename, content, oldContent, isNew }: ChangeParams): Promise<string | null> {
  const agentName = filename.replace(".md", "");

  if (isNew) {
    const description = extractDescription(content);
    const desc = description.length > 100 ? description.substring(0, 97) + "..." : description;
    console.log(`[AUDIT] New agent: ${agentName}`);
    return `[Audit] New agent: **${agentName}** - ${desc}`;
  }

  const addedLines = getAddedLines(oldContent, content);
  if (addedLines.length === 0) return null;
  const summary = summarizeChanges(addedLines);
  console.log(`[AUDIT] Agent updated: ${agentName}`);
  return `[Audit] Agent **${agentName}** updated: ${summary}`;
}

/**
 * Handle relationship file changes
 */
async function handleRelationshipChange({ filename, content, oldContent, isNew }: ChangeParams): Promise<string | null> {
  const userId = filename.replace(".md", "");

  if (isNew) {
    const summary = summarizeChanges(content.split('\n'));
    console.log(`[AUDIT] Relationship created: ${userId}`);
    return `[Audit] Learning about <@${userId}>: ${summary}`;
  }

  const addedLines = getAddedLines(oldContent, content);
  if (addedLines.length === 0) return null;
  const summary = summarizeChanges(addedLines);
  console.log(`[AUDIT] Relationship updated: ${userId}`);
  return `[Audit] Updated <@${userId}>: ${summary}`;
}

/**
 * Handle impression file changes (JSONL append-only)
 */
async function handleImpressionChange({ filename, content, oldContent }: ChangeParams): Promise<string | null> {
  const userId = filename.replace(".jsonl", "");

  // Find new lines (impressions are append-only JSONL)
  const oldLines = oldContent.trim().split('\n').filter(l => l);
  const newLines = content.trim().split('\n').filter(l => l);

  if (newLines.length <= oldLines.length) {
    return null; // No new impressions
  }

  // Get only the new impressions - collect all messages
  const addedLines = newLines.slice(oldLines.length);
  const messages: string[] = [];

  for (const line of addedLines) {
    try {
      const impression = JSON.parse(line);
      const what = impression.what || "unknown";
      const truncated = what.length > 150 ? what.substring(0, 147) + "..." : what;
      console.log(`[AUDIT] New impression for ${userId}: ${what.substring(0, 50)}...`);
      messages.push(`[Audit] Impression of <@${userId}>: ${truncated}`);
    } catch {
      // Invalid JSON line, skip
    }
  }

  // Return first message (the watcher sends one DM per call; for multiple impressions
  // we'd need a different approach, but typically only one is appended at a time)
  return messages[0] || null;
}

// ============================================================================
// Learned Patterns Watcher (special: single-file with size threshold)
// ============================================================================

let patternsWatcher: FSWatcher | null = null;
const patternsContent: Map<string, string> = new Map();
const patternsRecentlyProcessed: Set<string> = new Set();

/**
 * Watch agent-data for significant changes to learned-patterns.md
 */
async function watchLearnedPatterns(
  client: Client,
  creatorId: UserId
): Promise<void> {
  // Get initial file content
  try {
    const content = await fs.readFile(LEARNED_PATTERNS_FILE, "utf-8");
    patternsContent.set(LEARNED_PATTERNS_FILE, content);
  } catch {
    patternsContent.set(LEARNED_PATTERNS_FILE, "");
  }

  console.log(`[AUDIT] Watching learned patterns: ${LEARNED_PATTERNS_FILE}`);

  patternsWatcher = watch(AGENT_DATA_DIR, async (_event, filename) => {
    if (filename !== "learned-patterns.md") {
      return;
    }

    const cacheKey = `patterns:${LEARNED_PATTERNS_FILE}`;

    // Debounce
    if (patternsRecentlyProcessed.has(cacheKey)) {
      return;
    }
    patternsRecentlyProcessed.add(cacheKey);
    setTimeout(() => patternsRecentlyProcessed.delete(cacheKey), 2000);

    try {
      const content = await fs.readFile(LEARNED_PATTERNS_FILE, "utf-8").catch(() => null);
      if (!content) {
        return;
      }

      const oldContent = patternsContent.get(LEARNED_PATTERNS_FILE) || "";

      // Only notify for significant changes
      if (Math.abs(content.length - oldContent.length) < SIGNIFICANT_CHANGE_THRESHOLD) {
        patternsContent.set(LEARNED_PATTERNS_FILE, content);
        return;
      }

      // Get what changed
      const addedLines = getAddedLines(oldContent, content);
      if (addedLines.length === 0) {
        patternsContent.set(LEARNED_PATTERNS_FILE, content);
        return;
      }

      // Update cached content
      patternsContent.set(LEARNED_PATTERNS_FILE, content);

      const summary = summarizeChanges(addedLines);
      const message = `[Audit] Patterns updated: ${summary}`;

      console.log(`[AUDIT] Patterns updated:\n${summary}`);
      await dmCreator(client, creatorId, message);
    } catch (err) {
      console.error(`[AUDIT] Error processing patterns update:`, err);
    }
  });
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Start the audit watcher system
 */
export async function startAuditWatcher(
  client: Client,
  creatorId: UserId
): Promise<void> {
  console.log(`[AUDIT] Starting audit watcher system...`);

  await Promise.all([
    createFileWatcher(client, creatorId, {
      directory: SKILLS_DIR,
      fileFilter: (filename) => filename.endsWith("SKILL.md"),
      entityName: "skill",
      isDirectoryBased: true,
      targetFilename: "SKILL.md",
      recursive: true,
      handleChange: handleSkillChange,
    }),
    createFileWatcher(client, creatorId, {
      directory: LOCAL_SKILLS_DIR,
      fileFilter: (filename) => filename.endsWith("SKILL.md"),
      entityName: "skill",
      isDirectoryBased: true,
      targetFilename: "SKILL.md",
      recursive: true,
      handleChange: handleSkillChange,
    }),
    createFileWatcher(client, creatorId, {
      directory: AGENTS_DIR,
      fileFilter: (filename) => filename.endsWith(".md") && filename !== "TEMPLATE.md",
      entityName: "agent",
      handleChange: handleAgentChange,
    }),
    createFileWatcher(client, creatorId, {
      directory: RELATIONSHIPS_DIR,
      fileFilter: (filename) => filename.endsWith(".md"),
      entityName: "relationship",
      handleChange: handleRelationshipChange,
    }),
    createFileWatcher(client, creatorId, {
      directory: IMPRESSIONS_DIR,
      fileFilter: (filename) => filename.endsWith(".jsonl") && filename !== "README.md",
      entityName: "impression",
      handleChange: handleImpressionChange,
    }),
    watchLearnedPatterns(client, creatorId),
  ]);

  console.log(`[AUDIT] Audit watcher system started`);
}

/**
 * Stop all audit watchers
 */
export function stopAuditWatcher(): void {
  console.log(`[AUDIT] Stopping audit watcher system...`);

  // Close factory-managed watchers
  closeAllWatchers();

  // Close the patterns watcher (managed separately due to its unique logic)
  if (patternsWatcher) {
    patternsWatcher.close();
    patternsWatcher = null;
  }
  patternsContent.clear();
  patternsRecentlyProcessed.clear();

  console.log(`[AUDIT] Audit watcher system stopped`);
}
