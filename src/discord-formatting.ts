import { Message, Client } from "discord.js-selfbot-v13";
import sharp from "sharp";
import { wrapExternalContent } from "./security";
import { log, warn } from "./log";
import { BOT_NAME } from "./config/identity";

const IMAGES_ENABLED = process.env.ENABLE_IMAGES === "1";

// Max image size to download (5MB)
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
// Supported image MIME types
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
// Anthropic vision sweet spot: 1568px on the longest side
const MAX_IMAGE_DIMENSION = 1568;

// ============================================================================
// Discord Context Formatting
// ============================================================================

const channelTypeMap: Record<string, string> = {
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

/**
 * Formats Discord context for the agent, including recent messages and channel info.
 * Includes threaded reply context so Greg understands what messages are replying to.
 */
export async function formatDiscordContext(
  message: Message,
  client: Client,
  creatorId?: string
): Promise<string> {
  const channel = message.channel;
  const botId = client.user?.id;

  // Fetch last 15 messages from channel (consecutive same-author merged later)
  const messages = await channel.messages.fetch({ limit: 15 });
  const sortedMessages = [...messages.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );

  // Build a map of message IDs to content for resolving reply references
  const messageMap = new Map<string, { author: string; content: string }>();
  for (const msg of sortedMessages) {
    messageMap.set(msg.id, {
      author: msg.author.id === botId ? BOT_NAME : msg.author.username,
      content: msg.content.substring(0, 100) + (msg.content.length > 100 ? "..." : ""),
    });
  }

  // Format messages as "[Username]: content"
  // Wrap non-Greg messages with security boundary to mark as untrusted
  // Filter out Greg's system messages (audit notifications, etc.)
  // Merge consecutive messages from the same author into one context entry
  // so multi-chunk responses don't eat multiple context slots.
  // Skip empty-content messages (image/attachment-only) that waste slots.
  const formattedMessages: string[] = [];
  let lastAuthorId: string | null = null;

  for (const msg of sortedMessages) {
    // Skip Greg's audit/system messages
    if (msg.author.id === botId && msg.content.startsWith("[Audit]")) {
      continue;
    }

    // For empty-content messages (image/attachment-only), include a brief marker
    // so the model knows something was posted (important for conversational context).
    if (!msg.content.trim()) {
      if (msg.attachments.size > 0 || msg.embeds.length > 0) {
        const authorName = msg.author.id === botId ? BOT_NAME : msg.author.username;
        formattedMessages.push(`[${authorName}]: [posted an image]`);
      }
      continue;
    }

    const isBot = msg.author.id === botId;
    const authorName = isBot ? BOT_NAME : msg.author.username;

    // Build content — note attachments if present alongside text
    const attachmentNote = msg.attachments.size > 0 ? " [+image]" : "";
    const content = isBot
      ? msg.content
      : wrapExternalContent(msg.content + attachmentNote, { source: "Discord", author: msg.author.username });

    // Build reply context if this message is a reply
    let replyContext = "";
    if (msg.reference?.messageId) {
      const localRef = messageMap.get(msg.reference.messageId);
      if (localRef) {
        const refDisplay = localRef.author === BOT_NAME
          ? localRef.content
          : wrapExternalContent(localRef.content, { source: "Discord reply", author: localRef.author });
        replyContext = `\n  ↳ replying to [${localRef.author}]: ${refDisplay}`;
      } else {
        try {
          const referencedMsg = await channel.messages.fetch(msg.reference.messageId);
          const refAuthor = referencedMsg.author.id === botId ? BOT_NAME : referencedMsg.author.username;
          const refContent = referencedMsg.content.substring(0, 100) + (referencedMsg.content.length > 100 ? "..." : "");
          const refDisplay = refAuthor === BOT_NAME
            ? refContent
            : wrapExternalContent(refContent, { source: "Discord reply", author: refAuthor });
          replyContext = `\n  ↳ replying to [${refAuthor}]: ${refDisplay}`;
        } catch {
          replyContext = `\n  ↳ replying to [unknown message]`;
        }
      }
    }

    // Build reaction suffix
    let reactionSuffix = "";
    if (msg.reactions.cache.size > 0) {
      const reactionStr = msg.reactions.cache
        .map(r => {
          const emoji = r.emoji.name ?? r.emoji.id ?? "?";
          return r.count > 1 ? `${emoji}×${r.count}` : emoji;
        })
        .join(", ");
      reactionSuffix = ` [${reactionStr}]`;
    }

    // Merge consecutive messages from the same author into one context entry.
    // Prevents Greg's multi-chunk responses (3 Discord messages for one response)
    // from eating 3 context slots, preserving room for other speakers' messages.
    if (msg.author.id === lastAuthorId && formattedMessages.length > 0) {
      formattedMessages[formattedMessages.length - 1] += `\n${content}${reactionSuffix}${replyContext}`;
    } else {
      formattedMessages.push(`[${authorName}]: ${content}${reactionSuffix}${replyContext}`);
      lastAuthorId = msg.author.id;
    }
  }

  const formattedMessagesStr = formattedMessages.join("\n");

  // Get channel type as string (channel.type is a string like "DM", "GROUP_DM", etc.)
  const channelTypeStr = channelTypeMap[channel.type] || "Unknown";

  // Build context string
  let context = `=== Channel Info ===
Type: ${channelTypeStr}
Channel ID: ${channel.id}
Timestamp: ${new Date().toLocaleString()}
`;

  // For Group DM, list participants
  if (channel.type === "GROUP_DM" && "recipients" in channel) {
    const recipients = (channel as any).recipients;
    if (recipients) {
      const participantList = recipients
        .map((user: any) => `  - ${user.username} (${user.id})`)
        .join("\n");
      context += `\nParticipants:\n${participantList}\n`;
    }
  }

  // Add current message details
  const isCurrentMsgCreator = creatorId ? message.author.id === creatorId : true;
  const currentAttachmentNote = message.attachments.size > 0
    ? isCurrentMsgCreator
      ? `\nAttachments: ${message.attachments.size} image(s)`
      : `\nAttachments: ${message.attachments.size} image(s) [NOT VISIBLE — only the creator can activate ${BOT_NAME}'s third eye]`
    : "";
  let currentMsgContext = `
=== Current Message ===
Author: ${message.author.username} (${message.author.id})
Content: ${message.content}${currentAttachmentNote}
Message ID: ${message.id}
Created At: ${message.createdAt.toISOString()}`;

  // If the current message is a reply, show what it's replying to
  if (message.reference?.messageId) {
    try {
      // Check local map first
      const localRef = messageMap.get(message.reference.messageId);
      if (localRef) {
        currentMsgContext += `\nReplying to: [${localRef.author}]: ${localRef.content}`;
      } else {
        // Fetch the referenced message
        const referencedMsg = await channel.messages.fetch(message.reference.messageId);
        const refAuthor = referencedMsg.author.id === botId ? BOT_NAME : referencedMsg.author.username;
        const refContent = referencedMsg.content.substring(0, 150) + (referencedMsg.content.length > 150 ? "..." : "");
        currentMsgContext += `\nReplying to: [${refAuthor}]: ${refContent}`;
      }
    } catch {
      currentMsgContext += `\nReplying to: [could not fetch referenced message]`;
    }
  }

  context += currentMsgContext;
  context += `

=== Recent Messages ===
${formattedMessagesStr}
`;

  return context;
}

// ============================================================================
// Phase 5: Image Attachment Support (ENABLE_IMAGES=1)
// ============================================================================

/** Content block types for SDKUserMessage.message.content */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/**
 * Download an image from a URL and return as base64 content block.
 * Returns null if the download fails or the image is too large.
 */
async function downloadImageAsBase64(url: string): Promise<ContentBlock | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      warn("IMAGE", `Failed to download ${url}: ${response.status}`);
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const mediaType = contentType.split(";")[0].trim();
    if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
      warn("IMAGE", `Unsupported image type: ${mediaType} for ${url}`);
      return null;
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_IMAGE_SIZE) {
      warn("IMAGE", `Image too large: ${contentLength} bytes for ${url}`);
      return null;
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_SIZE) {
      warn("IMAGE", `Image too large after download: ${buffer.byteLength} bytes`);
      return null;
    }

    // Downscale large images to reduce token count
    const originalSize = buffer.byteLength;
    let finalBuffer: Buffer;
    let finalMediaType = mediaType;
    try {
      const image = sharp(Buffer.from(buffer));
      const metadata = await image.metadata();
      const w = metadata.width ?? 0;
      const h = metadata.height ?? 0;
      const longest = Math.max(w, h);

      if (longest > MAX_IMAGE_DIMENSION) {
        const scale = MAX_IMAGE_DIMENSION / longest;
        const newW = Math.round(w * scale);
        const newH = Math.round(h * scale);
        finalBuffer = await image
          .resize(newW, newH, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
        finalMediaType = "image/jpeg";
        log("IMAGE", `Downscaled ${w}x${h} -> ${newW}x${newH} (${originalSize} -> ${finalBuffer.byteLength} bytes)`);
      } else {
        finalBuffer = Buffer.from(buffer);
      }
    } catch (err) {
      warn("IMAGE", `Sharp downscale failed, using original: ${err}`);
      finalBuffer = Buffer.from(buffer);
    }

    const base64 = finalBuffer.toString("base64");
    log("IMAGE", `Downloaded ${url} (${originalSize} bytes, ${finalMediaType})`);

    return {
      type: "image",
      source: {
        type: "base64",
        media_type: finalMediaType,
        data: base64,
      },
    };
  } catch (err) {
    warn("IMAGE", `Failed to download image ${url}: ${err}`);
    return null;
  }
}

