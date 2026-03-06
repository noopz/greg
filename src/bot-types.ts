/**
 * Bot Types & Shared Utilities
 *
 * Leaf module with zero inward dependencies on bot.ts, idle.ts, or custom-tools.ts.
 * Houses the BotConfig type and dmCreator utility that multiple modules need,
 * breaking the bot ↔ idle ↔ custom-tools cycle.
 */

import { Client } from "discord.js-selfbot-v13";
import type { ChannelId, UserId } from "./agent-types";

// ============================================================================
// Types
// ============================================================================

export interface BotConfig {
  creatorId: UserId;
  channelIds: Set<ChannelId>;
}

/** Alias for backward compatibility */
export type Config = BotConfig;

// ============================================================================
// Utilities
// ============================================================================

/** Send a DM to the bot creator */
export async function dmCreator(
  client: Client,
  creatorId: UserId,
  content: string
): Promise<void> {
  const creator = await client.users.fetch(creatorId);
  await creator.send(content);
}
