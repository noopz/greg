/**
 * Custom MCP Tools
 *
 * Centralized registry of custom tools available to the bot.
 * Created once at startup, reused across all agent executions
 * (idle behaviors, main conversation, forked sessions).
 *
 * Adding a new tool:
 * 1. Add tool definition below using the `tool()` helper
 * 2. Update agent-data/tools.md so the bot can discover it
 */

import { Client, TextChannel } from "discord.js-selfbot-v13";
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type BotConfig } from "./bot-types";
import { sendWithTypingSimulation } from "./typing";
import { executeFollowup, canScheduleFollowup, getActiveFollowupCount } from "./followup-executor";
import { log, warn, error as logError } from "./log";
import { searchTranscripts, formatSearchResults, getSearchContext, getSearchContextForSession, getDmChannelId } from "./transcript-index";
import { getStreamingSession } from "./streaming-session";
import { recordBotActivity } from "./conversation";
import { channelId as toChannelId } from "./agent-types";
import { BOT_NAME } from "./config/identity";

// Reviewer metadata — co-located with tool definitions so adding a tool = one file to edit.
// reviewerHint: tells the reviewer WHEN to flag a missed opportunity
// additive: when true, missed use enhances the response (e.g. GIF) rather than
//   correcting it. Additive misses should NOT suppress the original response.
interface ToolReviewerMeta {
  reviewerHint?: string;
  additive?: boolean;
}

const REVIEWER_META: Record<string, ToolReviewerMeta> = {
  search_gif: {
    reviewerHint: "Short casual response (<200 chars) when a GIF would land harder — roasts, flexes, reaction moments, meta-requests about memes. Do NOT flag for substantive/technical answers or genuine emotional depth.",
    additive: true,
  },
  search_transcripts: {
    reviewerHint: "Someone asked about a SPECIFIC past conversation or event ('remember when...', 'you said...', 'didn't you talk to [person]?') and search_transcripts wasn't used. Also flag if bot claimed ignorance without searching first. ALSO flag if the bot attributes a specific statement or opinion to a named person ('X mentioned...', 'X said...', 'X brought up...') without having searched transcripts to verify the attribution — misattribution is worse than not attributing at all. Do NOT flag for rhetorical questions, banter, or roasts ('when have you ever...', 'since when does X...') — those don't need factual transcript lookup.",
  },
  schedule_followup: {
    reviewerHint: "Bot promised research or a lookup without calling WebSearch or schedule_followup.",
  },
};

export interface ToolSummary {
  name: string;
  description: string;
  reviewerHint?: string;
  additive?: boolean;
}

let cachedToolSummaries: ToolSummary[] = [];

/** Get MCP tool summaries (name + first-sentence description + reviewer metadata) for the post-turn reviewer. */
export function getToolSummaries(): ToolSummary[] {
  return cachedToolSummaries;
}

/** Check if a tool is additive (enhances response) vs corrective (replaces response). */
export function isAdditiveTool(toolName: string): boolean {
  // Normalize MCP tool names (mcp__custom-tools__search_gif → search_gif)
  const shortName = toolName.replace(/^mcp__[^_]+__/, "");
  const summary = cachedToolSummaries.find(t => t.name === shortName);
  return summary?.additive ?? false;
}

/**
 * Resolve a channel alias, env var reference, or raw ID to a concrete channel ID.
 * Returns { channelId } on success or { error } with a user-facing error message.
 */
