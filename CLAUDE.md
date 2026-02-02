# Greg - Discord Self-Learning Agent

## Banned Libraries

**DO NOT USE:**
- `@anthropic-ai/sdk` - This project uses `@anthropic-ai/claude-agent-sdk` which leverages the claude CLI for auth. No API key is needed. Never install or import the direct Anthropic SDK.

## Banned Commands

**NEVER RUN THESE BASH COMMANDS:**
- `rm -rf /` or `rm -rf ~/` or `rm -rf *` - Destructive deletion
- `dd` to `/dev/` devices - Disk destruction
- `mkfs` - Filesystem formatting
- `:(){ :|:& };:` - Fork bombs
- `curl ... | bash` or `wget ... | sh` - Remote code execution
- `chmod 777` or `chmod +s` - Dangerous permissions
- `chown root` - Privilege escalation
- Redirects to `/dev/sd*` - Disk overwrites
- Any command that deletes files outside of `agent-data/`
- Any command that modifies system files

## Architecture

Greg is a self-learning Discord selfbot using:
- `@anthropic-ai/claude-agent-sdk` - Agent SDK (uses claude CLI auth, no API key)
- `discord.js-selfbot-v13` - Discord selfbot library
- Bun runtime

### Key Patterns

1. **Hot-reload context**: Identity, memories, patterns loaded fresh from disk every turn via `systemPrompt.append`
2. **Per-session turn queues**: Prevents concurrent agent calls per channel
3. **Atomic file writes**: tmp file + rename pattern for crash safety
4. **Append-only transcripts**: JSONL format, never modify historical entries
5. **Context compaction**: Summarizes old messages when approaching token limits

### File Structure

```
agent-data/
  persona.md              # Greg's identity
  learned-patterns.md     # Accumulated knowledge
  memories/               # Daily memory logs
  relationships/          # Per-user notes
  compaction-summaries/   # Conversation summaries after compaction
  session.json            # Current session state
  transcripts/            # Our own JSONL transcripts
```

### Token Management

- **Soft threshold (116k)**: Triggers memory flush - agent saves important memories
- **Hard threshold (120k)**: Triggers compaction - summarizes old messages, resets session

## Running

```bash
bun run dev    # Development with watch
bun run start  # Production
```

Requires `DISCORD_TOKEN` and `CREATOR_ID` environment variables.
