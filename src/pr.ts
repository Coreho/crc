import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunModel } from "./backend.ts";
import type { Config } from "./config.ts";
import { parseUnifiedDiff, type Hunk } from "./diff.ts";
import { location } from "./format.ts";
import { git, isAncestor, refExists, remoteFor, type Scope } from "./git.ts";
import { GitHubError, type GitHub, type NewReview, type PrRef, type PullFile, type PullRequest, type Review, type ReviewComment } from "./github.ts";
import { runReview } from "./review.ts";
import { SEVERITIES, type Finding, type ReviewResult } from "./types.ts";

const REVIEWED_MARKER = /<!-- crc:reviewed=([0-9a-f]{40}) -->/;

export interface PrReviewOptions {
  /** A local clone of the pull request's repository. */
  root: string;
  pr: PrRef;
  gh: GitHub;
  config: Config;
  runModel: RunModel;
  /** Build the review but don't post it. */
  dryRun?: boolean;
  /** Review the whole pull request even if crc reviewed earlier commits. */
  full?: boolean;
  /** Review drafts, closed PRs, and commits crc already reviewed. */
  force?: boolean;
  concurrency?: number;
  onProgress?: (message: string) => void;
}

export interface PrReviewOutcome {
  status: "posted" | "dry-run" | "skipped";
  reason?: string;
  url?: string;
  review?: NewReview;
  result?: ReviewResult;
}

export async function reviewPullRequest(opts: PrReviewOptions): Promise<PrReviewOutcome> {
  const { gh, pr: ref } = opts;
  const progress = opts.onProgress ?? (() => {});

  const pr = await gh.getPull(ref.repo, ref.number);
  const head = pr.head.sha;
  if (!opts.force && pr.state !== "open") return { status: "skipped", reason: `PR #${pr.number} is ${pr.state}` };
  if (!opts.force && pr.draft) return { status: "skipped", reason: `PR #${pr.number} is a draft` };

  const lastReviewed = lastReviewedSha(await gh.listReviews(ref.repo, ref.number));
  if (lastReviewed === head && !opts.force) {
    return { status: "skipped", reason: `crc already reviewed ${short(head)}` };
  }

  await ensureCommits(opts.root, ref, pr, progress);
  const incrementalFrom =
    !opts.full && lastReviewed && lastReviewed !== head && (await refExists(opts.root, lastReviewed)) && (await isAncestor(opts.root, lastReviewed, head))
      ? lastReviewed
      : undefined;
  const scope: Scope = incrementalFrom
    ? {
        kind: "range",
        base: incrementalFrom,
        head,
        label: `PR #${pr.number}: commits pushed since the last crc review (${short(incrementalFrom)}..${short(head)})`,
      }
    : { kind: "range", base: pr.base.sha, head, label: `PR #${pr.number} "${pr.title}" (${pr.head.ref} into ${pr.base.ref})` };

  const checkout = await checkoutCommit(opts.root, head, progress);
  try {
    const result = await runReview({
      root: checkout.dir,
      scope,
      config: opts.config,
      runModel: opts.runModel,
      includeUntracked: false,
      concurrency: opts.concurrency,
      onProgress: opts.onProgress,
    });
    const files = await gh.listFiles(ref.repo, ref.number);
    const review = buildReview(result, files, { headSha: head, incrementalFrom });
    if (opts.dryRun) return { status: "dry-run", review, result };

    progress("Posting review");
    try {
      const posted = await gh.createReview(ref.repo, ref.number, review);
      return { status: "posted", url: posted.html_url, review, result };
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 422) || review.comments.length === 0) throw err;
      // GitHub refused an inline position; put every finding in the review body instead.
      progress("GitHub rejected an inline comment, posting the findings in the review body");
      const fallback = buildReview(result, [], { headSha: head, incrementalFrom });
      const posted = await gh.createReview(ref.repo, ref.number, fallback);
      return { status: "posted", url: posted.html_url, review: fallback, result };
    }
  } finally {
    await checkout.cleanup();
  }
}

export function lastReviewedSha(reviews: Review[]): string | undefined {
  let sha: string | undefined;
  for (const r of reviews) {
    const m = REVIEWED_MARKER.exec(r.body ?? "");
    if (m) sha = m[1];
  }
  return sha;
}

async function ensureCommits(root: string, ref: PrRef, pr: PullRequest, progress: (m: string) => void): Promise<void> {
  const present = async () => (await refExists(root, pr.head.sha)) && (await refExists(root, pr.base.sha));
  if (await present()) return;
  const remote = await remoteFor(root, ref.repo);
  if (!remote) throw new Error(`This clone has no remote for ${ref.repo}. Run crc pr inside a clone of that repository.`);
  progress(`Fetching PR #${pr.number} from ${remote}`);
  await git(["fetch", "--no-tags", remote, `pull/${pr.number}/head`, pr.base.ref], root);
  if (!(await present())) throw new Error(`Couldn't fetch the commits for PR #${pr.number}`);
}

/**
 * The reviewer reads files from disk, so it needs the PR head checked out.
 * Reuse the clone when it's already there (as in CI), else use a temporary worktree.
 */
