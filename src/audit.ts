/**
 * Audit Trail - Skill Creation Detection & Creator DMs
 *
 * Watches .claude/skills/ and agent-data/ for changes,
 * notifying the creator when Greg creates new skills or
 * makes significant updates to its knowledge base.
 */

import { Client } from "discord.js-selfbot-v13";
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { dmCreator } from "./bot";

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = process.cwd();
const SKILLS_DIR = path.join(PROJECT_DIR, ".claude", "skills");
const AGENT_DATA_DIR = path.join(PROJECT_DIR, "agent-data");
const RELATIONSHIPS_DIR = path.join(AGENT_DATA_DIR, "relationships");
const LEARNED_PATTERNS_FILE = path.join(AGENT_DATA_DIR, "learned-patterns.md");

// Minimum file size change (in bytes) to consider "significant"
const SIGNIFICANT_CHANGE_THRESHOLD = 100;

// ============================================================================
// State
// ============================================================================

let skillsWatcher: FSWatcher | null = null;
let agentDataWatcher: FSWatcher | null = null;
let relationshipsWatcher: FSWatcher | null = null;

// Track file sizes for detecting significant changes
const fileSizes: Map<string, number> = new Map();

// Track recently processed files to avoid duplicate notifications
const recentlyProcessed: Set<string> = new Set();
const DEBOUNCE_MS = 2000;

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

/**
 * Format a skill notification message
 */
function formatSkillNotification(
  skillName: string,
  description: string,
  createdAt: Date
): string {
  const timestamp = createdAt.toLocaleString();

  return `**[Audit] New Skill Created**

**Skill Name:** ${skillName}
**Description:** ${description}
**Created:** ${timestamp}

_Greg created this skill to improve itself._`;
}

/**
 * Format a relationship file notification
 */
function formatRelationshipNotification(
  userId: string,
  preview: string,
  createdAt: Date
): string {
  const timestamp = createdAt.toLocaleString();

  return `**[Audit] New Relationship File**

**User ID:** ${userId}
**Preview:** ${preview}
**Created:** ${timestamp}

_Greg is learning about this user._`;
}

/**
 * Format a learned patterns update notification
 */
function formatPatternsNotification(
  sizeDiff: number,
  updatedAt: Date
): string {
  const timestamp = updatedAt.toLocaleString();
  const changeType = sizeDiff > 0 ? "added" : "removed";
  const absSize = Math.abs(sizeDiff);

  return `**[Audit] Learned Patterns Updated**

**Change:** ${absSize} bytes ${changeType}
**Updated:** ${timestamp}

_Greg is refining its behavioral patterns._`;
}

// ============================================================================
// Watchers
// ============================================================================

/**
 * Watch the skills directory for new SKILL.md files
 */
async function watchSkillsDirectory(
  client: Client,
  creatorId: string
): Promise<void> {
  // Ensure directory exists
  await fs.mkdir(SKILLS_DIR, { recursive: true });

  console.log(`[AUDIT] Watching skills directory: ${SKILLS_DIR}`);

  skillsWatcher = watch(SKILLS_DIR, { recursive: true }, async (event, filename) => {
    if (!filename || !filename.endsWith("SKILL.md")) {
      return;
    }

    const fullPath = path.join(SKILLS_DIR, filename);
    const cacheKey = `skill:${fullPath}`;

    // Debounce
    if (recentlyProcessed.has(cacheKey)) {
      return;
    }
    recentlyProcessed.add(cacheKey);
    setTimeout(() => recentlyProcessed.delete(cacheKey), DEBOUNCE_MS);

    try {
      // Check if file exists (might be a delete event)
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat) {
        return;
      }

      console.log(`[AUDIT] New skill detected: ${filename}`);

      // Read and parse the skill file
      const content = await fs.readFile(fullPath, "utf-8");
      const frontmatter = parseYamlFrontmatter(content);

      // Get skill name from frontmatter or filename
      const skillName = frontmatter.name || path.dirname(filename) || filename.replace("/SKILL.md", "");
      const description = frontmatter.description || extractDescription(content);

      // Send DM to creator
      const message = formatSkillNotification(skillName, description, stat.birthtime);
      await dmCreator(client, creatorId, message);

      console.log(`[AUDIT] Sent skill notification for: ${skillName}`);
    } catch (error) {
      console.error(`[AUDIT] Error processing skill file ${filename}:`, error);
    }
  });
}

/**
 * Watch the relationships directory for new files
 */
