import assert from "node:assert/strict";
import { test } from "node:test";
import { childEnv, type ModelRequest, type ModelResult } from "../src/backend.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { GitHub, parsePrRef, type NewReview } from "../src/github.ts";
import { buildReview, lastReview, placeFinding, reviewPullRequest } from "../src/pr.ts";
import type { Finding, ReviewResult } from "../src/types.ts";
import { makeRepo } from "./helpers.ts";

const BASE = ["function a() {", "  return 1;", "}", "", "function b() {", "  return 2;", "}", ""].join("\n");

/** A repo with main plus a feature branch of two commits; HEAD stays on main. */
function setup() {
  const repo = makeRepo({ "src/app.js": BASE });
  const baseSha = repo.git("rev-parse", "HEAD").trim();
  repo.git("checkout", "-q", "-b", "feature");
  repo.write("src/app.js", BASE.replace("return 1;", "return 10;"));
  repo.git("commit", "-q", "-am", "first");
  const firstSha = repo.git("rev-parse", "HEAD").trim();
  repo.write("src/app.js", BASE.replace("return 1;", "return 10;").replace("return 2;", "return 20;"));
  repo.git("commit", "-q", "-am", "second");
  const headSha = repo.git("rev-parse", "HEAD").trim();
  repo.git("checkout", "-q", "main");
  return { ...repo, baseSha, firstSha, headSha };
}

type FakeReview = { body: string; user?: { login: string }; author_association?: string };

