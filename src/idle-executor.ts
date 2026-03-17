/**
 * Idle Behavior Executor
 *
 * Runs an idle behavior using the Claude Agent SDK with a fresh session.
 * Each behavior gets isolated context to prevent confusion with main conversation.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { AGENT_DATA_DIR, PROJECT_DIR, localDate } from "./paths";
import { log, error } from "./log";
import type { IdleBehavior } from "./skill-loader";
import { loadIdleState } from "./idle-state";
import { getEffectiveConfig } from "./config/runtime-config";
import { getLocalToolNames } from "./local-config";
import { BOT_NAME } from "./config/identity";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { StreamingSession } from "./streaming-session";

// ============================================================================
// Tool Input Logging
// ============================================================================

/**
 * Summarize tool input for logging.
 * Shows the key information without overwhelming the log.
 */
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Read":
      return `-> ${input.file_path}`;
    case "Write":
      return `-> ${input.file_path} (${String(input.content ?? "").length} chars)`;
    case "Edit":
      return `-> ${input.file_path}`;
    case "Glob":
      return `-> ${input.pattern}${input.path ? ` in ${input.path}` : ""}`;
    case "Grep":
      return `-> "${input.pattern}"${input.path ? ` in ${input.path}` : ""}`;
    case "Bash":
      // NEVER truncate bash - security requires full visibility
      return `-> ${input.command}`;
    case "WebSearch":
      return `-> "${input.query}"`;
    case "WebFetch":
      return `-> ${input.url}`;
    case "Task":
      return `-> ${input.subagent_type}: ${String(input.description ?? "").substring(0, 50)}`;
    default:
      // For unknown tools, show first key-value pair
      const keys = Object.keys(input);
      if (keys.length === 0) return "";
      const firstKey = keys[0];
      const firstVal = String(input[firstKey] ?? "").substring(0, 50);
      return `-> ${firstKey}: ${firstVal}`;
  }
}

// ============================================================================
// Idle Stats Builder
// ============================================================================

export async function buildIdleStats(): Promise<string> {
  const state = await loadIdleState();
  const { config: runtimeConfig } = await getEffectiveConfig();
  const now = Date.now();

  const lines = Object.entries(state.lastRuns)
    .sort(([, a], [, b]) => a - b) // oldest first
    .map(([name, timestamp]) => {
      const ago = now - timestamp;
      const hours = Math.floor(ago / 3600000);
      const mins = Math.floor((ago % 3600000) / 60000);
      const timeAgo = hours > 0 ? `${hours}h ${mins}m ago` : `${mins}m ago`;
      return `  - ${name}: ${timeAgo}`;
    });

  // Include skills that have never run
  const neverRun = lines.length === 0 ? "  (no skills have run yet)" : "";

  return `## YOUR IDLE STATS
Current config: threshold=${runtimeConfig.idle.thresholdMinutes}min, check interval=${runtimeConfig.idle.checkIntervalMinutes}min
Config file: agent-data/runtime-config.json (you can edit idle.thresholdMinutes and idle.checkIntervalMinutes)

Last run times (oldest first):
${lines.join("\n") || neverRun}`;
}

// ============================================================================
// Executor
// ============================================================================

/**
 * Execute an idle behavior with its own fresh session.
 * Uses no resume - each idle behavior gets isolated context.
 * This prevents confusion between idle tasks and main conversation.
 */
