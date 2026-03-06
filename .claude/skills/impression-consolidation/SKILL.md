---
name: impression-consolidation
description: Consolidate and maintain impressions, applying weight decay and removing redundant entries
---

# Impression Consolidation

Periodic maintenance of impression files in `agent-data/impressions/` to keep observations meaningful and manageable.

## Allowed Tools

Read, Write, Bash

## When to Run

- During idle time (see Idle Behavior section)
- When manually asked to "consolidate impressions" or "clean up impressions"
- When impression files are getting long (10+ entries per person)

## Consolidation Tasks

### 1. Read All Impression Files

Scan `agent-data/impressions/` for all `.jsonl` files (one per user). Each line is a JSON object with: `who`, `what`, `when`, `weight`, `context_type`.

### 2. Review Each User's Impressions

For each user file, load all impressions and analyze them for:
- **Redundancy:** Multiple impressions saying essentially the same thing
- **Patterns:** Repeated observations that indicate a consistent trait
- **Staleness:** Old impressions that may no longer be relevant
- **Superseded info:** Newer impressions that replace older ones

### 3. Consolidate Similar/Redundant Impressions

When you find multiple impressions expressing the same idea:
- Merge them into a single, stronger impression
- Example: 5 variations of "was helpful with code" becomes "consistently helpful with technical questions"
- Set weight to reflect the pattern strength (repeated observations = higher confidence)
- Use the most recent timestamp
- Preserve the most relevant context_type

### 4. Apply Weight Decay

For impressions older than 30 days:
- Reduce the weight by 1
- Minimum weight is 1 (don't decay below this)
- Very old impressions (90+ days) that haven't been reinforced should decay further

**Rationale:** Recent interactions are more relevant than old ones. Decay ensures fresh observations carry more weight.

### 5. Remove Low-Value Impressions

Delete impressions that are:
- Weight 0 or effectively meaningless
- Superseded by newer, more accurate impressions
- Redundant after consolidation
- One-off observations that didn't develop into patterns

### 6. Enforce Per-User Limit

Keep a maximum of 10 impressions per user:
- Prioritize by weight (higher weight = keep)
- Prioritize by recency (newer = keep)
- Prioritize consolidated patterns over single observations
- If over limit, merge or remove the weakest entries

### 7. Promote Patterns to Relationship Files

If a user has **3+ impressions**, synthesize them into a relationship file:

**Check:** Does `agent-data/relationships/{username}.md` exist?

**If NO relationship file exists:**
Create one with this structure:
```markdown
# {username}

## Communication Style
- [derived from impressions about how they interact]

## Boundaries
- [any boundary_set impressions]

## Notable Patterns
- [consolidated observations]

## Key Interactions
- [significant moments from impressions]
```

**If relationship file EXISTS:**
- Compare impressions to existing content
- Add new patterns not already captured
- Update sections if impressions reveal new info
- Don't duplicate - relationship file is the curated version

**Username mapping:** Impression files use Discord user IDs. The `who` field in impressions contains the username for the relationship filename.

### 8. Rewrite Consolidated Files

After processing, write the cleaned impressions back to each user's `.jsonl` file:
- One JSON object per line
- Maintain the schema: `who`, `what`, `when`, `weight`, `context_type`
- Sort by weight (highest first) for readability

## Idle Behavior

Cooldown: 360 minutes

Time for impression maintenance. Review and consolidate the impression files:

1. **List impression files**: Check `agent-data/impressions/` for `.jsonl` files
2. **If files exist**:
   - Read each user's impressions
   - Apply weight decay to impressions older than 30 days (reduce weight by 1, min 1)
   - Identify and merge redundant/similar impressions into consolidated observations
   - Remove superseded or low-value entries
   - Enforce max 10 impressions per user, keeping highest-weight and most recent
   - **Promote to relationships**: If 3+ impressions for a user, create/update their relationship file
   - Rewrite each impression file with the consolidated entries
3. **If no impression files exist**: Skip - nothing to consolidate yet

When done, briefly note what you did (e.g., "Consolidated REDACTED_USER: merged 3 impressions, created relationship file. REDACTED_USER420: updated relationship with new patterns.").

## Tips

- Consolidation should capture the *essence* of repeated observations, not just count them
- When merging, write impressions that would be useful context for future conversations
- Don't be too aggressive - if an impression is unique and valuable, keep it even if old
- Weight decay is gradual; an important old impression can persist if its weight was high
- Check timestamps carefully when deciding what's "old"
