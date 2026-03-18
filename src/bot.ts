import { Client, Message, Typing, MessageReaction, User } from "discord.js-selfbot-v13";
import { formatDiscordContext, buildMessageContentBlocks } from "./discord-formatting";
import { processWithAgent, getStreamingSession } from "./agent";
import { resetIdleTimer } from "./idle";
import { checkForInjection, sanitizeInput } from "./security";
import {
  clearTyping,
  isUserTyping,
  sendWithTypingSimulation,
  createTypingCallback,
  recordTypingStart,
} from "./typing";
import {
  getConversationConfidence,
  recordBotResponse,
  recordMessageForEnergy,
} from "./conversation";
import { shouldRespondViaGate } from "./response-gate";
import type { GateInput } from "./response-gate";
import { log, warn, error as logError } from "./log";
import type { ChannelId, UserId, TurnResult, ContextRefreshCallback } from "./agent-types";
import { channelId, userId, registerUser, resolveUser } from "./agent-types";
import { isMessageCancelled, getCurrentSessionId } from "./turn-queue";
import { indexBotResponse, setDmChannelId } from "./transcript-index";
import { BOT_NAME, BOT_NAME_LOWER } from "./config/identity";
import { appendToTranscript, getTranscriptPath, appendJsonl, type TranscriptEntry } from "./persistence";
import { TRANSCRIPTS_DIR, AGENT_DATA_DIR } from "./paths";
import path from "node:path";

import { consumeHypothesisReviewTrigger } from "./context-loader";
import { executeFollowup, canScheduleFollowup } from "./followup-executor";
import type { BotConfig } from "./bot-types";
import {
  trackParticipant,
  registerKnownUser,
  detectReferences,
  getActiveParticipants,
  loadAliases,
} from "./active-participants";

// Track the currently processing message for interrupt support (Phase 3)
let currentlyProcessingMessageId: string | null = null;

// Track last seen message ID per channel for discord context deltas
const lastSeenMsgIds = new Map<ChannelId, string>();

// Re-export shared types/utils from bot-types (leaf module) for backward compatibility
export type { BotConfig, Config } from "./bot-types";
export { dmCreator } from "./bot-types";

// ============================================================================
// Focused Return Types
// ============================================================================

interface ChannelValidation {
  isAllowedChannel: boolean;
  isCreatorDm: boolean;
  isDirectMention: boolean;
  isNameMentioned: boolean;
  isReplyToBot: boolean;
}

interface GateContext {
  recentMessages: Array<{ author: string; content: string; isBot: boolean }>;
  replyContext?: { author: string; content: string; isBot: boolean };
}

// ============================================================================
// Duplicate / Echo Detection
// ============================================================================

const lastSentMessage = new Map<ChannelId, string>();

function isDuplicateResponse(chId: ChannelId, response: string): boolean {
  const last = lastSentMessage.get(chId);
  if (!last) return false;
  return response.trim().toLowerCase() === last.trim().toLowerCase();
}

function isEchoResponse(userMessage: string, response: string): boolean {
  const normalizedUser = userMessage.trim().toLowerCase();
  const normalizedResponse = response.trim().toLowerCase();
  if (normalizedUser === normalizedResponse) return true;
  if (normalizedUser.length > 10 && normalizedResponse.includes(normalizedUser)) return true;
  return false;
}

// ============================================================================
// Context Refresh Callback
// ============================================================================

function buildContextRefreshCallback(
  message: Message,
  client: Client,
  mustRespond: boolean
): ContextRefreshCallback {
  const originalMessageId = message.id;
  const channel = message.channel;

  return async () => {
    try {
      const recentMessages = await channel.messages.fetch({ limit: 10 });
      const sortedMessages = [...recentMessages.values()].sort(
        (a, b) => a.createdTimestamp - b.createdTimestamp
      );

      const newMessages = sortedMessages.filter(
        (msg) =>
          msg.createdTimestamp > message.createdTimestamp &&
          msg.id !== originalMessageId &&
          msg.author.id !== client.user?.id
      );

      const newMessageCount = newMessages.length;

      // If >2 new messages arrived while we were generating, the conversation
      // may have moved on. With >4 and no mention, skip the response entirely.
      if (newMessageCount > 2 && !mustRespond) {
        log(
          "CONTEXT_REFRESH",
          `${newMessageCount} new messages - checking if response still relevant`
        );
        const hasMention = newMessages.some(
          (msg) =>
            msg.mentions.has(client.user!.id) ||
            msg.content.toLowerCase().includes(BOT_NAME_LOWER)
        );
        if (!hasMention && newMessageCount > 4) {
          return { newMessageCount, shouldSkip: true };
        }
      }

      return { newMessageCount, shouldSkip: false };
    } catch (err) {
      logError("CONTEXT_REFRESH", "Failed to fetch recent messages", err);
      return { newMessageCount: 0, shouldSkip: false };
    }
  };
}

