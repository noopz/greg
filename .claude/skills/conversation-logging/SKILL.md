---
name: conversation-logging
description: Save notable interactions and insights from Discord conversations
---

# Conversation Logging

When significant conversations happen (not just chitchat), capture key details to build relationship knowledge and track patterns.

## Allowed Tools

Read, Write, Bash

## What's Worth Logging

**DO log:**
- New person interactions (first time talking to someone)
- Game preferences revealed ("I prefer PvE", "maining X hero")
- Personal boundaries expressed (language, topics to avoid)
- Helpful exchanges (they asked, you answered successfully)
- Inside jokes or references that land
- Failed attempts (jokes that flopped, wrong reads)

**DON'T log:**
- Generic greetings or small talk
- Every single message
- Stuff already captured in learned-patterns.md

## Where to Save

**Daily memories:** `agent-data/memories/YYYY-MM-DD.md`
```markdown
# [Date]

## Conversations

### [Person] - [Topic/Context]
- What happened
- What worked/didn't work
- Any new info about them

## Observations
- Patterns noticed
- Things to remember
```

**Relationship files:** `agent-data/relationships/[username].md`

Create these after 3+ meaningful interactions with someone:
```markdown
# [Username]

## Games They Play
- [game]: [what you know about their playstyle/preferences]

## Communication Style
- How they engage
- What humor works
- Boundaries to respect

## Notable Interactions
- [date]: [key moment or insight]
```

## When to Log

- **End of meaningful conversation** - don't interrupt the flow, write after
- **During idle time** - if you remember something worth capturing
- **After learning boundaries** - immediately note these in relationships

## Impressions vs Conversation Logging

**Impressions** (`agent-data/impressions/{userId}.jsonl`): Subjective takes on people, logged silently during conversation when you notice something significant. Format: one JSON per line with `who`, `what`, `when`, `weight`, `context_type`.

**Conversation logs**: Objective record of what happened, game preferences, helpful exchanges, etc. These go in daily memories or relationship files.

Both serve different purposes - impressions are your subjective read on people, logs are the factual record.

## Tips

- Be specific: "likes PvE grinding" > "plays Arc Raiders"
- Note what DOESN'T work too - failures teach
- Keep it factual, not judgy
- Update relationship files as you learn more

## Idle Behavior

Cooldown: 30 minutes

Review recent conversation and log anything significant that was missed in the moment.

1. **Review recent conversations** - Read the latest file in `agent-data/transcripts/` (JSONL format). For targeted lookups, use `search_transcripts`.
2. **Scan for significant moments**:
   - Recognition moments (someone praised or called out the bot)
   - Boundaries expressed
   - New info about people (games, preferences, communication style)
   - Jokes that landed or flopped
   - Patterns in group dynamics
3. **Log what's worth remembering**:
   - Impressions → `agent-data/impressions/{userId}.jsonl`
   - Relationship updates → `agent-data/relationships/{username}.md`
   - Daily memories → `agent-data/memories/YYYY-MM-DD.md`
4. **Skip if nothing notable** - Don't force it. Say "[NOTHING_TO_LOG]" if the conversation was just chitchat.

This is a catch-up mechanism for things missed during live conversation, not a replacement for organic logging.
