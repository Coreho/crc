import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const created: string[] = [];
process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A throwaway git repo with one commit on main, deleted when the test process exits. */
export function makeRepo(files: Record<string, string>): { root: string; git: (...args: string[]) => string; write: (path: string, content: string | Buffer) => void } {
  const root = mkdtempSync(join(tmpdir(), "crc-test-"));
  created.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      encoding: "utf8",
    });
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  for (const [path, content] of Object.entries(files)) write(path, content);
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  return { root, git, write };
}