// ============================================================================
// Step Functions
// ============================================================================

async function validateChannel(
  message: Message,
  client: Client,
  config: BotConfig,
  msgChannelId: ChannelId,
  msgUserId: UserId
): Promise<ChannelValidation | null> {
  // Ignore own messages
  if (message.author.id === client.user?.id) {
    log("MSG", "Ignoring own message");
    return null;
  }

  // Cache username for readable logs
  registerUser(msgUserId, message.author.username);

  // Track active participants (runs for every incoming message)
  trackParticipant(msgChannelId, msgUserId);
  registerKnownUser(msgChannelId, message.author.username, msgUserId);

  // One-time population of name pool for group DMs
  if (message.channel.type === "GROUP_DM" && "recipients" in message.channel) {
    for (const user of (message.channel as any).recipients) {
      if (user.username) registerKnownUser(msgChannelId, user.username, userId(user.id));
    }
  }

  detectReferences(msgChannelId, message.content);
  loadAliases(); // Hot-reload aliases (checks mtime, no-op if unchanged)

  // Drop image-only messages (no text content, just attachments/embeds).
  // Image-only messages from the creator are allowed through (unless DISABLE_IMAGES=1).
  // Non-creator image-only messages are always dropped (creator can reply to them to trigger image processing).
  const IMAGES_ENABLED = process.env.DISABLE_IMAGES !== "1";
  const isCreatorMsg = msgUserId === config.creatorId;
  if (!message.content.trim() && (message.attachments.size > 0 || message.embeds.length > 0)) {
    if (!IMAGES_ENABLED || !isCreatorMsg) {
      log("MSG", `Ignoring image/attachment-only message from ${message.author.username}${IMAGES_ENABLED ? " (non-creator)" : ""}`);
      return null;
    }
  }

  // Kill switch — creator sends "order 86" to shut down the bot ("order 86 -quiet" skips the goodbye).
  const lowerMsg = message.content.toLowerCase().trim();
  if (
    msgUserId === config.creatorId &&
    (lowerMsg === "order 86" || lowerMsg === "order 86 -quiet")
  ) {
    const quiet = lowerMsg.includes("-quiet");
    log("KILL", `Order 86 received from creator${quiet ? " (quiet)" : ""}. Shutting down...`);
    if (!quiet) {
      await message.channel.send("understood. shutting down.");
    }
    process.exit(0);
  }

  log("MSG", `From ${message.author.username} (${msgUserId}): "${message.content}"`);

  const isAllowedChannel = config.channelIds.has(msgChannelId);
  const isCreatorDm = message.channel.type === "DM" && msgUserId === config.creatorId;
  const isDirectMention = message.mentions.has(client.user!.id);
  const isNameMentioned = message.content.toLowerCase().includes(BOT_NAME_LOWER);

  let isReplyToBot = false;
  if (message.reference?.messageId) {
    try {
      const referencedMsg = await message.channel.messages.fetch(
        message.reference.messageId
      );
      if (referencedMsg.author.id === client.user!.id) {
        isReplyToBot = true;
        log("MSG", `Is reply to bot's message: ${message.reference.messageId}`);
      }
    } catch {
      // Could not fetch referenced message, ignore
    }
  }

  log(
    "MSG",
    `isAllowedChannel=${isAllowedChannel} isCreatorDm=${isCreatorDm} isDirectMention=${isDirectMention} isNameMentioned=${isNameMentioned} isReplyToBot=${isReplyToBot}`
  );

  if (!isAllowedChannel && !isCreatorDm) {
    log("MSG", "Ignoring - not in target channel");
    return null;
  }

  recordMessageForEnergy(msgChannelId, msgUserId, message.content.length);

  return { isAllowedChannel, isCreatorDm, isDirectMention, isNameMentioned, isReplyToBot };
}

