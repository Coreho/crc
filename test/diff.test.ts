import assert from "node:assert/strict";
import { test } from "node:test";
import { addedFileDiff, diffSize, lineInDiff, parseUnifiedDiff, renderFileDiff, sameChange } from "../src/diff.ts";

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 import x from "x";
-const a = 1;
+const a = 2;
+const b = 3;

 export {};
@@ -20,3 +21,3 @@ function run() {
   start();
--- not a header, a deleted line
+++ not a header, an added line
   stop();
`;

test("parses a modified file with line numbers", () => {
  const [f] = parseUnifiedDiff(MODIFIED);
  assert.ok(f);
  assert.equal(f.path, "src/app.ts");
  assert.equal(f.status, "modified");
  assert.equal(f.hunks.length, 2);
  assert.equal(f.additions, 3);
  assert.equal(f.deletions, 2);

  const added = f.hunks[0]!.lines.filter((l) => l.kind === "add");
  assert.deepEqual(added.map((l) => [l.newLine, l.text]), [[2, "const a = 2;"], [3, "const b = 3;"]]);
  // The blank context line (bare space) keeps numbering in step.
  assert.equal(f.hunks[0]!.lines.at(-1)!.newLine, 5);
});

test("lines starting with --- or +++ inside a hunk stay content", () => {
  const [f] = parseUnifiedDiff(MODIFIED);
  const h = f!.hunks[1]!;
  assert.equal(h.heading, "function run() {");
  assert.deepEqual(h.lines.map((l) => l.kind), ["ctx", "del", "add", "ctx"]);
  assert.equal(h.lines[1]!.text, "-- not a header, a deleted line");
  assert.equal(h.lines[2]!.newLine, 22);
  assert.equal(diffSize(f!), 10);
});

test("lineInDiff covers hunk ranges in the new file", () => {
  const [f] = parseUnifiedDiff(MODIFIED);
  assert.equal(lineInDiff(f!, 1), true);
  assert.equal(lineInDiff(f!, 5), true);
  assert.equal(lineInDiff(f!, 6), false);
  assert.equal(lineInDiff(f!, 23), true);
  assert.equal(lineInDiff(f!, 24), false);
});

test("parses added, deleted, renamed and binary files", () => {
  const text = [
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "index 0000000..e69de29",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-a",
    "-b",
    "diff --git a/lib/a b.ts b/lib/c d.ts",
    "similarity index 100%",
    "rename from lib/a b.ts",
    "rename to lib/c d.ts",
    "diff --git a/logo.png b/logo.png",
    "index 1..2 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "",
  ].join("\n");
  const files = parseUnifiedDiff(text);
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.binary]),
    [
      ["new.txt", "added", false],
      ["old.txt", "deleted", false],
      ["lib/c d.ts", "renamed", false],
      ["logo.png", "modified", true],
    ],
  );
  assert.equal(files[2]!.oldPath, "lib/a b.ts");
  assert.equal(files[0]!.hunks[0]!.newLines, 1);
});

test("unquotes C-style quoted paths", () => {
  const text = [
    'diff --git "a/caf\\303\\251 \\"x\\".txt" "b/caf\\303\\251 \\"x\\".txt"',
    "--- \"a/caf\\303\\251 \\\"x\\\".txt\"",
    "+++ \"b/caf\\303\\251 \\\"x\\\".txt\"",
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ].join("\n");
  assert.equal(parseUnifiedDiff(text)[0]!.path, 'café "x".txt');
});

test("handles CRLF diff output", () => {
  const [f] = parseUnifiedDiff(MODIFIED.replaceAll("\n", "\r\n"));
  assert.equal(f!.path, "src/app.ts");
  assert.equal(f!.hunks[0]!.lines[1]!.text, "const a = 1;");
});

test("addedFileDiff marks every line as added", () => {
  const f = addedFileDiff("x.py", "a\r\nb\n");
  assert.equal(f.status, "added");
  assert.equal(f.additions, 2);
  assert.deepEqual(f.hunks[0]!.lines.map((l) => l.newLine), [1, 2]);
  assert.equal(addedFileDiff("empty", "").hunks.length, 0);
});

test("renderFileDiff puts new-file line numbers in the left column", () => {
  const [f] = parseUnifiedDiff(MODIFIED);
  const lines = renderFileDiff(f!).split("\n");
  assert.equal(lines[0], "### src/app.ts (modified, +3 -2)");
  assert.equal(lines[1], "@@ -1,4 +1,5 @@");
  assert.equal(lines[2], " 1   import x from \"x\";");
  assert.equal(lines[3], "   - const a = 1;");
  assert.equal(lines[4], " 2 + const a = 2;");
  assert.match(renderFileDiff({ ...f!, status: "deleted" }), /\(file deleted\)$/);
});

test("sameChange ignores where a hunk sits but not what it changes", () => {
  const diff = (start: number, added: string) =>
    parseUnifiedDiff(`diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -${start},3 +${start},3 @@ fn()\n x\n-y\n+${added}\n z\n`)[0]!;
  assert.equal(sameChange(diff(10, "Y"), diff(40, "Y")), true);
  assert.equal(sameChange(diff(10, "Y"), diff(10, "W")), false);
  assert.equal(sameChange(diff(10, "Y"), { ...diff(10, "Y"), status: "renamed", oldPath: "b.js" }), false);
});