function resolveChannelAlias(
  rawId: string,
  channelAliases: Record<string, string>
): { channelId: string } | { error: string } {
  const aliasLower = rawId.toLowerCase().replace(/^["']|["']$/g, "");
  if (channelAliases[aliasLower]) {
    log("MCP", `Resolved alias "${aliasLower}" -> ${channelAliases[aliasLower]}`);
    return { channelId: channelAliases[aliasLower] };
  }
  if (rawId.startsWith("$")) {
    const resolved = process.env[rawId.slice(1)];
    if (resolved) {
      log("MCP", `Resolved env ${rawId} -> ${resolved}`);
      return { channelId: resolved };
    }
    return { error: `Unknown alias or env var "${rawId}". Available aliases: ${Object.keys(channelAliases).filter(k => channelAliases[k]).join(", ")}` };
  }
  return { channelId: rawId };
}

/**
 * Create the Greg Tools MCP server.
 * Captures client and config via closure for in-process access.
 */
export async function createToolsServer(
  client: Client,
  config: BotConfig,
  channelAliases: Record<string, string> = {}
) {
  const aliasNames = Object.entries(channelAliases)
    .filter(([, v]) => v)
    .map(([k, v]) => `"${k}" -> ${v}`)
    .join(", ");

  const tools: SdkMcpToolDefinition<any>[] = [
    tool(
        "send_to_channel",
        `Send a message to a Discord channel with natural typing simulation. Use when a skill or idle behavior needs to post to chat. Available aliases: ${Object.keys(channelAliases).filter(k => channelAliases[k]).join(", ")}. Or pass a raw channel ID.`,
        {
          channel_id: z.string().describe('Channel alias (e.g. "group", "primary") or a raw Discord channel ID snowflake.'),
          message: z.string().describe("The message text to send"),
        },
        async (args) => {
          try {
            // Resolve channel alias
            const resolved = resolveChannelAlias(args.channel_id, channelAliases);
            if ("error" in resolved) {
              return { content: [{ type: "text" as const, text: `Error: ${resolved.error}` }] };
            }
            const channelId = resolved.channelId;

            const channel = await client.channels.fetch(channelId);
            if (!channel || !("send" in channel)) {
              warn("MCP", `send_to_channel: channel ${channelId} not found or not a text channel`);
              return {
                content: [{ type: "text" as const, text: `Error: Channel ${channelId} not found or not a text channel` }],
              };
            }

            await sendWithTypingSimulation(
              channel as TextChannel,
              args.message
            );

            log("MCP", `send_to_channel: Sent to ${channelId} (${args.message.length} chars)`);

            // Track channel activity so follow-up messages from users get
            // conversation confidence ("low" or higher) instead of "none".
            // Without this, idle skills (pot-stirrer, etc.) send messages but
            // the conversation tracker doesn't know Greg spoke, causing
            // replies to be gated as "Cold start, no keyword match."
            recordBotActivity(toChannelId(channelId));

            return {
              content: [{ type: "text" as const, text: "Message sent successfully" }],
            };
          } catch (err) {
            logError("MCP", "send_to_channel failed", err);
            return {
              content: [{ type: "text" as const, text: `Error sending message: ${err}` }],
            };
          }
        }
      ),

    tool(
        "get_channel_history",
        `Fetch recent messages from a Discord channel. Returns the last N messages formatted as "[ISO timestamp] [Username]: content". Use timestamps to gauge how active/dead the chat is. Same aliases as send_to_channel: ${Object.keys(channelAliases).filter(k => channelAliases[k]).join(", ")}.`,
        {
          channel_id: z.string().describe('Channel alias (e.g. "group") or a raw Discord channel ID snowflake.'),
          limit: z.number().min(1).max(25).default(10).describe("Number of messages to fetch (1-25, default 10)"),
        },
        async (args) => {
          try {
            const resolved = resolveChannelAlias(args.channel_id, channelAliases);
            if ("error" in resolved) {
              return { content: [{ type: "text" as const, text: `Error: ${resolved.error}` }] };
            }
            const channelId = resolved.channelId;

            const channel = await client.channels.fetch(channelId);
            if (!channel || !("messages" in channel)) {
              return { content: [{ type: "text" as const, text: `Error: Channel ${channelId} not found or has no messages` }] };
            }

            const messages = await (channel as TextChannel).messages.fetch({ limit: args.limit });
            const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
            const botId = client.user?.id;

            const lines = sorted.map(msg => {
              const author = msg.author.id === botId ? BOT_NAME : `${msg.author.username}@${msg.author.id}`;
              const timestamp = msg.createdAt.toISOString();
              return `[${timestamp}] [${author}]: ${msg.content}`;
            });

            log("MCP", `get_channel_history: Fetched ${lines.length} messages from ${channelId}`);
            return { content: [{ type: "text" as const, text: lines.join("\n") }] };
          } catch (err) {
            logError("MCP", "get_channel_history failed", err);
            return { content: [{ type: "text" as const, text: `Error fetching history: ${err}` }] };
          }
        }
      ),

    tool(
        "search_gif",
        `Search for GIFs and reaction images. GIFs are your native communication — a reaction GIF often IS the response, not a supplement. Use proactively for roasts, flexes, reaction moments, and banter where a GIF hits harder than text.

Examples:
- "you're washed" → search_gif({query: "washed up old man"})
- "I just got a 6k" → search_gif({query: "shocked jaw drop"})
- "think you can keep up?" → search_gif({query: "bring it on"})
- "lol true" → no GIF needed, genuinely minimal exchange

When the moment calls for a reaction, search first, text second. Send ONLY the GIF URL — no text in the same message. The GIF IS the response, not a supplement to text. Discord auto-embeds it.`,
        {
          query: z.string().describe("Search query (e.g. 'old gregg', 'confused cat')"),
          type: z.enum(["gifs", "memes", "stickers"]).default("gifs").describe("Content type to search"),
          limit: z.number().min(1).max(10).default(5).describe("Number of results (1-10, default 5)"),
        },
        async (args) => {
          const apiKey = process.env.KLIPY_API_KEY;
          if (!apiKey) {
            return { content: [{ type: "text" as const, text: "Error: KLIPY_API_KEY not set" }] };
          }

          try {
            const q = encodeURIComponent(args.query);
            const url = `https://api.klipy.com/api/v1/${apiKey}/${args.type}/search?q=${q}&per_page=${args.limit}`;
            const res = await fetch(url);

            if (!res.ok) {
              return { content: [{ type: "text" as const, text: `Error: Klipy API returned ${res.status}` }] };
            }

            const json = await res.json() as {
              result: boolean;
              data: { data: Array<{ title: string; file: { hd: { gif: { url: string } } } }> };
            };

            if (!json.result || !json.data?.data?.length) {
              return { content: [{ type: "text" as const, text: `No results found for "${args.query}"` }] };
            }

            // Validate URLs with parallel HEAD requests (filter out dead links)
            const validated = await Promise.all(
              json.data.data.map(async (item) => {
                try {
                  const head = await fetch(item.file.hd.gif.url, {
                    method: "HEAD",
                    signal: AbortSignal.timeout(3000),
                  });
                  return head.ok ? item : null;
                } catch {
                  return null;
                }
              })
            );
            const validItems = validated.filter((item): item is NonNullable<typeof item> => item !== null);

            if (validItems.length === 0) {
              log("MCP", `search_gif: All ${json.data.data.length} results failed validation for "${args.query}"`);
              return { content: [{ type: "text" as const, text: `No valid results for "${args.query}" — try different search terms` }] };
            }

            const results = validItems.map((item, i) =>
              `${i + 1}. ${item.title}: ${item.file.hd.gif.url}`
            ).join("\n");

            log("MCP", `search_gif: ${validItems.length}/${json.data.data.length} valid results for "${args.query}"`);
            return { content: [{ type: "text" as const, text: results }] };
          } catch (err) {
            logError("MCP", "search_gif failed", err);
            return { content: [{ type: "text" as const, text: `Error searching Klipy: ${err}` }] };
          }
        }
      ),

    tool(
        "react_to_message",
        `React to a Discord message with an emoji. Use for acknowledgments, agreement, or when an emoji reaction fits better than a text response. Same aliases as send_to_channel: ${Object.keys(channelAliases).filter(k => channelAliases[k]).join(", ")}.`,
        {
          message_id: z.string().describe("The Discord message ID to react to"),
          emoji: z.string().describe("The emoji to react with (e.g. '👍', '😂', '💀', '🔥')"),
          channel_id: z.string().describe('Channel alias (e.g. "group") or raw Discord channel ID'),
        },
        async (args) => {
          try {
            const resolved = resolveChannelAlias(args.channel_id, channelAliases);
            if ("error" in resolved) {
              return { content: [{ type: "text" as const, text: `Error: ${resolved.error}` }] };
            }
            const channelId = resolved.channelId;

            const channel = await client.channels.fetch(channelId);
            if (!channel || !("messages" in channel)) {
              return { content: [{ type: "text" as const, text: `Error: Channel ${channelId} not found or not a text channel` }] };
            }

            const message = await (channel as TextChannel).messages.fetch(args.message_id);
            await message.react(args.emoji);

            log("MCP", `react_to_message: Reacted ${args.emoji} to ${args.message_id} in ${channelId}`);
            return { content: [{ type: "text" as const, text: `Reacted ${args.emoji} to message` }] };
          } catch (err) {
            logError("MCP", "react_to_message failed", err);
            return { content: [{ type: "text" as const, text: `Error reacting to message: ${err}` }] };
          }
        }
      ),

    tool(
        "search_transcripts",
        `Search your past conversation transcripts using FTS5. Use when someone references a past conversation or event — whether between you and them, or you and someone else.

Query syntax (FTS5 — write queries directly):
- "marvel rivals"  → exact phrase match
- stuck AND queue   → both words required
- stuck OR frozen   → either word
- REDACTED_USER NOT roast    → exclude term
- stream*           → prefix match (streaming, streamed, etc.)
- Plain words without operators default to OR (any word matches, best matches ranked higher)

Examples:
- "didn't you talk to REDACTED_USER about that?" → search_transcripts({query: 'REDACTED_USER AND [topic]'})
- "remember when you roasted REDACTED_USER" → search_transcripts({query: '"roasted" AND REDACTED_USER'})
- "you said marvel rivals was bad" → search_transcripts({query: '"marvel rivals"'})

Returns snippets ranked by relevance. Do NOT pass channel_id unless you specifically want to limit results to one channel — conversations often happen across channels, so omitting it searches everything.`,
        {
          query: z.string().min(1).describe('FTS5 query. Use AND/OR/NOT, "exact phrases", prefix* matching. Be specific — use names, topics, or distinctive words.'),
          limit: z.number().min(1).max(10).default(5).describe("Number of results (1-10, default 5)"),
          channel_id: z.string().optional().describe('Optional channel alias or ID to restrict search to a single channel. Usually omit this. Non-creator searches are always filtered to the current channel.'),
        },
        async (args) => {
          try {
            // Use session-keyed context to avoid race conditions
            // between concurrent creator/public sessions
            const creatorSess = getStreamingSession(true);
            const publicSess = getStreamingSession(false);
            // Check which session is active (non-idle)
            const activeSession = !creatorSess.isIdle() && creatorSess.sessionId
              ? creatorSess
              : (!publicSess.isIdle() && publicSess.sessionId ? publicSess : null);
            const searchCtx = activeSession?.sessionId
              ? getSearchContextForSession(activeSession.sessionId) ?? getSearchContext()
              : getSearchContext();

            // Resolve channel_id alias if provided
            let filterChannelId = args.channel_id;
            if (filterChannelId) {
              const resolved = resolveChannelAlias(filterChannelId, channelAliases);
              if ("error" in resolved) {
                return { content: [{ type: "text" as const, text: `Error: ${resolved.error}` }] };
              }
              filterChannelId = resolved.channelId;
            }

            // Security: non-creator turns are always filtered to their channel
            if (!searchCtx.isCreator) {
              filterChannelId = searchCtx.channelId ?? filterChannelId;
            }

            let results = searchTranscripts(args.query, {
              limit: args.limit,
              channelId: filterChannelId,
            });

            // Non-creator: explain when search was channel-restricted and found nothing
            if (results.length === 0 && !searchCtx.isCreator && filterChannelId) {
              return { content: [{ type: "text" as const, text: "No results found for that query in this channel. Note: I can only search the current channel here." }] };
            }

            // Auto-broaden: if creator search with channel filter yields 0 results,
            // retry without filter — conversations often happen in other channels.
            if (results.length === 0 && filterChannelId && searchCtx.isCreator) {
              let broadened = searchTranscripts(args.query, { limit: args.limit });
              // If searching from a group context, exclude DM results (DMs are confidential)
              const dmChannelId = channelAliases["dm"] || getDmChannelId();
              if (searchCtx.isGroupDm && dmChannelId) {
                broadened = broadened.filter(r => r.channelId !== dmChannelId);
              }
              if (broadened.length > 0) {
                log("MCP", `search_transcripts: "${args.query}" -> 0 in channel ${filterChannelId}, broadened to ${broadened.length} across all channels`);
                const formatted = formatSearchResults(broadened);
                return { content: [{ type: "text" as const, text: `(No results in the filtered channel — broadened to all channels)\n\n${formatted}` }] };
              }
            }

            const formatted = formatSearchResults(results);
            log("MCP", `search_transcripts: "${args.query}" -> ${results.length} results${filterChannelId ? ` (channel ${filterChannelId})` : ""}`);
            return { content: [{ type: "text" as const, text: formatted }] };
          } catch (err) {
            logError("MCP", "search_transcripts failed", err);
            return { content: [{ type: "text" as const, text: `Error searching transcripts: ${err}` }] };
          }
        }
      ),

    tool(
        "schedule_followup",
        `Schedule a background task that runs without blocking the conversation. Forks from the current session (getting conversation context for free), runs with full file tools (Read/Write/Edit) plus WebSearch/WebFetch, and posts results to the channel when done. Two use cases: (1) Background research — look something up and post findings. (2) Silent file updates — update relationship files, memories, or impressions when you don't have file tools on the current turn. For silent file updates, be specific about what to write (the followup has conversation context but needs clear instructions). Available aliases: ${Object.keys(channelAliases).filter(k => channelAliases[k]).join(", ")}.`,
        {
          task: z.string().describe("What to do — be specific. For research: 'find OW patch notes for feb 2026'. For file updates: 'Update REDACTED_USER relationship file: has max level toons on UO:R with REDACTED_USER'"),
          channel_id: z.string().describe('Channel alias (e.g. "group") or raw Discord channel ID. For silent file updates, still pass the channel (used as fallback only).'),
        },
        async (args) => {
          if (!canScheduleFollowup()) {
            return { content: [{ type: "text" as const, text: "Too many follow-ups running. Try again later." }] };
          }

          const resolved = resolveChannelAlias(args.channel_id, channelAliases);
          if ("error" in resolved) {
            return { content: [{ type: "text" as const, text: `Error: ${resolved.error}` }] };
          }
          const channelId = resolved.channelId;

          const channel = await client.channels.fetch(channelId);
          if (!channel || !("send" in channel)) {
            return { content: [{ type: "text" as const, text: `Error: Channel ${channelId} not found or not a text channel` }] };
          }

          executeFollowup(args.task, channel as TextChannel)
            .catch(err => logError("MCP", "Follow-up failed", err));

          log("MCP", `schedule_followup: Scheduled "${args.task.substring(0, 60)}" -> ${channelId} (${getActiveFollowupCount()} active)`);
          return { content: [{ type: "text" as const, text: "Follow-up scheduled. Results will be posted when ready." }] };
        }
      ),
  ];

  // Capture tool summaries for the post-turn reviewer (first sentence of each description + reviewer hint)
  cachedToolSummaries = tools.map(t => {
    const meta = REVIEWER_META[t.name];
    return {
      name: t.name,
      description: t.description.split('. ')[0] + '.',
      ...(meta?.reviewerHint ? { reviewerHint: meta.reviewerHint } : {}),
      ...(meta?.additive ? { additive: true } : {}),
    };
  });

  log("MCP", `Registered ${tools.length} framework tools: ${tools.map(t => t.name).join(", ")}`);
  log("MCP", `Channel aliases: ${aliasNames}`);

  // Load local tools if local/tools/index.ts exists (personal tools not synced to public)
  try {
    const localModule = await import("../local/tools/index");
    if (localModule.registerTools) {
      const result = localModule.registerTools({ tool, z, log, logError, client, config, channelAliases });
      if (result?.tools) {
        tools.push(...result.tools);
        // Merge reviewer meta for future lookups
        if (result.reviewerMeta) Object.assign(REVIEWER_META, result.reviewerMeta);
        // Rebuild summaries to include local tools
        cachedToolSummaries = tools.map(t => {
          const meta = REVIEWER_META[t.name] ?? {};
          return {
            name: t.name,
            description: t.description.split('. ')[0] + '.',
            ...(meta.reviewerHint ? { reviewerHint: meta.reviewerHint } : {}),
            ...(meta.additive ? { additive: true } : {}),
          };
        });
      }
      log("MCP", `Loaded ${result?.tools?.length ?? 0} local tool(s)`);
    }
  } catch {
    // local/tools/ doesn't exist — running on public branch
  }

  return createSdkMcpServer({
    name: "custom-tools",
    version: "1.0.0",
    tools,
  });
}
