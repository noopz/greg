/**
 * Active Participant Tracking
 *
 * Per-channel tracking of who's actively chatting. Grows as people talk
 * or get mentioned, resets after inactivity. Used to avoid loading
 * relationships/impressions for all ~9 group members when only 1-2 are chatting.
 */

import type { ChannelId, UserId } from "./agent-types";
import { userId } from "./agent-types";
import { log } from "./log";
import { AGENT_DATA_DIR } from "./paths";
import { getFileMtime } from "./context-cache";
import path from "node:path";
import fs from "node:fs";

interface ChannelParticipants {
  active: Set<UserId>;
  knownNames: Map<string, UserId>; // lowercase name/alias -> userId
  /** Cached compiled regex for all knownNames. Invalidated when names change. */
  namePattern: RegExp | null;
  lastActivity: number;
}

const channels = new Map<ChannelId, ChannelParticipants>();
const RESET_TIMEOUT_MS = 15 * 60 * 1000;

const DISCORD_MENTION_RE = /<@!?(\d+)>/g;

function getOrCreate(channelId: ChannelId): ChannelParticipants {
  let entry = channels.get(channelId);
  if (!entry) {
    entry = { active: new Set(), knownNames: new Map(), namePattern: null, lastActivity: Date.now() };
    channels.set(channelId, entry);
  }
  return entry;
}

function lazyReset(entry: ChannelParticipants): void {
  if (Date.now() - entry.lastActivity > RESET_TIMEOUT_MS) {
    entry.active.clear();
    entry.lastActivity = Date.now();
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rebuild the combined name-matching regex from all knownNames. */
function rebuildNamePattern(entry: ChannelParticipants): void {
  if (entry.knownNames.size === 0) {
    entry.namePattern = null;
    return;
  }
  const alternatives = [...entry.knownNames.keys()].map(escapeRegex).join("|");
  entry.namePattern = new RegExp(`\\b(${alternatives})\\b`, "g");
}

function addName(entry: ChannelParticipants, name: string, uid: UserId): void {
  const lower = name.toLowerCase();
  if (entry.knownNames.get(lower) === uid) return; // already registered
  entry.knownNames.set(lower, uid);
  entry.namePattern = null; // invalidate cached pattern
}

/**
 * Register a username (and word-split parts 4+ chars) into the lookup map.
 * Short-circuits if the username is already registered for this user.
 */
export function registerKnownUser(channelId: ChannelId, username: string, uid: UserId): void {
  const entry = getOrCreate(channelId);
  const lower = username.toLowerCase();

  // Short-circuit: already registered this exact username for this user
  if (entry.knownNames.get(lower) === uid) return;

  addName(entry, lower, uid);

  // Word-split: register individual words of 4+ characters
  const words = lower
    .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase -> spaces
    .split(/[\s_\-]+/)
    .filter(w => w.length >= 4);
  for (const word of words) {
    if (word !== lower) {
      addName(entry, word, uid);
    }
  }
}

/**
 * Add a user to the active set for a channel.
 */
export function trackParticipant(channelId: ChannelId, uid: UserId): void {
  const entry = getOrCreate(channelId);
  lazyReset(entry);
  entry.active.add(uid);
  entry.lastActivity = Date.now();
}

/**
 * Scan message content for known names and Discord <@id> mentions.
 * Adds matched users to the active set.
 */
export function detectReferences(channelId: ChannelId, messageContent: string): void {
  const entry = getOrCreate(channelId);
  lazyReset(entry);

  let found = false;

  // Discord <@userId> mentions
  DISCORD_MENTION_RE.lastIndex = 0;
  let match;
  while ((match = DISCORD_MENTION_RE.exec(messageContent)) !== null) {
    entry.active.add(userId(match[1]));
    found = true;
  }

  // Known name matching via single combined regex
  if (entry.knownNames.size > 0) {
    if (!entry.namePattern) rebuildNamePattern(entry);
    if (entry.namePattern) {
      const lowerContent = messageContent.toLowerCase();
      entry.namePattern.lastIndex = 0;
      while ((match = entry.namePattern.exec(lowerContent)) !== null) {
        const uid = entry.knownNames.get(match[1]);
        if (uid) {
          entry.active.add(uid);
          found = true;
        }
      }
    }
  }

  if (found) entry.lastActivity = Date.now();
}

/**
 * Get the current active participant set for a channel.
 * Lazy-resets if idle > 15 min.
 */
export function getActiveParticipants(channelId: ChannelId): UserId[] {
  const entry = channels.get(channelId);
  if (!entry) return [];
  lazyReset(entry);
  return [...entry.active];
}

// ============================================================================
// Alias Loading (hot-reload from agent-data/user-aliases.json)
// ============================================================================

const ALIASES_PATH = path.join(AGENT_DATA_DIR, "user-aliases.json");
let lastAliasesMtime: number | null = null;
/** Cached parsed aliases for injection into newly-created channels. */
let cachedAliases: Record<string, string[]> = {};

/**
 * Load aliases from agent-data/user-aliases.json and register them
 * into knownNames for all channels. Watches mtime for hot-reload.
 * Also caches aliases so new channels get them via getOrCreateWithAliases.
 *
 * Format: { "userId": ["alias1", "alias2"], ... }
 */
export function loadAliases(): void {
  const mtime = getFileMtime(ALIASES_PATH);
  if (mtime === lastAliasesMtime) return; // No change
  lastAliasesMtime = mtime;

  let data: Record<string, string[]>;
  try {
    const raw = fs.readFileSync(ALIASES_PATH, "utf-8");
    data = JSON.parse(raw);
  } catch {
    return; // File doesn't exist or invalid JSON
  }

  cachedAliases = data;
  injectAliases(data);

  const aliasCount = Object.values(data).flat().length;
  if (aliasCount > 0) {
    log("PARTICIPANTS", `Loaded ${aliasCount} aliases for ${Object.keys(data).length} users`);
  }
}

function injectAliases(data: Record<string, string[]>): void {
  for (const [uid, aliases] of Object.entries(data)) {
    if (!Array.isArray(aliases)) continue;
    const typedUid = userId(uid);
    for (const [, entry] of channels) {
      for (const alias of aliases) {
        if (typeof alias === "string" && alias.length > 0) {
          addName(entry, alias, typedUid);
        }
      }
    }
  }
}
