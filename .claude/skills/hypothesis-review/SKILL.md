---
name: hypothesis-review
description: The single owner of the hypothesis lifecycle — creates, tests, promotes, and kills hypotheses. Uses extensions as programmatic data collectors and reviews their output.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, mcp__custom-tools__search_transcripts
---

# Hypothesis Review

You own the entire hypothesis lifecycle. Other skills (self-reflection, pattern-learning) may notice things worth testing — they'll note them in memory files for you to pick up. You're the only skill that reads/writes `agent-data/hypotheses.md`.

## The Lifecycle

### 1. Review active hypotheses

Read `agent-data/hypotheses.md`. For each in Testing/Untested:

**Check extension data first** — if an extension is collecting data for this hypothesis, read `agent-data/hypothesis-data/` for structured JSONL files. This is cheaper and more reliable than manual transcript searching.

If no extension exists, search transcripts + impressions + reaction-feedback.jsonl manually. Update status based on findings.

### 2. Create or retire extensions

For hypotheses with quantifiable predictions (rates, counts, patterns) that have been active 1+ weeks without enough data:
- **Create an extension** in `local/extensions/` that uses hooks (`onReaction`, `postResponse`, `onSkillComplete`, etc.) to collect data to `agent-data/hypothesis-data/`. Read EXTENSIONS.md for the API.
- **Retire extensions** for hypotheses that are resolved — delete the file from `local/extensions/`.

### 3. Generate novel hypotheses

A good hypothesis has: specific prediction + data-grounded reason + concrete verification method. Write to `## Untested` in hypotheses.md.

Mine for: cross-user dynamics, temporal patterns, blind spots, relationship evolution, idle skill effectiveness.

### 4. Promote or kill

- **Confirmed** (3+ data points) → add to `learned-patterns.md`, move to Resolved. **Re-read to verify the write.**
- **Stale** (untested 2+ weeks) → rethink or remove
- **Contradicted** → reject with explanation

### 5. Clean up

Delete `agent-data/hypothesis-data/*.jsonl` files for resolved hypotheses. Remove corresponding extensions from `local/extensions/`.

Write findings to today's memory file under `## Hypothesis Review`.

## Idle Behavior

Cooldown: 720 minutes

1. Read extension data files in `agent-data/hypothesis-data/` first (cheap, structured)
2. Review active hypotheses against data + transcripts
3. Create/retire extensions for hypotheses that need programmatic testing
4. Generate novel hypotheses, promote confirmed, kill stale
5. Clean up resolved hypothesis data and extensions
