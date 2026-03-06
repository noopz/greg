/**
 * Runtime Configuration System
 *
 * Core configuration management with operator bounds enforcement.
 * Implements secure config loading, validation, clamping, and atomic persistence.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { AGENT_DATA_DIR } from "../paths";
import { log, warn, error } from "../log";
import { atomicWriteFile } from "../persistence";
import {
  RuntimeConfigSchema,
  parseConfig,
  getDefaultConfig,
  validateFileSize,
  MAX_CONFIG_FILE_SIZE,
  type RuntimeConfig,
} from "./schema";

// =============================================================================
// Constants
// =============================================================================

const TAG = "Config";

/** User-editable config file path */
const CONFIG_FILE = path.join(AGENT_DATA_DIR, "runtime-config.json");

/** Effective config file path (includes feedback) */
const EFFECTIVE_CONFIG_FILE = path.join(AGENT_DATA_DIR, "runtime-config-effective.json");

/** Lock file for preventing TOCTOU races */
const LOCK_FILE = path.join(AGENT_DATA_DIR, ".runtime-config.lock");

/** Lock acquisition timeout in milliseconds */
const LOCK_TIMEOUT_MS = 5000;

/** Lock retry interval in milliseconds */
const LOCK_RETRY_MS = 50;

/** Stale lock threshold - locks older than this are considered abandoned */
const STALE_LOCK_MS = 30000;

// =============================================================================
// Operator Bounds (Hardcoded - the bot cannot see these values)
// =============================================================================

/**
 * Operator-defined bounds that constrain Greg's configuration.
 * These values are intentionally hardcoded and not exposed to the agent.
 * Error messages use generic phrasing to avoid leaking exact limits.
 */
export const OPERATOR_BOUNDS = {
  idle: {
    checkIntervalMinutes: { min: 1, max: 10 },
    thresholdMinutes: { min: 5, max: 120 },
  },
  skills: {
    /** Maximum number of skills that can be disabled */
    maxDisabled: 5,
    /** Skills that cannot be disabled (operator-locked) */
    locked: [] as readonly string[],
  },
  keywords: {
    /** Maximum number of keywords allowed */
    maxCount: 20,
    /** Maximum length of each keyword */
    maxLength: 30,
    /** Pattern that keywords must match */
    allowedPattern: /^[a-z0-9 ]+$/i,
  },
} as const;

// =============================================================================
// Types
// =============================================================================

/** Feedback item generated when a value is clamped or adjusted */
export type ClampFeedback = {
  field: string;
  message: string;
  originalValue: unknown;
  adjustedValue: unknown;
};

/** Result from loading and clamping config */
export type LoadConfigResult = {
  config: RuntimeConfig;
  feedback: ClampFeedback[];
  source: "file" | "default";
};

/** Effective config with feedback included */
export type EffectiveConfig = {
  config: RuntimeConfig;
  feedback: ClampFeedback[];
  loadedAt: number;
  source: "file" | "default";
};

/** Lock info stored in the lock file */
type LockInfo = {
  pid: number;
  timestamp: number;
};

// =============================================================================
// File Locking
// =============================================================================

/**
 * Acquire a file lock to prevent TOCTOU races.
 * Uses a simple .lock file approach with PID and timestamp for stale detection.
 */
async function acquireLock(): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
    try {
      // Try to create lock file exclusively
      const lockInfo: LockInfo = {
        pid: process.pid,
        timestamp: Date.now(),
      };

      // Ensure directory exists
      await fs.mkdir(AGENT_DATA_DIR, { recursive: true });

      // Try exclusive create (fails if file exists)
      await fs.writeFile(LOCK_FILE, JSON.stringify(lockInfo), {
        flag: "wx",
      });

      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Lock exists - check if stale
        try {
          const content = await fs.readFile(LOCK_FILE, "utf-8");
          const existingLock = JSON.parse(content) as LockInfo;

          // Check if lock is stale
          if (Date.now() - existingLock.timestamp > STALE_LOCK_MS) {
            // Remove stale lock and retry
            warn(TAG, `Removing stale lock from PID ${existingLock.pid}`);
            await fs.unlink(LOCK_FILE);
            continue;
          }

          // Lock is valid, wait and retry
          await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
        } catch {
          // Error reading lock file - try to remove and retry
          try {
            await fs.unlink(LOCK_FILE);
          } catch {
            // Ignore unlink errors
          }
        }
      } else if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // Unexpected error
        throw err;
      }
    }
  }

  error(TAG, "Failed to acquire config lock within timeout");
  return false;
}

/**
 * Release the file lock.
 */