/**
 * Fetch recent messages for the Haiku gate prompt.
 * Returns last N messages as lightweight { author, content, isBot } objects,
 * plus the reply context if the message is a reply.
 */
async function fetchRecentMessagesForGate(
  message: Message,
  client: Client,
  limit = 5
): Promise<GateContext> {
  const result: GateContext = { recentMessages: [] };

  try {
    const fetched = await message.channel.messages.fetch({ limit: limit + 1 });
    const sorted = [...fetched.values()]
      .filter((m) => m.id !== message.id)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-limit);

    result.recentMessages = sorted.map((m) => ({
      author: m.author.username,
      content: m.content.substring(0, 200),
      isBot: m.author.id === client.user?.id,
    }));
  } catch {
    // Fetch failed — gate runs with empty context
  }

  // Fetch reply context separately (may be outside the last N messages)
  if (message.reference?.messageId) {
    try {
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      result.replyContext = {
        author: ref.author.username,
        content: ref.content.substring(0, 200),
        isBot: ref.author.id === client.user?.id,
      };
    } catch {
      // Could not fetch referenced message
    }
  }

  return result;
}

/**
 * Execute the full response pipeline: typing wait → security → context → agent → deliver.
 * Shared by both the creator-DM path and the gated path.
 */
async function executePipeline(
  message: Message,
  client: Client,
  config: BotConfig,
  validation: ChannelValidation,
  msgChannelId: ChannelId,
  msgUserId: UserId,
  opts: { mustRespond: boolean; isFollowUp: boolean }
): Promise<void> {
  log("PIPELINE", `Start msg=${message.id} user=${resolveUser(msgUserId)} ch=${msgChannelId} mustRespond=${opts.mustRespond} isFollowUp=${opts.isFollowUp} isReply=${validation.isReplyToBot}`);

  // Track conversation immediately so messages arriving during processing
  // (reviewer, ReAct) are detected as follow-ups instead of cold starts.
  // The post-send recordBotResponse() call refreshes the timestamp.
  recordBotResponse(msgChannelId, msgUserId);

  await awaitTyping(message, msgChannelId, msgUserId);

  if (!runSecurityCheck(message, validation.isCreatorDm)) return;

  log("PIPELINE", `msg=${message.id} building context...`);
  const isCreator = msgUserId === config.creatorId;

  // Use delta context on continuation turns (session already has prior messages)
  const session = getStreamingSession(isCreator);
  const sessionAlive = session.isAlive();
  if (!sessionAlive) {
    // Session dead/restarting — clear watermark so fresh session gets full context
    lastSeenMsgIds.delete(msgChannelId);
  }
  const lastSeenId = sessionAlive ? lastSeenMsgIds.get(msgChannelId) ?? null : null;
  const { context: discordContext, latestMessageId } = await formatDiscordContext(
    message, client, config.creatorId, lastSeenId
  );
  lastSeenMsgIds.set(msgChannelId, latestMessageId);
  log("PIPELINE", `msg=${message.id} context built (${discordContext.length} chars${lastSeenId ? ", delta" : ""})`);

  // Build image content blocks (enabled by default, DISABLE_IMAGES=1 to opt out).
  // Only the creator can trigger image processing — either by sending images directly,
  // or by replying to a non-creator's message that contains images.
  let imageBlocks: Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }> = [];

  if (isCreator) {
    const contentBlocks = await buildMessageContentBlocks(message, discordContext);
    imageBlocks = contentBlocks
      .filter((b): b is Extract<typeof b, { type: "image" }> => b.type === "image");

    // Reply-to-extract: pull images from the referenced message when the creator's own message has none.
    if (imageBlocks.length === 0 && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        if (refMsg.attachments.size > 0 || refMsg.embeds.length > 0) {
          const refBlocks = await buildMessageContentBlocks(refMsg, discordContext);
          imageBlocks = refBlocks
            .filter((b): b is Extract<typeof b, { type: "image" }> => b.type === "image");
          if (imageBlocks.length > 0) {
            log("IMAGE", `Extracted ${imageBlocks.length} image(s) from referenced message ${refMsg.id}`);
          }
        }
      } catch {
        // Couldn't fetch referenced message, skip image extraction
      }
    }
  }

  const contextRefreshCallback = buildContextRefreshCallback(
    message, client, opts.mustRespond
  );

  // Typing indicator driven by partial message streaming events
  const typingCallback = createTypingCallback(message.channel);

  // Track currently processing message for interrupt support (Phase 3)
  currentlyProcessingMessageId = message.id;

  let result: TurnResult;
  try {
    log("PIPELINE", `msg=${message.id} processing with agent...`);
    const activeUserIds = getActiveParticipants(msgChannelId);
    log("PIPELINE", `msg=${message.id} active participants: ${activeUserIds.length}`);
    result = await processWithAgent(
      discordContext,
      {
        mustRespond: opts.mustRespond,
        channelId: msgChannelId,
        isGroupDm: !validation.isCreatorDm && validation.isAllowedChannel,
        isCreator,
        processingStartedAt: Date.now(),
        originalMessageId: message.id,
        isReplyToBot: validation.isReplyToBot,
        userId: msgUserId,
        isFollowUp: opts.isFollowUp,
        activeUserIds,
        ...(imageBlocks.length > 0 ? { imageBlocks } : {}),
      },
      contextRefreshCallback,
      typingCallback
    );
  } finally {
    currentlyProcessingMessageId = null;
  }

  await deliverResponse(
    message, result, msgChannelId, msgUserId,
    validation.isReplyToBot, opts.mustRespond
  );

  // Trigger background hypothesis review if the roll succeeded this session.
  // Runs as a silent followup — never injected into conversation context
  // (injecting distracted Greg from user messages and leaked reasoning).
  // Only on successful turns — errors/skips shouldn't trigger background work.
  if (result.kind === "response" && consumeHypothesisReviewTrigger() && canScheduleFollowup()) {
    const reviewTask = "Hypothesis review: Read agent-data/hypotheses.md and recent memories (agent-data/memories/). For each active hypothesis: add dated evidence from recent conversations, promote confirmed ones to learned-patterns.md, reject hypotheses stale for 2+ weeks with no evidence, and create new hypotheses if patterns in memories aren't captured yet. Update hypotheses.md with all changes. Silent file update — do NOT post to Discord.";
    log("CONTEXT", "Triggering background hypothesis review followup");
    executeFollowup(reviewTask, message.channel).catch(err => {
      logError("CONTEXT", "Hypothesis review followup failed", err);
    });
  }
}

