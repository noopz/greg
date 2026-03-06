/**
 * Backfill transcripts from Discord channel history.
 *
 * Fetches the last N days of messages from a Discord channel and writes them
 * as JSONL transcript files that the bot's FTS index can ingest.
 *
 * Usage: DISCORD_TOKEN=... CHANNEL_ID=... DAYS=21 bun run scripts/backfill-transcripts.ts
 */

import fs from "node:fs";
import path from "node:path";

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID || process.env.GROUP_DM_CHANNEL_ID;
const DAYS = parseInt(process.env.DAYS || "21", 10);
const BOT_USER_ID = process.env.BOT_USER_ID; // optional: to tag bot messages as "assistant"

if (!TOKEN || !CHANNEL_ID) {
  console.error("Required: DISCORD_TOKEN, CHANNEL_ID (or GROUP_DM_CHANNEL_ID)");
  process.exit(1);
}

const AGENT_DATA_DIR = path.join(process.cwd(), "agent-data");
const TRANSCRIPTS_DIR = path.join(AGENT_DATA_DIR, "transcripts");
fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

interface DiscordMessage {
  id: string;
  author: { id: string; username: string; global_name?: string };
  content: string;
  timestamp: string;
  attachments: Array<{ url: string; content_type?: string }>;
  embeds: Array<unknown>;
  type: number; // 0 = default, 19 = reply, etc.
  referenced_message?: DiscordMessage | null;
}

interface TranscriptEntry {
  type: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

async function fetchMessages(beforeId?: string): Promise<DiscordMessage[]> {
  const params = new URLSearchParams({ limit: "100" });
  if (beforeId) params.set("before", beforeId);

  const res = await fetch(
    `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages?${params}`,
    { headers: { Authorization: TOKEN! } }
  );

  if (!res.ok) {
    console.error(`Discord API error: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  return res.json() as Promise<DiscordMessage[]>;
}

async function fetchAllMessages(days: number): Promise<DiscordMessage[]> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const allMessages: DiscordMessage[] = [];
  let beforeId: string | undefined;
  let page = 0;

  while (true) {
    const batch = await fetchMessages(beforeId);
    if (batch.length === 0) break;

    page++;
    const oldest = new Date(batch[batch.length - 1].timestamp).getTime();
    console.log(`  Page ${page}: ${batch.length} messages (oldest: ${batch[batch.length - 1].timestamp})`);

    for (const msg of batch) {
      const ts = new Date(msg.timestamp).getTime();
      if (ts < cutoff) {
        // Add remaining messages from this batch that are in range
        allMessages.push(...batch.filter(m => new Date(m.timestamp).getTime() >= cutoff));
        console.log(`  Reached ${days}-day cutoff`);
        return allMessages.sort((a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
      }
    }

    allMessages.push(...batch);
    beforeId = batch[batch.length - 1].id;

    // Rate limit: 50 requests per second, be conservative
    await new Promise(r => setTimeout(r, 200));
  }

  return allMessages.sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

function formatUserEntry(msg: DiscordMessage): string {
  // Match the format that extractUserContent() in transcript-index.ts expects
  const displayName = msg.author.global_name || msg.author.username;
  let content = msg.content;

  // Add attachment info
  if (msg.attachments.length > 0) {
    const attachmentInfo = msg.attachments
      .map(a => `[Attachment: ${a.url}]`)
      .join(" ");
    content = content ? `${content} ${attachmentInfo}` : attachmentInfo;
  }

  // Handle replies
  let replyContext = "";
  if (msg.referenced_message) {
    const refAuthor = msg.referenced_message.author.global_name || msg.referenced_message.author.username;
    const refPreview = msg.referenced_message.content.slice(0, 100);
    replyContext = `\nReplying to ${refAuthor}: "${refPreview}"`;
  }

  return `=== Channel Info ===
Channel ID: ${CHANNEL_ID}
${replyContext}
=== Current Message ===
Author: ${displayName} (${msg.author.id})
Content: ${content}
Message ID: ${msg.id}`;
}

// Group messages into "sessions" by day
function groupByDay(messages: DiscordMessage[]): Map<string, DiscordMessage[]> {
  const groups = new Map<string, DiscordMessage[]>();
  for (const msg of messages) {
    const date = new Date(msg.timestamp).toISOString().split("T")[0];
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date)!.push(msg);
  }
  return groups;
}

async function main() {
  console.log(`Fetching last ${DAYS} days of messages from channel ${CHANNEL_ID}...`);
  const messages = await fetchAllMessages(DAYS);
  console.log(`\nFetched ${messages.length} messages total`);

  if (messages.length === 0) {
    console.log("No messages found");
    return;
  }

  // Deduplicate (fetchAllMessages may include some overlap)
  const seen = new Set<string>();
  const unique = messages.filter(m => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  console.log(`${unique.length} unique messages`);

  // Group by day and write transcript files
  const byDay = groupByDay(unique);
  let totalEntries = 0;

  for (const [date, dayMessages] of byDay) {
    const sessionId = `backfill-${date}`;
    const transcriptPath = path.join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
    const entries: string[] = [];

    for (const msg of dayMessages) {
      // Skip empty messages (join notifications, etc.)
      if (!msg.content && msg.attachments.length === 0) continue;
      // Skip system messages (type !== 0 and type !== 19 for replies)
      if (msg.type !== 0 && msg.type !== 19) continue;

      const isBotMessage = BOT_USER_ID && msg.author.id === BOT_USER_ID;

      const entry: TranscriptEntry = isBotMessage
        ? {
            type: "assistant",
            content: msg.content,
            timestamp: new Date(msg.timestamp).getTime(),
            metadata: { channelId: CHANNEL_ID, backfilled: true },
          }
        : {
            type: "user",
            content: formatUserEntry(msg),
            timestamp: new Date(msg.timestamp).getTime(),
            metadata: { channelId: CHANNEL_ID, backfilled: true },
          };

      entries.push(JSON.stringify(entry));
    }

    if (entries.length > 0) {
      fs.writeFileSync(transcriptPath, entries.join("\n") + "\n");
      totalEntries += entries.length;
      console.log(`  ${date}: ${entries.length} entries -> ${sessionId}.jsonl`);
    }
  }

  console.log(`\nWrote ${totalEntries} transcript entries across ${byDay.size} days`);
  console.log(`Transcripts saved to: ${TRANSCRIPTS_DIR}/`);
  console.log(`\nThe FTS index will auto-rebuild on next bot startup.`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
