/**
 * Turn Executor - SDK Execution
 *
 * Main mode: persistent streaming session with full session management,
 * transcripts, token tracking, and post-turn reviewer.
 * Fork mode: ephemeral branched query() call, no transcripts, log cost only.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { PROJECT_DIR, TRANSCRIPTS_DIR } from "./paths";
import {
  appendToTranscript,
  getTranscriptPath,
  type TranscriptEntry,
} from "./persistence";
import { log, warn, error as logError } from "./log";
import {
  buildDynamicContext,
  loadPersona,
  rollHypothesisInclusion,
  snapshotSessionMtimes,
  checkContextDirtiness,
  resetSessionSnapshot,
  hasSessionSnapshot,
} from "./context-loader";
import type { ContentBlock } from "./discord-formatting";
import {
  loadSessionData,
  loadSessionId,
  saveSessionId,
  updateTokenUsage,
} from "./session-manager";
import {
  getShouldStartFreshSession,
  clearShouldStartFreshSession,
} from "./memory-flush";
import {
  getCurrentSessionId,
  setCurrentSessionId,
  getToolsServer,
} from "./turn-queue";
import {
  type AgentContext,
  type TurnResult,
  type ContextRefreshCallback,
  buildDiscordResponsePrompt,
  buildSystemPromptConfig,
  buildAllowedTools,
  sanitizeResponse,
  findOverlappingParagraphs,
  extractUserIds,
  getSystemPromptMode,
  resolveUser,
  isNoResponse,
} from "./agent-types";
import { buildAccessControlHooks } from "./access-control";
import { setSearchContext, setSearchContextForSession } from "./transcript-index";
import { reviewTurn } from "./post-turn-reviewer";
import { isAdditiveTool } from "./custom-tools";
import { BOT_NAME_LOWER } from "./config/identity";
import {
  getStreamingSession,
  type TypingCallback,
  type ResponseBoundary,
} from "./streaming-session";

/** Resolve user IDs from active participants or fallback to regex extraction. */
function resolveUserIds(discordContext: string, options: AgentContext): string[] {
  if (options.activeUserIds?.length) {
    return options.activeUserIds.map(String);
  }
  return extractUserIds(discordContext);
}

// ============================================================================
// Turn Configuration
// ============================================================================

interface TurnConfig {
  mode: "main" | "fork";
  contextRefreshCallback?: ContextRefreshCallback;
  /** Typing callback for streaming output. */
  typingCallback?: TypingCallback;
}

// ============================================================================
// Main Turn Executor
// ============================================================================

/**
 * Execute a single turn against the Claude Agent SDK.
 *
 * Main mode: Persistent streaming session with transcripts and token tracking.
 * Fork mode: Ephemeral branched session for parallel responses.
 */
