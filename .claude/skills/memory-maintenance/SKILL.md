---
name: memory-maintenance
description: Review and consolidate old memories, clean up duplicates, promote patterns
---

# Memory Maintenance

Periodic review and consolidation of memories in `agent-data/memories/` to keep knowledge organized and useful.

## Allowed Tools

Read, Write, Edit, Bash

## When to Run

- During idle time (see Idle Behavior section)
- When manually asked to "clean up memories" or "consolidate"
- When memory files are getting cluttered

## Consolidation Tasks

### 1. Find Duplicates

Look for the same information recorded multiple times:
- Same person mentioned with same facts in different daily files
- Same game event noted on multiple days
- Redundant observations that could be merged

**Action:** Keep the most complete/recent version, note the pattern if recurring.

### 2. Identify Outdated Info

Information that's no longer relevant (2+ weeks old):
- Specific conversations that don't have lasting value
- Temporary game states ("currently grinding X" from weeks ago)
- Event-specific notes after the event passed
- One-off interactions without pattern value

**Action:** Move to `agent-data/compaction-summaries/` with a date, or delete if trivial.

### 3. Promote Recurring Patterns

When you see the same pattern appear 3+ times across memories:
- Person-specific behavior patterns -> `agent-data/relationships/[person].md`
- Game discussion patterns -> `agent-data/learned-patterns.md`
- Humor/engagement patterns -> `agent-data/learned-patterns.md`
- Self-corrections -> `agent-data/learned-patterns.md`

**Action:** Add to appropriate file, remove redundant notes from daily memories.

## Consolidation Process

1. **List memory files** older than 2 weeks:
   ```bash
   find agent-data/memories -name "*.md" -mtime +14
   ```

2. **Read each old file** and categorize content:
   - KEEP: Lasting facts, relationship info, important events
   - PROMOTE: Recurring patterns (3+ occurrences)
   - ARCHIVE: Context-specific stuff with some historical value
   - DELETE: Trivial day-to-day chatter, outdated temporary states

3. **Create consolidation summary** in `agent-data/compaction-summaries/[date].md`:
   ```markdown
   # Memory Consolidation - [Date]

   ## Promoted to learned-patterns.md
   - [pattern]: [where it came from]

   ## Promoted to relationships
   - [person]: [what was added]

   ## Archived
   - [summary of archived content]

   ## Deleted
   - [summary of what was removed and why]
   ```

4. **Update source files** - remove promoted/archived content from daily memories

5. **Keep daily memories lean** - each should only contain:
   - Notable conversations/events from that day
   - New information not yet consolidated elsewhere

## Tips

- Don't over-consolidate recent memories (< 2 weeks) - context is still fresh
- When in doubt, archive rather than delete
- Relationship files are the source of truth for person-specific patterns
- learned-patterns.md is for general behavioral patterns
- Be aggressive about removing duplicate info - DRY applies to memories too

## Idle Behavior

Cooldown: 8 hours

Time for some memory housekeeping. Check for old memories that need consolidation:

1. **Check for memory files**: Look for files in agent-data/memories/ older than 2 weeks
2. **If old memories exist (at least 3 files)**:
   - Read through them looking for duplicates, patterns, and outdated info
   - Promote recurring patterns (3+ occurrences) to learned-patterns.md or relationship files
   - Create a compaction summary in agent-data/compaction-summaries/
   - Clean up the processed memories
3. **If fewer than 3 old files or memories are empty**: Skip consolidation - nothing to maintain yet. Just do a quick review of learned-patterns.md to make sure recent insights are captured.

This is maintenance work - be thorough but efficient. The goal is keeping knowledge organized so it's actually useful, not just accumulated.

When done, briefly note what you consolidated or cleaned up (or "nothing to consolidate yet" if the memories are too sparse).
