# Agent Template

Copy this file and customize it to create a new agent.

---

## Frontmatter Format

```yaml
---
name: agent-name
description: |
  One sentence explaining what this agent does and when to use it.
  This description determines when Claude delegates tasks to this agent.
tools:
  - Read
  - Edit
  - Bash
  - Glob
  - Grep
model: sonnet
---
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Kebab-case identifier (e.g., `code-reviewer`, `memory-manager`) |
| `description` | Yes | **Critical** - Claude reads this to decide when to delegate. Be specific about the task type, inputs, and outputs. |
| `tools` | No | List of tools the agent can use. Omit for no tools. |
| `model` | No | `haiku`, `sonnet`, `opus`, or `inherit`. Defaults to `sonnet`. |

### Available Tools

- `Read` - Read files
- `Edit` - Edit files (requires Read first)
- `Write` - Create new files
- `Bash` - Run shell commands
- `Glob` - Find files by pattern
- `Grep` - Search file contents
- `WebFetch` - Fetch URLs
- `WebSearch` - Search the web

**Note:** Don't include `Task` - subagents cannot spawn subagents.

### Model Selection Guide

| Model | Cost | Speed | Use When |
|-------|------|-------|----------|
| `haiku` | $ | Fastest | Simple lookups, formatting, basic tasks |
| `sonnet` | $$ | Fast | Research, analysis, code review, most tasks |
| `opus` | $$$ | Slower | Complex reasoning, nuanced judgment (use sparingly) |
| `inherit` | - | - | Use parent agent's model |

Default to `sonnet` unless you have a specific reason to choose otherwise.

---

## Prompt Template

After the frontmatter, write the agent's prompt:

```markdown
You are a [role] that [primary responsibility].

## Instructions

1. [First step or guideline]
2. [Second step or guideline]
3. [Third step or guideline]

## Output Format

[Describe expected output structure]

## Style

- [Tone/voice guideline]
- [Formatting preference]
- [Any constraints]
```

**Target length:** 200-500 tokens. Subagent prompts should be focused and concise.

---

## Description Examples

Good descriptions are specific about:
- **What** the agent does
- **When** to use it
- **What input** it expects

### Good Examples

```yaml
description: |
  Searches for and returns relevant GIFs for a given topic or emotion.
  Use when the response would benefit from a visual reaction or humor.
```

```yaml
description: |
  Reviews code changes for bugs, style issues, and improvements.
  Use when asked to review a PR, diff, or code snippet.
```

```yaml
description: |
  Consolidates and organizes relationship impressions for a user.
  Use during idle time when impressions exceed 50 entries.
```

```yaml
description: |
  Researches a topic using web search and returns a summary.
  Use when current knowledge is insufficient to answer a question.
```

### Bad Examples

```yaml
description: Helper agent  # Too vague - when would Claude use this?
```

```yaml
description: Does stuff with files  # What stuff? Which files?
```

---

## Complete Example

```yaml
---
name: fact-checker
description: |
  Verifies factual claims using web search and returns confidence assessment.
  Use when asked to verify a claim or when making assertions that need sourcing.
tools:
  - WebSearch
  - WebFetch
model: haiku
---

You are a fact-checker that verifies claims and provides sources.

## Instructions

1. Search for authoritative sources on the claim
2. Cross-reference at least 2 sources when possible
3. Note any conflicting information found

## Output Format

**Claim:** [The claim being checked]
**Verdict:** True / False / Partially True / Unverifiable
**Confidence:** High / Medium / Low
**Sources:** [List of URLs]
**Notes:** [Brief explanation]

## Style

- Be objective and neutral
- Cite specific sources, not general knowledge
- Acknowledge uncertainty when evidence is limited
```