async function releaseLock(): Promise<void> {
  try {
    // Verify we own the lock before releasing
    const content = await fs.readFile(LOCK_FILE, "utf-8");
    const lockInfo = JSON.parse(content) as LockInfo;

    if (lockInfo.pid === process.pid) {
      await fs.unlink(LOCK_FILE);
    } else {
      warn(TAG, `Lock owned by different PID (${lockInfo.pid}), not releasing`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      warn(TAG, `Error releasing lock: ${err}`);
    }
  }
}

/**
 * Execute a function while holding the config lock.
 */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const acquired = await acquireLock();
  if (!acquired) {
    throw new Error("Could not acquire config lock");
  }

  try {
    return await fn();
  } finally {
    await releaseLock();
  }
}

// =============================================================================
// Clamping Logic
// =============================================================================

/**
 * Clamp a numeric value to min/max bounds.
 * Returns the clamped value and feedback if adjustment was made.
 */
function clampNumeric(
  value: number,
  min: number,
  max: number,
  fieldName: string
): { value: number; feedback: ClampFeedback | null } {
  if (value < min) {
    return {
      value: min,
      feedback: {
        field: fieldName,
        message: "Value was adjusted to fit within allowed range",
        originalValue: value,
        adjustedValue: min,
      },
    };
  }

  if (value > max) {
    return {
      value: max,
      feedback: {
        field: fieldName,
        message: "Value was adjusted to fit within allowed range",
        originalValue: value,
        adjustedValue: max,
      },
    };
  }

  return { value, feedback: null };
}

/**
 * Clamp a config to operator bounds.
 * Returns the clamped config and an array of feedback messages.
 */
export function clampToBounds(config: RuntimeConfig): {
  config: RuntimeConfig;

  feedback: ClampFeedback[];
} {
  const feedback: ClampFeedback[] = [];
  const clamped = structuredClone(config);

  // Clamp idle.checkIntervalMinutes
  const checkInterval = clampNumeric(
    clamped.idle.checkIntervalMinutes,
    OPERATOR_BOUNDS.idle.checkIntervalMinutes.min,
    OPERATOR_BOUNDS.idle.checkIntervalMinutes.max,
    "idle.checkIntervalMinutes"
  );
  clamped.idle.checkIntervalMinutes = checkInterval.value;
  if (checkInterval.feedback) feedback.push(checkInterval.feedback);

  // Clamp idle.thresholdMinutes
  const threshold = clampNumeric(
    clamped.idle.thresholdMinutes,
    OPERATOR_BOUNDS.idle.thresholdMinutes.min,
    OPERATOR_BOUNDS.idle.thresholdMinutes.max,
    "idle.thresholdMinutes"
  );
  clamped.idle.thresholdMinutes = threshold.value;
  if (threshold.feedback) feedback.push(threshold.feedback);

  // Clamp skills.disabled - remove locked skills and limit count
  const originalDisabled = [...clamped.skills.disabled];
  const lockedSkills = new Set(OPERATOR_BOUNDS.skills.locked);

  // Filter out locked skills
  let filteredDisabled = clamped.skills.disabled.filter(
    (skill) => !lockedSkills.has(skill)
  );

  // Check if any locked skills were removed
  const removedLocked = originalDisabled.filter((skill) =>
    lockedSkills.has(skill)
  );
  if (removedLocked.length > 0) {
    feedback.push({
      field: "skills.disabled",
      message: "Some skills cannot be disabled",
      originalValue: originalDisabled,
      adjustedValue: filteredDisabled,
    });
  }

  // Limit to maxDisabled
  if (filteredDisabled.length > OPERATOR_BOUNDS.skills.maxDisabled) {
    const truncated = filteredDisabled.slice(
      0,
      OPERATOR_BOUNDS.skills.maxDisabled
    );
    feedback.push({
      field: "skills.disabled",
      message: "Number of disabled skills was reduced to fit within allowed limit",
      originalValue: filteredDisabled,
      adjustedValue: truncated,
    });
    filteredDisabled = truncated;
  }

  clamped.skills.disabled = filteredDisabled;

  // Clamp keywords
  const originalKeywords = [...clamped.keywords];
  let clampedKeywords = clamped.keywords;

  // Filter keywords by pattern and length
  clampedKeywords = clampedKeywords.filter((keyword) => {
    if (keyword.length > OPERATOR_BOUNDS.keywords.maxLength) {
      return false;
    }
    if (!OPERATOR_BOUNDS.keywords.allowedPattern.test(keyword)) {
      return false;
    }
    return true;
  });

  // Check if any were filtered
  if (clampedKeywords.length !== originalKeywords.length) {
    feedback.push({
      field: "keywords",
      message: "Some keywords were removed (invalid format or too long)",
      originalValue: originalKeywords,
      adjustedValue: clampedKeywords,
    });
  }

  // Limit count
  if (clampedKeywords.length > OPERATOR_BOUNDS.keywords.maxCount) {
    const truncated = clampedKeywords.slice(0, OPERATOR_BOUNDS.keywords.maxCount);
    feedback.push({
      field: "keywords",
      message: "Number of keywords was reduced to fit within allowed limit",
      originalValue: clampedKeywords,
      adjustedValue: truncated,
    });
    clampedKeywords = truncated;
  }

  clamped.keywords = clampedKeywords;

  return { config: clamped, feedback };
}

