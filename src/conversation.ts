// ============================================================================
// Conversation Tracker (Hybrid Model)
// ============================================================================
// Uses dual tracking for natural follow-ups in group chats:
// 1. Per-user tracking: High confidence - Greg was talking to this person
// 2. Channel-wide tracking: Low confidence - immediate reactions from anyone (45s)
//
// Timeouts adapt to chat energy:
// - High energy (rapid-fire): shorter timeout (2.5 min) - messages come fast
// - Low energy (slow 1:1): longer timeout (10 min) - people take breaks
//
// This mirrors how humans track "who am I talking to" vs "is there activity in the room"

import { log } from "./log";
import type { ChannelId, UserId } from "./agent-types";

// Adaptive user timeouts based on chat energy
// Low energy conversations need longer timeouts - people take breaks, type slowly
const USER_TIMEOUT_HIGH_ENERGY_MS = 2.5 * 60 * 1000;  // 2.5 minutes - rapid chat
const USER_TIMEOUT_MEDIUM_ENERGY_MS = 5 * 60 * 1000;  // 5 minutes - normal pace
const USER_TIMEOUT_LOW_ENERGY_MS = 10 * 60 * 1000;    // 10 minutes - slow 1:1

// For cleanup, use the max possible timeout to avoid premature expiration
const USER_TIMEOUT_MAX_MS = USER_TIMEOUT_LOW_ENERGY_MS;

// Channel-wide timeout: catches follow-ups from anyone in the channel
// 90s gives people time to read Greg's response and type a follow-up question
const CHANNEL_TIMEOUT_MS = 90 * 1000; // 90 seconds

// Chat energy tracking window
const ENERGY_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

// Forward declaration - will be set after getChatEnergy is defined
let getUserTimeoutForChannel: (channelId: ChannelId) => number;

// Track who Greg was directly talking to in each channel
// Map of channelId -> Map of userId -> timestamp
// Supports multiple concurrent conversants in group chats
const directConversants = new Map<ChannelId, Map<UserId, number>>();

// Track channel-wide activity (any response)
// Map of channelId -> timestamp
const activeChannels = new Map<ChannelId, number>();

// Track recent message timestamps for energy calculation
// Map of channelId -> array of { timestamp, length, userId }
const recentMessages = new Map<ChannelId, Array<{ timestamp: number; length: number; userId: UserId }>>();

export type ConversationConfidence = "high" | "low" | "none";

/**
 * Record that the bot responded to a specific user in a channel.
 * - Marks that user as the direct conversant (high confidence, long timeout)
 * - Also marks the channel as active (low confidence, short timeout)
 */
export function recordBotResponse(channelId: ChannelId, userId: UserId): void {
  const now = Date.now();

  // Track direct conversant (multiple per channel for group chats)
  let channelConversants = directConversants.get(channelId);
  if (!channelConversants) {
    channelConversants = new Map();
    directConversants.set(channelId, channelConversants);
  }
  channelConversants.set(userId, now);

  // Track channel activity
  activeChannels.set(channelId, now);

  log("CONVO", `Responding to ${userId} in ${channelId} (tracking both)`);
}

/**
 * Record that the bot sent a message to a channel without a specific target user.
 * Used by idle skills (pot-stirrer, daily-share) and send_to_channel MCP tool.
 * Marks the channel as active so follow-up messages get at least "low" confidence
 * instead of being gated as "Cold start, no keyword match."
 */
export function recordBotActivity(channelId: ChannelId): void {
  activeChannels.set(channelId, Date.now());
  log("CONVO", `Bot activity in ${channelId} (channel tracking only)`);
}

/**
 * Check if there's an active conversation and return confidence level.
 * Timeout adapts to chat energy - low energy convos get longer timeouts.
 * - "high": This is the person Greg was directly talking to
 * - "low": Someone else in an active channel (45s window)
 * - "none": No active conversation
 */
export function getConversationConfidence(channelId: ChannelId, userId: UserId): ConversationConfidence {
  const now = Date.now();

  // Check direct conversant first (high confidence)
  const channelConversants = directConversants.get(channelId);
  const directTimestamp = channelConversants?.get(userId);
  if (directTimestamp) {
    const elapsed = now - directTimestamp;
    const timeout = getUserTimeoutForChannel(channelId);
    if (elapsed < timeout) {
      log("CONVO", `High confidence: direct conversant ${userId} (${Math.floor(elapsed / 1000)}s ago, timeout ${Math.floor(timeout / 1000)}s)`);
      return "high";
    }
  }

  // Check channel activity (low confidence)
  const channelTimestamp = activeChannels.get(channelId);
  if (channelTimestamp) {
    const elapsed = now - channelTimestamp;
    if (elapsed < CHANNEL_TIMEOUT_MS) {
      log("CONVO", `Low confidence: channel active (${Math.floor(elapsed / 1000)}s ago), different user`);
      return "low";
    }
  }

  return "none";
}

