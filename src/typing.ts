import { Message, MessageFlags, TextBasedChannel } from "discord.js-selfbot-v13";
import { log } from "./log";
import type { ChannelId, UserId } from "./agent-types";
import { resolveUser } from "./agent-types";

// ============================================================================
// Typing Tracker
// ============================================================================
// Tracks who is currently typing in each channel to avoid interrupting people

// Discord typing indicators last ~10 seconds, but users often pause briefly
const TYPING_DURATION_MS = 10_000;
const TYPING_CHECK_INTERVAL_MS = 250;

// Map of channelId -> Map of userId -> expiration timestamp
const typingUsers = new Map<ChannelId, Map<UserId, number>>();

// Bot's own user ID (set during init)
let botUserId: UserId | null = null;

/**
 * Initialize the typing tracker with the bot's user ID
 */
export function initTypingTracker(id: UserId): void {
  botUserId = id;
  log("TYPING", `Tracker initialized for bot user ${id}`);
}

/**
 * Record that a user started typing in a channel
 */
export function recordTypingStart(uid: UserId, chId: ChannelId): void {
  // Ignore our own typing
  if (uid === botUserId) return;

  if (!typingUsers.has(chId)) {
    typingUsers.set(chId, new Map());
  }

  const channelTypers = typingUsers.get(chId)!;
  const expiresAt = Date.now() + TYPING_DURATION_MS;
  channelTypers.set(uid, expiresAt);

  log("TYPING", `${resolveUser(uid)} started typing in ${chId}`);
}

/**
 * Clear a user's typing status (e.g., when they send a message)
 */
export function clearTyping(uid: UserId, chId: ChannelId): void {
  const channelTypers = typingUsers.get(chId);
  if (channelTypers) {
    channelTypers.delete(uid);
    log("TYPING", `Cleared typing for ${resolveUser(uid)} in ${chId}`);
  }
}

/**
 * Check if a specific user is currently typing in a channel
 */
export function isUserTyping(uid: UserId, chId: ChannelId): boolean {
  const channelTypers = typingUsers.get(chId);
  if (!channelTypers) return false;

  const expiresAt = channelTypers.get(uid);
  if (!expiresAt) return false;

  const now = Date.now();
  if (expiresAt < now) {
    // Expired, clean up
    channelTypers.delete(uid);
    return false;
  }

  return true;
}

// ============================================================================
// Typing Keepalive (Early Typing Indicator)
// ============================================================================

// ============================================================================
// Typing Callback Factory (Real-Time Typing via Streaming Output)
// ============================================================================

// Discord's typing indicator timeout
const TYPING_INDICATOR_INTERVAL_MS = 8_000;

/**
 * Create a typing callback for streaming output mode.
 * Triggers channel.sendTyping() on first chunk, then rate-limits to every 8s.
 * Returns a callback that the streaming session invokes on each partial text event.
 */
export function createTypingCallback(channel: TextBasedChannel): (chunk: string) => void {
  let lastSentAt = 0;

  return (_chunk: string) => {
    const now = Date.now();
    if (now - lastSentAt >= TYPING_INDICATOR_INTERVAL_MS) {
      lastSentAt = now;
      channel.sendTyping().catch(() => {});
    }
  };
}

// ============================================================================
// Typing Simulation Helpers
// ============================================================================

// Max messages to send at once - prevents wall-of-text that kills conversations
const MAX_MESSAGE_CHUNKS = 3;

// Discord's message character limit
const DISCORD_MAX_CHARS = 2000;

/**
 * Calculate typing delay for a message.
 * Minimal delay — just enough to trigger the typing indicator before sending.
 * The early typing keepalive already shows "Greg is typing..." during SDK processing,
 * so additional simulated typing speed adds no value and just delays the response.
 */
export function calculateTypingDelay(_text: string): number {
  return 200 + Math.floor(Math.random() * 300);
}

const URL_PATTERN = /https?:\/\/\S+/g;
export function countUrls(text: string): number {
  return (text.match(URL_PATTERN) || []).length;
}

/**
 * Enforce Discord's character limit on each chunk.
 * Splits oversized chunks on newline boundaries; hard-splits as last resort.
 */