export async function executeTurn(
  discordContext: string,
  options: AgentContext,
  config: TurnConfig
): Promise<TurnResult> {
  if (config.mode === "fork") {
    return executeForkTurn(discordContext, options);
  }

  // ========================================================================
  // MAIN MODE: Persistent streaming session
  // Phases: 1) Session setup → 2) Build tools + context → 3) Streaming
  //   ReAct loop (yield → wait → review → continue) → 4) Post-turn teardown
  // ========================================================================

  const msgId = options.originalMessageId ?? "unknown";
  const turnUserId = options.userId ?? "unknown";

  log("SDK", `executeTurn mode=main msg=${msgId} user=${resolveUser(turnUserId)} ch=${options.channelId} mustRespond=${options.mustRespond} isReply=${options.isReplyToBot ?? false} isFollowUp=${options.isFollowUp ?? false}`);

  const userIds = resolveUserIds(discordContext, options);
  log("SDK", `${options.activeUserIds?.length ? "Active" : "Extracted"} ${userIds.length} user IDs: ${userIds.join(', ')}`);

  // Load session ID (for context building — streaming manages its own sessions)
  let sessionId = getCurrentSessionId();
  if (!sessionId) {
    sessionId = await loadSessionId();
    if (sessionId) {
      setCurrentSessionId(sessionId);
    }
    log("SDK", `Loaded session ID: ${sessionId || 'none (new session)'}`);
  } else {
    log("SDK", `Using existing session: ${sessionId}`);
  }

  // Determine if this is a continuation of an existing streaming session
  const session = getStreamingSession(options.isCreator);
  const isStreamingContinuation = session.isAlive();

  // Build dynamic context (skip static blocks on continuation turns)
  log("SDK", `Building dynamic context...${isStreamingContinuation ? " (streaming continuation, skipping static)" : ""}`);
  const dynamicContext = await buildDynamicContext(discordContext, userIds, true, isStreamingContinuation);
  log("SDK", `Dynamic context built (${dynamicContext.length} chars)`);

  // Take mtime snapshot after building context so subsequent turns can detect changes
  if (!hasSessionSnapshot()) {
    snapshotSessionMtimes(userIds);
  }

  // Build prompt
  let prompt = buildDiscordResponsePrompt(dynamicContext, options);

  // Cold-start instruction: when there's no existing session, Greg has no
  // conversational memory — remind him to verify claims with search_transcripts.
  if (!isStreamingContinuation) {
    prompt += `\n\n**[Cold start]** You've just been restarted — you have NO session memory beyond the recent messages above. Before attributing statements to people or engaging deeply with an ongoing topic, use search_transcripts to verify context you're unsure about. Don't guess who said what.`;
  }

  const persona = await loadPersona();
  const toolsServer = getToolsServer();
  const allowedTools = buildAllowedTools(options.isCreator, !!toolsServer);
  const accessHooks = buildAccessControlHooks(options.isCreator);
  setSearchContext(options.channelId, options.isCreator, options.isGroupDm);

  log("SDK", `Using system prompt mode: ${getSystemPromptMode()}`);
  if (!options.isCreator) {
    log("SDK", "Non-creator request: Write/Edit/Bash/Task restricted, reads path-gated via hook");
  }

  // ========================================================================
  // Phase 3: Streaming ReAct loop (yield → wait → review → continue)
  // ========================================================================

  // Ensure session is alive, (re)start if needed
  const isNewSession = !session.isAlive();
  if (isNewSession) {
    log("SDK", `[STREAMING] ${session.label} session not alive — starting...`);
    // Resume from session's own last ID, or from persisted ID for creator only.
    // Public session must never resume the creator's persisted session ID.
    const resumeId = session.lastSessionId ?? (options.isCreator ? sessionId : undefined);
    const systemPromptConfig = buildSystemPromptConfig(persona);
    session.start({
      cwd: PROJECT_DIR,
      model: "claude-sonnet-4-6",
      systemPrompt: systemPromptConfig,
      allowedTools,
      ...(accessHooks ? { hooks: accessHooks } : {}),
      mcpServers: toolsServer ? { "custom-tools": toolsServer } : undefined,
      resumeSessionId: resumeId,
      env: {
        KLIPY_API_KEY: process.env.KLIPY_API_KEY,
      },
    });
    log("SDK", `[STREAMING] Session started${resumeId ? ` (resuming ${resumeId})` : ", will bootstrap on first message"}`);
  }

  // Set search context (global fallback always works; session-keyed set if we have a session ID)
  if (session.sessionId) {
    setSearchContextForSession(session.sessionId, options.channelId, options.isCreator, options.isGroupDm);
  }

  // Yield message and wait for response (mutex-protected)
  log("SDK", `[STREAMING] Acquiring session mutex msg=${msgId}...`);
  await session.acquire();
  log("SDK", `[STREAMING] Mutex acquired, yielding message msg=${msgId}...`);
  const yieldStart = Date.now();
  let boundary: ResponseBoundary;
  let response: string;
  let toolNamesUsed: Set<string>;
  let resultMessage: SDKResultMessage | null;
  try {
    if (options.imageBlocks && options.imageBlocks.length > 0) {
      const contentBlocks: ContentBlock[] = [
        { type: "text", text: prompt },
        ...options.imageBlocks,
      ];
      session.yieldMessage(contentBlocks, config.typingCallback);
    } else {
      session.yieldMessage(prompt, config.typingCallback);
    }
    boundary = await session.waitForResponse();

    const responseTime = ((Date.now() - yieldStart) / 1000).toFixed(1);
    response = boundary.responseText;
    toolNamesUsed = boundary.toolNamesUsed;
    resultMessage = boundary.resultMessage;

    log("SDK", `[STREAMING] Response received msg=${msgId} in ${responseTime}s. Length: ${response.length}, tools: [${[...toolNamesUsed].join(", ")}]`);

    // On first turn: capture session ID now that init has been received
    if (isNewSession && session.sessionId) {
      setCurrentSessionId(session.sessionId);
      await saveSessionId(session.sessionId);
      log("SDK", `[STREAMING] Session bootstrapped: ${session.sessionId}`);
      setSearchContextForSession(session.sessionId, options.channelId, options.isCreator, options.isGroupDm);
    }

    // Get transcript file (now that session ID is available)
    const activeSessionId = session.sessionId ?? getCurrentSessionId();
    const activeTranscriptFile = activeSessionId
      ? getTranscriptPath(TRANSCRIPTS_DIR, activeSessionId)
      : null;

    // Append user message to transcript
    if (activeTranscriptFile) {
      try {
        const userEntry: TranscriptEntry = {
          type: "user",
          content: discordContext,
          timestamp: Date.now(),
          metadata: {
            channelId: options.channelId,
            isGroupDm: options.isGroupDm,
            mustRespond: options.mustRespond,
          },
        };
        await appendToTranscript(activeTranscriptFile, userEntry);
      } catch (err) {
        logError("SDK", "Failed to append user message to transcript", err);
      }
    }

    // Update token usage
    if (resultMessage) {
      try {
        await updateTokenUsage(resultMessage, boundary.lastCallInputTokens);
      } catch (err) {
        logError("SDK", "Failed to update token usage", err);
      }
    }

    try {
      if (getShouldStartFreshSession()) {
        log("SDK", "[STREAMING] Memory flush requested fresh session — will restart");
        session.close();
        setCurrentSessionId(undefined);
        clearShouldStartFreshSession();
        resetSessionSnapshot();
        rollHypothesisInclusion();
      } else if (activeSessionId) {
        const sessionData = await loadSessionData();
        const currentTokens = sessionData?.totalTokens ?? 0;
        // ~750k tokens ≈ 75% of the 1M context window. Beyond this,
        // prompt assembly competes with conversation history for space.
        if (currentTokens >= 750000) {
          log("SDK", `[STREAMING] Token threshold reached (${currentTokens}) — will restart session`);
          session.close();
          setCurrentSessionId(undefined);
          resetSessionSnapshot();
          rollHypothesisInclusion();
        } else {
          const dirtiness = checkContextDirtiness();
          if (dirtiness.needsFreshSession) {
            log("SDK", "[STREAMING] Context files changed — will restart session");
            session.close();
            setCurrentSessionId(undefined);
            resetSessionSnapshot();
            rollHypothesisInclusion();
            // If persona/patterns changed, close BOTH sessions
            const otherSession = options.isCreator ? getStreamingSession(false) : getStreamingSession(true);
            if (otherSession.isAlive()) {
              log("SDK", "[STREAMING] Also restarting the other session (shared context changed)");
              otherSession.close();
            }
          }
        }
      }
    } catch (err) {
      logError("SDK", "Post-turn teardown check failed", err);
    }

    // ---- Post-turn Haiku reviewer (ReAct Observe step) ----
    if (response.length >= 20 && !options.isFollowUp) {
      const visible = response.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      const hasVisibleResponse = visible.length >= 20 && visible !== "[NO_RESPONSE]";
      const toolsUsedButNoResponse = toolNamesUsed.size > 0 && (visible === "[NO_RESPONSE]" || visible.length < 20);
      const isQuestion = visible.length > 0 && visible.includes("?");

      if (hasVisibleResponse || toolsUsedButNoResponse || isQuestion) {
        // Keep typing indicator alive during reviewer
        const typingCb = config.typingCallback;
        const reviewerTypingInterval = typingCb
          ? setInterval(() => typingCb(""), 8_000)
          : null;
        typingCb?.("");

        let missed: Awaited<ReturnType<typeof reviewTurn>>;
        try {
          missed = await reviewTurn({
            userMessage: extractLastUserMessage(discordContext),
            responseText: toolsUsedButNoResponse ? `[NO_RESPONSE] (but used tools: ${[...toolNamesUsed].join(", ")})` : visible,
            toolNamesUsed,
            channelId: options.channelId,
            recentSpeakers: extractRecentSpeakers(discordContext),
            isGroupDm: options.isGroupDm ?? false,
          });
        } catch (err) {
          warn("SDK", `[STREAMING] Initial reviewTurn failed: ${err instanceof Error ? err.message : String(err)}`);
          missed = [];
        }

        // Cap at 2 iterations: one to fix the issue, one to verify the fix.
        // More iterations risk loops where the reviewer and agent disagree.
        const MAX_REACT_ITERATIONS = 2;
        let reactIteration = 0;
        let currentMissed = missed;
        let sentReplacement = false;

        while (currentMissed.length > 0 && reactIteration < MAX_REACT_ITERATIONS) {
          reactIteration++;
          log("SDK", `[STREAMING] ReAct iteration ${reactIteration}: ${currentMissed.length} issue(s)`);

          if (!session.isAlive()) break;

          const continuationPrompt = buildReviewerContinuation(currentMissed, options.channelId, options.imageBlocks);

          try {
            session.yieldMessage(continuationPrompt);
            const contBoundary = await session.waitForResponse(60_000);

            for (const toolName of contBoundary.toolNamesUsed) {
              toolNamesUsed.add(toolName);
              const shortName = toolName.replace(/^mcp__[^_]+__/, "");
              if (shortName === "send_to_channel") {
                sentReplacement = true;
              }
            }

            log("SDK", `[STREAMING] ReAct iteration ${reactIteration}: ${contBoundary.toolNamesUsed.size} tool(s), sent replacement: ${sentReplacement}`);

            // Re-run reviewer on continuation
            if (reactIteration < MAX_REACT_ITERATIONS && contBoundary.toolNamesUsed.size > 0) {
              const reviewText = sentReplacement
                ? `[Original response suppressed — sent replacement via send_to_channel]`
                : `${visible}\n[Continuation used tools: ${[...toolNamesUsed].join(", ")}]`;

              currentMissed = await reviewTurn({
                userMessage: extractLastUserMessage(discordContext),
                responseText: reviewText.substring(0, 500),
                toolNamesUsed,
                channelId: options.channelId,
                recentSpeakers: extractRecentSpeakers(discordContext),
                isGroupDm: options.isGroupDm ?? false,
              });
            } else {
              currentMissed = [];
            }
          } catch (err) {
            warn("SDK", `[STREAMING] ReAct iteration ${reactIteration} failed: ${err instanceof Error ? err.message : String(err)}`);
            // Do NOT reset sentReplacement — if a replacement was already delivered to Discord, that can't be undone
            break;
          }
        }

        if (reactIteration > 0) {
          const allAdditive = missed.every(m => isAdditiveTool(m.tool));
          log("SDK", `[STREAMING] ReAct loop completed after ${reactIteration} iteration(s), sent replacement: ${sentReplacement}, all additive: ${allAdditive}`);

          if (sentReplacement && !allAdditive) {
            log("SDK", "[STREAMING] Suppressing original response — corrective continuation sent replacement");
            response = "[NO_RESPONSE]";
          } else if (sentReplacement && allAdditive) {
            log("SDK", "[STREAMING] Keeping original response — additive continuation sent separately");
          }
        }

        if (reviewerTypingInterval) clearInterval(reviewerTypingInterval);
      }
    }

    // Check for NO_RESPONSE
    const noResponse = isNoResponse(response);

    // Append assistant response to transcript
    if (activeTranscriptFile) {
      try {
        const assistantEntry: TranscriptEntry = {
          type: "assistant",
          content: noResponse ? "[NO_RESPONSE]" : response.trim(),
          timestamp: Date.now(),
          metadata: {
            channelId: options.channelId,
            responseLength: response.length,
          },
        };
        await appendToTranscript(activeTranscriptFile, assistantEntry);
      } catch (err) {
        logError("SDK", "Failed to append assistant response to transcript", err);
      }
    }

    if (noResponse) {
      return { kind: "no_response", toolNamesUsed };
    }

    // Context refresh check
    if (config.contextRefreshCallback) {
      try {
        const refreshResult = await config.contextRefreshCallback();
        if (refreshResult.shouldSkip) {
          return { kind: "skipped", reason: "stale context" };
        }
        if (refreshResult.acknowledgment) {
          const sanitized = sanitizeResponse(response.trim());
          return { kind: "response", text: `${refreshResult.acknowledgment}\n\n${sanitized}`, toolNamesUsed };
        }
      } catch (err) {
        logError("SDK", "Context refresh failed", err);
      }
    }

    let sanitized = sanitizeResponse(response.trim());
    if (!sanitized) {
      return { kind: "skipped", reason: "empty after sanitize" };
    }
    sanitized = await dedupParagraphs(sanitized);
    if (!sanitized.trim()) {
      return { kind: "skipped", reason: "empty after dedup" };
    }
    return { kind: "response", text: sanitized, toolNamesUsed };

  } catch (err) {
    logError("SDK", `[STREAMING] Turn execution failed after ${((Date.now() - yieldStart) / 1000).toFixed(1)}s`, err);

    // Salvage partial response on stall — if the model already produced usable text
    // before the SDK went silent, send it rather than wasting the work.
    const isStall = err instanceof Error && /SDK stalled/.test(err.message);
    const partial = session.partialResponse;
    if (isStall && partial.length > 30) {
      const sanitized = sanitizeResponse(partial.trim());
      if (sanitized) {
        log("SDK", `[STREAMING] Salvaged ${sanitized.length} chars of partial response from stalled turn`);
        // Close and clear session — don't resume a stalled session
        session.close();
        setCurrentSessionId(undefined);
        resetSessionSnapshot();
        return { kind: "response", text: sanitized, toolNamesUsed: new Set<string>() };
      }
    }

    // Close the session on any failure — prevents zombie sessions
    if (session.isAlive()) {
      log("SDK", `[STREAMING] Closing session after error (was alive but stuck)`);
      session.close();
    } else {
      log("SDK", `[STREAMING] Session already dead — will restart on next turn`);
    }

    // On stall, don't resume the same session — start fresh
    if (isStall) {
      setCurrentSessionId(undefined);
      resetSessionSnapshot();
    }

    return { kind: "error", error: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    session.release();
  }
}

// ============================================================================
// Fork Turn Executor (Classic query() for ephemeral parallel operations)
// ============================================================================

/**
 * Execute a fork turn using classic per-turn query().
 * Used by haiku-router.ts and followup-executor.ts for ephemeral sessions.
 */
async function executeForkTurn(
  discordContext: string,
  options: AgentContext,
): Promise<TurnResult> {
  const msgId = options.originalMessageId ?? "unknown";
  log("SDK", `[FORK] executeTurn msg=${msgId} user=${resolveUser(options.userId ?? "unknown")} ch=${options.channelId}`);

  // Fork needs a session to fork from
  let sessionId = getCurrentSessionId();
  if (!sessionId) {
    sessionId = await loadSessionId();
    if (sessionId) {
      setCurrentSessionId(sessionId);
    } else {
      warn("SDK", "[FORK] No session to fork from, falling back to queue");
      return { kind: "skipped", reason: "no session to fork from" };
    }
  }

  // Build context + prompt
  const userIds = resolveUserIds(discordContext, options);
  const dynamicContext = await buildDynamicContext(discordContext, userIds, false, false);
  const prompt = buildDiscordResponsePrompt(dynamicContext, options);

  // Build SDK options
  const persona = await loadPersona();
  const systemPromptConfig = buildSystemPromptConfig(persona);
  const toolsServer = getToolsServer();
  const allowedTools = buildAllowedTools(options.isCreator, !!toolsServer);
  const accessHooks = buildAccessControlHooks(options.isCreator);
  setSearchContext(options.channelId, options.isCreator, options.isGroupDm);

  log("SDK", `[FORK] Calling query()...`);
  let response = "";
  const toolNamesUsed = new Set<string>();

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: PROJECT_DIR,
        model: "haiku",
        resume: sessionId,
        forkSession: true,
        systemPrompt: systemPromptConfig,
        settingSources: ["project"],
        allowedTools,
        ...(accessHooks ? { hooks: accessHooks } : {}),
        mcpServers: toolsServer ? { "custom-tools": toolsServer } : undefined,
        env: {
          ...process.env,
          KLIPY_API_KEY: process.env.KLIPY_API_KEY,
        },
      },
    })) {
      if (message.type === "system") {
        const sysMsg = message as any;
        if (sysMsg.subtype === "init") {
          log("SDK", `[FORK] Got forked session ID: ${sysMsg.session_id} (ephemeral, not saved)`);
        }
      } else if (message.type === "assistant" && (message as any).message?.content) {
        for (const block of (message as any).message.content) {
          if ("text" in block) {
            if (response.length > 0 && !response.endsWith("\n")) response += "\n\n";
            response += block.text;
          } else if ("name" in block) {
            toolNamesUsed.add((block as { name: string }).name);
            log("SDK", `[FORK] Tool call: ${(block as { name: string }).name}`);
          }
        }
      } else if (message.type === "result") {
        const totalCost = (message as SDKResultMessage).total_cost_usd ?? 0;
        log("SDK", `[FORK] Cost: $${totalCost.toFixed(4)} (not counted in main session)`);
      }
    }
  } catch (err) {
    logError("SDK", `[FORK] Query failed`, err);
    return { kind: "error", error: err instanceof Error ? err : new Error(String(err)) };
  }

  log("SDK", `[FORK] Query complete msg=${msgId}. Response length: ${response.length}`);

  const noResponse = isNoResponse(response);
  if (noResponse) {
    return { kind: "no_response", toolNamesUsed };
  }

  const sanitized = sanitizeResponse(response.trim());
  if (!sanitized) {
    return { kind: "skipped", reason: "empty after sanitize" };
  }
  return { kind: "response", text: sanitized, toolNamesUsed };
}