/**
 * Periodically clean up expired conversations to prevent memory leaks.
 * Uses the maximum possible timeout to avoid premature cleanup.
 */
export function cleanupExpiredConversations(): void {
  const now = Date.now();
  let cleaned = 0;

  // Clean up direct conversants - use max timeout to avoid premature expiration
  // The actual timeout check happens in getConversationConfidence with energy-aware values
  for (const [channelId, channelConversants] of directConversants.entries()) {
    for (const [userId, timestamp] of channelConversants.entries()) {
      if (now - timestamp >= USER_TIMEOUT_MAX_MS) {
        channelConversants.delete(userId);
        cleaned++;
      }
    }
    // Remove empty channel maps
    if (channelConversants.size === 0) {
      directConversants.delete(channelId);
    }
  }

  // Clean up channel activity
  for (const [channelId, timestamp] of activeChannels.entries()) {
    if (now - timestamp >= CHANNEL_TIMEOUT_MS) {
      activeChannels.delete(channelId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    log("CONVO", `Cleaned up ${cleaned} expired tracking entries`);
  }
}

// Run cleanup every 2 minutes (since max timeout is 10 min, no rush)
setInterval(cleanupExpiredConversations, 2 * 60 * 1000);

// ============================================================================
// Chat Energy Tracking
// ============================================================================
// Tracks message frequency and length to determine conversation pace.
// Used to adjust response verbosity - match the energy of the chat.

export type ChatEnergy = "high" | "medium" | "low";

/**
 * Record an incoming message for energy calculation.
 * Call this for every message in the channel (not just ones Greg responds to).
 */
export function recordMessageForEnergy(channelId: ChannelId, userId: UserId, messageLength: number): void {
  const now = Date.now();

  let messages = recentMessages.get(channelId);
  if (!messages) {
    messages = [];
    recentMessages.set(channelId, messages);
  }

  // Add new message
  messages.push({ timestamp: now, length: messageLength, userId });

  // Prune old messages outside the window
  const cutoff = now - ENERGY_WINDOW_MS;
  recentMessages.set(channelId, messages.filter(m => m.timestamp > cutoff));
}

/**
 * Get the current chat energy level for a channel.
 * - "high": >5 messages/min, multiple participants, short messages (rapid-fire banter)
 * - "low": <2 messages/min, single participant, longer messages (deep conversation)
 * - "medium": everything else
 */
export function getChatEnergy(channelId: ChannelId): ChatEnergy {
  const now = Date.now();
  const messages = recentMessages.get(channelId);

  if (!messages || messages.length === 0) {
    return "low"; // No recent activity = low energy
  }

  // Prune old messages
  const cutoff = now - ENERGY_WINDOW_MS;
  const recent = messages.filter(m => m.timestamp > cutoff);

  if (recent.length === 0) {
    return "low";
  }

  // Calculate metrics
  const messagesPerMin = recent.length / (ENERGY_WINDOW_MS / 60000);
  const uniqueUsers = new Set(recent.map(m => m.userId)).size;
  const avgLength = recent.reduce((sum, m) => sum + m.length, 0) / recent.length;

  // High energy: rapid-fire, multiple people, short messages
  if (messagesPerMin > 5 && uniqueUsers >= 2 && avgLength < 100) {
    log("ENERGY", `High energy: ${messagesPerMin.toFixed(1)} msg/min, ${uniqueUsers} users, ${avgLength.toFixed(0)} avg chars`);
    return "high";
  }

  // Low energy: slow, potentially 1:1, longer messages
  if (messagesPerMin < 2 || (uniqueUsers === 1 && avgLength > 150)) {
    log("ENERGY", `Low energy: ${messagesPerMin.toFixed(1)} msg/min, ${uniqueUsers} users, ${avgLength.toFixed(0)} avg chars`);
    return "low";
  }

  log("ENERGY", `Medium energy: ${messagesPerMin.toFixed(1)} msg/min, ${uniqueUsers} users, ${avgLength.toFixed(0)} avg chars`);
  return "medium";
}

// ============================================================================
// Adaptive Timeout Implementation
// ============================================================================

/**
 * Get the user timeout based on current chat energy.
 * Low energy = longer timeout (people take breaks in slow convos)
 * High energy = shorter timeout (messages come fast, no need to wait)
 */
getUserTimeoutForChannel = (channelId: ChannelId): number => {
  const energy = getChatEnergy(channelId);
  switch (energy) {
    case "high":
      return USER_TIMEOUT_HIGH_ENERGY_MS;
    case "medium":
      return USER_TIMEOUT_MEDIUM_ENERGY_MS;
    case "low":
      return USER_TIMEOUT_LOW_ENERGY_MS;
  }
};
