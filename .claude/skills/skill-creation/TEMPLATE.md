# Skill Template

## Minimal Chat Skill

```markdown
---
name: my-skill
description: Does X when someone asks about Y. Use when the user mentions Z.
allowed-tools: Read, Grep, WebSearch
---

# My Skill

[Concise instructions — what to do, not how Claude works]

## When to Use

When users ask about Y or mention Z.
```

## Chat + Idle Skill

```markdown
---
name: my-skill
description: Does X when asked, and periodically checks for updates during idle.
allowed-tools: Read, Write, Edit, WebSearch, mcp__custom-tools__send_to_channel
---

# My Skill

[Main instructions]

## When to Use

When users ask about X or request updates on Y.

## Idle Behavior

Cooldown: 120 minutes

1. Check if there's new data worth reporting
2. If nothing new, stop immediately
3. If something notable, post via send_to_channel with channel_id "group"
```

## Idle-Only Skill

```markdown
---
name: my-maintenance
description: Periodically maintains X by checking for staleness and updating.
allowed-tools: Read, Edit, Grep
---

# My Maintenance

[What this skill maintains and why]

## Idle Behavior

Cooldown: 8 hours

1. [Check condition]
2. [If work needed, do it]
3. [If nothing needed, stop immediately — don't keep reading files]
```

## Progressive Disclosure Example

```
game-watcher/
  SKILL.md          # 50 lines: overview, when-to-use, idle steps
  STATE-FORMAT.md   # Detailed JSON schema for the state file
  SEARCH-TIPS.md    # Web search strategies for this game
```

In SKILL.md: "See [STATE-FORMAT.md](STATE-FORMAT.md) for the state file schema."

## Description Best Practices

Descriptions are critical — Claude uses them to decide which skill to activate.

**Good** (specific, says what + when):
- "Monitors WoW Race to World First and posts boss kill updates. Runs while RWF is live."
- "Recommends games when someone asks 'what should we play' by checking Steam library data."

**Bad** (vague):
- "Helps with games"
- "Does stuff periodically"

Write in third person. Include key trigger words the user might say.
