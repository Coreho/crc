export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  /** Line number in the new file; absent for deleted lines. */
  newLine?: number;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  heading: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  binary: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Parse `git diff` output. Expects the default a/ and b/ prefixes, which
 * git.ts forces with --src-prefix/--dst-prefix.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let hunk: Hunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let newNo = 0;

  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    // Inside a hunk the line counts decide where it ends, so a deleted line
    // that happens to start with "--- " is not mistaken for a header.
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const marker = line[0];
      const body = line.slice(1);
      if (marker === "+") {
        hunk.lines.push({ kind: "add", text: body, newLine: newNo++ });
        newLeft--;
        file!.additions++;
      } else if (marker === "-") {
        hunk.lines.push({ kind: "del", text: body });
        oldLeft--;
        file!.deletions++;
      } else if (marker === "\\") {
        // "\ No newline at end of file"
      } else {
        // Context line; tolerate a stripped leading space on blank lines.
        hunk.lines.push({ kind: "ctx", text: marker === " " ? body : line, newLine: newNo++ });
        oldLeft--;
        newLeft--;
      }
      continue;
    }

    if (line.startsWith("diff --git ")) {
      file = {
        path: pathFromDiffGitLine(line.slice("diff --git ".length)),
        status: "modified",
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;

    const m = HUNK_HEADER.exec(line);
    if (m) {
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        heading: m[5] ?? "",
        lines: [],
      };
      file.hunks.push(hunk);
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      newNo = hunk.newStart;
    } else if (line.startsWith("new file mode")) {
      file.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      file.status = "deleted";
    } else if (line.startsWith("rename from ")) {
      file.oldPath = unquote(line.slice("rename from ".length));
      file.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      file.path = unquote(line.slice("rename to ".length));
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
    } else if (line.startsWith("--- ")) {
      const p = line.slice(4);
      if (p !== "/dev/null" && file.status === "deleted") file.path = stripPrefix(unquote(p));
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") file.path = stripPrefix(unquote(p));
    }
  }
  return files;
}

/** Build a diff for a file git doesn't track yet: every line is an addition. */
export function addedFileDiff(path: string, content: string): FileDiff {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const hunks: Hunk[] =
    lines.length === 0
      ? []
      : [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: lines.length,
            heading: "",
            lines: lines.map((text, i) => ({ kind: "add", text, newLine: i + 1 })),
          },
        ];
  return { path, status: "added", binary: false, hunks, additions: lines.length, deletions: 0 };
}

/** Number of diff lines, used to size review batches. */
export function diffSize(f: FileDiff): number {
  return f.hunks.reduce((n, h) => n + h.lines.length, 0);
}

/** True when `line` of the new file falls inside one of the hunks. */
export function lineInDiff(f: FileDiff, line: number): boolean {
  return f.hunks.some((h) => line >= h.newStart && line < h.newStart + h.newLines);
}

/**
 * Render one file's diff for the model, with new-file line numbers in the
 * left column so findings can cite exact lines.
 */
export function renderFileDiff(f: FileDiff): string {
  const status = f.status === "renamed" ? `renamed from ${f.oldPath}` : f.status;
  const header = `### ${f.path} (${status}, +${f.additions} -${f.deletions})`;
  if (f.status === "deleted") return `${header}\n(file deleted)`;
  if (f.hunks.length === 0) return `${header}\n(no content changes)`;

  const maxLine = Math.max(...f.hunks.map((h) => h.newStart + h.newLines));
  const width = String(maxLine).length;
  const out = [header];
  for (const h of f.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.heading ? " " + h.heading : ""}`);
    for (const l of h.lines) {
      const num = l.newLine === undefined ? " ".repeat(width) : String(l.newLine).padStart(width);
      const marker = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
      out.push(`${num} ${marker} ${l.text}`);
    }
  }
  return out.join("\n");
}

function pathFromDiffGitLine(rest: string): string {
  if (rest.startsWith('"')) {
    const end = closingQuote(rest);
    return stripPrefix(unquote(rest.slice(0, end + 1)));
  }
  // "a/<p> b/<p>": when old and new paths match, each half is (len - 5) / 2.
  const n = (rest.length - 5) / 2;
  if (Number.isInteger(n) && rest.slice(2, 2 + n) === rest.slice(5 + n)) return rest.slice(2, 2 + n);
  const split = rest.indexOf(" b/");
  return split === -1 ? rest : rest.slice(split + 3);
}

function stripPrefix(p: string): string {
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}

function closingQuote(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i;
  }
  return s.length - 1;
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\", a: "\x07", b: "\b", f: "\f", r: "\r", v: "\v" };

/** Undo git's C-style path quoting ("a/caf\303\251.txt"). */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const next = body[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(...Buffer.from(ESCAPES[next] ?? next, "utf8"));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