// ============================================================================
// Reviewer Helpers
// ============================================================================

/** Build the continuation prompt for missed tool actions. Returns content blocks if images present. */
function buildReviewerContinuation(
  missed: import("./agent-types").MissedAction[],
  channelId: import("./agent-types").ChannelId,
  imageBlocks?: ContentBlock[],
): string | ContentBlock[] {
  const observations = missed.map(m => `- ${m.tool}: ${m.task}`).join("\n");
  const allAdditive = missed.every(m => isAdditiveTool(m.tool));

  let text: string;
  if (allAdditive) {
    text = `[Reviewer feedback] Your response will be sent as-is. However, you missed these additional actions:\n${observations}\n\nExecute the missed tool calls now. If the results produce content worth sharing (like a GIF or image), send it as a follow-up via send_to_channel (channel: ${channelId}). If the tool was for verification and your original response holds up, just output [NO_RESPONSE].`;
  } else {
    text = `[Reviewer feedback] Your response was reviewed and these issues were flagged:\n${observations}\n\nIMPORTANT: Your text output here is invisible to the user — only tool calls matter. Address each issue using the tools available. If after investigating your original response turns out to be accurate, just output [NO_RESPONSE] — it will be sent as-is. If you find errors or missing context that changes your response, you MUST use send_to_channel (channel: ${channelId}) to deliver the corrected version, then output [NO_RESPONSE]. Without send_to_channel, only your original (possibly wrong) response will be seen.`;
  }

  // Re-include original images so the model can reference them during ReAct
  if (imageBlocks && imageBlocks.length > 0) {
    return [{ type: "text", text }, ...imageBlocks];
  }
  return text;
}

