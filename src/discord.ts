/**
 * Discord Client Shim — Dual Selfbot/Bot Support
 *
 * Config-driven toggle: DISCORD_CLIENT_MODE=selfbot|bot (default: selfbot)
 * At runtime, loads the correct package. All types are selfbot-shaped so the
 * rest of the codebase sees consistent types regardless of mode.
 *
 * The ~8 behavioral incompatibilities between selfbot v13 and discord.js v14
 * are handled by helper functions exported from this file.
 */

import { log, warn } from "./log";

// Re-export all types from selfbot (the primary type source).
// Consumers use `import type { ... } from "./discord"`.
export type {
  Client,
  Message,
  Typing,
  MessageReaction,
  User,
  TextChannel,
  TextBasedChannel,
} from "discord.js-selfbot-v13";

// ============================================================================
// Mode Detection
// ============================================================================

const mode = process.env.DISCORD_CLIENT_MODE ?? "selfbot";
export const isSelfbot = mode === "selfbot";

// ============================================================================
// Runtime Import
// ============================================================================

// Load the correct package at runtime, cast to selfbot types for consistency.
// The `as any` is confined to this single file.
const discord: typeof import("discord.js-selfbot-v13") = isSelfbot
  ? await import("discord.js-selfbot-v13")
  : (await import("discord.js")) as any;

// No runtime re-exports of Client/Message needed — createClient() is the only
// constructor, and all consuming files use `import type`.

log("DISCORD", `Client mode: ${mode}`);

// ============================================================================
// Helper: createClient()
// ============================================================================

/**
 * Create a Discord client configured for the current mode.
 * Selfbot: no options needed. Bot: requires intents + partials.
 */
export function createClient(): InstanceType<typeof discord.Client> {
  if (isSelfbot) {
    return new discord.Client();
  }

  // Bot mode: configure intents and partials
  const { GatewayIntentBits, Partials } = discord as any;

  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,        // PRIVILEGED — must enable in portal
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.DirectMessageTyping,
  ];

  const partials = [
    Partials.Message,
    Partials.Reaction,
    Partials.Channel,
  ];

  // Validate intents resolved correctly (typos silently become undefined with `as any`)
  const resolvedIntents = intents.filter((i: unknown) => i !== undefined);
  if (resolvedIntents.length !== intents.length) {
    warn("DISCORD", `Some intents resolved to undefined — check for typos`);
  }
  log("DISCORD", `Bot mode: ${resolvedIntents.length} intents, ${partials.length} partials`);

  return new discord.Client({
    intents: resolvedIntents,
    partials,
  } as any);
}

// ============================================================================
// Helper: Channel Type Detection
// ============================================================================

// discord.js v14 uses numeric ChannelType enum; selfbot uses strings.
// These helpers abstract the difference.

/** Check if a channel is a DM (1:1 direct message) */
export function isChannelDM(channel: { type: string | number }): boolean {
  return channel.type === "DM" || channel.type === 1;
}

/** Check if a channel is a Group DM */
export function isChannelGroupDM(channel: { type: string | number }): boolean {
  return channel.type === "GROUP_DM" || channel.type === 3;
}

/** Check if a channel is a guild text channel */
export function isChannelGuildText(channel: { type: string | number }): boolean {
  return channel.type === "GUILD_TEXT" || channel.type === 0;
}

/** Get a human-readable label for a channel type */
export function getChannelTypeLabel(channel: { type: string | number }): string {
  if (isSelfbot) {
    const selfbotMap: Record<string, string> = {
      DM: "DM",
      GROUP_DM: "Group DM",
      GUILD_TEXT: "Guild Text",
      GUILD_VOICE: "Guild Voice",
      GUILD_CATEGORY: "Guild Category",
      GUILD_NEWS: "Guild News",
      GUILD_STORE: "Guild Store",
      GUILD_NEWS_THREAD: "Guild News Thread",
      GUILD_PUBLIC_THREAD: "Guild Public Thread",
      GUILD_PRIVATE_THREAD: "Guild Private Thread",
      GUILD_STAGE_VOICE: "Guild Stage Voice",
    };
    return selfbotMap[channel.type as string] || "Unknown";
  }

  // discord.js v14: numeric ChannelType enum
  const v14Map: Record<number, string> = {
    0: "Guild Text",
    1: "DM",
    2: "Guild Voice",
    3: "Group DM",
    4: "Guild Category",
    5: "Guild News",
    10: "Guild News Thread",
    11: "Guild Public Thread",
    12: "Guild Private Thread",
    13: "Guild Stage Voice",
  };
  return v14Map[channel.type as number] || "Unknown";
}

// ============================================================================
// Helper: Group DM Recipients
// ============================================================================

/**
 * Get recipients from a group DM channel.
 * Selfbot: channel.recipients is a Collection. Bot: group DMs aren't accessible
 * to bots (they use guild channels instead), so this returns an empty array.
 */
export function getGroupDmRecipients(
  channel: { type: string | number; recipients?: any }
): Array<{ id: string; username: string }> {
  if (!isChannelGroupDM(channel)) return [];
  if (!("recipients" in channel) || !channel.recipients) return [];

  // Selfbot: recipients is a Collection with .map()
  if (typeof channel.recipients.map === "function") {
    return channel.recipients.map((user: any) => ({
      id: user.id,
      username: user.username,
    }));
  }

  return [];
}

// ============================================================================
// Helper: MessageFlags (Suppress Embeds)
// ============================================================================

/**
 * Get the flag value for suppressing embeds.
 * Selfbot: MessageFlags.FLAGS.SUPPRESS_EMBEDS (bigint or number).
 * Bot v14: MessageFlags.SuppressEmbeds (bitfield).
 */
export function getSuppressEmbedsFlag(): number {
  if (isSelfbot) {
    const { MessageFlags } = discord as any;
    return MessageFlags?.FLAGS?.SUPPRESS_EMBEDS ?? 4;
  }
  const { MessageFlags } = discord as any;
  return MessageFlags?.SuppressEmbeds ?? 4;
}

// ============================================================================
// Helper: Presence (Graceful Shutdown)
// ============================================================================

/**
 * Set the client to appear offline on shutdown.
 * Selfbot: setPresence({ status: "invisible" }).
 * Bot: can't go invisible — client.destroy() handles disconnection.
 */
export function setOfflinePresence(client: InstanceType<typeof discord.Client>): void {
  if (!client.user) return;
  if (isSelfbot) {
    client.user.setPresence({ status: "invisible" });
  }
  // Bot mode: no-op. client.destroy() handles disconnection.
}