function fakeGitHub(opts: { headSha: string; baseSha: string; reviews?: FakeReview[]; failFirstPost?: boolean; draft?: boolean }) {
  const posted: NewReview[] = [];
  const requests: string[] = [];
  const patch = "@@ -1,7 +1,7 @@\n function a() {\n-  return 1;\n+  return 10;\n }\n \n function b() {\n-  return 2;\n+  return 20;\n }";
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://api.test", "").replace(/[?&]per_page=100&page=\d+/, "");
    const method = init?.method ?? "GET";
    requests.push(`${method} ${path}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (method === "GET" && path === "/repos/o/r/pulls/7") {
      return json(200, {
        number: 7,
        title: "Bump numbers",
        state: "open",
        draft: opts.draft ?? false,
        html_url: "https://github.com/o/r/pull/7",
        head: { sha: opts.headSha, ref: "feature" },
        base: { sha: opts.baseSha, ref: "main" },
      });
    }
    if (method === "GET" && path === "/repos/o/r/pulls/7/reviews") {
      return json(
        200,
        (opts.reviews ?? []).map((r, i) => ({ id: i + 1, commit_id: null, html_url: "", user: { login: "owner" }, author_association: "OWNER", ...r })),
      );
    }
    if (method === "GET" && path === "/repos/o/r/pulls/7/files") {
      return json(200, [{ filename: "src/app.js", status: "modified", patch }]);
    }
    if (method === "POST" && path === "/repos/o/r/pulls/7/reviews") {
      const review = JSON.parse(String(init!.body)) as NewReview;
      posted.push(review);
      if (opts.failFirstPost && posted.length === 1) return json(422, { message: "Unprocessable Entity", errors: ["Line could not be resolved"] });
      return json(200, { id: 99, body: review.body, commit_id: review.commit_id, html_url: "https://github.com/o/r/pull/7#pullrequestreview-99" });
    }
    return json(404, { message: "Not Found" });
  }) as typeof fetch;
  return { gh: new GitHub("token", fetchImpl, "https://api.test"), posted, requests };
}

function fakeModel(findings: unknown[]) {
  const calls: ModelRequest[] = [];
  const run = async (req: ModelRequest): Promise<ModelResult> => {
    calls.push(req);
    return { output: { summary: "Bumps the return values.", findings }, costUsd: 0.1 };
  };
  return { run, calls };
}

const finding = (o: Partial<Finding> = {}) => ({
  file: "src/app.js",
  line: 2,
  endLine: 2,
  severity: "major",
  category: "bug",
  title: "Wrong constant",
  body: "Callers expect 1.",
  suggestion: "  return 1;",
  ...o,
});

test("posts a full review with inline comments and a reviewed-commit marker", async () => {
  const { root, git, baseSha, headSha } = setup();
  const github = fakeGitHub({ headSha, baseSha });
  const model = fakeModel([finding(), finding({ line: 40, endLine: 40, title: "Far away", suggestion: "" })]);

  const outcome = await reviewPullRequest({
    root,
    pr: { repo: "o/r", number: 7 },
    gh: github.gh,
    config: { ...DEFAULT_CONFIG, verify: false },
    runModel: model.run,
  });

  assert.equal(outcome.status, "posted");
  assert.equal(outcome.url, "https://github.com/o/r/pull/7#pullrequestreview-99");
  // The review ran against the PR head, which only exists on the feature branch.
  const prompt = model.calls[0]!.prompt;
  assert.match(prompt, /PR #7 "Bump numbers" \(feature into main\)/);
  assert.match(prompt, /2 \+ {3}return 10;/);
  assert.match(prompt, /6 \+ {3}return 20;/);
  assert.notEqual(model.calls[0]!.cwd, root, "reviews in a worktree because main is checked out");
  assert.doesNotMatch(git("worktree", "list"), /crc-pr-/, "worktree is removed afterwards");

  const [review] = github.posted;
  assert.equal(review!.commit_id, headSha);
  assert.equal(review!.event, "COMMENT");
  assert.deepEqual(review!.comments.map((c) => [c.path, c.line, c.side]), [["src/app.js", 2, "RIGHT"]]);
  assert.match(review!.comments[0]!.body, /```suggestion\n {2}return 1;\n```/);
  assert.match(review!.body, /Bumps the return values\./);
  assert.match(review!.body, /\*\*2 findings\*\* \(2 major\)/);
  assert.match(review!.body, /#### Findings outside the diff\n\n- \*\*Major\*\* · bug · `src\/app\.js:40`: \*\*Far away\*\*/);
  assert.match(review!.body, new RegExp(`<!-- crc:base=${baseSha} -->\\n<!-- crc:reviewed=${headSha} -->$`));
});

test("after an earlier crc review, only the new commits are reviewed", async () => {
  const { root, baseSha, firstSha, headSha } = setup();
  const github = fakeGitHub({ headSha, baseSha, reviews: [{ body: `old\n<!-- crc:reviewed=${firstSha} -->` }] });
  const model = fakeModel([]);
  const outcome = await reviewPullRequest({
    root,
    pr: { repo: "o/r", number: 7 },
    gh: github.gh,
    config: { ...DEFAULT_CONFIG, verify: false },
    runModel: model.run,
    dryRun: true,
  });
  assert.equal(outcome.status, "dry-run");
  assert.equal(github.posted.length, 0);
  const prompt = model.calls[0]!.prompt;
  assert.match(prompt, /commits pushed since the last crc review/);
  assert.match(prompt, /6 \+ {3}return 20;/);
  assert.doesNotMatch(prompt, /\+ {3}return 10;/, "the first commit was already reviewed");
  assert.match(outcome.review!.body, new RegExp(`No issues found in 1 file at the commits since \`${firstSha.slice(0, 7)}\``));
});

