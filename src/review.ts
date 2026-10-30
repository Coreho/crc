import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunModel } from "./backend.ts";
import { isIgnored, type Config } from "./config.ts";
import { diffSize, lineInDiff, renderFileDiff, type FileDiff } from "./diff.ts";
import { collectChanges, readScopedFile, type Scope } from "./git.ts";
import {
  REVIEW_SCHEMA,
  REVIEW_SYSTEM,
  VERIFY_SCHEMA,
  VERIFY_SYSTEM,
  reviewPrompt,
  verifyPrompt,
  type Guideline,
} from "./prompts.ts";
import {
  CATEGORIES,
  SEVERITIES,
  severityRank,
  type Category,
  type Finding,
  type ReviewResult,
  type Severity,
} from "./types.ts";

export interface ReviewOptions {
  root: string;
  scope: Scope;
  config: Config;
  runModel: RunModel;
  includeUntracked?: boolean;
  /**
   * Review only these changed files. The rest of the change is named to the
   * model as context but gets no findings; pull requests use this after a rebase.
   */
  only?: string[];
  /** Parallel model calls. */
  concurrency?: number;
  /** Diff lines per review batch; a single larger file still gets one batch. */
  batchLines?: number;
  onProgress?: (message: string) => void;
}

const VERIFY_GROUP_SIZE = 10;
const MAX_GUIDELINE_CHARS = 40_000;
const MAX_SNIPPET_LINES = 8;

export async function runReview(opts: ReviewOptions): Promise<ReviewResult> {
  const { root, config, runModel } = opts;
  const progress = opts.onProgress ?? (() => {});
  const concurrency = opts.concurrency ?? 2;
  const started = Date.now();
  const stats = { reviewCalls: 0, verifyCalls: 0, costUsd: 0, durationMs: 0, hiddenNits: 0 };

  progress("Collecting changes");
  const changes = await collectChanges(root, opts.scope, opts.includeUntracked ?? true);
  const skipped = [...changes.skipped];
  const reviewable: FileDiff[] = [];
  const leftOut: string[] = [];
  for (const f of changes.files) {
    if (f.binary) skipped.push({ path: f.path, reason: "binary" });
    else if (isIgnored(f.path, config)) skipped.push({ path: f.path, reason: "ignored" });
    else if (opts.only && !opts.only.includes(f.path)) leftOut.push(f.path);
    else reviewable.push(f);
  }
  reviewable.sort((a, b) => a.path.localeCompare(b.path));
  const byPath = new Map(reviewable.map((f) => [f.path, f]));

  const result: ReviewResult = {
    scope: changes.description,
    files: reviewable.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
    skipped,
    summary: "",
    findings: [],
    rejected: [],
    stats,
  };
  if (reviewable.length === 0) {
    stats.durationMs = Date.now() - started;
    return result;
  }

  // Review pass: one model call per batch of files.
  const guidelines = await loadGuidelines(root, config.guidelines);
  const batches = makeBatches(reviewable, opts.batchLines ?? 1500);
  const allPaths = reviewable.map((f) => f.path);
  const scopeText = changes.note ? `${changes.description}. ${changes.note}` : changes.description;
  progress(`Reviewing ${plural(reviewable.length, "file")}${batches.length > 1 ? ` in ${batches.length} batches` : ""}`);
  let done = 0;
  const reviews = await mapLimit(batches, concurrency, async (batch) => {
    const batchPaths = batch.map((f) => f.path);
    const otherPaths = [...allPaths.filter((p) => !batchPaths.includes(p)), ...leftOut];
    const res = await runModel({
      system: REVIEW_SYSTEM,
      prompt: reviewPrompt({
        scope: scopeText,
        diffs: batch.map(renderFileDiff),
        batchFiles: batchPaths,
        otherFiles: otherPaths,
        guidelines,
        instructions: config.instructions,
      }),
      schema: REVIEW_SCHEMA,
      model: config.model,
      effort: config.effort,
      cwd: root,
    });
    stats.reviewCalls++;
    stats.costUsd += res.costUsd;
    if (batches.length > 1) progress(`Reviewed batch ${++done}/${batches.length}`);
    const review = parseReviewOutput(res.output);
    const findings = review.findings
      .map((raw) => normalizeFinding(raw, root, [...allPaths, ...leftOut], byPath))
      // Another batch owns these files and reviews them with their diff in view.
      .filter((f) => !otherPaths.includes(f.file));
    return { summary: review.summary, findings };
  });

  result.summary = reviews.map((r) => r.summary.trim()).filter(Boolean).join("\n\n");
  let findings = dedupe(reviews.flatMap((r) => r.findings));

  // Verification pass: a second, skeptical look at every finding.
  if (config.verify && findings.length > 0) {
    progress(`Verifying ${plural(findings.length, "finding")}`);
    const groups = chunk(findings, VERIFY_GROUP_SIZE);
    await mapLimit(groups, concurrency, async (group) => {
      const files = new Set(group.map((f) => f.file));
      const res = await runModel({
        system: VERIFY_SYSTEM,
        prompt: verifyPrompt({
          scope: scopeText,
          diffs: reviewable.filter((f) => files.has(f.path)).map(renderFileDiff),
          items: group.map((f, i) => ({ id: i + 1, ...f })),
        }),
        schema: VERIFY_SCHEMA,
        model: config.verifyModel,
        effort: config.verifyEffort,
        cwd: root,
      });
      stats.verifyCalls++;
      stats.costUsd += res.costUsd;
      applyVerdicts(group, res.output);
    });
    result.rejected = findings.filter((f) => f.verification?.verdict === "rejected");
    findings = findings.filter((f) => f.verification?.verdict !== "rejected");
  }

  if (!config.nits) {
    stats.hiddenNits = findings.filter((f) => f.severity === "nit").length;
    findings = findings.filter((f) => f.severity !== "nit");
  }

  await attachSnippets(root, opts.scope, [...findings, ...result.rejected]);
  result.findings = findings.sort(compareFindings);
  result.rejected.sort(compareFindings);
  stats.durationMs = Date.now() - started;
  return result;
}

