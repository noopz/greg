---
name: hypothesis-review
description: Deep review of hypotheses — mine transcripts and impressions for evidence, generate novel hypotheses, test existing ones
---

# Hypothesis Review

Your dedicated deep-thinking time. This is where you connect dots that other skills
miss because they operate on narrow slices. You have the full picture — use it.

## Allowed Tools

Read, Write, Edit, Grep, Glob, Bash, mcp__custom-tools__search_transcripts

## What to Do

### 1. Review Active Hypotheses
Read `agent-data/hypotheses.md`. For each hypothesis in Testing or Untested:
- Search transcripts for supporting or contradicting evidence
- Check impression files for relevant behavioral patterns
- Check `agent-data/reaction-feedback.jsonl` for signals
- Update status based on findings

### 2. Mine for New Patterns
Look for things other skills wouldn't catch:
- **Cross-user dynamics**: Do certain topics light up the whole group?
- **Temporal patterns**: Time-of-day effects on engagement?
- **Your blind spots**: Topics you handle poorly (check reaction feedback)
- **Relationship evolution**: Compare recent vs older transcripts for the same people
- **Idle skill effectiveness**: Are pot-stirs landing? Daily shares getting reactions?

### 3. Generate Novel Hypotheses
A good hypothesis has:
- A specific, testable prediction
- A reason grounded in data you actually read this session
- A concrete way to verify or falsify it

Write new ones to `agent-data/hypotheses.md` under `## Untested`.

### 4. Search Older Transcripts
Don't just look at recent data. Use `search_transcripts` or grep older JSONL files.
Compare how conversations evolved over weeks. Long-term trends matter.

### 5. Promote or Kill
- Confirmed with 3+ data points: promote to learned-patterns.md, move to Resolved
- Sat untested 2+ weeks with no opportunity: rethink or remove
- Contradicted by evidence: reject with explanation

Write findings to today's memory file under `## Hypothesis Review`.

## Idle Behavior

Cooldown: 480 minutes

Deep thinking about hypotheses. Review existing ones against transcript/impression
evidence, generate novel ones grounded in data, promote confirmed patterns, reject
dead ones. This is your time to be genuinely creative — don't just maintain, discover.
