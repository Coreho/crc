import assert from "node:assert/strict";
import { test } from "node:test";
import { autoScope, collectChanges, defaultBase } from "../src/git.ts";
import { makeRepo } from "./helpers.ts";

function setup() {
  const repo = makeRepo({ "src/a.ts": "export const a = 1;\n", "README.md": "# demo\n" });
  repo.git("checkout", "-q", "-b", "feature");
  repo.write("src/a.ts", "export const a = 2;\n");
  repo.git("commit", "-q", "-am", "change a");
  repo.write("README.md", "# demo\n\nmore\n");
  repo.write("src/new.ts", "export const n = 1;\n");
  repo.write("logo.bin", Buffer.from([0, 1, 2, 3]));
  return repo;
}

test("autoScope reviews the branch against main on a feature branch", async () => {
  const { root, git } = setup();
  assert.equal(await defaultBase(root), "main");
  assert.deepEqual(await autoScope(root), { kind: "base", ref: "main" });
  git("checkout", "-q", "main");
  assert.deepEqual(await autoScope(root), { kind: "uncommitted" });
});

test("base scope covers commits, uncommitted edits and untracked files", async () => {
  const { root } = setup();
  const changes = await collectChanges(root, { kind: "base", ref: "main" });
  assert.match(changes.description, /^changes since main \([0-9a-f]{7}\)/);
  assert.deepEqual(changes.files.map((f) => [f.path, f.status]).sort(), [
    ["README.md", "modified"],
    ["src/a.ts", "modified"],
    ["src/new.ts", "added"],
  ]);
  assert.deepEqual(changes.skipped, [{ path: "logo.bin", reason: "binary" }]);
});

test("uncommitted scope leaves out committed branch work", async () => {
  const { root } = setup();
  const changes = await collectChanges(root, { kind: "uncommitted" });
  assert.deepEqual(changes.files.map((f) => f.path).sort(), ["README.md", "src/new.ts"]);
});

test("staged scope and --no-untracked", async () => {
  const { root, git } = setup();
  git("add", "README.md");
  const staged = await collectChanges(root, { kind: "staged" });
  assert.deepEqual(staged.files.map((f) => f.path), ["README.md"]);
  const tracked = await collectChanges(root, { kind: "uncommitted" }, false);
  assert.deepEqual(tracked.files.map((f) => f.path), ["README.md"]);
});

test("an untracked nested repository is skipped, not a crash", async () => {
  const { root, write } = setup();
  write("vendored/lib/x.txt", "x\n");
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q"], { cwd: `${root}/vendored/lib` });
  const changes = await collectChanges(root, { kind: "uncommitted" });
  assert.ok(changes.skipped.some((s) => s.path === "vendored/lib/" && s.reason === "not a regular file"));
  assert.ok(changes.files.some((f) => f.path === "src/new.ts"));
});

test("unknown base ref is a clear error", async () => {
  const { root } = setup();
  await assert.rejects(collectChanges(root, { kind: "base", ref: "nope" }), /Unknown base ref "nope"/);
});