// ============================================================================
// Paragraph Dedup (Haiku judge for near-duplicate paragraphs)
// ============================================================================

const DEDUP_TIMEOUT_MS = 8_000;

/**
 * If consecutive paragraphs share any bigram overlap, ask Haiku to judge
 * whether they're saying the same thing. Returns cleaned text.
 * Cheap gate (bigram overlap) → expensive judge (Haiku) only when needed.
 */
async function dedupParagraphs(text: string): Promise<string> {
  const pairs = findOverlappingParagraphs(text);
  if (pairs.length === 0) return text;

  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);
  log("SDK", `Found ${pairs.length} paragraph pair(s) with bigram overlap — asking Haiku to judge`);

  const indicesToDrop = new Set<number>();

  for (const { i, j, overlap } of pairs) {
    if (indicesToDrop.has(i) || indicesToDrop.has(j)) continue;

    const prompt = `Two consecutive paragraphs from a Discord message. Are they saying the same thing (paraphrases/near-duplicates)?

Paragraph A:
"${paragraphs[i]}"

Paragraph B:
"${paragraphs[j]}"

If they say essentially the same thing, reply: DROP_SECOND
If paragraph A is just a preview/announcement of what B reports as done, reply: DROP_FIRST
If they make genuinely different points, reply: KEEP_BOTH

Reply with ONLY one of: DROP_FIRST, DROP_SECOND, or KEEP_BOTH`;

    try {
      let responseText = "";
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), DEDUP_TIMEOUT_MS);

      try {
        for await (const message of query({
          prompt,
          options: {
            cwd: PROJECT_DIR,
            model: "haiku",
            systemPrompt: "You compare two paragraphs and decide if they are near-duplicates. Reply with exactly one of: DROP_FIRST, DROP_SECOND, or KEEP_BOTH. Nothing else.",
            allowedTools: [],
            abortController,
          },
        })) {
          if (message.type === "assistant" && message.message?.content) {
            for (const block of message.message.content) {
              if ("text" in block) responseText += block.text;
            }
          }
        }
      } finally {
        clearTimeout(timer);
      }

      const verdict = responseText.trim().toUpperCase();
      if (verdict.includes("DROP_FIRST")) {
        log("SDK", `Haiku dedup: dropping paragraph ${i} (overlap=${overlap.toFixed(2)}): "${paragraphs[i].substring(0, 60)}..."`);
        indicesToDrop.add(i);
      } else if (verdict.includes("DROP_SECOND")) {
        log("SDK", `Haiku dedup: dropping paragraph ${j} (overlap=${overlap.toFixed(2)}): "${paragraphs[j].substring(0, 60)}..."`);
        indicesToDrop.add(j);
      } else {
        log("SDK", `Haiku dedup: keeping both paragraphs ${i}/${j} (overlap=${overlap.toFixed(2)})`);
      }
    } catch (err) {
      warn("SDK", `Haiku dedup failed for pair ${i}/${j}, keeping both: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (indicesToDrop.size === 0) return text;

  const kept = paragraphs.filter((_, idx) => !indicesToDrop.has(idx));
  return kept.join("\n\n");
}

/** Extract the current message author and content from a Discord context string for the reviewer. */
function extractLastUserMessage(discordContext: string): string {
  const section = discordContext.match(/=== Current Message ===([\s\S]*?)(?:===|$)/);
  if (section) {
    const authorMatch = section[1].match(/(?:Author|From): (\S+?)(?:@\d+)?[\s\n]/);
    const contentMatch = section[1].match(/Content: (.+)/);
    const author = authorMatch?.[1] ?? "unknown";
    const content = contentMatch?.[1] ?? section[1].trim();
    return `[${author}]: ${content}`.substring(0, 500);
  }
  return discordContext.slice(-500).substring(0, 500);
}

/**
 * Extract recent speakers from discord context for the reviewer.
 * Primary: Parse the `Participants:` block from `=== Channel Info ===` (Group DM only).
 * Fallback: Parse `[Username]:` patterns from `=== Recent Messages ===`.
 * Filters out "Greg" (the bot).
 */
function extractRecentSpeakers(discordContext: string): string[] {
  const speakers = new Set<string>();

  // Participants are formatted as "  - username@id"
  const participantsMatch = discordContext.match(/Participants:\s*\n((?:\s+-\s+.+\n?)+)/);
  if (participantsMatch) {
    const lines = participantsMatch[1].split("\n");
    for (const line of lines) {
      const m = line.match(/^\s+-\s+(\S+?)(?:@\d+)?$/);
      if (m && m[1].toLowerCase() !== BOT_NAME_LOWER) {
        speakers.add(m[1]);
      }
    }
    if (speakers.size > 0) return [...speakers];
  }

  // Messages are formatted as "[username@id]:" or "[BotName]:"
  const recentSection = discordContext.match(/=== Recent Messages[^=]*===\n([\s\S]*?)(?:===|$)/);
  if (recentSection) {
    const userPattern = /\[([^\]@]+)(?:@\d+)?\]:/g;
    let match;
    while ((match = userPattern.exec(recentSection[1])) !== null) {
      const name = match[1].trim();
      if (name.toLowerCase() !== BOT_NAME_LOWER) {
        speakers.add(name);
      }
    }
  }

  return [...speakers];
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Convenience wrapper for main mode execution.
 * Used as the registered turn executor in turn-queue.ts.
 */
export async function executeAgentTurn(
  discordContext: string,
  options: AgentContext,
  contextRefreshCallback?: ContextRefreshCallback,
  typingCallback?: TypingCallback
): Promise<TurnResult> {
  return executeTurn(discordContext, options, {
    mode: "main",
    contextRefreshCallback,
    typingCallback,
  });
}
