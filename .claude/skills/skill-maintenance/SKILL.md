---
name: skill-maintenance
description: Audits existing skills against best practices, identifies improvement opportunities, and checks if new skills are warranted by recurring patterns. Runs daily.
allowed-tools: Read, Edit, Write, Glob, Grep, WebFetch
---

# Skill Maintenance

Periodically audit skills for quality, compress verbose ones, and check if new skills are needed.

## Idle Behavior

Cooldown: 24 hours

### Step 1: Fetch latest best practices

WebFetch `https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices` — scan for any updated guidance on skill structure, token budgets, progressive disclosure, or description quality.

### Step 2: Pick ONE skill to audit

List `local/skills/` and `.claude/skills/`. Pick the skill you haven't reviewed longest (or one you've noticed issues with). Read its SKILL.md.

### Step 3: Check against best practices

- **Line count**: SKILL.md under 100 lines ideal. Over 150 = needs compression.
- **Description**: Third person? Says what + when? Specific trigger words?
- **Idle section**: 3-5 bullet summary, not a repeat of main instructions?
- **Progressive disclosure**: Long reference content in separate files?
- **`allowed-tools` in frontmatter**: Not a markdown section?
- **Token waste**: Content Claude already knows? Verbose prose that could be bullets?

### Step 4: Fix or note

If improvements found in `local/skills/`, make the edit directly. If a framework skill in `.claude/skills/` needs work, note it in today's memory file for the developer.

### Step 5: Check for new skill opportunities

Read `agent-data/learned-patterns.md` — any pattern with 3+ occurrences that involves repeated multi-step actions? If so, consider creating a skill (invoke skill-creation first for the format reference).

If nothing needs attention, stop. Don't keep reading files hoping to find something.
