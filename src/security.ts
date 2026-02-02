/**
 * Prompt injection protection for Greg.
 * Based on patterns from longrunningagents/docs/SECURITY-PROMPT-INJECTION.md
 */

import path from "node:path";

// =============================================================================
// Pattern Arrays
// =============================================================================

/**
 * Patterns that may indicate prompt injection attempts.
 * Sources: OpenClaw, OWASP, PromptGuard
 */
export const SUSPICIOUS_PATTERNS: RegExp[] = [
  // Instruction override attempts
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /disregard\s+(your\s+)?(rules?|guidelines?)/i,
  /forget\s+(everything|all|your)\s+(instructions?|rules?|guidelines?)/i,

  // Role/mode switching
  /you\s+are\s+now\s+(a|an|in)?\s*(developer|admin)\s*(mode)?/i,
  /pretend\s+(to\s+be|you\s+(are|have))/i,
  /act\s+as\s+(if\s+)?(you\s+)?(have\s+)?/i,

  // Safety bypass attempts
  /bypass\s+(safety|security|filters?|restrictions?)/i,
  /jailbreak/i,
  /DAN\s+(mode|prompt)/i,

  // System prompt markers (injection boundaries)
  /\[SYSTEM\]/i,
  /\[INST\]/i,
  /<<SYS>>/i,
  /<\|im_start\|>/i,
  /<\/?system>/i,

  // Prompt reveal attempts
  /reveal\s+(your\s+)?(system\s+)?prompt/i,
  /what\s+(is|are)\s+your\s+(system\s+)?(instructions?|rules?|guidelines?)/i,
  /print\s+(your\s+)?(initial|system)\s+(prompt|instructions?)/i,
];

/**
 * Patterns indicating encoded/obfuscated content.
 */
export const ENCODING_PATTERNS: RegExp[] = [
  /base64[:\s]/i,
  /decode\s+(this|the\s+following)/i,
  /encrypted[:\s]/i,
  /unicode[:\s]/i,
  /hex[:\s]+(encoded|string)/i,
  /atob\s*\(/i,
  /btoa\s*\(/i,
  /from\s*base64/i,
  /\\u[0-9a-f]{4}/i,
  /\\x[0-9a-f]{2}/i,
];

/**
 * Dangerous bash command patterns.
 */
export const DANGEROUS_BASH_PATTERNS: RegExp[] = [
  // Destructive commands
  /rm\s+-rf\s+\//i,
  /rm\s+-rf\s+~\//i,
  /rm\s+-rf\s+\*/i,
  /\bdd\s+.*of=\/dev\//i,
  /\bmkfs\b/i,

  // Fork bombs
  /:\(\)\s*\{\s*:\|\s*:&\s*\}\s*;/,
  /\.\/\w+\s*&\s*\.\/\w+\s*&/,

  // Remote code execution
  /curl\s+.*\|\s*(bash|sh)/i,
  /wget\s+.*\|\s*(bash|sh)/i,
  /curl\s+.*-o\s*-\s*\|\s*(bash|sh)/i,

  // Dangerous permissions
  /chmod\s+777/i,
  /chmod\s+\+s/i,
  /chown\s+root/i,

  // Dangerous redirects
  />\s*\/dev\/sd[a-z]/i,
  />\s*\/dev\/null\s*2>&1\s*&/i,
];

// =============================================================================
// Types
// =============================================================================

export interface SecurityCheckResult {
  safe: boolean;
  warnings: string[];
  severity: "none" | "low" | "medium" | "high";
}

// =============================================================================
// Functions
// =============================================================================

/**
 * Check content for potential injection attacks.
 */
export function checkForInjection(content: string): SecurityCheckResult {
  const warnings: string[] = [];

  // Check suspicious patterns
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(content)) {
      warnings.push(`Suspicious pattern: ${pattern.source}`);
    }
  }

  // Check encoding patterns
  for (const pattern of ENCODING_PATTERNS) {
    if (pattern.test(content)) {
      warnings.push(`Encoding indicator: ${pattern.source}`);
    }
  }

  // Determine severity
  let severity: "none" | "low" | "medium" | "high" = "none";
  if (warnings.length > 0) {
    if (warnings.length <= 1) {
      severity = "low";
    } else if (warnings.length <= 3) {
      severity = "medium";
    } else {
      severity = "high";
    }
  }

  return {
    safe: warnings.length === 0,
    warnings,
    severity,
  };
}

/**
 * Sanitize untrusted input.
 */
export function sanitizeInput(input: unknown): string {
  // Type check
  if (typeof input !== "string") {
    if (input === null || input === undefined) {
      return "";
    }
    try {
      return String(input);
    } catch {
      return "";
    }
  }

  let content = input;

  // Remove null bytes (security issue)
  content = content.replace(/\0/g, "");

  // Normalize line endings
  content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Limit to 100KB
  const MAX_SIZE = 100 * 1024;
  if (content.length > MAX_SIZE) {
    content = content.slice(0, MAX_SIZE);
  }

  return content;
}

/**
 * Check if a requested path is safe (no directory traversal).
 */
export function isPathSafe(basePath: string, requestedPath: string): boolean {
  // Resolve both paths to absolute
  const resolvedBase = path.resolve(basePath);
  const resolvedRequested = path.resolve(basePath, requestedPath);

  // Check that requested path starts with base path
  // Adding path.sep ensures we don't match partial directory names
  // e.g., /foo/bar should not match /foo/barbaz
  return (
    resolvedRequested === resolvedBase ||
    resolvedRequested.startsWith(resolvedBase + path.sep)
  );
}

/**
 * Check a bash command for dangerous patterns.
 */
export function checkBashCommand(command: string): SecurityCheckResult {
  const warnings: string[] = [];

  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(command)) {
      warnings.push(`Dangerous command pattern: ${pattern.source}`);
    }
  }

  // Determine severity - bash commands are higher risk
  let severity: "none" | "low" | "medium" | "high" = "none";
  if (warnings.length > 0) {
    if (warnings.length === 1) {
      severity = "medium";
    } else {
      severity = "high";
    }
  }

  return {
    safe: warnings.length === 0,
    warnings,
    severity,
  };
}
