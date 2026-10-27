#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, styleText } from "node:util";
import { claudeCodeRunner } from "./backend.ts";
import { CONFIG_FILE, STARTER_CONFIG, loadConfig, type Config } from "./config.ts";
import { formatMarkdown, formatText } from "./format.ts";
import { autoScope, githubRepoFromRemote, repoRoot, type Scope } from "./git.ts";
import { GitHub, githubToken, parsePrRef } from "./github.ts";
import { formatReviewPreview, reviewPullRequest } from "./pr.ts";
import { runReview } from "./review.ts";
import { SEVERITIES, severityRank, type ReviewResult, type Severity } from "./types.ts";

const HELP = `crc - AI code review for your git changes and pull requests, run through Claude Code

Usage:
  crc [review] [options]   Review your local changes
  crc pr <pr> [options]    Review a GitHub pull request and post the review on it
  crc init                 Write a starter ${CONFIG_FILE} in the repo root

What gets reviewed (default: the branch against main/master when you're on
a feature branch, otherwise your uncommitted changes):
  -b, --base <ref>         Everything since <ref>'s merge base, including uncommitted work
  -u, --uncommitted        Uncommitted changes only (staged + unstaged + untracked)
  -s, --staged             Staged changes only
      --no-untracked       Leave out untracked files

Pull requests (<pr> is a number, owner/repo#number, or a PR URL; run inside a clone):
      --repo <owner/repo>  Repository for a bare PR number (default: the origin remote)
      --dry-run            Print the review instead of posting it
      --full               Review the whole PR, not just commits since crc's last review
      --force              Also review drafts, closed PRs, and commits already reviewed

Output:
  -f, --format <fmt>       text (default), json, or md
  -o, --output <file>      Write the report to a file instead of stdout
      --show-rejected      Also list findings the verification pass threw out
      --nits               Include nit-level findings
      --fail-on <level>    Exit with code 1 if any finding is at or above
                           critical, major, minor, or nit

Model:
      --model <name>       Model for the review pass (default: opus)
      --verify-model <n>   Model for the verification pass (default: opus)
      --effort <level>     Review effort: low, medium, high, xhigh, max (default: high)
      --no-verify          Skip the verification pass (faster, noisier)
      --concurrency <n>    Parallel Claude runs (default: 2)

  -C, --cwd <dir>          Run as if started in <dir>
  -h, --help               Show this help
  -v, --version            Show the version
`;

