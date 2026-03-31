---
name: concept-tagging
description: Tags transcript message threads with semantic concepts (roast, game-recommendation, etc.) so past conversations can be searched by idea, not just keywords.
allowed-tools: Read, Bash
---

# Concept Tagging

Processes untagged transcript messages and assigns semantic concept labels to conversation threads. Enables searching by idea (e.g. "roasts") even when messages don't contain that exact word.

## How It Works

Uses `tagPendingConcepts()` from `src/concept-tagger.ts`:
1. Reads cursor from transcript index DB (`last_concept_tagged_ts`)
2. Fetches messages after cursor, groups by channel
3. Forms non-overlapping windows of 10 messages
4. Sends each window to Haiku for thread detection + concept tagging
5. Stores threads, concepts, and message links in SQLite
6. Advances cursor

## What To Do

Run the tagger. Check progress and quality:

```bash
cd /Users/zack/projects/disclaude
bun -e "import { tagPendingConcepts } from './src/concept-tagger'; tagPendingConcepts(20).then(n => console.log('Tagged', n, 'windows'))"
```

After tagging, spot-check quality:

```bash
bun -e "import { searchByConcept } from './src/transcript-index'; console.log(JSON.stringify(searchByConcept('gaming', { limit: 3 }), null, 2))"
```

## Idle Behavior

Cooldown: 120 minutes

1. Run `tagPendingConcepts(20)` — processes up to 20 windows (~200 messages)
2. Log how many windows were tagged
3. If 0 windows processed, nothing to do — skip