async function awaitTyping(
  message: Message,
  msgChannelId: ChannelId,
  msgUserId: UserId,
): Promise<void> {
  clearTyping(msgUserId, msgChannelId);

  // Wait for same user to finish typing (possible follow-up), up to 5s.
  // Applies to ALL messages including mustRespond — "greg" followed by the
  // actual question is a common pattern; skipping the wait causes Greg to
  // respond to just the name mention before the real message arrives.
  // NOTE: We intentionally do NOT wait for other users' typing. That caused
  // message ordering inversion — earlier messages got held while later ones
  // from other users raced ahead and got queued first.
  const SAME_USER_TYPING_WAIT_MS = 5000;
  const TYPING_CHECK_INTERVAL_MS = 250;
  const startTime = Date.now();

  while (isUserTyping(msgUserId, msgChannelId)) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= SAME_USER_TYPING_WAIT_MS) {
      log("TYPING", `Same-user typing wait timeout reached (${SAME_USER_TYPING_WAIT_MS}ms), proceeding`);
      break;
    }
    log("TYPING", `Waiting for ${message.author.username} to finish typing (possible follow-up)...`);
    await new Promise((resolve) => setTimeout(resolve, TYPING_CHECK_INTERVAL_MS));
  }
}

function runSecurityCheck(message: Message, isCreatorDm: boolean): boolean {
  resetIdleTimer();

  const sanitizedContent = sanitizeInput(message.content);
  const injectionCheck = checkForInjection(sanitizedContent);

  if (!injectionCheck.safe) {
    warn("SECURITY", `Potential injection attempt from ${message.author.username}`);
    warn("SECURITY", `Severity: ${injectionCheck.severity}`);
    warn("SECURITY", `Warnings: ${injectionCheck.warnings.join(", ")}`);

    if (injectionCheck.severity === "high" && !isCreatorDm) {
      warn("SECURITY", "Blocking high-severity injection attempt");
      return false;
    }
  }

  return true;
}

