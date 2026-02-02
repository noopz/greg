import { Client, Message, TextBasedChannel } from "discord.js-selfbot-v13";
import { shouldRespond, formatDiscordContext } from "./utils";
import { processWithAgent } from "./agent";
import { resetIdleTimer } from "./idle";
import { checkForInjection, sanitizeInput } from "./security";

// ============================================================================
// Typing Simulation
// ============================================================================

// Typing speed: 70-80 WPM average = ~75 WPM = 375 chars/min = 6.25 chars/sec
// We'll use ~80-120ms per character for variation
const TYPING_MS_PER_CHAR_MIN = 80;
const TYPING_MS_PER_CHAR_MAX = 120;

/**
 * Calculate typing delay for a message based on simulated WPM.
 * Adds some randomness to feel more natural.
 */
function calculateTypingDelay(text: string): number {
  const msPerChar = TYPING_MS_PER_CHAR_MIN +
    Math.random() * (TYPING_MS_PER_CHAR_MAX - TYPING_MS_PER_CHAR_MIN);
  return Math.floor(text.length * msPerChar);
}

/**
 * Split a long response into natural message chunks.
 * Splits on double newlines (paragraphs) or single newlines if chunks are short.
 */
function splitIntoChunks(response: string): string[] {
  // First try splitting by double newlines (paragraphs)
  let chunks = response.split(/\n\n+/).map(c => c.trim()).filter(c => c.length > 0);

  // If we only got one chunk, try splitting by single newlines
  if (chunks.length === 1 && response.includes('\n')) {
    chunks = response.split(/\n/).map(c => c.trim()).filter(c => c.length > 0);
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

  return merged;
}

/**
 * Send a response as multiple messages with natural typing delays.
 */
async function sendWithTypingSimulation(
  channel: TextBasedChannel,
  response: string
): Promise<void> {
  const chunks = splitIntoChunks(response);

  console.log(`[SEND] Splitting into ${chunks.length} message(s)`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const typingDelay = calculateTypingDelay(chunk);

    // Cap typing delay at 8 seconds per message to not feel too slow
    const cappedDelay = Math.min(typingDelay, 8000);

    console.log(`[SEND] Chunk ${i + 1}/${chunks.length}: "${chunk.substring(0, 40)}..." (${cappedDelay}ms typing)`);

    // Show typing indicator
    await channel.sendTyping();

    // Wait for "typing" time
    await new Promise(resolve => setTimeout(resolve, cappedDelay));

    // Send the chunk
    await channel.send(chunk);

    // Small pause between messages (like hitting enter and starting to type again)
    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 500));
    }
  }

  console.log(`[SEND] All ${chunks.length} message(s) sent`);
}

export interface BotConfig {
  creatorId: string;
  groupDmId: string;
}

// Re-export as Config for backward compatibility with index.ts
export type Config = BotConfig;

export function handleReady(client: Client): void {
  console.log(`[READY] Greg is online as ${client.user?.username} (${client.user?.id})`);
  console.log(`[CONFIG] Watching for messages...`);
}

export async function handleMessage(
  client: Client,
  message: Message,
  config: BotConfig
): Promise<void> {
  // Ignore own messages
  if (message.author.id === client.user?.id) {
    console.log(`[MSG] Ignoring own message`);
    return;
  }

  console.log(`[MSG] From ${message.author.username}: "${message.content.substring(0, 50)}${message.content.length > 50 ? '...' : ''}"`);

  const isGroupDm = message.channel.id === config.groupDmId;
  const isCreatorDm =
    message.channel.type === "DM" && message.author.id === config.creatorId;
  const isDirectMention = message.mentions.has(client.user!.id);

  console.log(`[MSG] isGroupDm=${isGroupDm} isCreatorDm=${isCreatorDm} isDirectMention=${isDirectMention}`);

  // Check if message is in allowed channels
  if (!isGroupDm && !isCreatorDm) {
    console.log(`[MSG] Ignoring - not in target channel`);
    return;
  }

  // Determine if we must respond
  const mustRespond = isDirectMention || isCreatorDm;
  console.log(`[MSG] mustRespond=${mustRespond}`);

  // For Group DM: check shouldRespond, return early if false
  if (isGroupDm && !mustRespond) {
    const shouldReply = await shouldRespond(message.content);
    console.log(`[MSG] shouldRespond check: ${shouldReply}`);
    if (!shouldReply) {
      return;
    }
  }

  try {
    // Reset idle timer since we're processing a message
    resetIdleTimer();

    // Security: Sanitize and check for injection attempts
    const sanitizedContent = sanitizeInput(message.content);
    const injectionCheck = checkForInjection(sanitizedContent);

    if (!injectionCheck.safe) {
      console.warn(`[SECURITY] ⚠️  Potential injection attempt from ${message.author.username}`);
      console.warn(`[SECURITY] Severity: ${injectionCheck.severity}`);
      console.warn(`[SECURITY] Warnings: ${injectionCheck.warnings.join(", ")}`);

      // For high severity, skip processing entirely (unless from creator)
      if (injectionCheck.severity === "high" && !isCreatorDm) {
        console.warn(`[SECURITY] Blocking high-severity injection attempt`);
        return;
      }
    }

    console.log(`[AGENT] Building context...`);
    // Build context and process with agent
    const context = await formatDiscordContext(message, client);
    console.log(`[AGENT] Context built (${context.length} chars)`);
    console.log(`[AGENT] Processing with agent...`);
    const response = await processWithAgent(context, { mustRespond, channelId: message.channel.id, isGroupDm });
    console.log(`[AGENT] Response: ${response ? `"${response.substring(0, 100)}${response.length > 100 ? '...' : ''}"` : 'null'}`);

    if (response !== null) {
      await sendWithTypingSimulation(message.channel, response);
    }
  } catch (error) {
    console.error("[ERROR] Processing message:", error);
    if (mustRespond) {
      await message.channel.send("brain.exe has stopped working");
    }
  }
}

export async function dmCreator(
  client: Client,
  creatorId: string,
  content: string
): Promise<void> {
  const creator = await client.users.fetch(creatorId);
  await creator.send(content);
}