const OPTIONS = {
  base: { type: "string", short: "b" },
  uncommitted: { type: "boolean", short: "u" },
  staged: { type: "boolean", short: "s" },
  untracked: { type: "boolean", default: true },
  repo: { type: "string" },
  "dry-run": { type: "boolean" },
  full: { type: "boolean" },
  force: { type: "boolean" },
  format: { type: "string", short: "f", default: "text" },
  output: { type: "string", short: "o" },
  "show-rejected": { type: "boolean" },
  nits: { type: "boolean" },
  "fail-on": { type: "string" },
  model: { type: "string" },
  "verify-model": { type: "string" },
  effort: { type: "string" },
  verify: { type: "boolean" },
  concurrency: { type: "string", default: "2" },
  cwd: { type: "string", short: "C" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; allowNegative: true }>>["values"];

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true, allowNegative: true });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  const [command = "review", ...args] = positionals;
  const expectedArgs = command === "pr" ? 1 : 0;
  if (!["review", "pr", "init"].includes(command) || args.length !== expectedArgs) {
    throw new UsageError(command === "pr" ? "Usage: crc pr <number|url>" : `Unknown command "${positionals.join(" ")}". Run crc --help.`);
  }
  const root = await repoRoot(values.cwd ?? process.cwd()).catch(() => {
    throw new UsageError("Not inside a git repository.");
  });

  if (command === "init") {
    const path = join(root, CONFIG_FILE);
    if (existsSync(path)) throw new UsageError(`${CONFIG_FILE} already exists.`);
    await writeFile(path, JSON.stringify(STARTER_CONFIG, null, 2) + "\n");
    process.stdout.write(`Wrote ${path}\n`);
    return 0;
  }

  const format = values.format;
  if (format !== "text" && format !== "json" && format !== "md") {
    throw new UsageError(`--format must be text, json, or md`);
  }
  const failOn = values["fail-on"] as Severity | undefined;
  if (failOn !== undefined && !SEVERITIES.includes(failOn)) {
    throw new UsageError(`--fail-on must be one of ${SEVERITIES.join(", ")}`);
  }
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new UsageError("--concurrency must be a positive integer");

  const config = await configWithFlags(root, values, failOn);
  const showProgress = process.stderr.isTTY || !!process.env.GITHUB_ACTIONS;
  const onProgress = (msg: string) => {
    if (showProgress) process.stderr.write(styleText("dim", `· ${msg}…`, { stream: process.stderr }) + "\n");
  };

  let result: ReviewResult | undefined;
  if (command === "pr") {
    const pr = parsePrRef(args[0]!, values.repo ?? (await githubRepoFromRemote(root)));
    const outcome = await reviewPullRequest({
      root,
      pr,
      gh: new GitHub(await githubToken()),
      config,
      runModel: claudeCodeRunner(),
      dryRun: values["dry-run"],
      full: values.full,
      force: values.force,
      concurrency,
      onProgress,
    });
    result = outcome.result;
    if (outcome.status === "skipped") {
      process.stdout.write(`Skipped: ${outcome.reason}\n`);
    } else if (outcome.status === "dry-run") {
      await emit(values, formatReviewPreview(outcome.review!));
    } else {
      const r = outcome.result!;
      const inline = outcome.review!.comments.length;
      process.stdout.write(
        `Posted ${r.findings.length} finding${r.findings.length === 1 ? "" : "s"} (${inline} inline) to ${pr.repo}#${pr.number}: ${outcome.url}\n`,
      );
    }
  } else {
    if ([values.base !== undefined, values.uncommitted, values.staged].filter(Boolean).length > 1) {
      throw new UsageError("Pick only one of --base, --uncommitted, --staged.");
    }
    const scope: Scope = values.base
      ? { kind: "base", ref: values.base }
      : values.uncommitted
        ? { kind: "uncommitted" }
        : values.staged
          ? { kind: "staged" }
          : await autoScope(root);
    result = await runReview({
      root,
      scope,
      config,
      runModel: claudeCodeRunner(),
      includeUntracked: values.untracked,
      concurrency,
      onProgress,
    });
    const showRejected = values["show-rejected"] ?? false;
    const toFile = values.output !== undefined;
    await emit(
      values,
      format === "json"
        ? JSON.stringify(result, null, 2) + "\n"
        : format === "md"
          ? formatMarkdown(result, { showRejected })
          : formatText(result, {
              color: !toFile && process.stdout.isTTY && !process.env.NO_COLOR,
              width: process.stdout.columns ?? 100,
              showRejected,
            }),
    );
  }

  if (failOn && result?.findings.some((f) => severityRank(f.severity) <= severityRank(failOn))) return 1;
  return 0;
}

async function configWithFlags(root: string, values: Values, failOn: Severity | undefined): Promise<Config> {
  const config = await loadConfig(root);
  if (values.model) config.model = values.model;
  if (values["verify-model"]) config.verifyModel = values["verify-model"];
  if (values.effort) config.effort = values.effort;
  if (values.verify !== undefined) config.verify = values.verify;
  // Nits are hidden by default, which would make --fail-on nit a silent no-op.
  if (values.nits || failOn === "nit") config.nits = true;
  return config;
}

async function emit(values: Values, report: string): Promise<void> {
  if (values.output !== undefined) {
    await writeFile(values.output, report);
    process.stderr.write(`Wrote ${values.output}\n`);
  } else {
    process.stdout.write(report);
  }
}

class UsageError extends Error {}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`crc: ${message}\n`);
    process.exitCode = 2;
  },
);