interface RawReview {
  summary: string;
  findings: RawFinding[];
}

interface RawFinding {
  file: string;
  line: number;
  endLine: number;
  severity: Severity;
  category: Category;
  title: string;
  body: string;
  suggestion: string;
}

/** Structured output is schema-checked by Claude Code, but don't trust it blindly. */
export function parseReviewOutput(output: unknown): RawReview {
  const o = (output ?? {}) as Record<string, unknown>;
  const findings: RawFinding[] = [];
  for (const item of Array.isArray(o.findings) ? o.findings : []) {
    const f = item as Record<string, unknown>;
    if (typeof f.file !== "string" || !f.file || typeof f.title !== "string") continue;
    const line = Number.isInteger(f.line) && (f.line as number) > 0 ? (f.line as number) : 1;
    const endLine = Number.isInteger(f.endLine) ? Math.max(line, f.endLine as number) : line;
    findings.push({
      file: f.file,
      line,
      endLine,
      severity: SEVERITIES.includes(f.severity as Severity) ? (f.severity as Severity) : "minor",
      category: CATEGORIES.includes(f.category as Category) ? (f.category as Category) : "bug",
      title: f.title.trim(),
      body: typeof f.body === "string" ? f.body.trim() : "",
      suggestion: typeof f.suggestion === "string" ? f.suggestion.replace(/^\n+|\s+$/g, "") : "",
    });
  }
  return { summary: typeof o.summary === "string" ? o.summary : "", findings };
}

/** Map whatever path the model wrote back to a repo-relative path. */
export function normalizePath(file: string, root: string, known: string[]): string {
  let p = file.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const rootFwd = root.replaceAll("\\", "/").replace(/\/$/, "");
  if (p.toLowerCase().startsWith(rootFwd.toLowerCase() + "/")) p = p.slice(rootFwd.length + 1);
  if (known.includes(p)) return p;
  if (/^[ab]\//.test(p) && known.includes(p.slice(2))) return p.slice(2);
  const bySuffix = known.filter((k) => p.endsWith("/" + k));
  if (bySuffix.length > 0) return bySuffix.sort((a, b) => b.length - a.length)[0]!;
  return p;
}

function normalizeFinding(raw: RawFinding, root: string, known: string[], byPath: Map<string, FileDiff>): Finding {
  const file = normalizePath(raw.file, root, known);
  const diff = byPath.get(file);
  return { ...raw, file, inDiff: diff ? lineInDiff(diff, raw.line) : false };
}

/** Drop repeats of the same finding, keeping the most severe copy. */
function dedupe(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${f.title.toLowerCase()}`;
    const prev = seen.get(key);
    if (!prev || severityRank(f.severity) < severityRank(prev.severity)) seen.set(key, f);
  }
  return [...seen.values()];
}

function applyVerdicts(group: Finding[], output: unknown): void {
  const verdicts = ((output ?? {}) as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(verdicts)) return;
  for (const v of verdicts as Record<string, unknown>[]) {
    const f = typeof v.id === "number" ? group[v.id - 1] : undefined;
    if (!f || (v.verdict !== "confirmed" && v.verdict !== "rejected")) continue;
    f.verification = { verdict: v.verdict, reason: typeof v.reason === "string" ? v.reason : "" };
    const s = v.severity as Severity;
    if (SEVERITIES.includes(s) && severityRank(s) > severityRank(f.severity)) f.severity = s;
  }
}

async function attachSnippets(root: string, scope: Scope, findings: Finding[]): Promise<void> {
  const cache = new Map<string, Promise<string[] | undefined>>();
  for (const f of findings) {
    if (!cache.has(f.file)) {
      cache.set(f.file, readScopedFile(root, scope, f.file).then((t) => t?.split(/\r?\n/)));
    }
    const lines = await cache.get(f.file)!;
    if (!lines || f.line > lines.length) continue;
    const end = Math.min(f.endLine, f.line + MAX_SNIPPET_LINES - 1, lines.length);
    f.snippet = { start: f.line, lines: lines.slice(f.line - 1, end) };
  }
}

async function loadGuidelines(root: string, paths: string[]): Promise<Guideline[]> {
  const out: Guideline[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(join(root, path), "utf8");
    } catch {
      continue;
    }
    if (text.length > MAX_GUIDELINE_CHARS) {
      text = text.slice(0, MAX_GUIDELINE_CHARS) + `\n[... cut at ${MAX_GUIDELINE_CHARS} characters; read ${path} for the rest]`;
    }
    if (text.trim()) out.push({ path, text });
  }
  return out;
}

export function makeBatches(files: FileDiff[], maxLines: number): FileDiff[][] {
  const batches: FileDiff[][] = [];
  let current: FileDiff[] = [];
  let size = 0;
  for (const f of files) {
    const n = diffSize(f);
    if (current.length > 0 && size + n > maxLines) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(f);
    size += n;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Like Promise.all with a concurrency cap, but waits for running tasks before
 * rejecting. After the first failure no new tasks start, since the review is
 * lost anyway and each one would spend more of the plan.
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let failure: { reason: unknown } | undefined;
  let next = 0;
  const worker = async () => {
    while (!failure && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]!);
      } catch (reason) {
        failure ??= { reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.reason;
  return results;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function compareFindings(a: Finding, b: Finding): number {
  return severityRank(a.severity) - severityRank(b.severity) || a.file.localeCompare(b.file) || a.line - b.line;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
