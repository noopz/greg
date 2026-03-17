/**
 * Idle Preconditions
 *
 * Gathers cheap file-system signals before idle behavior selection.
 * Gives the Haiku selector visibility into system state so it can make
 * informed choices about which skills to run.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { AGENT_DATA_DIR } from "./paths";

// ============================================================================
// Types
// ============================================================================

export interface PreconditionData {
  /** Multi-line text block for the selector prompt */
  globalSummary: string;
}

// ============================================================================
// Helpers
// ============================================================================

function timeAgo(mtime: Date): string {
  const ago = Date.now() - mtime.getTime();
  const hours = Math.floor(ago / 3600000);
  const mins = Math.floor((ago % 3600000) / 60000);
  if (hours > 0) return `${hours}h ago`;
  return `${mins}m ago`;
}

async function countMatches(filePath: string, pattern: RegExp): Promise<number> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return (content.match(pattern) || []).length;
  } catch {
    return 0;
  }
}

// ============================================================================
// Main
// ============================================================================

export async function gatherPreconditions(): Promise<PreconditionData> {
  const lines: string[] = [];

  // hypotheses.md: count untested/testing entries
  try {
    const hypoPath = path.join(AGENT_DATA_DIR, "hypotheses.md");
    const content = await fs.readFile(hypoPath, "utf-8");
    // Hypotheses are grouped under ## Untested, ## Testing, ## Resolved headers
    // Count ### Hypothesis entries in each section
    const sections = content.split(/^## /m);
    let untested = 0;
    let testing = 0;
    for (const section of sections) {
      const count = (section.match(/^### Hypothesis/gm) || []).length;
      if (section.startsWith("Untested")) untested = count;
      else if (section.startsWith("Testing")) testing = count;
    }
    const stat = await fs.stat(hypoPath);
    lines.push(`hypotheses.md: ${untested} untested, ${testing} testing (edited ${timeAgo(stat.mtime)})`);
  } catch {
    // File doesn't exist
  }

  // learned-patterns.md: last modified time
  try {
    const lpPath = path.join(AGENT_DATA_DIR, "learned-patterns.md");
    const stat = await fs.stat(lpPath);
    lines.push(`learned-patterns.md: last edited ${timeAgo(stat.mtime)}`);
  } catch {
    // File doesn't exist
  }

  // impressions/: count per-user entries, flag users with 8+
  try {
    const impDir = path.join(AGENT_DATA_DIR, "impressions");
    const files = await fs.readdir(impDir);
    const jsonFiles = files.filter(f => f.endsWith(".json"));
    let totalEntries = 0;
    const needsConsolidation: string[] = [];

    for (const file of jsonFiles) {
      try {
        const content = await fs.readFile(path.join(impDir, file), "utf-8");
        const data = JSON.parse(content);
        const entries = Array.isArray(data) ? data.length : (data.impressions ? data.impressions.length : 0);
        totalEntries += entries;
        if (entries >= 8) {
          const userName = file.replace(".json", "");
          needsConsolidation.push(`${userName}: ${entries}`);
        }
      } catch {
        // Skip malformed files
      }
    }

    let impLine = `impressions: ${jsonFiles.length} users, ${totalEntries} total entries`;
    if (needsConsolidation.length > 0) {
      impLine += `\n  users needing consolidation (8+): ${needsConsolidation.join(", ")}`;
    }
    lines.push(impLine);
  } catch {
    // Directory doesn't exist
  }

  // memories/: latest file date
  try {
    const memDir = path.join(AGENT_DATA_DIR, "memories");
    const files = await fs.readdir(memDir);
    const mdFiles = files.filter(f => f.endsWith(".md")).sort();
    if (mdFiles.length > 0) {
      lines.push(`latest memory: ${mdFiles[mdFiles.length - 1]}`);
    }
  } catch {
    // Directory doesn't exist
  }

  // transcripts/: latest file, total count
  try {
    const txDir = path.join(AGENT_DATA_DIR, "transcripts");
    const files = await fs.readdir(txDir);
    const jsonlFiles = files.filter(f => f.endsWith(".jsonl")).sort();
    if (jsonlFiles.length > 0) {
      lines.push(`transcripts: ${jsonlFiles.length} files, latest: ${jsonlFiles[jsonlFiles.length - 1]}`);
    }
  } catch {
    // Directory doesn't exist
  }

  // reaction-feedback.jsonl: entry count, last modified
  try {
    const rfPath = path.join(AGENT_DATA_DIR, "reaction-feedback.jsonl");
    const stat = await fs.stat(rfPath);
    const entries = await countMatches(rfPath, /\n/g);
    lines.push(`reaction-feedback: ~${entries} entries, last updated ${timeAgo(stat.mtime)}`);
  } catch {
    // File doesn't exist
  }

  return { globalSummary: lines.join("\n") };
}
