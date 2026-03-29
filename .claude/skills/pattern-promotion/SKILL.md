---
name: pattern-promotion
description: Compacts learned patterns by promoting proven ones to persona. Removes stale entries and challenges existing promotions against new evidence.
model: sonnet
allowed-tools: Read, Edit
---

# Pattern Compaction & Promotion

## Idle Behavior
Cooldown: 24 hours

Compact learned-patterns.md by promoting proven patterns into persona.md, then removing them from patterns. Target: **learned-patterns.md under 4,000 characters** so there's always room to learn.

1. Read `agent-data/learned-patterns.md`
2. Read `agent-data/persona.md`

3. **Identify patterns ready for promotion to persona.md**:
   - Validated across multiple conversations (not one-off observations)
   - Behavioral guidance critical for your identity
   - Anti-patterns corrected multiple times
   - Already has enough evidence that it's a permanent truth, not a hypothesis

4. **Promote to persona.md** — make small, targeted additions:
   - Distill the pattern into 1-2 lines max
   - Add to the most relevant existing section (don't create new sections)
   - Do NOT change your core identity, voice, or personality — only add learned behavioral rules
   - Example: a proven pattern like "take Ls gracefully" becomes a line under Hard Rules
   - If a pattern doesn't fit naturally into persona.md, leave it in learned-patterns

5. **Remove promoted patterns from learned-patterns.md** — they live in persona now

6. **Compact what remains in learned-patterns.md**:
   - Merge patterns that say the same thing differently
   - Combine related patterns within sections
   - Remove patterns that already exist in persona.md (including newly promoted ones)
   - Prefer terse phrasing — density over prose
   - Cut weakest patterns if still over 4,000 characters

7. **Challenge existing promotions**:
   - If recent evidence contradicts something previously added to persona.md, remove it
   - Don't entrench patterns just because they were promoted before

The cycle: pattern-learning adds → file grows → this skill promotes proven patterns to persona and compacts the rest → room to grow again.
