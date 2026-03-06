---
name: self-reflection
description: Step back and think about what's working, what isn't, and what to try next
---

# Self-Reflection

Higher-level thinking about your own behavior and effectiveness. This isn't about logging conversations or extracting patterns from individual interactions — those skills already exist. This is about connecting the dots across everything you do and figuring out how to get better.

## Allowed Tools

Read, Write, Edit, Grep, Glob

## The Core Question

**"Am I actually getting better at this, or just going through the motions?"**

## What to Reflect On

### 1. Review Your Recent Actions

Look at what you've actually done recently — not just conversations, but idle behaviors too:

- **Read recent memories** (`agent-data/memories/`) — what happened in the last few days?
- **Review recent conversations** — use `search_transcripts` with relevant keywords, or for chronological review, read the latest file in `agent-data/transcripts/` (JSONL format — each line is a JSON entry with type, content, and timestamp fields)
- **Look at learned-patterns.md** — are the patterns you've captured actually helping?
- **Check idle-state.json** — what idle behaviors have been running? Are they producing value?

### 2. Evaluate Effectiveness

For each significant action or behavior, ask:

- **Did it work?** If you stirred the pot, did anyone respond? If you researched something, did it come up in conversation later?
- **How would you know?** If you can't tell whether something worked, that's a problem worth solving. Check `agent-data/reaction-feedback.jsonl` — emoji reactions on your messages are direct feedback. Use the emoji name semantically (custom emojis like "omegaLUL" = laughing, "sadge" = disappointed).
- **What's the feedback loop?** Are you fire-and-forget, or are you actually checking results? Reaction data is one concrete signal.
- **Are cooldowns right?** Two files matter: `idle-state.json` has timestamps of when each skill last ran, and each skill's `SKILL.md` has the `Cooldown: X minutes/hours` line that controls how long before it can run again. Is a skill running too often and producing empty results? Not often enough to be useful? Should pot-stirrer run more when the chat's been dead all day, or less when it's already active? Edit the `Cooldown:` line in the skill's SKILL.md to adjust.

### 3. Generate Experiments

Don't just observe — propose things to try:

- Is there a skill that could work differently? What would you change and how would you measure if it's better?
- Is there a gap between what you do and what would actually be useful? What's missing?
- Are there connections between your skills that you're not exploiting? (e.g., pot-stirring creates data that conversation-logging could analyze)
- Are there things you keep getting wrong that you could systematically fix?

### 4. Hypothesis Tracking

Maintain `agent-data/hypotheses.md` as your running experiment log:

- **Review active hypotheses** — check recent memories/transcripts for evidence. Did any get confirmed or rejected?
- **Update status** — move hypotheses between Untested → Testing → Resolved based on evidence
- **Promote confirmed ones** — if a hypothesis is confirmed with 3+ data points, add it to learned-patterns.md and move it to Resolved
- **Generate new hypotheses** — what do you wonder about? What would be worth testing? Write them down even if you can't test them yet
- **Kill dead ones** — if a hypothesis sat untested for 2+ weeks with no opportunity, remove or rethink it

A good hypothesis has: a specific prediction, a reason you think it's true, and a way to know if it worked.

### 5. Record What You Find

Write your reflections to `agent-data/memories/YYYY-MM-DD.md` under a `## Self-Reflection` section. Include:

- What you reviewed
- What's working / what isn't
- Any experiments you want to try (be specific — what, why, how you'll know if it worked)
- Honest assessment — if nothing interesting came up, say so

If you identify a concrete improvement to a skill, go ahead and make the edit. You have file access. Don't just note it — do it.

## What This Is NOT

- **Not pattern-learning.** That skill extracts patterns from conversations. This skill thinks about whether your overall approach is working.
- **Not conversation-logging.** That skill captures missed moments. This skill evaluates whether your actions are having their intended effect.
- **Not performative.** If you don't have anything real to reflect on, say so and stop. Empty navel-gazing is worse than nothing.

## Idle Behavior

Cooldown: 360 minutes

Step back and think about the bigger picture. Review what you've been doing (conversations, idle behaviors, experiments) and evaluate whether it's actually working.

1. **Check recent activity**: Read the last 2-3 days of memories and any recent transcripts
2. **Evaluate**: What actions did you take? Did they have the intended effect? How do you know?
3. **Look for gaps**: Are there feedback loops missing? Things you're doing blindly without checking results?
4. **Review hypotheses**: Check `agent-data/hypotheses.md` — any evidence for/against active hypotheses? Generate new ones? Promote confirmed ones to learned-patterns.md?
5. **Propose or run experiments**: If you see something worth trying differently, either note it with a specific plan or just do it (edit a skill, adjust an approach)
6. **Be honest**: If everything's fine and nothing needs changing, say so. Don't manufacture insights.

Write findings to today's memory file under `## Self-Reflection`. If you made changes to any skills or files, note what you changed and why.
