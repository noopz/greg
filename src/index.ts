import type { Message } from "./discord";
import { createClient, isChannelDM, isChannelGroupDM, setOfflinePresence } from "./discord";
import { handleReady, handleMessage, handleTypingStart, handleReaction, Config } from "./bot";
import { startIdleLoop, stopIdleLoop, IdleConfig } from "./idle";
import { startAuditWatcher, stopAuditWatcher } from "./audit";
import { initTypingTracker } from "./typing";
import { log, error } from "./log";
import { createToolsServer } from "./custom-tools";
import { setToolsServer } from "./agent";
import { initTranscriptIndex, closeTranscriptIndex, setDmChannelId } from "./transcript-index";
import { parseArgs } from "util";
import { BOT_NAME } from "./config/identity";
import { channelId, userId } from "./agent-types";
import { cancelMessage, cancelQueuedMessage } from "./turn-queue";
import { getStreamingSession } from "./agent";
import { getCurrentlyProcessingMessageId, interruptCurrentMessage } from "./bot";
import { initExtensions, stopExtensions } from "./extensions/loader";

// Execution paths:
//   Main: bot.ts (Discord events) → turn-queue.ts (ordering/dedup) →
//     turn-executor.ts (Agent SDK streaming) → context-loader.ts (prompt assembly)
//   Buffer: haiku-router.ts (classify parallel messages) → fork or re-queue
//   Idle: idle-selector.ts (pick channel) → idle-executor.ts (unprompted turn)

// Parse command line arguments
const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "idle-timeout": {
      type: "string",
      short: "i",
      description: "Idle timeout in minutes (default: 15)",
    },
    "debug": {
      type: "boolean",
      short: "d",
      description: "Debug mode: 1 min idle threshold, 30s check interval",
    },
    "quiet": {
      type: "boolean",
      short: "q",
      description: "Suppress shutdown message in group chat",
    },
  },
});

// Build idle config from args
const idleConfig: IdleConfig = {};

// Debug mode: aggressive idle timings for testing
if (args["debug"]) {
  idleConfig.thresholdMs = 1 * 60 * 1000; // 1 minute idle threshold
  idleConfig.checkIntervalMs = 30 * 1000; // Check every 30 seconds
  idleConfig.debugMode = true; // Reduces cooldowns to 1/60th
  log("CONFIG", "🐛 Debug mode: idle threshold=1min, check interval=30s, cooldowns/60");
}

// Manual idle timeout overrides debug mode
if (args["idle-timeout"]) {
  const minutes = parseInt(args["idle-timeout"], 10);
  if (!isNaN(minutes) && minutes > 0) {
    idleConfig.thresholdMs = minutes * 60 * 1000;
    idleConfig.checkIntervalMs = Math.max(30 * 1000, (minutes / 2) * 60 * 1000); // Check at half the threshold, min 30s
    log("CONFIG", `Idle timeout set to ${minutes} minute(s)`);
  }
}

// Validate required environment variables
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CREATOR_USER_ID = process.env.CREATOR_USER_ID;
const CHANNEL_IDS = process.env.CHANNEL_IDS || process.env.GROUP_DM_CHANNEL_ID;

if (!DISCORD_TOKEN) {
  error("STARTUP", "DISCORD_TOKEN environment variable is required");
  process.exit(1);
}

if (!CREATOR_USER_ID) {
  error("STARTUP", "CREATOR_USER_ID environment variable is required");
  process.exit(1);
}

if (!CHANNEL_IDS) {
  error("STARTUP", "CHANNEL_IDS environment variable is required (comma-separated channel IDs)");
  process.exit(1);
}

// Parse comma-separated channel IDs (wrap at system boundary)
const channelIds = new Set(
  CHANNEL_IDS.split(",").map(id => channelId(id.trim())).filter(id => id.length > 0)
);

log("CONFIG", `Bot identity: ${BOT_NAME}`);
log("CONFIG", `Watching ${channelIds.size} channel(s): ${[...channelIds].join(", ")}`);

// Create config object (wrap env vars at system boundary)
const config: Config = {
  creatorId: userId(CREATOR_USER_ID),
  channelIds,
};

// Create Discord client
const client = createClient();

