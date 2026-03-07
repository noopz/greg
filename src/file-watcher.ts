/**
 * File Watcher Factory
 *
 * Generic factory for creating file watchers that detect changes and send notifications.
 * Used by the audit system to watch skills, agents, relationships, impressions, and patterns.
 */

import { Client } from "discord.js-selfbot-v13";
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { dmCreator } from "./bot-types";
import type { UserId } from "./agent-types";
import { log, error } from "./log";

// ============================================================================
// Types
// ============================================================================

export interface WatchConfig {
  /** Directory to watch */
  directory: string;
  /** Filter function for filenames (return true to process) */
  fileFilter: (filename: string) => boolean;
  /** Human-readable entity name for logging (e.g., "skill", "agent") */
  entityName: string;
  /** Whether to scan subdirectories for a specific file (e.g., skills have SKILL.md inside dirs) */
  isDirectoryBased?: boolean;
  /** For directory-based watchers, the filename to look for inside each subdirectory */
  targetFilename?: string;
  /** Whether to use recursive watch (needed for directory-based watchers) */
  recursive?: boolean;
  /** Handle a file change. Return a message string to send, or null to skip. */
  handleChange: (params: ChangeParams) => Promise<string | null>;
}

export interface ChangeParams {
  fullPath: string;
  filename: string;
  content: string;
  oldContent: string;
  isNew: boolean;
}

interface WatcherState {
  watcher: FSWatcher;
  fileContents: Map<string, string>;
}

// ============================================================================
// Shared State
// ============================================================================

// Track recently processed files to avoid duplicate notifications (shared across all watchers)
const recentlyProcessed: Set<string> = new Set();
const DEBOUNCE_MS = 2000;

// All active watchers for cleanup
const activeWatchers: WatcherState[] = [];

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a file watcher with the given configuration.
 * Returns the FSWatcher and content map for cleanup.
 */
export async function createFileWatcher(
  client: Client,
  creatorId: UserId,
  config: WatchConfig
): Promise<WatcherState> {
  const fileContents = new Map<string, string>();

  // Ensure directory exists
  await fs.mkdir(config.directory, { recursive: true });

  // Load initial content
  if (config.isDirectoryBased && config.targetFilename) {
    // Scan subdirectories for target file (e.g., skills/*/SKILL.md)
    try {
      const entries = await fs.readdir(config.directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const filePath = path.join(config.directory, entry.name, config.targetFilename);
          try {
            const content = await fs.readFile(filePath, "utf-8");
            fileContents.set(filePath, content);
          } catch {
            // File doesn't exist yet
          }
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
  } else {
    // Scan files directly in the directory
    try {
      const files = await fs.readdir(config.directory);
      for (const file of files) {
        if (config.fileFilter(file)) {
          const filePath = path.join(config.directory, file);
          try {
            const content = await fs.readFile(filePath, "utf-8");
            fileContents.set(filePath, content);
          } catch {
            // File doesn't exist
          }
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
  }

  log("AUDIT", `Watching ${config.entityName} directory: ${config.directory}`);

  const watcher = watch(
    config.directory,
    { recursive: config.recursive },
    async (_event, filename) => {
      if (!filename || !config.fileFilter(filename)) {
        return;
      }

      const fullPath = path.join(config.directory, filename);
      const cacheKey = `${config.entityName}:${fullPath}`;

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

        const content = await fs.readFile(fullPath, "utf-8");
        const oldContent = fileContents.get(fullPath) || "";
        const isNew = !oldContent;

        // Update cached content
        fileContents.set(fullPath, content);

        const message = await config.handleChange({
          fullPath,
          filename,
          content,
          oldContent,
          isNew,
        });

        if (message) {
          await dmCreator(client, creatorId, message);
        }
      } catch (err) {
        error("AUDIT", `Error processing ${config.entityName} file ${filename}`, err);
      }
    }
  );

  const state = { watcher, fileContents };
  activeWatchers.push(state);
  return state;
}

/**
 * Close all active watchers and clear state.
 */
export function closeAllWatchers(): void {
  for (const state of activeWatchers) {
    state.watcher.close();
    state.fileContents.clear();
  }
  activeWatchers.length = 0;
  recentlyProcessed.clear();
}
