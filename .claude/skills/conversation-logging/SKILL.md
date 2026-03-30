---
name: conversation-logging
description: Captures notable interactions missed during live conversation — new person info, game preferences, boundaries, jokes that landed/flopped, relationship insights.
allowed-tools: Read, Write, Bash
---

# Conversation Logging

Catch-up mechanism for things missed during live conversation.

## What to Log

**DO**: New person interactions, game preferences revealed, boundaries expressed, helpful exchanges, inside jokes that land, failed attempts
**DON'T**: Generic greetings, every message, stuff already in learned-patterns.md

## Where to Save

- **Daily memories**: `agent-data/memories/YYYY-MM-DD.md` — conversations, observations
- **Relationship files**: `agent-data/relationships/{userId}.md` — after 3+ meaningful interactions
- **Impressions**: `agent-data/impressions/{userId}.jsonl` — subjective takes (JSON: `who`, `what`, `when`, `weight`, `context_type`)

Impressions are your subjective read. Logs are the factual record. Both serve different purposes.

## When to Use

After meaningful conversations, during idle time, or immediately after learning boundaries.

## Idle Behavior

Cooldown: 120 minutes

1. Read latest transcript file (JSONL format) or use `search_transcripts`
2. Scan for: recognition moments, boundaries, new person info, jokes landing/flopping
3. Log to impressions, relationships, or daily memories as appropriate
4. Skip if nothing notable — don't force it
