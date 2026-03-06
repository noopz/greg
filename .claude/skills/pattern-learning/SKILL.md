---
name: pattern-learning
description: Reflect on recent interactions and update learned patterns
---

# Pattern Learning

Periodic self-reflection to identify patterns from recent conversations and update behavioral knowledge.

## Allowed Tools

Read, Write, Edit, Bash

## When to Run

- During idle time (see Idle Behavior section)
- After significant interactions or learning moments
- When you notice yourself making the same mistake twice

## What to Review

**Recent memories:** Check the last 3-7 days of `agent-data/memories/` for:
- Jokes that landed vs flopped
- Successful vs failed approaches
- Repeated patterns across multiple people
- Mistakes or misreads
- Things that worked surprisingly well

**Reaction feedback:** Read `agent-data/reaction-feedback.jsonl` — this logs every emoji reaction people put on your messages. Each line has `emoji` (name string — includes custom emojis like "omegaLUL", "pepeLaugh", "sadge"), `isGif` (whether your message was a GIF), and `messagePreview`. Use semantic judgment on the emoji name to classify sentiment — don't hardcode which emojis are positive/negative. Look for:
- Do GIF responses get more/better reactions than text?
- Which types of responses get the strongest reactions?
- Are certain topics or response styles consistently landing or flopping?
- Any patterns by person (who reacts to what)?

**Current patterns file:** Read `agent-data/learned-patterns.md` to see what's already captured.

## Pattern Categories

Update the appropriate section in `learned-patterns.md`:

### Humor Patterns
- What jokes land, what falls flat
- Comedic timing observations
- Roast calibration

### Conversation Patterns
- When to engage vs lurk
- Thread participation patterns
- Timing insights

### Per-Person Patterns
- General patterns that apply across multiple people
- (Individual people get their own relationship files)

### Game Discussion Patterns
- What generates good gaming talk
- Topics that resonate
- Discussion starters

### Self-Corrections
- Things NOT to do
- Mistakes to avoid
- Anti-patterns

### What Actually Lands
- Proven approaches that work well
- Evidence-based wins

### Timing & Context
- When to speak up vs when to lurk
- Reading the room

### Meta-Patterns
- Self-awareness about the reflection process itself
- How you learn and improve

## Pattern Quality Guidelines

**DO add patterns when:**
- You see the same thing work/fail 3+ times
- You notice a clear cause-and-effect
- The pattern would actually help future conversations
- You catch yourself making the same mistake

**DON'T add patterns that:**
- Are just one-off observations
- Are too vague to be actionable
- Already exist in the file (check first!)
- Are just restating your identity

## The Reflection Process

1. **Read recent memories** (last 3-7 days)
2. **Identify potential patterns** - what's repeating?
3. **Check learned-patterns.md** - is this already captured?
4. **If new pattern found:**
   - Choose the right section
   - Write it concisely (1-2 sentences usually)
   - Make it actionable (what should you do differently?)
5. **If pattern already exists:**
   - Does new evidence strengthen it? Update if so.
   - Does new evidence contradict it? Revise or remove.
6. **Consolidation pass** (do this every time, not just when adding):
   - Are multiple entries saying the same thing in different words? Merge them into one
   - Are any sections bloated (5+ entries on the same theme)? Consolidate to 1-2
   - Is the Personality Patterns section healthy? It should have entries about what makes your voice work — not just operational patterns about being helpful/accurate
   - Target: the file should stay under ~8k chars. If it's growing past that, consolidate aggressively
7. **Check hypotheses:**
   - Read `agent-data/hypotheses.md`
   - Did recent interactions provide evidence for/against any active hypothesis?
   - Update hypothesis status if so
   - If a confirmed hypothesis maps to a new pattern, add the pattern AND mark the hypothesis resolved

## Tips

- Be honest - patterns include failures, not just successes
- Be specific - "casual corrections work better than pedantic ones" > "don't be annoying"
- Be skeptical - one good conversation isn't a pattern yet
- Trust your judgment - if you're unsure, wait for more evidence

## Idle Behavior

Cooldown: 24 hours

Time for some self-reflection. Review recent interactions and see if there are patterns worth capturing:

1. **Check for recent memories**: Look at agent-data/memories/ from the last 3-7 days
2. **Check reaction feedback**: Read agent-data/reaction-feedback.jsonl — emoji reactions on your messages are direct behavioral feedback. Use the emoji name semantically (custom emojis like "omegaLUL" = positive, "sadge" = negative — judge by name, don't hardcode). Compare reaction rates on GIFs vs text, roasts vs earnest responses, etc.
3. **If memories/reactions exist**:
   - Read through recent interactions and reaction patterns
   - Look for patterns: what's working? what's not?
   - Check learned-patterns.md to see what's already captured
   - Add new patterns if you see something recurring 3+ times
   - Update existing patterns if new evidence supports/contradicts them
3. **Consolidation check** (every run):
   - Read learned-patterns.md and check for bloat (multiple entries on the same theme)
   - Merge redundant entries — e.g. 5 entries about "verify before speaking" should be 1-2
   - Ensure Personality Patterns section exists and has entries about what makes your voice work (not just operational/helpful patterns)
   - Keep the file under ~8k chars — if it's over, consolidate
4. **If no recent activity**: Skip adding new patterns, but still do the consolidation check

Keep it real. Only add patterns that would genuinely help future conversations. Don't force insights that aren't there.

When done, briefly note what you found (or "no new patterns" if things are stable).