async function watchRelationshipsDirectory(
  client: Client,
  creatorId: string
): Promise<void> {
  // Ensure directory exists
  await fs.mkdir(RELATIONSHIPS_DIR, { recursive: true });

  console.log(`[AUDIT] Watching relationships directory: ${RELATIONSHIPS_DIR}`);

  relationshipsWatcher = watch(RELATIONSHIPS_DIR, async (event, filename) => {
    if (!filename || !filename.endsWith(".md")) {
      return;
    }

    const fullPath = path.join(RELATIONSHIPS_DIR, filename);
    const cacheKey = `relationship:${fullPath}`;

    // Debounce
    if (recentlyProcessed.has(cacheKey)) {
      return;
    }
    recentlyProcessed.add(cacheKey);
    setTimeout(() => recentlyProcessed.delete(cacheKey), DEBOUNCE_MS);

    try {
      // Check if file exists
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat) {
        return;
      }

      // Only notify for new files (created in last 5 seconds)
      const isNew = Date.now() - stat.birthtimeMs < 5000;
      if (!isNew) {
        return;
      }

      console.log(`[AUDIT] New relationship file detected: ${filename}`);

      // Read preview
      const content = await fs.readFile(fullPath, "utf-8");
      const preview = content.substring(0, 100) + (content.length > 100 ? "..." : "");
      const userId = filename.replace(".md", "");

      // Send DM to creator
      const message = formatRelationshipNotification(userId, preview, stat.birthtime);
      await dmCreator(client, creatorId, message);

      console.log(`[AUDIT] Sent relationship notification for: ${userId}`);
    } catch (error) {
      console.error(`[AUDIT] Error processing relationship file ${filename}:`, error);
    }
  });
}

/**
 * Watch agent-data for significant changes to learned-patterns.md
 */
async function watchLearnedPatterns(
  client: Client,
  creatorId: string
): Promise<void> {
  // Get initial file size
  try {
    const stat = await fs.stat(LEARNED_PATTERNS_FILE);
    fileSizes.set(LEARNED_PATTERNS_FILE, stat.size);
  } catch {
    fileSizes.set(LEARNED_PATTERNS_FILE, 0);
  }

  console.log(`[AUDIT] Watching learned patterns: ${LEARNED_PATTERNS_FILE}`);

  agentDataWatcher = watch(AGENT_DATA_DIR, async (event, filename) => {
    if (filename !== "learned-patterns.md") {
      return;
    }

    const cacheKey = `patterns:${LEARNED_PATTERNS_FILE}`;

    // Debounce
    if (recentlyProcessed.has(cacheKey)) {
      return;
    }
    recentlyProcessed.add(cacheKey);
    setTimeout(() => recentlyProcessed.delete(cacheKey), DEBOUNCE_MS);

    try {
      const stat = await fs.stat(LEARNED_PATTERNS_FILE).catch(() => null);
      if (!stat) {
        return;
      }

      const previousSize = fileSizes.get(LEARNED_PATTERNS_FILE) || 0;
      const sizeDiff = stat.size - previousSize;

      // Only notify for significant changes
      if (Math.abs(sizeDiff) < SIGNIFICANT_CHANGE_THRESHOLD) {
        fileSizes.set(LEARNED_PATTERNS_FILE, stat.size);
        return;
      }

      console.log(`[AUDIT] Significant patterns change: ${sizeDiff} bytes`);

      // Update tracked size
      fileSizes.set(LEARNED_PATTERNS_FILE, stat.size);

      // Send DM to creator
      const message = formatPatternsNotification(sizeDiff, stat.mtime);
      await dmCreator(client, creatorId, message);

      console.log(`[AUDIT] Sent patterns notification`);
    } catch (error) {
      console.error(`[AUDIT] Error processing patterns update:`, error);
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
  creatorId: string
): Promise<void> {
  console.log(`[AUDIT] Starting audit watcher system...`);

  await Promise.all([
    watchSkillsDirectory(client, creatorId),
    watchRelationshipsDirectory(client, creatorId),
    watchLearnedPatterns(client, creatorId),
  ]);

  console.log(`[AUDIT] Audit watcher system started`);
}

/**
 * Stop all audit watchers
 */
export function stopAuditWatcher(): void {
  console.log(`[AUDIT] Stopping audit watcher system...`);

  if (skillsWatcher) {
    skillsWatcher.close();
    skillsWatcher = null;
  }

  if (relationshipsWatcher) {
    relationshipsWatcher.close();
    relationshipsWatcher = null;
  }

  if (agentDataWatcher) {
    agentDataWatcher.close();
    agentDataWatcher = null;
  }

  recentlyProcessed.clear();
  fileSizes.clear();

  console.log(`[AUDIT] Audit watcher system stopped`);
}
