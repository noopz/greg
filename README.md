# Greg

A self-learning Discord bot built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk). Greg lives in your group chat as a persistent personality — he remembers conversations, forms opinions, learns behavioral patterns, and develops relationships with individual users over time.

This is a **selfbot** (runs as a user account, not a bot account). It uses `discord.js-selfbot-v13` to connect to Discord.

## What it does

- **Persistent identity** — persona, learned patterns, and memories stored on disk, hot-reloaded every turn
- **Streaming sessions** — long-lived Claude sessions with full conversation context
- **Idle behaviors** — skill-based autonomous actions (research, memory maintenance, conversation starters) that run on configurable cooldowns
- **Tool use** — GIF search, transcript search (FTS5), background research tasks, file operations, web search
- **Access control** — creator gets full access, other users are path-gated (can read/write specific files, can't run shell commands)
- **Self-improvement** — writes memories, updates relationship files, refines behavioral patterns, creates new skills and subagents
- **Post-turn review** — Haiku reviewer checks if the bot missed a tool opportunity and retries when appropriate

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
| `DISCORD_TOKEN` | Yes | Discord user token (DevTools → Network → Authorization header) |
| `CREATOR_USER_ID` | Yes | Your Discord user ID (right-click → Copy User ID) |
| `GROUP_DM_CHANNEL_ID` | Yes | Channel ID where the bot operates (from URL) |
| `BOT_NAME` | No | Display name (default: "Greg") |
| `KLIPY_API_KEY` | No | GIF search via [Klipy](https://partner.klipy.com/api-keys) (free) |
| `ENABLE_IMAGES` | No | Set to "1" to enable image vision |
| `LOG_TO_FILE` | No | File logging (default: true) |

### Initial persona

On first run, the bot needs an identity. A starter `agent-data/persona.md` is included — **you must customize it**:

1. Update the **name** and **Discord username** on line 5 to match your bot's Discord account
2. Update the **trigger words** on line 6 (these are the names/phrases the bot responds to)
3. Customize the personality to fit your bot

The persona is loaded into every conversation turn and defines how the bot behaves.

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