async function checkoutCommit(root: string, sha: string, progress: (m: string) => void): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const current = (await git(["rev-parse", "HEAD"], root).catch(() => "")).trim();
  const dirty = (await git(["status", "--porcelain", "--untracked-files=no"], root)).trim() !== "";
  if (current === sha && !dirty) return { dir: root, cleanup: async () => {} };

  const dir = await mkdtemp(join(tmpdir(), "crc-pr-"));
  progress(`Checking out ${short(sha)} in a temporary worktree`);
  await git(["worktree", "add", "--detach", dir, sha], root);
  return {
    dir,
    cleanup: async () => {
      await git(["worktree", "remove", "--force", dir], root).catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Lines GitHub accepts comments on: the new-file side of each hunk in the PR's own diff. */
function prHunks(files: PullFile[]): Map<string, Hunk[]> {
  const out = new Map<string, Hunk[]>();
  for (const f of files) {
    if (!f.patch) continue;
    const parsed = parseUnifiedDiff(`diff --git a/x b/x\n${f.patch}`)[0];
    if (parsed) out.set(f.filename, parsed.hunks);
  }
  return out;
}

interface Placement {
  line: number;
  startLine?: number;
  /** True when the comment spans exactly the finding's lines, so a suggestion lines up. */
  exact: boolean;
}

export function placeFinding(f: Finding, hunks: Hunk[] | undefined): Placement | undefined {
  const contains = (h: Hunk, line: number) => h.newLines > 0 && line >= h.newStart && line < h.newStart + h.newLines;
  const start = hunks?.find((h) => contains(h, f.line));
  if (start && contains(start, f.endLine)) {
    return f.endLine > f.line ? { startLine: f.line, line: f.endLine, exact: true } : { line: f.line, exact: true };
  }
  if (start) return { line: f.line, exact: false };
  if (hunks?.some((h) => contains(h, f.endLine))) return { line: f.endLine, exact: false };
  return undefined;
}

export function buildReview(result: ReviewResult, files: PullFile[], info: { headSha: string; incrementalFrom?: string }): NewReview {
  const hunks = prHunks(files);
  const comments: ReviewComment[] = [];
  const unplaced: Finding[] = [];
  for (const f of result.findings) {
    const at = placeFinding(f, hunks.get(f.file));
    if (!at) {
      unplaced.push(f);
      continue;
    }
    comments.push({
      path: f.file,
      body: commentBody(f, at.exact),
      line: at.line,
      side: "RIGHT",
      ...(at.startLine === undefined ? {} : { start_line: at.startLine, start_side: "RIGHT" as const }),
    });
  }
  return { commit_id: info.headSha, event: "COMMENT", body: reviewBody(result, unplaced, info), comments };
}

function commentBody(f: Finding, withSuggestion: boolean): string {
  const out = [`**${label(f.severity)}** · ${f.category}`, "", `**${f.title}**`, "", f.body];
  if (withSuggestion && f.suggestion) {
    const fence = f.suggestion.includes("```") ? "````" : "```";
    out.push("", `${fence}suggestion`, f.suggestion, fence);
  }
  if (f.verification?.verdict === "confirmed" && f.verification.reason) {
    out.push("", `<sub>Verified: ${f.verification.reason}</sub>`);
  }
  return out.join("\n");
}

function reviewBody(r: ReviewResult, unplaced: Finding[], info: { headSha: string; incrementalFrom?: string }): string {
  const what = info.incrementalFrom
    ? `the commits since \`${short(info.incrementalFrom)}\` (up to \`${short(info.headSha)}\`)`
    : `\`${short(info.headSha)}\``;
  const out = ["### crc review", ""];
  if (r.summary) out.push(r.summary, "");

  const files = `${r.files.length} file${r.files.length === 1 ? "" : "s"}`;
  if (r.findings.length === 0) {
    out.push(`No issues found in ${files} at ${what}.`);
  } else {
    const counts = SEVERITIES.map((s) => [s, r.findings.filter((f) => f.severity === s).length] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s}`)
      .join(", ");
    out.push(`**${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}** (${counts}) in ${files} at ${what}.`);
  }

  if (unplaced.length > 0) {
    out.push("", "#### Findings outside the diff", "");
    for (const f of unplaced) out.push(`- **${label(f.severity)}** · ${f.category} · \`${location(f)}\`: **${f.title}** ${f.body}`);
  }
  if (r.rejected.length > 0) {
    out.push("", `<details><summary>${r.rejected.length} finding${r.rejected.length === 1 ? "" : "s"} rejected by verification</summary>`, "");
    for (const f of r.rejected) out.push(`- \`${location(f)}\` ${f.title}: ${f.verification?.reason ?? ""}`);
    out.push("", "</details>");
  }

  const footer = [`${Math.round(r.stats.durationMs / 1000)}s`];
  if (r.stats.costUsd > 0) footer.push(`est. API cost $${r.stats.costUsd.toFixed(2)}`);
  if (r.stats.hiddenNits > 0) footer.push(`${r.stats.hiddenNits} nit${r.stats.hiddenNits === 1 ? "" : "s"} hidden`);
  if (r.skipped.length > 0) footer.push(`skipped ${r.skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`);
  out.push("", `<sub>crc · ${footer.join(" · ")}</sub>`, `<!-- crc:reviewed=${info.headSha} -->`);
  return out.join("\n");
}

/** Render a review the way it would appear on GitHub, for --dry-run. */
export function formatReviewPreview(review: NewReview): string {
  const out = ["# Review body", "", review.body, ""];
  out.push(`# Inline comments (${review.comments.length})`);
  for (const c of review.comments) {
    const where = c.start_line === undefined ? `${c.path}:${c.line}` : `${c.path}:${c.start_line}-${c.line}`;
    out.push("", `## ${where}`, "", c.body);
  }
  return out.join("\n") + "\n";
}

function label(severity: string): string {
  return severity[0]!.toUpperCase() + severity.slice(1);
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
