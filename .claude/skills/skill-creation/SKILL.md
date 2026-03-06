---
name: skill-creation
description: Reference guide for creating and editing skills. Read this BEFORE creating any new skill.
---

# Skill Creation Guide

Skills live in `.claude/skills/<skill-name>/SKILL.md`. Every skill serves dual purpose:

- **Manual**: Invoked via the Skill tool during conversation
- **Idle**: Runs automatically when chat goes quiet (requires `## Idle Behavior` section)

## Required Format

```markdown
---
name: skill-name
description: When to use this skill (idle system reads this to decide when to run it)
---

# Skill Name

[Instructions for what the skill does]

## Allowed Tools

Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, mcp__custom-tools__search_transcripts
(list only what the skill actually needs)

## When to Use

[Explain triggers - when should this skill activate?]

## [Any additional instruction sections]

## Idle Behavior

Cooldown: 120 minutes

[What to do when running as an idle behavior.]
[Without this section, the skill is manual-only and will NOT run automatically.]
```

## Critical Requirements

### Idle Registration

The idle system scans for `## Idle Behavior` with a `Cooldown:` line. Both are required.

- **Without `## Idle Behavior`**: Skill is manual-only, never runs on its own
- **Without `Cooldown:`**: Idle system can't schedule it, skips it
- **Cooldown format**: `Cooldown: 30 minutes` or `Cooldown: 4 hours`

### File Paths in Idle Runs

Idle runs execute in **isolated sessions** with no conversation history. The working directory is injected into the system prompt, so use relative paths like `agent-data/memories/` in skill instructions — the model will resolve them against the working directory.

**Do NOT** use hardcoded absolute paths (like `/root/agent-data/`). The project directory varies by machine.

**Do** reference files relative to the project root:
- `agent-data/memories/` — memory files
- `agent-data/relationships/` — relationship files
- `agent-data/impressions/` — impression files
- `agent-data/learned-patterns.md` — learned patterns
- `agent-data/persona.md` — persona

### Sending Messages to Discord

During idle runs, your text output goes nowhere - it's not a conversation. To post to Discord:

- Use the `send_to_channel` tool
- Set `channel_id` to `"group"` for the main group chat (the tool accepts channel aliases — check its description for the full list)
- Include `mcp__custom-tools__send_to_channel` in your Allowed Tools

### Frontmatter

- `name`: Must match the directory name
- `description`: The idle system and behavior selector read this to decide when to use the skill
- `model`: Optional. `haiku`, `sonnet`, or `opus`. Omit to use the default (sonnet)

## Examples

Look at existing skills in `.claude/skills/` for reference:

- `impression-consolidation` - Idle skill, file operations only
- `pot-stirrer` - Idle skill, sends messages to Discord via send_to_channel
- `conversation-logging` - Both manual and idle, writes to memory files

## Idle Behavior

Cooldown: 8 hours

Check if skills need improvement or if a new skill is warranted. Be efficient and deliberate.

### Step 1: Gather context (4-5 reads/searches max)

Skills live in `.claude/skills/<skill-name>/SKILL.md`. List that directory to see what exists.

Read `agent-data/learned-patterns.md` (self-corrections section especially) and the most recent memory file. Look for:
- Repeated failures or complaints about a specific skill
- Repeated manual actions that you keep doing without a skill
- Shifts in group behavior (new game everyone's playing, new shared interest)

**Also check:**
- `agent-data/hypotheses.md` — Validated patterns (especially confirmed/promoted hypotheses) may reveal skill opportunities
- `search_transcripts` — Search for repeated questions or tasks that show up in conversations but might not make it into memory files (e.g., "patch notes", "what should we play", "playtime")

### Step 2: Decide (pick ONE or do nothing)

**Improve an existing skill** — Only if there's evidence it's failing repeatedly. Read the skill file (`.claude/skills/<skill-name>/SKILL.md`), then pull the RIGHT context for that skill type:
- Pot-stirrer improvements → check recent impressions/relationships AND call `get_channel_history` to see what recent chat looks like
- Game-info skills → check what games are being discussed, what info people keep asking for
- Conversation skills → check memory files for what topics generate engagement

**Create a new skill** — Only if a pattern appeared 3+ times in recent memories AND it's a genuinely repeated action, not a one-off. Not everything needs to be a skill. A skill is justified when:
- You keep doing the same multi-step task manually (e.g., "every time someone asks about a game, I search for patch notes, player counts, and news")
- The group's behavior shifted in a way that warrants automation (e.g., "they started playing a new game and keep asking for updates")
- There's a clear trigger and a clear action

A skill is NOT justified when:
- It happened once or twice
- It's just a conversational pattern (those go in learned-patterns.md, not a skill)
- It's something you can already do with existing tools without a formalized process

**Do nothing** — This is the correct choice most of the time. If nothing jumps out from the 2-3 files you read, stop immediately. Do not keep reading files hoping to find something.

### What NOT to do
- Do NOT read all skill files to "review" them
- Do NOT create skills for things that are better captured as learned patterns
- Do NOT improve a skill based on vibes — only based on specific evidence of failure
