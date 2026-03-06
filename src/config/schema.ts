/**
 * Zod validation schema for runtime configuration
 * Provides strict type validation with sensible defaults for missing/corrupted fields
 */

import { z } from "zod";

// =============================================================================
// Constants
// =============================================================================

/** Maximum config file size in bytes (10KB) */
export const MAX_CONFIG_FILE_SIZE = 10 * 1024;

/** Current config version */
export const CURRENT_CONFIG_VERSION = 1;

// =============================================================================
// Sub-schemas
// =============================================================================

/**
 * Idle monitoring configuration
 * Controls when the bot checks for idle users and the threshold for considering someone idle
 */
const IdleConfigSchema = z
  .object({
    /** How often to check for idle users (in minutes) */
    checkIntervalMinutes: z
      .number()
      .int("checkIntervalMinutes must be an integer")
      .positive("checkIntervalMinutes must be positive")
      .default(10),
    /** How long until a user is considered idle (in minutes) */
    thresholdMinutes: z
      .number()
      .int("thresholdMinutes must be an integer")
      .positive("thresholdMinutes must be positive")
      .default(30),
  })
  .default({ checkIntervalMinutes: 10, thresholdMinutes: 30 });

/**
 * Skills configuration
 * Controls which skills are disabled
 */
const SkillsConfigSchema = z
  .object({
    /** List of disabled skill names */
    disabled: z.array(z.string()).default([]),
  })
  .default({ disabled: [] });

/**
 * Typing indicator configuration
 * Controls when Discord typing indicators are shown
 */
const TypingConfigSchema = z
  .object({
    /** Show typing indicator during SDK processing (before response delivery) */
    showDuringProcessing: z.boolean().default(true),
  })
  .default({ showDuringProcessing: true });

// =============================================================================
// Main Config Schema
// =============================================================================

/**
 * Complete runtime configuration schema
 * Validates the entire config structure with strict type checking
 */
export const RuntimeConfigSchema = z.object({
  /** Config version for migration support */
  version: z
    .number()
    .int("version must be an integer")
    .positive("version must be positive")
    .default(CURRENT_CONFIG_VERSION),
  /** Idle monitoring settings */
  idle: IdleConfigSchema,
  /** Skills management settings */
  skills: SkillsConfigSchema,
  /** Typing indicator settings */
  typing: TypingConfigSchema,
  /** Keywords to monitor/respond to */
  keywords: z.array(z.string()).default([]),
});

// =============================================================================
// Types
// =============================================================================

/** Complete runtime configuration type */
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

// =============================================================================
// Validation Utilities
// =============================================================================

/**
 * Validates file size against the maximum allowed
 * @param sizeBytes - Size of the file in bytes
 * @returns true if within limit
 * @throws Error if file exceeds size limit
 */
export function validateFileSize(sizeBytes: number): boolean {
  if (sizeBytes > MAX_CONFIG_FILE_SIZE) {
    throw new Error(
      `Config file exceeds maximum size of ${MAX_CONFIG_FILE_SIZE} bytes (${sizeBytes} bytes provided)`
    );
  }
  return true;
}

/**
 * Parses and validates a config object
 * Returns a fully validated config with defaults applied for missing fields
 * @param data - Raw config data to validate
 * @returns Validated RuntimeConfig
 * @throws ZodError if validation fails
 */
export function parseConfig(data: unknown): RuntimeConfig {
  return RuntimeConfigSchema.parse(data);
}


/**
 * Gets the default config with all defaults applied
 * @returns A complete RuntimeConfig with default values
 */
export function getDefaultConfig(): RuntimeConfig {
  return RuntimeConfigSchema.parse({});
}

