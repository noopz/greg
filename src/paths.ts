import path from "node:path";

/** Today's date in YYYY-MM-DD format using local timezone (not UTC). */
export function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const PROJECT_DIR = process.cwd();
export const AGENT_DATA_DIR = path.join(PROJECT_DIR, "agent-data");
export const TRANSCRIPTS_DIR = path.join(AGENT_DATA_DIR, "transcripts");
export const MEMORIES_DIR = path.join(AGENT_DATA_DIR, "memories");
export const RELATIONSHIPS_DIR = path.join(AGENT_DATA_DIR, "relationships");
export const IMPRESSIONS_DIR = path.join(AGENT_DATA_DIR, "impressions");
export const SKILLS_DIR = path.join(PROJECT_DIR, ".claude", "skills");
export const LOCAL_SKILLS_DIR = path.join(PROJECT_DIR, "local", "skills");
export const AGENTS_DIR = path.join(PROJECT_DIR, ".claude", "agents");
export const LOGS_DIR = path.join(PROJECT_DIR, "logs");

/** Sanitize a user ID for use as a filename component. */
export function safeFileId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}