// Set up event handlers
client.on("ready", async () => {
  handleReady(client);
  initTypingTracker(userId(client.user!.id));

  // Resolve channel types to build accurate aliases
  // "group" should point to an actual GROUP_DM, not a 1:1 DM
  const channelAliases: Record<string, string> = {};
  for (const id of channelIds) {
    try {
      const channel = await client.channels.fetch(id);
      if (channel) {
        const type = channel.type;
        log("CONFIG", `Channel ${id}: type=${type}`);
        if (isChannelGroupDM(channel) && !channelAliases["group"]) {
          channelAliases["group"] = id;
        } else if (isChannelDM(channel) && !channelAliases["dm"]) {
          channelAliases["dm"] = id;
        }
      }
    } catch (err) {
      log("CONFIG", `Could not fetch channel ${id}: ${err}`);
    }
  }
  // Fallback: if no GROUP_DM found, "group" points to first channel
  if (!channelAliases["group"]) {
    channelAliases["group"] = channelIds.values().next().value ?? "";
  }
  channelAliases["primary"] = channelAliases["group"];

  // Set PRIMARY_CHANNEL_ID AFTER type resolution so it points to the actual GROUP_DM.
  // This is the single source of truth — used by shutdown, MCP tool handlers, agent env, idle env.
  process.env.PRIMARY_CHANNEL_ID = channelAliases["group"];

  log("CONFIG", `Channel aliases: ${Object.entries(channelAliases).map(([k, v]) => `${k}=${v}`).join(", ")}`);

  // Seed DM channel ID for transcript search filtering (survives until next restart)
  if (channelAliases["dm"]) {
    setDmChannelId(channelAliases["dm"]);
  }

  // Initialize transcript search index (backfills from JSONL)
  initTranscriptIndex();

  // Create custom MCP tools server (reused by all agent executions)
  const customTools = await createToolsServer(client, config, channelAliases);
  setToolsServer(customTools);
  log("MCP", "Custom tools server initialized");

  startIdleLoop(client, config, idleConfig, customTools);
  startAuditWatcher(client, config.creatorId);

  // Initialize extension system (discovers local/extensions/*.ts, starts file watcher)
  await initExtensions(client, config);
});

client.on("messageCreate", (message) => {
  handleMessage(client, message, config);
});

client.on("typingStart", (typing) => {
  handleTypingStart(typing, config);
});

client.on("messageReactionAdd", (reaction, user) => {
  handleReaction(reaction as any, user as any, client, config);
});

client.on("messageDelete", (message) => {
  if (message.author?.id === client.user?.id) return;
  cancelMessage(message.id);

  // Interrupt streaming session if the deleted message is currently being processed
  if (getCurrentlyProcessingMessageId() === message.id) {
    log("STREAM", `Deleted message ${message.id} is currently being processed — interrupting`);
    interruptCurrentMessage();
  }
});

client.on("messageUpdate", (oldMessage, newMessage) => {
  if (oldMessage.author?.id === client.user?.id) return;
  // Only act if content actually changed (not just embed loading)
  if (oldMessage.content !== newMessage.content) {
    // If still queued: cancel old turn, re-process with edited content
    // If already processing: let it finish (edit was probably a typo fix)
    if (cancelQueuedMessage(oldMessage.id)) {
      handleMessage(client, newMessage as Message, config);
    }
    // Interrupt streaming session if the edited message is currently being processed
    else if (getCurrentlyProcessingMessageId() === oldMessage.id) {
      log("STREAM", `Edited message ${oldMessage.id} is currently being processed — interrupting`);
      interruptCurrentMessage();
      // Re-process with the edited content
      handleMessage(client, newMessage as Message, config);
    }
  }
});

client.on("error", (err) => {
  error("DISCORD", "Client error", err);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason) => {
  error("PROCESS", "Unhandled rejection", reason);
});

// Graceful shutdown - set status to idle before quitting
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  // Prevent double shutdown
  if (isShuttingDown) return;
  isShuttingDown = true;

  log("SHUTDOWN", `Received ${signal}, shutting down...`);
  stopIdleLoop();
  stopAuditWatcher();
  stopExtensions();
  closeTranscriptIndex();

  // Close streaming sessions before process.exit so the output consumer
  // sees _alive=false and doesn't log a spurious error.
  getStreamingSession(true).close();
  getStreamingSession(false).close();

  // Send a goodbye message to the group DM
  const groupChannelId = process.env.PRIMARY_CHANNEL_ID;
  if (!args["quiet"] && groupChannelId) {
    try {
      const channel = await client.channels.fetch(groupChannelId);
      if (channel && "send" in channel) {
        await (channel as any).send("aight im gonna take a nap 💤");
        log("SHUTDOWN", `Sent goodbye to group DM ${groupChannelId}`);
      }
    } catch (err) {
      // Ignore errors sending goodbye
    }
  } else if (args["quiet"]) {
    log("SHUTDOWN", "Quiet mode: skipping goodbye message");
  }

  // Set status to invisible so Greg appears offline
  try {
    setOfflinePresence(client);
    log("SHUTDOWN", "Set status to offline");
    // Give Discord a moment to send the status change over websocket
    await new Promise(resolve => setTimeout(resolve, 1000));
  } catch (err) {
    // Ignore errors setting status on shutdown
  }

  try {
    client.destroy();
  } catch (err) {
    // Ignore destroy errors
  }

  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Login with token
client.login(DISCORD_TOKEN);