function enforceCharLimit(chunks: string[]): string[] {
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= DISCORD_MAX_CHARS) {
      result.push(chunk);
      continue;
    }
    // Split oversized chunk on newlines
    const lines = chunk.split("\n");
    let current = "";
    for (const line of lines) {
      if (current.length > 0 && current.length + 1 + line.length > DISCORD_MAX_CHARS) {
        result.push(current);
        current = line;
      } else {
        current = current.length > 0 ? current + "\n" + line : line;
      }
    }
    // Hard-split if a single line exceeds the limit
    while (current.length > DISCORD_MAX_CHARS) {
      result.push(current.slice(0, DISCORD_MAX_CHARS));
      current = current.slice(DISCORD_MAX_CHARS);
    }
    if (current.length > 0) {
      result.push(current);
    }
  }
  return result;
}

/**
 * Split a response into natural message chunks on paragraph boundaries (\n\n).
 * Each chunk becomes a separate Discord message for better readability.
 * Enforces a max chunk limit to prevent wall-of-text spam.
 */
export function splitIntoChunks(response: string, maxChunks: number = MAX_MESSAGE_CHUNKS): string[] {
  // Split on double newlines (paragraphs)
  const chunks = response.split(/\n\n+/).map(c => c.trim()).filter(c => c.length > 0);

  // Single paragraph or very short — send as one message
  if (chunks.length <= 1) {
    return enforceCharLimit([response.trim()]);
  }

  // Merge very short consecutive chunks (less than 50 chars) to avoid spam
  const merged: string[] = [];
  let current = "";

  for (const chunk of chunks) {
    if (current.length === 0) {
      current = chunk;
    } else if (current.length < 50 || chunk.length < 50) {
      // Merge short chunks
      current += "\n" + chunk;
    } else {
      merged.push(current);
      current = chunk;
    }
  }
  if (current.length > 0) {
    merged.push(current);
  }

  // Enforce max chunk limit - combine excess into the last allowed chunk
  if (merged.length > maxChunks) {
    log("SEND", `Response had ${merged.length} chunks, combining to ${maxChunks} max`);
    const limited: string[] = merged.slice(0, maxChunks - 1);
    const remainder = merged.slice(maxChunks - 1).join("\n\n");
    limited.push(remainder);
    return enforceCharLimit(limited);
  }

  return enforceCharLimit(merged);
}

// ============================================================================
// Typing Simulation - Send Response
// ============================================================================

/**
 * Send a response as multiple messages with natural typing delays.
 * If replyToMessage is provided, the first chunk will be sent as a reply.
 */
export async function sendWithTypingSimulation(
  channel: TextBasedChannel,
  response: string,
  replyToMessage?: Message
): Promise<void> {
  const chunks = splitIntoChunks(response);

  log("SEND", `Splitting into ${chunks.length} message(s)`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    const typingDelay = calculateTypingDelay(chunk);

    log("SEND", `Chunk ${i + 1}/${chunks.length}: "${chunk.substring(0, 40)}${chunk.length > 40 ? '...' : ''}" (${typingDelay}ms)`);

    // Show typing indicator
    await channel.sendTyping();

    // Wait for "typing" time
    await new Promise(resolve => setTimeout(resolve, typingDelay));

    // Send the chunk (first chunk as reply if replyToMessage provided)
    // Suppress link previews when chunk contains multiple URLs to reduce clutter
    const suppressEmbeds = countUrls(chunk) > 1;
    const payload = suppressEmbeds ? { content: chunk, flags: MessageFlags.FLAGS.SUPPRESS_EMBEDS } : chunk;

    log("SEND", `>>> CALLING channel.send() for chunk ${i + 1}${suppressEmbeds ? ' (embeds suppressed)' : ''}`);
    let sentMsg;
    if (i === 0 && replyToMessage) {
      try {
        sentMsg = await replyToMessage.reply(payload);
        log("SEND", `<<< message.reply() returned, msg id: ${sentMsg.id}`);
      } catch {
        // Reply can fail (system messages, deleted messages) — fall back to regular send
        log("SEND", `<<< message.reply() failed, falling back to channel.send()`);
        sentMsg = await channel.send(payload);
        log("SEND", `<<< channel.send() returned, msg id: ${sentMsg.id}`);
      }
    } else {
      sentMsg = await channel.send(payload);
      log("SEND", `<<< channel.send() returned, msg id: ${sentMsg.id}`);
    }

    // Pause between messages
    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 500));
    }
  }

  log("SEND", `All ${chunks.length} message(s) sent`);
}
