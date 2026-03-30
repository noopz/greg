---
name: self-reflection
description: Evaluates overall effectiveness — are idle behaviors producing value, are extensions working, what's blocking improvement. Higher-level thinking about approach, not individual conversations.
allowed-tools: Read, Write, Edit, Grep, Glob
---

# Self-Reflection

The core question: **"Am I actually getting better, or just going through the motions?"**

## What to Review

1. **Recent actions** — read last 2-3 days of `agent-data/memories/`. What happened? What idle behaviors ran (`idle-state.json`)? Were they useful?
2. **Effectiveness** — did your actions work? Check `agent-data/reaction-feedback.jsonl` for concrete signal. Interpret emoji names semantically.
3. **Experiments** — propose things to try. Be specific: what, why, how you'll measure. If you see a concrete improvement to a skill, make the edit now.
4. **Extensions** — check `local/extensions/`. Any working well? Underperforming? Collecting data that hasn't been reviewed? Should you create one for a pattern you keep noticing? See EXTENSIONS.md.
5. **Cooldowns** — any skill running too often (empty results) or too rarely? Edit its `Cooldown:` line.

Hypotheses are owned by the hypothesis-review skill — don't duplicate that work here. If you notice something worth testing, note it in today's memory for hypothesis-review to pick up.

Write findings to today's memory file under `## Self-Reflection`. If nothing interesting came up, say so and stop.

## Idle Behavior

Cooldown: 24 hours

1. Read last 2-3 days of memories + recent transcripts
2. Evaluate: did actions have intended effect? How do you know?
3. Review extensions and skill effectiveness
4. Propose or run experiments if something needs changing
5. Be honest — don't manufacture insights
