# Development Guide

## Architecture

A self-learning Discord selfbot using:
- `@anthropic-ai/claude-agent-sdk` - Agent SDK (uses claude CLI auth, no API key)
- `discord.js-selfbot-v13` - Discord selfbot library
- Bun runtime

### Key Patterns

1. **Hot-reload context**: Identity, memories, patterns loaded fresh from disk every turn via `systemPrompt.append`
2. **Per-session turn queues**: Prevents concurrent agent calls per channel
3. **Atomic file writes**: tmp file + rename pattern for crash safety
4. **Append-only transcripts**: JSONL format, never modify historical entries
5. **Memory flush**: At ~400k tokens, saves memories to disk. Session continues until 700k hard restart.
6. **Conversation tracking**: Hybrid per-user (2.5min) + channel-wide (45s) for natural follow-ups
7. **Impressions**: Append-only JSONL, hash-deduped, weight-sorted relationship memories

### Model Usage

- **Main agent**: Sonnet - fast, cost-effective for conversation
- **Memory flush**: Sonnet - cheaper, just needs to save memories
- **Idle behaviors**: Sonnet - cheaper, self-directed tasks
- **Behavior selection**: Haiku - cheap one-shot to pick idle activity
- **Subagents**: Chosen based on task complexity:
  - Haiku: Simple lookups, basic tasks
  - Sonnet: Research, analysis, code review
  - Opus: Complex reasoning (sparingly)

### File Structure

```
agent-data/                 # Gitignored — created at runtime, all files optional
  persona.md              # Bot identity (falls back to minimal default)
  learned-patterns.md     # Accumulated knowledge (starts empty)
  values-integrity.md     # Core principles
  hypotheses.md           # Active hypotheses being tested
  tools.md                # Tool documentation (loaded into context)
  reaction-feedback.jsonl # Emoji reaction tracking (auto-created on first reaction)
  runtime-config.json     # Runtime config overrides
  memories/               # Daily memory logs
  relationships/          # Per-user notes
  impressions/            # Per-user relationship impressions (JSONL)
  session.json            # Current session state
  transcripts/            # Conversation transcripts (JSONL, append-only)
  idle-state.json         # Tracks last run times for idle behaviors
  steam-user-map.json     # Discord→Steam username mappings
  steam-library-cache.json # Cached Steam game libraries

src/                        # Framework source (synced to public branch)
  # Core agent pipeline
  agent.ts                # Main agent orchestrator - turn queue, executeAgentTurn
  haiku-router.ts         # Buffer/classify/route pipeline for Haiku message triage
  context-loader.ts       # Load persona, memories, patterns, relationships from disk
  session-manager.ts      # Session lifecycle, token tracking, JSONL sync
  memory-flush.ts         # Background memory flush at ~400k token threshold
  local-config.ts         # Loads local/config.json (personal tool names, extra paths)

  # Discord integration
  bot.ts                  # Discord client setup, message handling, sending
  typing.ts               # Typing simulation (delays, chunking, URL counting)
  conversation.ts         # Hybrid conversation tracking (per-user + channel-wide)
  discord-formatting.ts   # Format Discord context, wrap external content
  response-triggers.ts    # Keyword/trigger loading and matching
  response-decision.ts    # shouldRespond() heuristic

  # Idle system
  idle.ts                 # IdleManager orchestrator
  idle-state.ts           # Idle state persistence and cooldown checks
  idle-selector.ts        # Behavior selection (Haiku + fallback)
  idle-executor.ts        # Execute idle behaviors via SDK query
  skill-loader.ts         # Parse SKILL.md files into behavior configs (scans .claude/skills/ + local/skills/)

  # Observability
  audit.ts                # File watchers for config/persona/memory changes
  file-watcher.ts         # Generic file watcher factory (used by audit.ts)
  log.ts                  # Timestamped logging with daily file rotation

  # Infrastructure
  paths.ts                # Centralized path constants (PROJECT_DIR, AGENT_DATA_DIR, etc.)
  persistence.ts          # Atomic file writes, session data, transcript I/O
  impressions.ts          # Relationship impression system
  security.ts             # Input sanitization, safety checks
  context-cache.ts        # File content caching with TTL
  reasoning-tags.ts       # Extract/strip reasoning tags from responses
  system-prompt-minimal.ts # Minimal system prompt
  custom-tools.ts          # MCP tool server for framework Discord tools
  index.ts                # Entry point

  config/
    identity.ts           # BOT_NAME env var constant
    schema.ts             # Zod schema for runtime-config.json
    runtime-config.ts     # Config loading, validation, operator bounds clamping

  extensions/
    types.ts              # Extension interface and hook parameter types
    loader.ts             # Discovery, composition, file-watcher hot-reload

local/                      # Personal content (tracked on main, absent on public)
  config.json             # Declares personal tool names + extra paths
  extensions/             # Composable extensions (see EXTENSIONS.md)
  skills/                 # Personal idle skills
  tools/                  # Personal MCP tool code (game_lookup, etc.)
    index.ts              # Exports registerTools() function
  plugins/                # Personal scripts (Steam game picker, etc.)
  docs/                   # Design documentation
```

