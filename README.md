# Greg

A self-learning Discord bot built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk). Greg lives in your group chat as a persistent personality — he remembers conversations, forms opinions, learns behavioral patterns, and develops relationships with individual users over time.

Supports two Discord client modes:
- **Selfbot mode** (default) — runs as a user account via `discord.js-selfbot-v13`, lives in group DMs
- **Bot mode** — runs as an official bot account via `discord.js` v14, lives in guild servers

Set `DISCORD_CLIENT_MODE=selfbot` or `DISCORD_CLIENT_MODE=bot` in your `.env`.

> **Disclaimer:** This project is provided for **educational and research purposes only**. Selfbot mode violates Discord's Terms of Service. I am not responsible for any Discord accounts that are suspended or banned as a result of using this software. No support is provided. Use entirely at your own risk.

## What makes it different

Most AI bots are stateless assistants — they answer questions and forget you exist. Greg is designed to be a **persistent member of your friend group**:

- **Remembers everything** — writes memories to disk, maintains per-user relationship notes, tracks conversation patterns. Ask about something from two weeks ago and it knows.
- **Learns and adapts** — updates its own behavioral patterns based on what works and what doesn't. Gets better at matching your group's vibe over time.
- **Acts, doesn't just talk** — uses tools (GIF search, web search, file operations, transcript search) on its own initiative. A post-turn reviewer catches missed opportunities and retries.
- **Has downtime behaviors** — when nobody's talking, it researches topics, maintains memories, consolidates patterns, or starts conversations based on configurable idle skills.
- **Knows its boundaries** — access control gives the creator full file/shell access while other users are path-gated to safe operations.

## Features

- **Streaming sessions** — long-lived Claude sessions via the Agent SDK with full conversation context
- **Turn queue** — debouncing, message coalescing, and transient error retry
- **Response gate** — decides whether to respond using conversation confidence tracking (not every message needs a reply)
- **Self-improvement** — writes memories, updates relationship files, refines behavioral patterns, creates new skills and subagents
- **Idle behaviors** — skill-based autonomous actions with configurable cooldowns
- **Tool use** — GIF search, transcript search (FTS5), background research tasks, file operations, web search
- **Post-turn review** — Haiku reviewer with ReAct loop checks for missed tool opportunities
- **Access control** — PreToolUse hooks enforce path restrictions for non-creator users

## Requirements

- [Bun](https://bun.sh) runtime
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) (authenticated — the Agent SDK uses CLI auth, no API key needed)
- A Discord user account token

## Setup

```bash
# Clone and install
git clone https://github.com/noopz/greg.git
cd greg
bun install

# Configure
cp .env.example .env
# Edit .env with your values (see below)

# Run
bun run dev          # Development with watch mode
bun run start        # Production
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Selfbot: user token (DevTools → Authorization header). Bot: bot token from Developer Portal. |
| `DISCORD_CLIENT_MODE` | No | `selfbot` (default) or `bot` |
| `CREATOR_USER_ID` | Yes | Your Discord user ID (right-click → Copy User ID) |
| `CHANNEL_IDS` | Yes | Comma-separated Discord channel IDs to watch |
| `BOT_NAME` | No | Display name (default: "Greg") |
| `KLIPY_API_KEY` | No | GIF search via [Klipy](https://partner.klipy.com/api-keys) (free) |
| `ENABLE_IMAGES` | No | Set to "1" to enable image vision |
| `LOG_TO_FILE` | No | File logging (default: true) |

### Bot mode setup

If using `DISCORD_CLIENT_MODE=bot`, you need to:

1. Create a Discord Application at [discord.com/developers](https://discord.com/developers)
2. Enable the **MESSAGE_CONTENT** privileged intent in Bot settings (without this, `message.content` is silently empty)
3. Generate a bot token and set it as `DISCORD_TOKEN`
4. Invite the bot to your server with permissions: View Channels, Send Messages, Read Message History, Add Reactions
5. Your `CHANNEL_IDS` should be guild text channel IDs (not group DM IDs)

### Initial persona

On first run, the bot needs an identity. A **sample** `agent-data/persona.md` is included as a starting point — it's an example personality, not something you should run as-is. **You must customize it:**

1. Update the **name** and **Discord username** on line 5 to match your bot's Discord account
2. Update the **trigger words** on line 6 (these are the names/phrases the bot responds to)
3. **Rewrite the personality** to fit your bot — the sample persona is just one example of what's possible. Make it your own.

The persona is loaded into every conversation turn and defines how the bot behaves. The more thought you put into it, the more distinct your bot will feel.

Other optional files in `agent-data/`:
- `learned-patterns.md` — behavioral insights the bot accumulates
- `values-integrity.md` — core principles
- `runtime-config.json` — runtime behavior settings (idle timing, disabled skills, keywords)

## Architecture

See [DEVELOPMENT.md](DEVELOPMENT.md) for full architecture docs, file structure, model usage, and token management details.

### Key concepts

- **Skills** (`.claude/skills/`) — markdown-defined behaviors with optional idle triggers and cooldowns
- **Subagents** (`.claude/agents/`) — specialized helpers spawned via the Task tool (e.g., web-lookup, meme-finder)
- **Streaming sessions** — persistent Claude sessions that maintain conversation context across messages
- **Access control** — PreToolUse hooks enforce path restrictions for non-creator users
- **Transcript search** — FTS5-indexed conversation history, searchable via the `search_transcripts` tool

### Extending with personal tools

The framework supports a `local/` directory convention for personal content that doesn't get synced to the public repo:

```
local/
  config.json        # Declares personal tool names + extra file paths
  skills/            # Personal idle skills
  tools/index.ts     # Personal MCP tools (dynamically imported at startup)
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for details on the `local/` convention.

## Linting

```bash
bun run lint    # TypeScript checking + dead code detection + circular dep check
```

## License

MIT
