/**
 * Skill-based Idle Behavior Loading
 *
 * Parses SKILL.md files to extract idle behavior definitions.
 * Skills can define an optional "## Idle Behavior" section with optional cooldown.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { SKILLS_DIR, LOCAL_SKILLS_DIR } from "./paths";
import { log } from "./log";
import { isSkillDisabled } from "./config/runtime-config";

const SKILL_DIRS = [SKILLS_DIR, LOCAL_SKILLS_DIR];

// ============================================================================
// Types
// ============================================================================

export interface IdleBehavior {
  name: string;
  prompt: string;
  skillPath?: string; // Path to the skill file this came from
  cooldownMs?: number; // Cooldown in milliseconds (optional)
  model?: string; // Model override from SKILL.md frontmatter (e.g., "haiku", "sonnet", "opus")
}

// ============================================================================
// Built-in Idle Behaviors (always available)
// ============================================================================

const BUILTIN_BEHAVIORS: IdleBehavior[] = [];

// ============================================================================
// Cooldown Parsing
// ============================================================================

/**
 * Parse cooldown string from skill content (e.g., "Cooldown: 1 hour", "Cooldown: 30 minutes")
 * Returns cooldown in milliseconds, or undefined if not specified
 */
export function parseCooldown(content: string): number | undefined {
  // Look for "Cooldown: X unit" pattern in the idle behavior section
  const cooldownMatch = content.match(/Cooldown:\s*(\d+)\s*(hours|hour|hrs|hr|minutes|minute|mins|min)/i);

  if (!cooldownMatch) {
    return undefined;
  }

  const value = parseInt(cooldownMatch[1], 10);
  const unit = cooldownMatch[2].toLowerCase();

  if (unit.startsWith("hour") || unit.startsWith("hr")) {
    return value * 60 * 60 * 1000;
  } else if (unit.startsWith("min")) {
    return value * 60 * 1000;
  }

  return undefined;
}

/**
 * Format a cooldown duration in milliseconds to a human-readable string.
 */
export function formatCooldown(ms: number): string {
  const minutes = Math.round(ms / 1000 / 60);
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours}h`;
  }
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  }
  return `${minutes}m`;
}

// ============================================================================
// Skill Parsing
// ============================================================================

/**
 * Parse a SKILL.md file and extract the idle behavior section if present.
 * Returns null if no idle behavior is defined.
 *
 * Skills can define cooldowns in the Idle Behavior section:
 * ```
 * ## Idle Behavior
 *
 * Cooldown: 1 hour
 *
 * [prompt text here]
 * ```
 */
export function parseIdleBehaviorFromSkill(content: string, skillName: string, skillPath: string): IdleBehavior | null {
  // Strip fenced code blocks to avoid matching headers inside examples,
  // but only for finding section boundaries — extract content from the original
  const contentWithoutCodeBlocks = content.replace(/```[\s\S]*?```/g, (match) => " ".repeat(match.length));

  // Look for ## Idle Behavior section in stripped content (for boundary detection)
  const idleBehaviorMatch = contentWithoutCodeBlocks.match(/## Idle Behavior\s*\n([\s\S]*?)(?=\n## |\n# |$)/i);

  if (!idleBehaviorMatch) {
    return null;
  }

  // Use the match position to extract from original content (preserving code blocks)
  const sectionStart = idleBehaviorMatch.index! + idleBehaviorMatch[0].length - idleBehaviorMatch[1].length;
  const sectionContent = content.substring(sectionStart, sectionStart + idleBehaviorMatch[1].length).trim();
  if (!sectionContent) {
    return null;
  }

  // Parse cooldown from the section content
  const cooldownMs = parseCooldown(sectionContent);

  // Remove the cooldown line from the prompt (if present)
  const prompt = sectionContent.replace(/Cooldown:\s*\d+\s*(?:hours|hour|hrs|hr|minutes|minute|mins|min)\s*\n*/gi, "").trim();

  if (!prompt) {
    return null;
  }

  // Parse model from YAML frontmatter (e.g., "model: haiku")
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  let model: string | undefined;
  if (frontmatterMatch) {
    const modelMatch = frontmatterMatch[1].match(/^model:\s*(.+)$/m);
    if (modelMatch) {
      model = modelMatch[1].trim();
    }
  }

  return {
    name: skillName,
    prompt,
    skillPath,
    cooldownMs,
    model,
  };
}

// ============================================================================
// Behavior Loading
// ============================================================================

/**
 * Load all idle behaviors from skills directory.
 * Scans .claude/skills/<name>/SKILL.md for ## Idle Behavior sections.
 */
async function loadSkillIdleBehaviors(): Promise<IdleBehavior[]> {
  const behaviors: IdleBehavior[] = [];

  for (const dir of SKILL_DIRS) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = path.join(dir, entry.name, "SKILL.md");

        try {
          const content = await fs.readFile(skillPath, "utf-8");
          const behavior = parseIdleBehaviorFromSkill(content, entry.name, skillPath);

          if (behavior) {
            // Check if this skill is disabled in config
            if (await isSkillDisabled(entry.name)) {
              log("IDLE", `Skill ${entry.name} is disabled, skipping`);
              continue;
            }

            behaviors.push(behavior);
            const cooldownInfo = behavior.cooldownMs
              ? ` (cooldown: ${Math.round(behavior.cooldownMs / 1000 / 60)} min)`
              : "";
            log("IDLE", `Loaded idle behavior from skill: ${entry.name}${cooldownInfo}`);
          }
        } catch {
          // SKILL.md doesn't exist or can't be read - skip
          continue;
        }
      }
    } catch {
      // Directory doesn't exist — skip silently
    }
  }

  return behaviors;
}

/**
 * Get all available idle behaviors (built-in + skills).
 * Reloads from disk each time to pick up new skills.
 */
export async function getAllIdleBehaviors(): Promise<IdleBehavior[]> {
  const skillBehaviors = await loadSkillIdleBehaviors();
  return [...BUILTIN_BEHAVIORS, ...skillBehaviors];
}