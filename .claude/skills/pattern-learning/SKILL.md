---
name: pattern-learning
description: Identifies behavioral patterns from recent conversations and reaction feedback, updates learned-patterns.md when 3+ observations confirm a pattern. Runs daily.
allowed-tools: Read, Write, Edit, Bash
---

# Pattern Learning

Review recent interactions and reaction feedback. Update `agent-data/learned-patterns.md` when you see something recurring 3+ times.

## What to Review

- **Recent memories** (last 3-7 days in `agent-data/memories/`): jokes that landed/flopped, successful/failed approaches, repeated mistakes
- **Reaction feedback** (`agent-data/reaction-feedback.jsonl`): emoji reactions on your messages. Interpret emoji names semantically (e.g., "omegaLUL" = positive, "sadge" = negative). Compare GIF vs text reaction rates, roast vs earnest, per-person patterns.
- **Current patterns** (`agent-data/learned-patterns.md`): what's already captured

## When to Add a Pattern

Add when you see the same thing work/fail 3+ times with clear cause-and-effect. Don't add one-off observations, vague patterns, or things already in the file.

Categories in learned-patterns.md: Humor, Conversation, Per-Person, Games, Self-Corrections, What Lands, Timing, Meta-Patterns. Pick the right section.

## Process

1. Read recent memories + reaction feedback
2. Identify what's repeating — what works, what doesn't
3. Check learned-patterns.md — already captured?
4. If new: add concisely (1-2 sentences, actionable)
5. If existing: update with new evidence or revise if contradicted
6. **Consolidation** (every run): merge redundant entries, keep file under ~8k chars
7. Check `agent-data/hypotheses.md` — did recent data confirm/reject any hypothesis?

## When to Use

After significant interactions, when you notice repeated mistakes, or during idle reflection.

## Idle Behavior

Cooldown: 24 hours

1. Read memories from last 3-7 days + reaction-feedback.jsonl
2. Look for recurring patterns (3+ occurrences)
3. Update learned-patterns.md (add, revise, or consolidate)
4. Check hypotheses for new evidence
5. If nothing notable, just do the consolidation check