export async function executeIdleBehaviorStandalone(
  behavior: IdleBehavior,
  idleMinutes: number,
  toolsServer: McpSdkServerConfigWithInstance | null
): Promise<string | null> {
  const today = localDate();

  // Load persona for context (but not full conversation history)
  let persona = `You are ${BOT_NAME}, a snarky but helpful AI.`;
  try {
    const personaContent = await fs.readFile(
      path.join(AGENT_DATA_DIR, "persona.md"),
      "utf-8"
    );
    persona = personaContent;
  } catch {
    // Use default
  }

  const idlePrompt = `## YOUR TASK: ${behavior.name.toUpperCase()}

${behavior.prompt}

---

When done, briefly describe what you did or found. Keep it concise.`;

  const cwd = PROJECT_DIR;

  let idleStats = "";
  try {
    idleStats = await buildIdleStats();
  } catch {
    // Non-critical, continue without stats
  }

  const systemContext = `## YOUR IDENTITY
${persona}

## WORKING DIRECTORY
${cwd}
All file tool calls must use absolute paths rooted here (e.g. ${cwd}/agent-data/memories/${today}.md).

## CUSTOM TOOLS
See agent-data/tools.md for available custom tools (e.g. sending Discord messages).
Only use these when a skill explicitly asks you to. Don't spam.

## CURRENT TIME
${new Date().toLocaleString()} (${localDate()}, ${Intl.DateTimeFormat().resolvedOptions().timeZone})

${idleStats}

## CONTEXT
You've been idle for ${idleMinutes} minutes. This is a self-directed task, not a conversation.`;

  let response = "";

  let totalCost = 0;
  let toolCalls = 0;

  try {
    for await (const message of query({
      prompt: idlePrompt,
      options: {
        cwd: PROJECT_DIR,
        model: behavior.model || "claude-sonnet-4-6", // Use skill's declared model, default to sonnet
        maxTurns: 30,
        maxBudgetUsd: 1.0,
        settingSources: ["project"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // NO resume - fresh session each time, prevents context buildup
        systemPrompt: systemContext,
        allowedTools: [
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "Bash",
          "WebSearch",
          "WebFetch",
          ...(toolsServer ? ["mcp__custom-tools__send_to_channel", "mcp__custom-tools__get_channel_history", "mcp__custom-tools__search_transcripts"] : []),
          ...getLocalToolNames("creator"),
        ],
        mcpServers: toolsServer ? { "custom-tools": toolsServer } : undefined,
        env: {
          ...process.env,
          KLIPY_API_KEY: process.env.KLIPY_API_KEY,
        },
      },
    })) {
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block) {
            // Add newline between text blocks
            if (response.length > 0 && !response.endsWith("\n")) {
              response += "\n\n";
            }
            response += block.text;
          } else if ("name" in block && "input" in block) {
            const toolBlock = block as { name: string; input: Record<string, unknown> };
            const inputSummary = summarizeToolInput(toolBlock.name, toolBlock.input);
            log("IDLE", `Tool: ${toolBlock.name} ${inputSummary}`);
            toolCalls++;
          }
        }
      } else if (message.type === "result") {
        // Capture cost from the result message
        totalCost = (message as { total_cost_usd?: number }).total_cost_usd ?? 0;
      }
    }

    // Log cost summary
    log("IDLE", `Cost: $${totalCost.toFixed(4)} (${toolCalls} tool calls)`);

    return response.trim() || null;
  } catch (err) {
    error("IDLE", `Behavior execution failed`, err);
    return null;
  }
}

/**
 * Execute an idle behavior on an existing streaming session.
 * Context accumulates across calls — each behavior sees what prior ones did.
 */
export async function executeIdleBehaviorOnSession(
  behavior: IdleBehavior,
  session: StreamingSession,
): Promise<{ responseText: string | null; inputTokens: number }> {
  const taskPrompt = `## TASK: ${behavior.name.toUpperCase()}

Before starting, briefly note anything relevant from your earlier tasks in this session.

${behavior.prompt}

---
When done, briefly describe what you did or found.`;

  session.yieldMessage(taskPrompt);
  const boundary = await session.waitForResponse();

  for (const tool of boundary.toolInputs) {
    log("IDLE", `Tool: ${tool.name} ${summarizeToolInput(tool.name, tool.input ?? {})}`);
  }
  const cost = boundary.resultMessage
    ? (boundary.resultMessage as { total_cost_usd?: number }).total_cost_usd ?? 0 : 0;
  log("IDLE", `Cost: $${cost.toFixed(4)} (${boundary.toolInputs.length} tool calls)`);

  return {
    responseText: boundary.responseText.trim() || null,
    inputTokens: boundary.lastCallInputTokens,
  };
}