### Token Management

- **Soft threshold (400k)**: Triggers memory flush — saves important memories to disk. Session continues.
- **Hard restart (700k)**: Tears down session and starts fresh.
- **SDK auto-compaction**: Safety net if neither threshold fires.
- **Token tracking**: Read from SDK's JSONL file (`latestContextSize`), NOT cumulative billing

### SDK Token Tracking (IMPORTANT)

**For billing** use `result.total_cost_usd` - this is authoritative.

**For context size tracking**, do NOT use `result.modelUsage` - it reports cumulative billing across all agentic steps (tool calls), which double-counts cached tokens.

**Correct approach**: Read the SDK's JSONL session file and use the most recent turn's `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. This is implemented in `persistence.ts:countTokensFromClaudeSession()`.

## Linting

```bash
bun run lint   # Run knip to find dead code
```

Knip is configured in `knip.json`. Run it before commits to catch:
- Unused dependencies
- Unused exports
- Unused files

## Running

```bash
bun run dev    # Development with watch
bun run start  # Production
```

Requires environment variables:
- `DISCORD_TOKEN` - Discord selfbot token
- `CREATOR_USER_ID` - Your Discord user ID
- `CHANNEL_IDS` - Comma-separated channel IDs to monitor
- `KLIPY_API_KEY` - GIF search (optional but recommended)
- `BOT_NAME` - Bot display name (default: "Greg") — used in prompts, logs, and identity strings
- `ENABLE_IMAGES` - Set to "1" to enable image vision

**Note:** If you change `BOT_NAME`, transcript search for historical bot messages may miss old entries (they were indexed under the previous name). This is an acceptable trade-off for a deploy-time identity config.

## Key Skills

```
.claude/skills/                     # Framework skills (synced to public)
  pattern-promotion/              # Idle: promote validated learned patterns (24h cooldown)
  impression-consolidation/       # Idle: maintain and consolidate impressions
  memory-maintenance/             # Idle: review and consolidate old memories
  conversation-logging/           # Manual conversation logging
  skill-creation/                 # Reference guide for creating new skills
  pattern-learning/               # Reflect on interactions and update patterns
  self-reflection/                # Step back and think about what's working

local/skills/                       # Personal skills (NOT synced to public)
  game-picker/                    # Game recommendation using Steam library data
  steam-refresh/                  # Idle: refresh Steam game database
  pot-stirrer/                    # Idle: casual conversation starter
  daily-share/                    # Idle: share interesting finds
  game-info/                      # Idle: game info research
  game-info-maintenance/          # Idle: maintain game update files
```

## `local/` Convention

Personal content lives in `local/` — tracked on `main`, absent on `public`. Framework code
reads from `local/config.json` to discover personal tool names and extra file paths. When
`local/` doesn't exist (public branch or fresh clone), all config getters return empty arrays.

To sync framework changes to the public branch:
```bash
bash scripts/sync-public.sh
# Review staged changes, then commit
```
