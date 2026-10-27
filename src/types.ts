export const SEVERITIES = ["critical", "major", "minor", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  "bug",
  "security",
  "performance",
  "error-handling",
  "concurrency",
  "breaking-change",
  "maintainability",
  "test",
  "guideline",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Lower rank = more severe. */
export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export interface Finding {
  /** Repo-relative path, forward slashes. */
  file: string;
  /** 1-based line in the new version of the file. */
  line: number;
  endLine: number;
  severity: Severity;
  category: Category;
  title: string;
  body: string;
  /** Replacement code for line..endLine, or "" when there is no short fix. */
  suggestion: string;
  /** False when the cited line is outside every hunk of the diff. */
  inDiff: boolean;
  snippet?: { start: number; lines: string[] };
  verification?: { verdict: "confirmed" | "rejected"; reason: string };
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}

export interface ReviewStats {
  reviewCalls: number;
  verifyCalls: number;
  costUsd: number;
  durationMs: number;
  /** Nit-severity findings left out because nits are off. */
  hiddenNits: number;
}

export interface ReviewResult {
  scope: string;
  files: ChangedFile[];
  skipped: { path: string; reason: string }[];
  summary: string;
  findings: Finding[];
  /** Findings the verification pass threw out. */
  rejected: Finding[];
  stats: ReviewStats;
}
