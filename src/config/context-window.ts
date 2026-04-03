/**
 * Context Window Configuration
 *
 * All thresholds are derived from the model's context window size.
 * Change MODEL to switch between 200k and 1M — all thresholds adjust automatically.
 *
 * To enable 1M: change MODEL to "claude-sonnet-4-6[1m]"
 * (requires "Extra usage" enabled on your Anthropic account)
 */

// The model used for the main streaming session
export const MODEL = "claude-sonnet-4-6";

// Context window size — determined by model suffix
const CONTEXT_WINDOW = MODEL.includes("[1m]") ? 1_000_000 : 200_000;

// --- Thresholds (as fractions of context window) ---

/**
 * Memory flush: snapshot memories to disk before context gets too large.
 * At 200k: 120k tokens. At 1M: 200k tokens (lower ratio — 200k is still plenty of signal).
 */
export const SOFT_FLUSH_THRESHOLD = MODEL.includes("[1m]") ? 200_000 : 120_000;

/**
 * Memory flush buffer: re-trigger flush after accumulating this many tokens since last flush.
 * At 200k: 40k. At 1M: 100k.
 */
export const FLUSH_BUFFER = MODEL.includes("[1m]") ? 100_000 : 40_000;

/**
 * Hard restart: tear down session and start fresh to avoid context pressure.
 * At 200k: 170k tokens (~85%). At 1M: 700k tokens (70%).
 */
export const HARD_RESTART_THRESHOLD = MODEL.includes("[1m]") ? 700_000 : 170_000;

/**
 * Cold cache restart: if session is above this AND cache is stale (>5min idle),
 * start fresh instead of paying full input token cost on a cold resume.
 * At 200k: 100k. At 1M: 200k.
 */
export const COLD_RESUME_TOKEN_THRESHOLD = MODEL.includes("[1m]") ? 200_000 : 100_000;
