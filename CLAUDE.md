# Project Rules

## Runtime

Bun, not Node.js. Use `bun run` for all commands.

## Verification

```bash
bun run lint        # tsc + knip + madge (types, dead code, circular deps)
```

## Banned Libraries

- `@anthropic-ai/sdk` — use `@anthropic-ai/claude-agent-sdk` (claude CLI auth, no API key)

## Banned Commands

- `rm -rf /`, `rm -rf ~/`, `rm -rf *` — destructive deletion
- `dd` to `/dev/`, `mkfs`, redirects to `/dev/sd*` — disk destruction
- `curl ... | bash`, `wget ... | sh` — remote code execution
- `chmod 777`, `chmod +s`, `chown root` — dangerous permissions
- Any command that deletes files outside of `agent-data/`

## Dependencies — DO NOT REMOVE

**`debug`** — required transitive dep. `discord.js-selfbot-v13` → `werift-rtp` uses `require("debug")` without declaring it. Keep installed or Bun fails to resolve.

## Code Conventions

**Atomic writes:** Always use `atomicWriteFile()` from `src/persistence.ts` for state files. Never raw `fs.writeFile()` — crashes corrupt data.

**Branded types:** IDs use compile-time branded types (`UserId`, `ChannelId`, `SessionId`). Wrap raw strings at system boundaries with `userId()`, `channelId()`, `sessionId()` from `src/agent-types.ts`.

**JSONL files** (transcripts, impressions): append-only. Never modify existing lines.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture, file structure, running, and linting docs.
