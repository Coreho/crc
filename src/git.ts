import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { addedFileDiff, parseUnifiedDiff, type FileDiff } from "./diff.ts";

export type Scope =
  | { kind: "base"; ref: string }
  | { kind: "uncommitted" }
  | { kind: "staged" }
  /** Committed changes only, from the merge base of `base` and `head` to `head`. Used for pull requests. */
  | { kind: "range"; base: string; head: string; label: string };

/** Untracked files bigger than this are listed as skipped instead of reviewed. */
const MAX_UNTRACKED_BYTES = 512 * 1024;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotePath=false", ...args],
      { cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || err.message}`));
        else resolve(stdout);
      },
    );
  });
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
}

export async function refExists(root: string, ref: string): Promise<boolean> {
  return git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root).then(
    () => true,
    () => false,
  );
}

export async function currentBranch(root: string): Promise<string | undefined> {
  const name = (await git(["rev-parse", "--abbrev-ref", "HEAD"], root).catch(() => "")).trim();
  return name && name !== "HEAD" ? name : undefined;
}

/** The branch a feature branch would merge into: origin's HEAD, else main or master. */
export async function defaultBase(root: string): Promise<string | undefined> {
  const originHead = (await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root).catch(() => "")).trim();
  const candidates = [originHead, "main", "master", "origin/main", "origin/master"].filter(Boolean);
  for (const ref of candidates) {
    if (await refExists(root, ref)) return ref;
  }
  return undefined;
}

/**
 * Pick what to review when the user didn't say: the whole branch against its
 * base when on a feature branch, otherwise the uncommitted changes.
 */
export async function autoScope(root: string): Promise<Scope> {
  const base = await defaultBase(root);
  const branch = await currentBranch(root);
  if (base && branch && branch !== base && base !== `origin/${branch}`) {
    const [baseSha, headSha] = await Promise.all([
      git(["rev-parse", base], root),
      git(["rev-parse", "HEAD"], root),
    ]);
    if (baseSha !== headSha) return { kind: "base", ref: base };
  }
  return { kind: "uncommitted" };
}

export interface Changes {
  description: string;
  /** Extra context for the model about how the diff relates to the files on disk. */
  note?: string;
  files: FileDiff[];
  /** Untracked files left out for size or binary content. */
  skipped: { path: string; reason: string }[];
}

export async function collectChanges(root: string, scope: Scope, includeUntracked = true): Promise<Changes> {
  const diffArgs = ["diff", "--no-color", "--no-ext-diff", "-M", "-U5", "--src-prefix=a/", "--dst-prefix=b/"];
  const hasHead = await refExists(root, "HEAD");
  let description: string;
  let note: string | undefined;
  let args: string[];

  if (scope.kind === "staged") {
    description = "staged changes";
    note =
      "Only staged changes are under review. Files in the working tree may also hold unstaged edits that are not part of it, so treat the diff as authoritative for the changed lines.";
    args = [...diffArgs, "--cached"];
  } else if (scope.kind === "base") {
    if (!(await refExists(root, scope.ref))) throw new Error(`Unknown base ref "${scope.ref}"`);
    const mergeBase = (await git(["merge-base", scope.ref, "HEAD"], root)).trim();
    description = `changes since ${scope.ref} (${mergeBase.slice(0, 7)}), including uncommitted work`;
    args = [...diffArgs, mergeBase];
  } else if (scope.kind === "range") {
    for (const ref of [scope.base, scope.head]) {
      if (!(await refExists(root, ref))) throw new Error(`Commit ${ref} is not available locally`);
    }
    const mergeBase = (await git(["merge-base", scope.base, scope.head], root)).trim();
    description = scope.label;
    args = [...diffArgs, mergeBase, scope.head];
  } else {
    description = "uncommitted changes";
    args = [...diffArgs, hasHead ? "HEAD" : EMPTY_TREE];
  }

  const files = parseUnifiedDiff(await git(args, root));
  const skipped: Changes["skipped"] = [];

  if (includeUntracked && scope.kind !== "staged" && scope.kind !== "range") {
    const listed = await git(["ls-files", "--others", "--exclude-standard", "-z"], root);
    for (const path of listed.split("\0").filter(Boolean)) {
      const abs = join(root, path);
      // Nested repositories show up as directories, and dangling symlinks fail to stat.
      const info = await stat(abs).catch(() => undefined);
      if (!info?.isFile()) {
        skipped.push({ path, reason: "not a regular file" });
        continue;
      }
      if (info.size > MAX_UNTRACKED_BYTES) {
        skipped.push({ path, reason: `untracked file too large (${Math.round(info.size / 1024)} KB)` });
        continue;
      }
      const buf = await readFile(abs);
      if (buf.subarray(0, 8000).includes(0)) {
        skipped.push({ path, reason: "binary" });
        continue;
      }
      files.push(addedFileDiff(path, buf.toString("utf8")));
    }
  }

  return { description, note, files, skipped };
}

/**
 * Contents of `path` as the scope sees it: the index for staged reviews, the
 * head commit for ranges, otherwise the working tree.
 */
export async function readScopedFile(root: string, scope: Scope, path: string): Promise<string | undefined> {
  if (scope.kind === "staged") return git(["show", `:${path}`], root).catch(() => undefined);
  if (scope.kind === "range") return git(["show", `${scope.head}:${path}`], root).catch(() => undefined);
  return readFile(join(root, path), "utf8").catch(() => undefined);
}

export async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  return git(["merge-base", "--is-ancestor", ancestor, descendant], root).then(
    () => true,
    () => false,
  );
}

/** The `owner/repo` that the origin remote points at on GitHub, if it does. */
export async function githubRepoFromRemote(root: string): Promise<string | undefined> {
  const url = (await git(["remote", "get-url", "origin"], root).catch(() => "")).trim();
  const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return m?.[1];
}

/** The name of a remote whose URL points at `owner/repo` on GitHub. */
export async function remoteFor(root: string, repo: string): Promise<string | undefined> {
  const out = await git(["remote", "-v"], root).catch(() => "");
  for (const line of out.split("\n")) {
    const [name, url] = line.split(/\s+/);
    const m = url && /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
    if (name && m?.[1]?.toLowerCase() === repo.toLowerCase()) return name;
  }
  return undefined;
}
