import { Client } from "discord.js-selfbot-v13";
import { handleReady, handleMessage, Config } from "./bot";
import { startIdleLoop, stopIdleLoop, IdleConfig } from "./idle";
import { startAuditWatcher, stopAuditWatcher } from "./audit";
import { parseArgs } from "util";

// Parse command line arguments
const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "idle-timeout": {
      type: "string",
      short: "i",
      description: "Idle timeout in minutes (default: 15)",
    },
  },
});

// Build idle config from args
const idleConfig: IdleConfig = {};
if (args["idle-timeout"]) {
  const minutes = parseInt(args["idle-timeout"], 10);
  if (!isNaN(minutes) && minutes > 0) {
    idleConfig.thresholdMs = minutes * 60 * 1000;
    idleConfig.checkIntervalMs = Math.max(30 * 1000, (minutes / 2) * 60 * 1000); // Check at half the threshold, min 30s
    console.log(`[CONFIG] Idle timeout set to ${minutes} minute(s)`);
  }
}

// Validate required environment variables
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CREATOR_USER_ID = process.env.CREATOR_USER_ID;
const GROUP_DM_CHANNEL_ID = process.env.GROUP_DM_CHANNEL_ID;

if (!DISCORD_TOKEN) {
  console.error("Error: DISCORD_TOKEN environment variable is required");
  process.exit(1);
}

if (!CREATOR_USER_ID) {
  console.error("Error: CREATOR_USER_ID environment variable is required");
  process.exit(1);
}

if (!GROUP_DM_CHANNEL_ID) {
  console.error("Error: GROUP_DM_CHANNEL_ID environment variable is required");
  process.exit(1);
}

// Create config object
const config: Config = {
  creatorId: CREATOR_USER_ID,
  groupDmId: GROUP_DM_CHANNEL_ID,
};

// Create Discord client
const client = new Client();

// Set up event handlers
client.on("ready", () => {
  handleReady(client);
  startIdleLoop(client, config, idleConfig);
  startAuditWatcher(client, config.creatorId);
});

client.on("messageCreate", (message) => {
  handleMessage(client, message, config);
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[SHUTDOWN] Received SIGINT, shutting down...");
  stopIdleLoop();
  stopAuditWatcher();
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[SHUTDOWN] Received SIGTERM, shutting down...");
  stopIdleLoop();
  stopAuditWatcher();
  client.destroy();
  process.exit(0);
});

// Login with token
client.login(DISCORD_TOKEN);
