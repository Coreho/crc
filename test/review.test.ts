import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelRequest, ModelResult } from "../src/backend.ts";
import { parseResult } from "../src/backend.ts";
import { DEFAULT_CONFIG, isIgnored, parseConfig } from "../src/config.ts";
import { addedFileDiff } from "../src/diff.ts";
import { formatMarkdown, formatText } from "../src/format.ts";
import { makeBatches, normalizePath, runReview } from "../src/review.ts";
import { makeRepo } from "./helpers.ts";

const SOURCE = ["export function parse(s: string) {", "  const n = parseInt(s);", "  return n;", "}", ""].join("\n");
const CHANGED = ["export function parse(s: string) {", "  const n = parseInt(s);", "  if (n > 0) return n;", "  return n / 0;", "}", ""].join("\n");

function fakeModel(responses: { review: unknown[]; verify?: unknown[] }) {
  const calls: ModelRequest[] = [];
  const run = async (req: ModelRequest): Promise<ModelResult> => {
    calls.push(req);
    const isVerify = "verdicts" in (req.schema as { properties: object }).properties;
    const queue = isVerify ? responses.verify ?? [] : responses.review;
    const output = queue.shift();
    if (output === undefined) throw new Error("unexpected model call");
    return { output, costUsd: 0.25 };
  };
  return { run, calls };
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    file: "src/parse.ts",
    line: 4,
    endLine: 4,
    severity: "major",
    category: "bug",
    title: "Division by zero returns Infinity",
    body: "Non-positive input falls through to n / 0.",
    suggestion: "  return 0;",
    ...overrides,
  };
}

test("review pipeline: normalizes, verifies, hides nits, attaches snippets", async () => {
  const { root, write } = makeRepo({ "src/parse.ts": SOURCE, "package-lock.json": "{}\n" });
  write("src/parse.ts", CHANGED);
  write("package-lock.json", '{"a":1}\n');

  const model = fakeModel({
    review: [
      {
        summary: "Adds a positive-number branch to parse.",
        findings: [
          finding({ file: `${root.replaceAll("\\", "/")}/src/parse.ts` }),
          finding({ file: "./src/parse.ts", line: 2, endLine: 2, category: "error-handling", severity: "minor", title: "parseInt without radix" }),
          finding({ file: "src\\parse.ts", line: 1, endLine: 1, category: "maintainability", severity: "nit", title: "Name it parseNumber" }),
        ],
      },
    ],
    verify: [
      {
        verdicts: [
          { id: 1, verdict: "confirmed", severity: "critical", reason: "Real." },
          { id: 2, verdict: "rejected", severity: "minor", reason: "Radix defaults to 10 for these inputs." },
          { id: 3, verdict: "confirmed", severity: "nit", reason: "Fine." },
        ],
      },
    ],
  });

  const result = await runReview({
    root,
    scope: { kind: "uncommitted" },
    config: { ...DEFAULT_CONFIG },
    runModel: model.run,
  });

  assert.equal(model.calls.length, 2);
  const reviewCall = model.calls[0]!;
  assert.equal(reviewCall.model, "opus");
  assert.equal(reviewCall.cwd, root);
  assert.match(reviewCall.prompt, /### src\/parse\.ts \(modified, \+2 -1\)/);
  assert.match(reviewCall.prompt, /4 \+ {3}return n \/ 0;/);
  assert.doesNotMatch(reviewCall.prompt, /package-lock/);

  assert.deepEqual(result.skipped, [{ path: "package-lock.json", reason: "ignored" }]);
  assert.equal(result.summary, "Adds a positive-number branch to parse.");
  assert.equal(result.findings.length, 1);
  const [f] = result.findings;
  assert.equal(f!.file, "src/parse.ts");
  // The verifier may lower severity but not raise it.
  assert.equal(f!.severity, "major");
  assert.equal(f!.inDiff, true);
  assert.deepEqual(f!.snippet, { start: 4, lines: ["  return n / 0;"] });
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0]!.verification!.reason, "Radix defaults to 10 for these inputs.");
  assert.equal(result.stats.hiddenNits, 1);
  assert.equal(result.stats.costUsd, 0.5);

  const text = formatText(result, { color: false, width: 80, showRejected: true });
  assert.match(text, /\[MAJOR\] bug {2}src\/parse\.ts:4/);
  assert.match(text, /4 │ {3}return n \/ 0;/);
  assert.match(text, /Rejected by verification \(1\)/);
  assert.match(text, /1 nit hidden/);
  assert.match(formatMarkdown(result, { showRejected: false }), /### Major · bug · `src\/parse\.ts:4`/);
});

test("--no-verify keeps every finding and skips the second call", async () => {
  const { root, write } = makeRepo({ "src/parse.ts": SOURCE });
  write("src/parse.ts", CHANGED);
  const model = fakeModel({ review: [{ summary: "", findings: [finding(), finding({ line: 99, endLine: 2, category: "test" })] }] });
  const result = await runReview({
    root,
    scope: { kind: "uncommitted" },
    config: { ...DEFAULT_CONFIG, verify: false },
    runModel: model.run,
  });
  assert.equal(model.calls.length, 1);
  assert.equal(result.findings.length, 2);
  const outside = result.findings.find((f) => f.line === 99)!;
  assert.equal(outside.endLine, 99);
  assert.equal(outside.inDiff, false);
  assert.equal(outside.snippet, undefined);
});