test("a merge from the base branch since the last review re-reviews the PR's changes, not the base branch's", async () => {
  const { root, git, write, firstSha } = setup();
  // main moves on, and the PR branch merges it in ("Update branch").
  write("other.js", "export const x = 1;\n");
  git("add", "other.js");
  git("commit", "-q", "-m", "unrelated work on main");
  const newBase = git("rev-parse", "HEAD").trim();
  git("checkout", "-q", "feature");
  git("merge", "-q", "--no-edit", "main");
  const mergedHead = git("rev-parse", "HEAD").trim();
  git("checkout", "-q", "main");

  // GitHub reports the base branch's current tip as the PR base.
  const github = fakeGitHub({ headSha: mergedHead, baseSha: newBase, reviews: [{ body: `<!-- crc:reviewed=${firstSha} -->` }] });
  const model = fakeModel([]);
  await reviewPullRequest({
    root,
    pr: { repo: "o/r", number: 7 },
    gh: github.gh,
    config: { ...DEFAULT_CONFIG, verify: false },
    runModel: model.run,
    dryRun: true,
  });
  const prompt = model.calls[0]!.prompt;
  assert.match(prompt, /PR #7 "Bump numbers".*only the files whose changes differ/, "compared with the last review, not incremental");
  assert.match(prompt, /2 \+ {3}return 10;/, "app.js changed since the last review, so its whole change is shown");
  assert.doesNotMatch(prompt, /other\.js/, "base-branch changes stay out of the review");
});

/** main with two files; a feature branch that crc reviewed, then rebased onto a newer main. */
function rebaseSetup() {
  const lines = (tag: string) => Array.from({ length: 30 }, (_, i) => `${tag}${i}`);
  const text = (l: string[]) => l.join("\n") + "\n";
  const edit = (l: string[], i: number, s: string) => l.map((x, j) => (j === i ? s : x));
  const a = lines("a");
  const b = lines("b");
  const repo = makeRepo({ "a.js": text(a), "b.js": text(b) });
  const baseSha = repo.git("rev-parse", "HEAD").trim();
  repo.git("checkout", "-q", "-b", "feature");
  repo.write("a.js", text(edit(a, 20, "A20")));
  repo.write("b.js", text(edit(b, 20, "B20")));
  repo.git("commit", "-q", "-am", "feature work");
  const reviewedSha = repo.git("rev-parse", "HEAD").trim();
  // main moves on: two lines inserted at the top of a.js shift the feature's hunk.
  repo.git("checkout", "-q", "main");
  repo.write("a.js", text(["top1", "top2", ...a]));
  repo.write("c.js", "export const c = 1;\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "work on main");
  const newBase = repo.git("rev-parse", "HEAD").trim();
  repo.git("checkout", "-q", "feature");
  repo.git("rebase", "-q", "main");
  const rebasedSha = repo.git("rev-parse", "HEAD").trim();
  const moreB = (head: string) => {
    repo.git("checkout", "-q", head);
    repo.write("b.js", text(edit(edit(b, 20, "B20"), 25, "B25")));
    repo.git("commit", "-q", "-am", "more b");
    return repo.git("rev-parse", "HEAD").trim();
  };
  return { ...repo, baseSha, reviewedSha, newBase, rebasedSha, moreB };
}

test("after a rebase that changed nothing in the PR, nothing is reviewed again", async () => {
  const { root, baseSha, reviewedSha, newBase, rebasedSha, git } = rebaseSetup();
  git("checkout", "-q", "main");
  const github = fakeGitHub({ headSha: rebasedSha, baseSha: newBase, reviews: [{ body: `<!-- crc:base=${baseSha} -->\n<!-- crc:reviewed=${reviewedSha} -->` }] });
  const model = fakeModel([]);
  const outcome = await reviewPullRequest({ root, pr: { repo: "o/r", number: 7 }, gh: github.gh, config: { ...DEFAULT_CONFIG }, runModel: model.run });
  assert.equal(outcome.status, "posted");
  assert.equal(model.calls.length, 0);
  const body = github.posted[0]!.body;
  assert.match(body, new RegExp(`Nothing new to review at \`${rebasedSha.slice(0, 7)}\`: the branch was rebased or merged since crc's last review at \`${reviewedSha.slice(0, 7)}\``));
  assert.match(body, new RegExp(`<!-- crc:base=${newBase} -->\\n<!-- crc:reviewed=${rebasedSha} -->$`), "the next review compares against this one");
});

test("after a rebase, only files whose changes differ are reviewed, the rest named as context", async () => {
  const { root, reviewedSha, newBase, rebasedSha, moreB, git } = rebaseSetup();
  const head = moreB(rebasedSha);
  git("checkout", "-q", "main");
  // An older review without a recorded base: the merge base with today's base stands in.
  const github = fakeGitHub({ headSha: head, baseSha: newBase, reviews: [{ body: `<!-- crc:reviewed=${reviewedSha} -->` }] });
  const model = fakeModel([]);
  const outcome = await reviewPullRequest({
    root,
    pr: { repo: "o/r", number: 7 },
    gh: github.gh,
    config: { ...DEFAULT_CONFIG, verify: false },
    runModel: model.run,
    dryRun: true,
  });
  assert.equal(model.calls.length, 1);
  const prompt = model.calls[0]!.prompt;
  assert.match(prompt, /Review the changes to these files: b\.js\. These files are also part of the change[^:]*: a\.js\./);
  assert.match(prompt, /\+ B20[\s\S]*\+ B25/, "b.js gets its whole change reviewed again");
  assert.doesNotMatch(prompt, /A20|c\.js/);
  assert.match(outcome.review!.body, /No issues found in 1 file at `[0-9a-f]{7}`\.\n\nThe branch was rebased or merged .* 1 file with the same changes was skipped\./);
});

test("--full reviews every file even after a rebase", async () => {
  const { root, reviewedSha, newBase, rebasedSha, git } = rebaseSetup();
  git("checkout", "-q", "main");
  const github = fakeGitHub({ headSha: rebasedSha, baseSha: newBase, reviews: [{ body: `<!-- crc:reviewed=${reviewedSha} -->` }] });
  const model = fakeModel([]);
  await reviewPullRequest({ root, pr: { repo: "o/r", number: 7 }, gh: github.gh, config: { ...DEFAULT_CONFIG, verify: false }, runModel: model.run, dryRun: true, full: true });
  assert.match(model.calls[0]!.prompt, /Review the changes to these files: a\.js, b\.js\.$/);
});

test("ignores reviewed-markers posted by people without write access", async () => {
  const { root, baseSha, headSha } = setup();
  const github = fakeGitHub({
    headSha,
    baseSha,
    reviews: [{ body: `<!-- crc:reviewed=${headSha} -->`, user: { login: "drive-by" }, author_association: "CONTRIBUTOR" }],
  });
  const model = fakeModel([]);
  const outcome = await reviewPullRequest({
    root,
    pr: { repo: "o/r", number: 7 },
    gh: github.gh,
    config: { ...DEFAULT_CONFIG, verify: false },
    runModel: model.run,
    dryRun: true,
  });
  assert.equal(outcome.status, "dry-run", "the fake marker doesn't make crc skip");
  assert.equal(model.calls.length, 1);
});

test("skips commits crc already reviewed, and drafts", async () => {
  const { root, baseSha, headSha } = setup();
  const model = fakeModel([]);
  const base = { root, pr: { repo: "o/r", number: 7 }, config: { ...DEFAULT_CONFIG }, runModel: model.run };
  const reviewed = fakeGitHub({ headSha, baseSha, reviews: [{ body: `<!-- crc:reviewed=${headSha} -->` }] });
  assert.deepEqual(await reviewPullRequest({ ...base, gh: reviewed.gh }), {
    status: "skipped",
    reason: `crc already reviewed ${headSha.slice(0, 7)}`,
  });
  const draft = fakeGitHub({ headSha, baseSha, draft: true });
  assert.equal((await reviewPullRequest({ ...base, gh: draft.gh })).reason, "PR #7 is a draft");
  assert.equal(model.calls.length, 0);
});

test("when GitHub rejects an inline comment, findings move into the review body", async () => {
  const { root, baseSha, headSha } = setup();
  const github = fakeGitHub({ headSha, baseSha, failFirstPost: true });
  const outcome = await reviewPullRequest({
    root,
    pr: { repo: "o/r", number: 7 },
    gh: github.gh,
    config: { ...DEFAULT_CONFIG, verify: false },
    runModel: fakeModel([finding()]).run,
  });
  assert.equal(outcome.status, "posted");
  assert.equal(github.posted.length, 2);
  assert.equal(github.posted[1]!.comments.length, 0);
  assert.match(github.posted[1]!.body, /Findings outside the diff[\s\S]*Wrong constant/);
});

test("placeFinding only spans lines GitHub can comment on", () => {
  const hunks = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, heading: "", lines: [] }, { oldStart: 20, oldLines: 2, newStart: 21, newLines: 3, heading: "", lines: [] }];
  const f = (line: number, endLine: number) => ({ line, endLine }) as Finding;
  assert.deepEqual(placeFinding(f(2, 4), hunks), { startLine: 2, line: 4, exact: true });
  assert.deepEqual(placeFinding(f(3, 3), hunks), { line: 3, exact: true });
  assert.deepEqual(placeFinding(f(4, 22), hunks), { line: 4, exact: false }, "range crossing hunks");
  assert.deepEqual(placeFinding(f(10, 21), hunks), { line: 21, exact: false });
  assert.equal(placeFinding(f(10, 12), hunks), undefined);
  assert.equal(placeFinding(f(1, 1), undefined), undefined, "file not in the PR diff");
});

