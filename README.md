# Greg

A self-improving AI that lives in your Discord group chat as a real participant — not a bot you summon, but a personality that listens, remembers, forms opinions about people, and rewrites its own behavior over time.

Built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk). No fine-tuning, no weight updates — everything runs on a frozen model with prompt-level adaptation.

> **Disclaimer:** Greg is a **selfbot** (runs as a user account via `discord.js-selfbot-v13`). This violates Discord's Terms of Service. Provided for **educational and research purposes only**. Use at your own risk.

## This is not a chatbot

Most AI bots — including CLI agent frameworks like [OpenClaw](https://github.com/openclaw) — are **tool agents**. You give them a task, they execute it. They're assistants.

Greg is a **social agent**. The hard problem isn't "execute the right command." It's "should I even be talking right now?" There's no benchmark for that. The evaluation function is whether real people in a real group chat want him around.

**Greg decides when to talk.** A response gate tracks conversation confidence — how likely is a reply welcome right now? Sometimes the answer is "stay quiet." Real people don't respond to every message. Neither should a bot.

**Greg gets better while idle.** When nobody's chatting, an idle loop runs self-directed skills — reviewing conversations, updating notes on people, reflecting on what's working. He's always refining his understanding, even when the chat is dead.

**Greg rewrites his own personality.** The persona file isn't config you write once. It's an output of the system. Behavioral patterns the bot discovers get promoted into the persona itself. The bot you deploy is not the bot you have a month later.

## How it works

### Layered memory

| Layer | What it stores | How it evolves |
|-------|---------------|----------------|
| **Transcripts** | Every conversation, append-only JSONL | Raw record, never modified |
| **Impressions** | Per-user observations ("sarcastic," "hates being corrected") | Weight decay on old entries, consolidation merges redundant ones |
| **Learned patterns** | Behavioral insights ("shorter replies land better," "don't explain jokes") | Proven patterns promoted into persona |
| **Persona** | The bot's personality and identity | Rewritten by the bot based on accumulated experience |

This isn't RAG. There's no vector store, no semantic similarity search over chunks. Each layer has a specific structure, a specific update mechanism, and a specific decay/promotion lifecycle.

### The idle loop

The bot is idle 90%+ of the time. That time is productive:

- **Conversation logging** (30min) — extract insights from recent transcripts
- **Pattern learning** (6hr) — reflect on interactions, write behavioral observations
- **Self-reflection** (12hr) — step back, evaluate overall approach and blind spots
- **Impression consolidation** (daily) — merge per-user notes, decay old observations
- **Hypothesis review** (daily) — test hypotheses about users against new evidence

Skills are markdown files with prompts and cooldowns. Adding a new idle behavior is creating a file.

The system is cost-conscious by design: it skips skills when there's no new data to process, skips the selector model when only one skill is eligible, and uses cheap models (Haiku) for gating decisions while reserving expensive models (Sonnet) for actual work.

### Conversation handling

- **Turn queue** — debounces rapid messages, coalesces related inputs, retries transient errors
- **Streaming sessions** — long-lived Claude sessions maintain full conversation context
- **Post-turn review** — a fast model checks every response for missed opportunities (should you have searched for that? sent a GIF?) and retries if so
- **Tool use** — GIF search, web search, transcript search (FTS5), background research, file operations
- **Access control** — PreToolUse hooks enforce path restrictions for non-creator users

## Setup

### Requirements

- [Bun](https://bun.sh) runtime
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) (authenticated — the Agent SDK uses CLI auth, no API key needed)
- A Discord user account token

### Quick start

```bash
git clone https://github.com/noopz/greg.git
cd greg
bun install

cp .env.example .env
# Edit .env with your values (see below)

bun run dev          # Development with watch mode
bun run start        # Production
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Discord user token (DevTools -> Network -> Authorization header) |
| `CREATOR_USER_ID` | Yes | Your Discord user ID (right-click -> Copy User ID) |
| `CHANNEL_IDS` | Yes | Comma-separated Discord channel IDs to watch (from URL) |
| `BOT_NAME` | No | Display name (default: "Greg") |
| `KLIPY_API_KEY` | No | GIF search via [Klipy](https://partner.klipy.com/api-keys) (free) |
| `ENABLE_IMAGES` | No | Set to "1" to enable image vision |
| `LOG_TO_FILE` | No | File logging (default: true) |

### Persona

On first run, Greg needs an identity. A sample `agent-data/persona.md` is included — it's an example, not something to run as-is.

1. Update the **name** and **Discord username** to match your bot's account
2. Update the **trigger words** (names/phrases the bot responds to)
3. **Rewrite the personality.** This defines everything about how the bot behaves. Make it yours.

The persona gets loaded into every conversation turn. Over time, the bot will modify it based on what it learns.

Other optional files in `agent-data/`:
- `learned-patterns.md` — behavioral insights the bot accumulates over time
- `values-integrity.md` — core principles that shouldn't be overridden
- `runtime-config.json` — runtime behavior settings (idle timing, disabled skills, keywords)

## Extending

Skills (`.claude/skills/`) and subagents (`.claude/agents/`) are markdown-defined and hot-reloaded. The `local/` directory convention supports personal tools and skills that don't sync to the public repo:

```
local/
  config.json        # Declares personal tool names + extra file paths
  skills/            # Personal idle skills
  tools/index.ts     # Personal MCP tools (dynamically imported at startup)
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for full architecture docs, file structure, and model usage details.

## Linting

```bash
bun run lint    # TypeScript checking + dead code detection + circular dep check
```

## License

MIT
