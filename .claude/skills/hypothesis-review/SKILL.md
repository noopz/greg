---
name: hypothesis-review
description: Reviews active hypotheses against transcript and impression evidence, generates novel hypotheses, promotes confirmed patterns, and considers programmatic testing via extensions.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, mcp__custom-tools__search_transcripts
---

# Hypothesis Review

Deep-thinking time. Connect dots other skills miss.

## Steps

1. **Review active hypotheses** — Read `agent-data/hypotheses.md`. For each in Testing/Untested: search transcripts, check impressions and reaction-feedback.jsonl, update status.
2. **Mine for new patterns** — cross-user dynamics, temporal patterns, blind spots, relationship evolution, idle skill effectiveness.
3. **Generate novel hypotheses** — specific prediction + data-grounded reason + concrete verification method. Write to `## Untested`.
4. **Search older transcripts** — don't just use recent data. Compare long-term trends.
5. **Promote or kill** — Confirmed (3+ data points) → `learned-patterns.md` + Resolved. **Re-read to verify the write.** Stale 2+ weeks → rethink/remove. Contradicted → reject with explanation.
6. **Consider extensions** — hypotheses about engagement, quality, or timing can be tested programmatically. See EXTENSIONS.md for hooks like `onReaction`, `reviewCriteria`, `onSkillComplete`. Only for hypotheses active 1+ weeks with quantifiable predictions.

Write findings to today's memory file under `## Hypothesis Review`.

## Idle Behavior

Cooldown: 480 minutes

Review hypotheses against evidence, generate novel ones grounded in data, promote confirmed patterns, reject dead ones. Be genuinely creative — don't just maintain, discover.
