import fs from "node:fs/promises";
import path from "node:path";
import { AGENT_DATA_DIR } from "./paths";
import { getEffectiveConfig } from "./config/runtime-config";
import { warn } from "./log";

// ============================================================================
// Response Triggers (loaded from disk - Greg can edit these!)
// ============================================================================

const TRIGGERS_FILE = path.join(AGENT_DATA_DIR, "response-triggers.json");

interface ResponseTriggers {
  [category: string]: {
    _description?: string;
    keywords?: string[];
  };
}

let cachedTriggers: ResponseTriggers | null = null;
let triggersLastLoaded = 0;
const TRIGGERS_CACHE_MS = 30_000; // Reload every 30 seconds

/** Allowlist pattern for keyword validation (alphanumeric, spaces, hyphens, apostrophes, and ? for social cues) */
const KEYWORD_ALLOWLIST = /^[a-z0-9 \-'?]+$/i;

/**
 * Normalize a keyword: NFKC Unicode normalization + lowercase.
 */
function normalizeKeyword(keyword: string): string {
  return keyword.normalize("NFKC").toLowerCase();
}

/**
 * Validate a keyword against the allowlist pattern.
 * Returns true if the keyword is valid.
 */
function isValidKeyword(keyword: string): boolean {
  return KEYWORD_ALLOWLIST.test(keyword);
}

/**
 * Load response triggers from disk (with caching) and merge with custom keywords.
 * The bot can edit agent-data/response-triggers.json to add new topics,
 * and also configure keywords via runtime-config.json.
 */
export async function loadResponseTriggers(): Promise<string[]> {
  const now = Date.now();

  // Load base keywords from response-triggers.json (with caching)
  let baseKeywords: string[];
  if (cachedTriggers && now - triggersLastLoaded < TRIGGERS_CACHE_MS) {
    baseKeywords = extractKeywords(cachedTriggers);
  } else {
    try {
      const content = await fs.readFile(TRIGGERS_FILE, "utf-8");
      cachedTriggers = JSON.parse(content);
      triggersLastLoaded = now;
      baseKeywords = extractKeywords(cachedTriggers!);
    } catch (error: unknown) {
      // ENOENT is expected (file is optional) — only warn on other errors
      if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") {
        warn("TRIGGERS", "Failed to load response triggers, using defaults", error);
      }
      baseKeywords = getDefaultKeywords();
    }
  }

  // Load Greg's custom keywords from config
  let gregKeywords: string[] = [];
  try {
    const effectiveConfig = await getEffectiveConfig();
    gregKeywords = effectiveConfig.config.keywords || [];
  } catch (error) {
    warn("TRIGGERS", "Failed to load Greg's keywords from config", error);
  }

  // Combine all keywords
  const allKeywords = [...baseKeywords, ...gregKeywords];

  // Normalize, validate, and dedupe
  const seen = new Set<string>();
  const result: string[] = [];

  for (const keyword of allKeywords) {
    // Normalize: NFKC Unicode normalization + lowercase
    const normalized = normalizeKeyword(keyword);

    // Skip empty strings
    if (!normalized) continue;

    // Validate against allowlist (double-check, also done in runtime-config)
    if (!isValidKeyword(normalized)) {
      warn("TRIGGERS", `Skipping invalid keyword: "${keyword}"`);
      continue;
    }

    // Dedupe
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

/**
 * Extract all keywords from the triggers structure.
 */
function extractKeywords(triggers: ResponseTriggers): string[] {
  const keywords: string[] = [];
  for (const category of Object.keys(triggers)) {
    if (category.startsWith("_")) continue; // Skip meta fields
    const section = triggers[category];
    if (section.keywords && Array.isArray(section.keywords)) {
      keywords.push(...section.keywords);
    }
  }
  return keywords;
}

/**
 * Fallback keywords if file can't be loaded.
 */
function getDefaultKeywords(): string[] {
  return [
    "arc raiders", "hots", "heroes of the storm", "overwatch",
    "patch", "meta", "nerf", "buff", "ranked", "mmr", "elo",
    "gaming", "game", "play", "playing"
  ];
}
