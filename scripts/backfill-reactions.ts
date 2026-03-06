/**
 * Backfill reaction-feedback.jsonl entries into transcript files.
 *
 * Reads all reactions, maps each to the correct transcript session by timestamp,
 * and appends a [Reaction] system entry in the same format as the live handler.
 *
 * Usage: bun run scripts/backfill-reactions.ts [--dry-run]
 */

import fs from "node:fs/promises";
import path from "node:path";

const AGENT_DATA_DIR = path.join(process.cwd(), "agent-data");
const TRANSCRIPTS_DIR = path.join(AGENT_DATA_DIR, "transcripts");
const REACTION_FILE = path.join(AGENT_DATA_DIR, "reaction-feedback.jsonl");

interface ReactionEntry {
  emoji: string;
  user: string;
  userId: string;
  messageId: string;
  channelId: string;
  isGif: boolean;
  messagePreview: string;
  when: string; // ISO timestamp
}

interface TranscriptRange {
  sessionId: string;
  filePath: string;
  startTs: number;
  endTs: number;
}

const dryRun = process.argv.includes("--dry-run");

async function loadTranscriptRanges(): Promise<TranscriptRange[]> {
  const files = await fs.readdir(TRANSCRIPTS_DIR);
  const ranges: TranscriptRange[] = [];

  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const filePath = path.join(TRANSCRIPTS_DIR, file);
    const sessionId = file.replace(".jsonl", "");

    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.length === 0) continue;

    try {
      const first = JSON.parse(lines[0]);
      const last = JSON.parse(lines[lines.length - 1]);
      ranges.push({
        sessionId,
        filePath,
        startTs: first.timestamp,
        endTs: last.timestamp,
      });
    } catch {
      console.warn(`Skipping malformed transcript: ${file}`);
    }
  }

  // Sort by start timestamp
  ranges.sort((a, b) => a.startTs - b.startTs);
  return ranges;
}

function findTranscript(ranges: TranscriptRange[], reactionTs: number): TranscriptRange | null {
  // Find the session that was active at reactionTs.
  // A reaction belongs to the latest session that started before or at the reaction time.
  let best: TranscriptRange | null = null;
  for (const range of ranges) {
    if (range.startTs <= reactionTs) {
      best = range;
    } else {
      break; // ranges are sorted, no point continuing
    }
  }
  return best;
}

async function checkAlreadyBackfilled(filePath: string, messageId: string, emoji: string, user: string): Promise<boolean> {
  // Check if this exact reaction is already in the transcript
  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.trim().split("\n");
  for (const line of lines) {
    if (!line.includes("[Reaction]")) continue;
    try {
      const entry = JSON.parse(line);
      if (
        entry.metadata?.messageId === messageId &&
        entry.metadata?.emoji === emoji &&
        entry.metadata?.user === user
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

async function main() {
  console.log(`${dryRun ? "[DRY RUN] " : ""}Backfilling reactions into transcripts...\n`);

  // Load reactions
  const reactionContent = await fs.readFile(REACTION_FILE, "utf-8");
  const reactions: ReactionEntry[] = reactionContent
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));

  console.log(`Found ${reactions.length} reactions in reaction-feedback.jsonl`);

  // Load transcript ranges
  const ranges = await loadTranscriptRanges();
  console.log(`Found ${ranges.length} transcript files\n`);

  let appended = 0;
  let skipped = 0;
  let noSession = 0;
  let alreadyExists = 0;

  // Group appends by file to batch them
  const appendsByFile = new Map<string, string[]>();

  for (const reaction of reactions) {
    const reactionTs = new Date(reaction.when).getTime();
    const transcript = findTranscript(ranges, reactionTs);

    if (!transcript) {
      console.warn(`No transcript found for reaction at ${reaction.when} (${reaction.emoji} by ${reaction.user})`);
      noSession++;
      continue;
    }

    // Check for duplicates (from live handler already capturing this reaction)
    const isDuplicate = await checkAlreadyBackfilled(
      transcript.filePath,
      reaction.messageId,
      reaction.emoji,
      reaction.user,
    );

    if (isDuplicate) {
      alreadyExists++;
      continue;
    }

    // Build transcript entry in the same format as the live handler
    const preview = reaction.messagePreview.substring(0, 100);
    const entry = {
      type: "system",
      content: `[Reaction] ${reaction.user} reacted ${reaction.emoji} to your message: "${preview}"${reaction.isGif ? " (GIF)" : ""}`,
      timestamp: reactionTs,
      metadata: {
        channelId: reaction.channelId,
        emoji: reaction.emoji,
        user: reaction.user,
        messageId: reaction.messageId,
        isGif: reaction.isGif,
      },
    };

    const line = JSON.stringify(entry) + "\n";

    if (!appendsByFile.has(transcript.filePath)) {
      appendsByFile.set(transcript.filePath, []);
    }
    appendsByFile.get(transcript.filePath)!.push(line);
    appended++;
  }

  // Write all appends
  if (!dryRun) {
    for (const [filePath, lines] of appendsByFile) {
      await fs.appendFile(filePath, lines.join(""), "utf-8");
    }
  }

  // Summary
  const filesModified = appendsByFile.size;
  console.log(`\nResults:`);
  console.log(`  Appended: ${appended} reaction entries to ${filesModified} transcript files`);
  console.log(`  Already existed: ${alreadyExists} (skipped duplicates)`);
  console.log(`  No session found: ${noSession}`);
  console.log(`  Skipped (other): ${skipped}`);

  if (dryRun) {
    console.log(`\n[DRY RUN] No files were modified. Run without --dry-run to apply.`);
    for (const [filePath, lines] of appendsByFile) {
      console.log(`  Would append ${lines.length} entries to ${path.basename(filePath)}`);
    }
  }
}

main().catch(err => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
