#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, styleText } from "node:util";
import { claudeCodeRunner } from "./backend.ts";
import { CONFIG_FILE, STARTER_CONFIG, loadConfig } from "./config.ts";
import { formatMarkdown, formatText } from "./format.ts";
import { autoScope, repoRoot, type Scope } from "./git.ts";
import { runReview } from "./review.ts";
import { SEVERITIES, severityRank, type Severity } from "./types.ts";

const HELP = `crc - AI code review for your local git changes, run through Claude Code

Usage:
  crc [review] [options]   Review your changes
  crc init                 Write a starter ${CONFIG_FILE} in the repo root

What gets reviewed (default: the branch against main/master when you're on
a feature branch, otherwise your uncommitted changes):
  -b, --base <ref>         Everything since <ref>'s merge base, including uncommitted work
  -u, --uncommitted        Uncommitted changes only (staged + unstaged + untracked)
  -s, --staged             Staged changes only
      --no-untracked       Leave out untracked files

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

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      base: { type: "string", short: "b" },
      uncommitted: { type: "boolean", short: "u" },
      staged: { type: "boolean", short: "s" },
      untracked: { type: "boolean", default: true },
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
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  const command = positionals[0] ?? "review";
  if (positionals.length > 1 || !["review", "init"].includes(command)) {
    throw new UsageError(`Unknown command "${positionals.join(" ")}". Run crc --help.`);
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
  const failOn = values["fail-on"];
  if (failOn !== undefined && !SEVERITIES.includes(failOn as Severity)) {
    throw new UsageError(`--fail-on must be one of ${SEVERITIES.join(", ")}`);
  }
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new UsageError("--concurrency must be a positive integer");
  if ([values.base !== undefined, values.uncommitted, values.staged].filter(Boolean).length > 1) {
    throw new UsageError("Pick only one of --base, --uncommitted, --staged.");
  }

  const config = await loadConfig(root);
  if (values.model) config.model = values.model;
  if (values["verify-model"]) config.verifyModel = values["verify-model"];
  if (values.effort) config.effort = values.effort;
  if (values.verify !== undefined) config.verify = values.verify;
  // Nits are hidden by default, which would make --fail-on nit a silent no-op.
  if (values.nits || failOn === "nit") config.nits = true;

  const scope: Scope = values.base
    ? { kind: "base", ref: values.base }
    : values.uncommitted
      ? { kind: "uncommitted" }
      : values.staged
        ? { kind: "staged" }
        : await autoScope(root);

  const showProgress = process.stderr.isTTY;
  const result = await runReview({
    root,
    scope,
    config,
    runModel: claudeCodeRunner(),
    includeUntracked: values.untracked,
    concurrency,
    onProgress: (msg) => {
      if (showProgress) process.stderr.write(styleText("dim", `· ${msg}…`) + "\n");
    },
  });

  const toFile = values.output !== undefined;
  const showRejected = values["show-rejected"] ?? false;
  const report =
    format === "json"
      ? JSON.stringify(result, null, 2) + "\n"
      : format === "md"
        ? formatMarkdown(result, { showRejected })
        : formatText(result, {
            color: !toFile && process.stdout.isTTY && !process.env.NO_COLOR,
            width: process.stdout.columns ?? 100,
            showRejected,
          });
  if (toFile) {
    await writeFile(values.output!, report);
    process.stderr.write(`Wrote ${values.output}\n`);
  } else {
    process.stdout.write(report);
  }

  if (failOn && result.findings.some((f) => severityRank(f.severity) <= severityRank(failOn as Severity))) return 1;
  return 0;
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