// =============================================================================
// Config Loading
// =============================================================================

/**
 * Load config from the JSON file, validate with schema, and clamp to bounds.
 * Returns default config if file doesn't exist or is invalid.
 */
export async function loadConfig(): Promise<LoadConfigResult> {
  return withLock(async () => {
    try {
      // Migrate from old greg-config.json if new file doesn't exist
      const oldConfigFile = path.join(AGENT_DATA_DIR, "greg-config.json");
      try {
        await fs.stat(CONFIG_FILE);
      } catch {
        try {
          await fs.stat(oldConfigFile);
          await fs.rename(oldConfigFile, CONFIG_FILE);
          log(TAG, "Migrated greg-config.json → runtime-config.json");
        } catch {
          // Neither file exists, will use defaults below
        }
      }

      // Check if file exists
      let stat;
      try {
        stat = await fs.stat(CONFIG_FILE);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          log(TAG, "Config file not found, using defaults");
          const defaultConfig = getDefaultConfig();
          const { config, feedback } = clampToBounds(defaultConfig);
          return { config, feedback, source: "default" as const };
        }
        throw err;
      }

      // Validate file size
      validateFileSize(stat.size);

      // Read and parse file
      const content = await fs.readFile(CONFIG_FILE, "utf-8");

      let rawConfig: unknown;
      try {
        rawConfig = JSON.parse(content);
      } catch (parseErr) {
        warn(TAG, `Config file has invalid JSON, using defaults`);
        const defaultConfig = getDefaultConfig();
        const { config, feedback } = clampToBounds(defaultConfig);
        return { config, feedback, source: "default" as const };
      }

      // Validate with schema
      let validatedConfig: RuntimeConfig;
      try {
        validatedConfig = parseConfig(rawConfig);
      } catch (validationErr) {
        warn(TAG, `Config validation failed, using defaults`);
        const defaultConfig = getDefaultConfig();
        const { config, feedback } = clampToBounds(defaultConfig);
        return { config, feedback, source: "default" as const };
      }

      // Clamp to operator bounds
      const { config, feedback } = clampToBounds(validatedConfig);

      if (feedback.length > 0) {
        log(TAG, `Config loaded with ${feedback.length} adjustment(s)`);
      } else {
        log(TAG, "Config loaded successfully");
      }

      return { config, feedback, source: "file" as const };
    } catch (err) {
      error(TAG, "Failed to load config", err);
      const defaultConfig = getDefaultConfig();
      const { config, feedback } = clampToBounds(defaultConfig);
      return { config, feedback, source: "default" as const };
    }
  });
}

// =============================================================================
// Effective Config (Cached Read)
// =============================================================================

/** Cached effective config */
let cachedEffectiveConfig: EffectiveConfig | null = null;

/** Last modification time of the config file */
let lastConfigMtime: number | null = null;

/**
 * Get the effective config with caching.
 * Re-reads if the config file has changed.
 */
export async function getEffectiveConfig(): Promise<EffectiveConfig> {
  try {
    // Check if file has changed
    let currentMtime: number | null = null;
    try {
      const stat = await fs.stat(CONFIG_FILE);
      currentMtime = stat.mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      // File doesn't exist - use null mtime
    }

    // Return cached if file hasn't changed
    if (
      cachedEffectiveConfig !== null &&
      currentMtime === lastConfigMtime
    ) {
      return cachedEffectiveConfig;
    }

    // Reload config
    const { config, feedback, source } = await loadConfig();

    const effectiveConfig: EffectiveConfig = {
      config,
      feedback,
      loadedAt: Date.now(),
      source,
    };

    // Update cache
    cachedEffectiveConfig = effectiveConfig;
    lastConfigMtime = currentMtime;

    // Write effective config file
    await writeEffectiveConfigInternal(effectiveConfig);

    return effectiveConfig;
  } catch (err) {
    error(TAG, "Failed to get effective config", err);

    // Return cached if available, otherwise default
    if (cachedEffectiveConfig !== null) {
      return cachedEffectiveConfig;
    }

    const defaultConfig = getDefaultConfig();
    const { config, feedback } = clampToBounds(defaultConfig);

    return {
      config,
      feedback,
      loadedAt: Date.now(),
      source: "default",
    };
  }
}

/**
 * Internal function to write effective config without lock (called from within locked context).
 */
async function writeEffectiveConfigInternal(
  effectiveConfig: EffectiveConfig
): Promise<void> {
  try {
    const content = JSON.stringify(effectiveConfig, null, 2);
    await atomicWriteFile(EFFECTIVE_CONFIG_FILE, content);
  } catch (err) {
    warn(TAG, `Failed to write effective config: ${err}`);
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a skill is currently disabled.
 * Uses cached effective config for efficiency.
 */
export async function isSkillDisabled(skillName: string): Promise<boolean> {
  const { config } = await getEffectiveConfig();
  return config.skills.disabled.includes(skillName);
}