test("a suggestion is attached only when the comment covers exactly the finding's lines", () => {
  const result = {
    scope: "",
    files: [{ path: "a.js", status: "modified", additions: 1, deletions: 0 }],
    skipped: [],
    summary: "",
    findings: [
      { ...finding({ file: "a.js", line: 1, endLine: 2, suggestion: "x" }), inDiff: true },
      { ...finding({ file: "a.js", line: 2, endLine: 9, suggestion: "y", title: "Spills over" }), inDiff: true },
    ],
    rejected: [],
    stats: { reviewCalls: 1, verifyCalls: 0, costUsd: 0, durationMs: 0, hiddenNits: 0 },
  } as ReviewResult;
  const review = buildReview(result, [{ filename: "a.js", status: "modified", patch: "@@ -1,2 +1,3 @@\n a\n+b\n c" }], { headSha: "f".repeat(40) });
  assert.deepEqual(review.comments.map((c) => [c.start_line, c.line, c.body.includes("```suggestion")]), [
    [1, 2, true],
    [undefined, 2, false],
  ]);
});

test("parsePrRef, lastReview, and childEnv", () => {
  assert.deepEqual(parsePrRef("12", "o/r"), { repo: "o/r", number: 12 });
  assert.deepEqual(parsePrRef("#12", "o/r"), { repo: "o/r", number: 12 });
  assert.deepEqual(parsePrRef("a-b/c.d#3", undefined), { repo: "a-b/c.d", number: 3 });
  assert.deepEqual(parsePrRef("https://github.com/x/y/pull/45/files", "o/r"), { repo: "x/y", number: 45 });
  assert.throws(() => parsePrRef("12", undefined), /--repo/);
  assert.throws(() => parsePrRef("main", "o/r"), /not a pull request/);

  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const c = "c".repeat(40);
  const review = (body: string | null, login: string, author_association: string) => ({ id: 1, body, commit_id: null, html_url: "", user: { login }, author_association });
  assert.deepEqual(
    lastReview([
      review(`<!-- crc:base=${c} -->
<!-- crc:reviewed=${a} -->`, "github-actions[bot]", "NONE"),
      review(null, "someone", "OWNER"),
      review(`x <!-- crc:reviewed=${b} -->`, "me", "OWNER"),
      review(`<!-- crc:reviewed=${c} -->`, "drive-by", "FIRST_TIME_CONTRIBUTOR"),
    ]),
    { sha: b, base: undefined },
  );
  assert.deepEqual(lastReview([review(`<!-- crc:base=${c} -->
<!-- crc:reviewed=${a} -->`, "github-actions[bot]", "NONE")]), { sha: a, base: c });
  assert.equal(lastReview([]), undefined);

  const env = childEnv({ PATH: "/bin", GITHUB_TOKEN: "x", gh_token: "y", INPUT_GITHUB_TOKEN: "z", CLAUDE_CODE_OAUTH_TOKEN: "keep", ANTHROPIC_API_KEY: "keep" });
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "PATH"]);
});
