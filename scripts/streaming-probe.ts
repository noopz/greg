/**
 * Streaming Probe - SDK Streaming Input Behavior Validation
 *
 * Run: bun run scripts/streaming-probe.ts
 *
 * Tests 5 critical unknowns about streaming input mode:
 * Q1: Turn boundary signal — What SDKMessage fires between assistant responses?
 * Q2: session_id bootstrapping — What value works for the first message?
 * Q3: Eager vs lazy iteration — Does the SDK drain the AsyncIterable eagerly?
 * Q4: Fork from active session — Can forkSession: true work mid-streaming?
 * Q5: Token tracking — Are per-turn token counts available between messages?
 *
 * FINDINGS (update after running):
 * Q1: [TODO: Run probe and document]
 * Q2: [TODO: Run probe and document]
 * Q3: [TODO: Run probe and document]
 * Q4: [TODO: Run probe and document]
 * Q5: [TODO: Run probe and document]
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const PROJECT_DIR = process.cwd();

// ============================================================================
// MessageChannel — async generator bridge for streaming input
// ============================================================================

class MessageChannel {
  private queue: SDKUserMessage[] = [];
  private waiter: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined as any, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.closed) {
        return;
      } else {
        const result = await new Promise<IteratorResult<SDKUserMessage>>(
          (resolve) => { this.waiter = resolve; }
        );
        if (result.done) return;
        yield result.value;
      }
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function makeUserMessage(text: string, sessionId: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function logMsg(tag: string, msg: string): void {
  console.log(`[${timestamp()}] [${tag}] ${msg}`);
}

function logSdkMessage(msg: SDKMessage): void {
  const base = `type=${msg.type}`;
  const sub = "subtype" in msg ? ` subtype=${(msg as any).subtype}` : "";
  const sid = "session_id" in msg ? ` session=${(msg as any).session_id?.substring(0, 12)}...` : "";

  // Extra detail based on type
  let extra = "";
  if (msg.type === "result") {
    const r = msg as any;
    extra = ` cost=$${r.total_cost_usd?.toFixed(4)} turns=${r.num_turns}`;
    if (r.usage) {
      extra += ` input=${r.usage.input_tokens} output=${r.usage.output_tokens}`;
    }
  } else if (msg.type === "assistant" && (msg as any).message?.content) {
    const content = (msg as any).message.content;
    const texts = content.filter((b: any) => "text" in b).map((b: any) => b.text);
    extra = ` text="${texts.join("").substring(0, 60)}..."`;
  } else if (msg.type === "system" && (msg as any).subtype === "init") {
    const init = msg as any;
    extra = ` model=${init.model} tools=${init.tools?.length ?? 0}`;
  }

  logMsg("SDK", `${base}${sub}${sid}${extra}`);
}

// ============================================================================
// Probe Execution
// ============================================================================

async function runProbe(): Promise<void> {
  logMsg("PROBE", "=== Starting streaming probe ===");

  const channel = new MessageChannel();
  let capturedSessionId = "";

  // Start query with streaming input
  logMsg("PROBE", "Creating query with AsyncIterable prompt...");
  const q = query({
    prompt: channel,
    options: {
      cwd: PROJECT_DIR,
      model: "haiku",
      permissionMode: "bypassPermissions",
      allowedTools: [],
    },
  });

  // Background output consumer
  const messages: SDKMessage[] = [];
  let resultCount = 0;
  const outputDone = (async () => {
    for await (const msg of q) {
      messages.push(msg);
      logSdkMessage(msg);

      if (msg.type === "system" && (msg as any).subtype === "init") {
        capturedSessionId = (msg as any).session_id;
        logMsg("PROBE", `Q2 ANSWER: Init message provides session_id="${capturedSessionId}"`);
      }

      if (msg.type === "result") {
        resultCount++;
        logMsg("PROBE", `Q1/Q5: Result message #${resultCount} received (turn boundary signal)`);
        const r = msg as any;
        if (r.usage) {
          logMsg("PROBE", `Q5: Per-turn usage: input=${r.usage.input_tokens} output=${r.usage.output_tokens} cache_read=${r.usage.cache_read_input_tokens ?? 0}`);
        }
      }
    }
    logMsg("PROBE", "Output stream ended");
  })();

  // Wait for init
  logMsg("PROBE", "Waiting for init message...");
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (capturedSessionId) {
        clearInterval(check);
        resolve();
      }
    }, 100);
    // Timeout after 30s
    setTimeout(() => { clearInterval(check); resolve(); }, 30_000);
  });

  if (!capturedSessionId) {
    logMsg("PROBE", "ERROR: No session_id received from init. Aborting.");
    channel.close();
    return;
  }

  // Q2: First message — test with the session_id from init
  logMsg("PROBE", "--- Q2 TEST: Sending first message with captured session_id ---");
  const msg1Time = Date.now();
  channel.push(makeUserMessage("Say exactly: 'Message 1 received'. Nothing else.", capturedSessionId));
  logMsg("PROBE", `Q3: Message 1 pushed at ${timestamp()}`);

  // Wait for first result
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (resultCount >= 1) { clearInterval(check); resolve(); }
    }, 100);
    setTimeout(() => { clearInterval(check); resolve(); }, 60_000);
  });

  logMsg("PROBE", `Q1: First turn completed. Result count: ${resultCount}. Took ${Date.now() - msg1Time}ms`);

  // Q3: Second message — does the SDK pull lazily?
  logMsg("PROBE", "--- Q3 TEST: Sending second message after first response ---");
  const msg2Time = Date.now();
  channel.push(makeUserMessage("Say exactly: 'Message 2 received'. Nothing else.", capturedSessionId));
  logMsg("PROBE", `Q3: Message 2 pushed at ${timestamp()}`);

  // Wait for second result
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (resultCount >= 2) { clearInterval(check); resolve(); }
    }, 100);
    setTimeout(() => { clearInterval(check); resolve(); }, 60_000);
  });

  logMsg("PROBE", `Q3: Second turn completed. Took ${Date.now() - msg2Time}ms`);

  // Q4: Fork from active session
  logMsg("PROBE", "--- Q4 TEST: Sending third message and forking mid-session ---");
  channel.push(makeUserMessage("Say exactly: 'Message 3 received'. Nothing else.", capturedSessionId));

  // Attempt fork while streaming session is alive
  try {
    logMsg("PROBE", "Attempting fork with forkSession: true...");
    let forkResponse = "";
    for await (const forkMsg of query({
      prompt: "Say exactly: 'Fork successful'. Nothing else.",
      options: {
        cwd: PROJECT_DIR,
        model: "haiku",
        resume: capturedSessionId,
        forkSession: true,
        permissionMode: "bypassPermissions",
        allowedTools: [],
      },
    })) {
      if (forkMsg.type === "assistant" && (forkMsg as any).message?.content) {
        for (const block of (forkMsg as any).message.content) {
          if ("text" in block) forkResponse += block.text;
        }
      }
    }
    logMsg("PROBE", `Q4 ANSWER: Fork succeeded! Response: "${forkResponse.substring(0, 60)}"`);
  } catch (err) {
    logMsg("PROBE", `Q4 ANSWER: Fork FAILED: ${err}`);
  }

  // Wait for third result from main session
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (resultCount >= 3) { clearInterval(check); resolve(); }
    }, 100);
    setTimeout(() => { clearInterval(check); resolve(); }, 60_000);
  });

  // Close channel and wait for output to finish
  logMsg("PROBE", "Closing channel...");
  channel.close();

  // Give time for output to drain
  await Promise.race([
    outputDone,
    new Promise(resolve => setTimeout(resolve, 10_000)),
  ]);

  // Summary
  logMsg("PROBE", "=== PROBE SUMMARY ===");
  logMsg("PROBE", `Total SDK messages: ${messages.length}`);
  logMsg("PROBE", `Result messages: ${resultCount}`);
  logMsg("PROBE", `Session ID: ${capturedSessionId}`);

  const msgTypes = new Map<string, number>();
  for (const m of messages) {
    const key = m.type + ("subtype" in m ? `:${(m as any).subtype}` : "");
    msgTypes.set(key, (msgTypes.get(key) ?? 0) + 1);
  }
  logMsg("PROBE", "Message type counts:");
  for (const [type, count] of [...msgTypes.entries()].sort()) {
    logMsg("PROBE", `  ${type}: ${count}`);
  }

  logMsg("PROBE", "=== Probe complete ===");
  process.exit(0);
}

runProbe().catch((err) => {
  console.error("Probe failed:", err);
  process.exit(1);
});