/**
 * Build content blocks for a Discord message, optionally including images.
 * When ENABLE_IMAGES=1, inline image attachments are included as base64 content blocks.
 * Returns an array of content blocks suitable for SDKUserMessage.message.content.
 */
export async function buildMessageContentBlocks(
  message: Message,
  discordContext: string
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [{ type: "text", text: discordContext }];

  if (!IMAGES_ENABLED) return blocks;

  // Collect image URLs from attachments
  const imageUrls: string[] = [];
  for (const [, attachment] of message.attachments) {
    if (attachment.contentType && SUPPORTED_IMAGE_TYPES.has(attachment.contentType)) {
      imageUrls.push(attachment.url);
    } else if (attachment.url && /\.(jpg|jpeg|png|gif|webp)$/i.test(attachment.url)) {
      imageUrls.push(attachment.url);
    }
  }

  // Collect image URLs from embeds (e.g., posted image links)
  for (const embed of message.embeds) {
    if (embed.image?.url) {
      imageUrls.push(embed.image.url);
    }
    if (embed.thumbnail?.url && !embed.url) {
      // Only include thumbnail if there's no embed URL (standalone image)
      imageUrls.push(embed.thumbnail.url);
    }
  }

  if (imageUrls.length === 0) return blocks;

  // Download images in parallel (max 4)
  const downloadPromises = imageUrls.slice(0, 4).map(downloadImageAsBase64);
  const results = await Promise.all(downloadPromises);

  for (const result of results) {
    if (result) blocks.push(result);
  }

  if (blocks.length > 1) {
    log("IMAGE", `Included ${blocks.length - 1} image(s) in message content`);
  }

  return blocks;
}