async function deliverResponse(
  message: Message,
  result: TurnResult,
  msgChannelId: ChannelId,
  msgUserId: UserId,
  isReplyToBot: boolean,
  mustRespond: boolean
): Promise<void> {
  const triggerMsgId = message.id;

  if (isMessageCancelled(triggerMsgId)) {
    log("SEND", `Skipping response for msg=${triggerMsgId} - original message was deleted`);
    return;
  }

  switch (result.kind) {
    case "response": {
      log(
        "SEND",
        `msg=${triggerMsgId} user=${resolveUser(msgUserId)} ch=${msgChannelId} → "${result.text.substring(0, 100)}${result.text.length > 100 ? "..." : ""}"`
      );
      if (isDuplicateResponse(msgChannelId, result.text)) {
        log("SEND", `msg=${triggerMsgId} skipped: duplicate response`);
      } else if (isEchoResponse(message.content, result.text)) {
        log("SEND", `msg=${triggerMsgId} skipped: echo response`);
      } else {
        await sendWithTypingSimulation(
          message.channel,
          result.text,
          isReplyToBot ? message : undefined
        );
        indexBotResponse(result.text, String(msgChannelId));
        lastSentMessage.set(msgChannelId, result.text);
        recordBotResponse(msgChannelId, msgUserId);
      }
      break;
    }
    case "no_response":
      log("SEND", `msg=${triggerMsgId} → no_response`);
      break;
    case "skipped":
      log("SEND", `msg=${triggerMsgId} → skipped: ${result.reason}`);
      if (mustRespond && result.reason === "empty after sanitize") {
        warn("SEND", `msg=${triggerMsgId} mustRespond=true but response was empty after sanitize — sending fallback`);
        await message.channel.send("brain.exe has stopped working");
      }
      break;
    case "error":
      logError("SEND", `msg=${triggerMsgId} → error`, result.error);
      break;
  }
}

// ============================================================================
// Public API
// ============================================================================

export function handleReady(client: Client): void {
  log("READY", `Greg is online as ${client.user?.username} (${client.user?.id})`);
  log("CONFIG", "Watching for messages...");
}

export async function handleMessage(
  client: Client,
  message: Message,
  config: BotConfig
): Promise<void> {
  const msgChannelId = channelId(message.channel.id);
  const msgUserId = userId(message.author.id);

  // Step 1: Validate channel
  const validation = await validateChannel(message, client, config, msgChannelId, msgUserId);
  if (!validation) return;

  // Step 2: Creator DM — bypass gate entirely
  if (validation.isCreatorDm) {
    setDmChannelId(String(msgChannelId));
    log("MSG", "Creator DM — bypassing gate, straight to pipeline");
    try {
      await executePipeline(message, client, config, validation, msgChannelId, msgUserId, {
        mustRespond: true,
        isFollowUp: false,
      });
    } catch (err) {
      logError("ERROR", "Processing message", err);
    }
    return;
  }

  // Step 3: Build gate input and run Haiku gate
  const convoConfidence = getConversationConfidence(msgChannelId, msgUserId);
  const isFollowUp = convoConfidence !== "none";
  log("MSG", `convoConfidence=${convoConfidence} isFollowUp=${isFollowUp}`);

  const { recentMessages, replyContext } = await fetchRecentMessagesForGate(message, client);

  const gateInput: GateInput = {
    messageContent: message.content,
    messageAuthorUsername: message.author.username,
    recentMessages,
    replyContext,
    isDirectMention: validation.isDirectMention,
    isNameMentioned: validation.isNameMentioned,
    isReplyToBot: validation.isReplyToBot,
    convoConfidence,
    channelId: msgChannelId,
    userId: msgUserId,
  };

  const gateResult = await shouldRespondViaGate(gateInput);
  if (!gateResult) return;

  // Step 4: Compute pipeline options from validation + convo signals
  const mustRespond =
    validation.isDirectMention || validation.isNameMentioned || validation.isReplyToBot ||
    convoConfidence === "high";
  log("MSG", `mustRespond=${mustRespond}`);

  try {
    await executePipeline(message, client, config, validation, msgChannelId, msgUserId, {
      mustRespond,
      isFollowUp,
    });
  } catch (err) {
    logError("ERROR", "Processing message", err);
  }
}