test("staged reviews tell the model so and take snippets from the index", async () => {
  const { root, write, git } = makeRepo({ "src/parse.ts": SOURCE });
  write("src/parse.ts", CHANGED);
  git("add", "src/parse.ts");
  write("src/parse.ts", "// unstaged edit\n" + CHANGED);
  const model = fakeModel({ review: [{ summary: "", findings: [finding()] }] });
  const result = await runReview({
    root,
    scope: { kind: "staged" },
    config: { ...DEFAULT_CONFIG, verify: false },
    runModel: model.run,
  });
  assert.match(model.calls[0]!.prompt, /Only staged changes are under review/);
  assert.deepEqual(result.findings[0]!.snippet, { start: 4, lines: ["  return n / 0;"] });
});

test("findings are kept per batch: other batches' files dropped, same-line issues both kept", async () => {
  const { root, write } = makeRepo({ "a.ts": "a\n", "b.ts": "b\n" });
  write("a.ts", "a2\n");
  write("b.ts", "b2\n");
  const model = fakeModel({
    review: [
      {
        summary: "A",
        findings: [
          finding({ file: "a.ts", line: 1, endLine: 1, title: "First problem" }),
          finding({ file: "a.ts", line: 1, endLine: 1, title: "Second problem" }),
          finding({ file: "b.ts", line: 1, endLine: 1, title: "Belongs to the other batch" }),
        ],
      },
      { summary: "B", findings: [] },
    ],
  });
  const result = await runReview({
    root,
    scope: { kind: "uncommitted" },
    config: { ...DEFAULT_CONFIG, verify: false },
    runModel: model.run,
    batchLines: 1,
    concurrency: 1,
  });
  assert.equal(model.calls.length, 2);
  assert.deepEqual(result.findings.map((f) => f.title).sort(), ["First problem", "Second problem"]);
  assert.equal(result.summary, "A\n\nB");
});

test("nothing to review makes no model calls", async () => {
  const { root } = makeRepo({ "a.txt": "a\n" });
  const model = fakeModel({ review: [] });
  const result = await runReview({ root, scope: { kind: "uncommitted" }, config: { ...DEFAULT_CONFIG }, runModel: model.run });
  assert.equal(model.calls.length, 0);
  assert.equal(result.files.length, 0);
  assert.match(formatText(result, { color: false, width: 80, showRejected: false }), /Nothing to review\./);
});

test("a failed model call fails the review", async () => {
  const { root, write } = makeRepo({ "a.txt": "a\n" });
  write("a.txt", "b\n");
  const run = async (): Promise<ModelResult> => {
    throw new Error("rate limited");
  };
  await assert.rejects(runReview({ root, scope: { kind: "uncommitted" }, config: { ...DEFAULT_CONFIG }, runModel: run }), /rate limited/);
});

test("makeBatches splits by diff size but never splits a file", () => {
  const file = (name: string, lines: number) => addedFileDiff(name, "x\n".repeat(lines));
  const batches = makeBatches([file("a", 600), file("b", 600), file("c", 2000), file("d", 10)], 1500);
  assert.deepEqual(batches.map((b) => b.map((f) => f.path)), [["a", "b"], ["c"], ["d"]]);
});

test("normalizePath maps model paths back to repo paths", () => {
  const known = ["src/a.ts", "lib/src/a.ts"];
  assert.equal(normalizePath("./src/a.ts", "C:\\repo", known), "src/a.ts");
  assert.equal(normalizePath("C:/repo/src/a.ts", "C:\\repo", known), "src/a.ts");
  assert.equal(normalizePath("c:\\repo\\lib\\src\\a.ts", "C:\\repo", known), "lib/src/a.ts");
  assert.equal(normalizePath("b/src/a.ts", "/repo", known), "src/a.ts");
  assert.equal(normalizePath("/elsewhere/lib/src/a.ts", "/repo", known), "lib/src/a.ts");
  assert.equal(normalizePath("other/file.ts", "/repo", known), "other/file.ts");
});

test("config validation", () => {
  assert.equal(parseConfig({ model: "sonnet" }).model, "sonnet");
  assert.throws(() => parseConfig({ modle: "x" }), /unknown key "modle"/);
  assert.throws(() => parseConfig({ ignore: "dist" }), /"ignore" must be an array of strings/);
  assert.throws(() => parseConfig([]), /JSON object/);
  const config = parseConfig({ ignore: ["generated/**"] });
  assert.equal(isIgnored("generated/api.ts", config), true);
  assert.equal(isIgnored("web/yarn.lock", config), true);
  assert.equal(isIgnored("src/index.ts", config), false);
});

test("parseResult reads Claude Code's JSON output", () => {
  const ok = JSON.stringify({ subtype: "success", is_error: false, structured_output: { a: 1 }, total_cost_usd: 0.1 });
  assert.deepEqual(parseResult(ok), { output: { a: 1 }, costUsd: 0.1 });
  assert.throws(() => parseResult("not json"), /not JSON/);
  assert.throws(() => parseResult(JSON.stringify({ subtype: "error_max_turns", is_error: true })), /error_max_turns/);
  assert.throws(() => parseResult(JSON.stringify({ subtype: "success", result: "hi" })), /without structured output/);
});

test("after a failed model call, no new calls start", async () => {
  const { root, write } = makeRepo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
  for (const f of ["a.txt", "b.txt", "c.txt"]) write(f, "changed\n");
  let calls = 0;
  const run = async (): Promise<ModelResult> => {
    calls++;
    throw new Error("You've hit your 5-hour limit");
  };
  await assert.rejects(
    runReview({ root, scope: { kind: "uncommitted" }, config: { ...DEFAULT_CONFIG }, runModel: run, batchLines: 1, concurrency: 1 }),
    /5-hour limit/,
  );
  assert.equal(calls, 1, "the other two batches never start");
});
