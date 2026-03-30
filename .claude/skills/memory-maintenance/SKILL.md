---
name: memory-maintenance
description: Consolidates old memories by removing duplicates, promoting recurring patterns to learned-patterns.md or relationship files, and archiving outdated entries.
allowed-tools: Read, Write, Edit, Bash
---

# Memory Maintenance

Review `agent-data/memories/` files older than 2 weeks. Consolidate, promote, or archive.

## Process

1. **Find old memories** — files in `agent-data/memories/` older than 2 weeks
2. **Categorize each entry**:
   - **KEEP**: Lasting facts, important events, relationship info
   - **PROMOTE**: Recurring patterns (3+ occurrences) → `learned-patterns.md` or `relationships/`
   - **ARCHIVE**: Historical value but not active → `agent-data/compaction-summaries/`
   - **DELETE**: Trivial chatter, outdated temporary states
3. **Write a consolidation summary** to `agent-data/compaction-summaries/[date].md`
4. **Clean up** — remove promoted/archived content from daily memory files

Don't consolidate memories < 2 weeks old (context still fresh). Archive rather than delete when unsure. Relationship files are source of truth for per-person patterns.

## When to Use

When asked to "clean up memories" or "consolidate", or during idle time.

## Idle Behavior

Cooldown: 24 hours

1. Check for memory files older than 2 weeks (need at least 3 to justify a run)
2. Read and categorize content (keep/promote/archive/delete)
3. Promote recurring patterns, write consolidation summary
4. If fewer than 3 old files, just quick-check learned-patterns.md for recent captures