export function handleTypingStart(typing: Typing, config: BotConfig): void {
  const typingChannelId = channelId(typing.channel.id);
  const typingUserId = userId(typing.user.id);

  // Cache username (typing events may arrive before any message from this user)
  if (typing.user.username) {
    registerUser(typingUserId, typing.user.username);
  }

  const isAllowedChannel = config.channelIds.has(typingChannelId);
  const isCreatorDm = typing.channel.type === "DM" && typingUserId === config.creatorId;

  if (isAllowedChannel || isCreatorDm) {
    recordTypingStart(typingUserId, typingChannelId);
  }
}

const REACTION_FEEDBACK_FILE = path.join(AGENT_DATA_DIR, "reaction-feedback.jsonl");

/**
 * Handle reactions on Greg's messages.
 * Logs the reaction and appends to a feedback JSONL for pattern learning.
 * Emoji names (including custom emojis like "pepeLaugh", "KEKW", "sadge")
 * are stored raw — sentiment classification happens at consumption time
 * via semantic judgment, not a hardcoded list.
 */
export async function handleReaction(
  reaction: MessageReaction,
  reactingUser: User,
  client: Client,
  config: BotConfig
): Promise<void> {
  try {
    // Fetch partial reaction/message if needed (uncached messages)
    if (reaction.partial) {
      try { reaction = await reaction.fetch() as MessageReaction; } catch { return; }
    }
    if (reaction.message.partial) {
      try { reaction.message = await reaction.message.fetch(); } catch { return; }
    }

    const msg = reaction.message;

    // Only care about reactions on Greg's messages
    if (msg.author?.id !== client.user?.id) return;

    // Only in watched channels
    const msgChannelId = channelId(msg.channelId);
    if (!config.channelIds.has(msgChannelId)) return;

    // Ignore Greg's own reactions
    if (reactingUser.id === client.user?.id) return;

    const emoji = reaction.emoji.name ?? reaction.emoji.id ?? "?";
    const username = reactingUser.username ?? reactingUser.id;
    const isGif = msg.content?.includes("https://static.klipy.com/") ?? false;
    const preview = msg.content?.substring(0, 100) ?? "";

    log("REACTION", `${username} reacted ${emoji} to bot's msg ${msg.id} in ${msgChannelId}${isGif ? " (GIF)" : ""}`);

    // Append to feedback log (JSONL, append-only)
    const entry = {
      emoji,
      user: username,
      userId: reactingUser.id,
      messageId: msg.id,
      channelId: String(msgChannelId),
      isGif,
      messagePreview: preview,
      when: new Date().toISOString(),
    };

    await appendJsonl(REACTION_FEEDBACK_FILE, entry);

    // Append reaction to the active transcript so Greg can see feedback
    // when reading transcripts during idle skills (conversation-logging,
    // self-reflection, pattern-learning). Without this, reactions are
    // invisible in transcript reads and Greg can't tell if GIFs/messages landed.
    const sessionId = getCurrentSessionId();
    if (sessionId) {
      const transcriptEntry: TranscriptEntry = {
        type: "system",
        content: `[Reaction] ${username} reacted ${emoji} to your message: "${preview}"${isGif ? " (GIF)" : ""}`,
        timestamp: Date.now(),
        metadata: {
          channelId: String(msgChannelId),
          emoji,
          user: username,
          messageId: msg.id,
          isGif,
        },
      };
      await appendToTranscript(getTranscriptPath(TRANSCRIPTS_DIR, sessionId), transcriptEntry);
    }
  } catch (err) {
    logError("REACTION", "Failed to handle reaction", err);
  }
}

// ============================================================================
// Phase 3: Interrupt Support
// ============================================================================

/** Get the ID of the message currently being processed (for interrupt checks). */
export function getCurrentlyProcessingMessageId(): string | null {
  return currentlyProcessingMessageId;
}

/** Interrupt the streaming session processing the current message. */
export function interruptCurrentMessage(): void {
  if (!currentlyProcessingMessageId) return;

  // Interrupt both sessions — we don't know which one is processing.
  // The idle one will be a no-op.
  const creator = getStreamingSession(true);
  const pub = getStreamingSession(false);

  if (!creator.isIdle() && creator.isAlive()) {
    creator.interrupt().catch(() => {});
  }
  if (!pub.isIdle() && pub.isAlive()) {
    pub.interrupt().catch(() => {});
  }
}
