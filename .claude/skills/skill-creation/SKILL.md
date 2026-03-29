---
name: skill-creation
description: Reference for creating and editing skills. Covers format, naming, frontmatter, progressive disclosure, idle registration, and dead zone handling. Read before creating any skill.
allowed-tools: Read, Write, Edit, Glob, Grep
---

# Skill Creation Reference

Read this before creating or editing any skill. For the full template, see [TEMPLATE.md](TEMPLATE.md).

## Where Skills Live

- **`local/skills/<name>/SKILL.md`** — Your skills. Always create here.
- **`.claude/skills/<name>/SKILL.md`** — Framework skills. Never modify.

## Frontmatter

```yaml
---
name: my-skill              # lowercase, hyphens only, matches directory name
description: Does X when Y.  # Third person. What it does + when to use it.
allowed-tools: Read, Edit    # Tools this skill needs (comma-separated)
model: sonnet                # Optional: haiku, sonnet, opus
---
```

## Key Sections

- **`## When to Use`** — Required for chat skills. Without it, the skill is idle-only.
- **`## Idle Behavior`** + **`Cooldown: N minutes`** — Required for idle skills. Without both, the skill won't auto-run.

## Progressive Disclosure

Keep SKILL.md under 100 lines. Move detailed content to reference files in the skill directory:

```
my-skill/
  SKILL.md         # Overview + navigation (loaded when skill triggers)
  REFERENCE.md     # Detailed docs (loaded only when needed)
  FORMAT.md        # Data format examples
```

SKILL.md references them: "See [REFERENCE.md](REFERENCE.md) for details." Claude reads reference files only when needed — zero token cost until accessed. Keep references one level deep (no nested references).

## Dead Zones

If a skill detects nothing to do until a future time, edit its own `Cooldown:` line to a longer value. The skill loader hot-reloads every idle cycle. Edit back to normal when the dead zone passes.

## Sending Messages to Discord

Idle runs have no conversation output. Use `send_to_channel` with `channel_id: "group"`.

## When to Use

Invoke this skill before creating a new skill or making significant edits to an existing one.
