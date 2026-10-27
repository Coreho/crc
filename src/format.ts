import { styleText } from "node:util";
import type { Finding, ReviewResult, Severity } from "./types.ts";

type Style = Parameters<typeof styleText>[0];

const SEVERITY_STYLE: Record<Severity, Style> = {
  critical: ["bold", "red"],
  major: ["bold", "yellow"],
  minor: "cyan",
  nit: "gray",
};

export function formatText(r: ReviewResult, opts: { color: boolean; width: number; showRejected: boolean }): string {
  const c = (style: Style, s: string) => (opts.color ? styleText(style, s, { validateStream: false }) : s);
  const width = Math.max(40, Math.min(opts.width, 110));
  const out: string[] = [];

  out.push(`${c("bold", "crc")} ${r.scope}`);
  out.push(c("dim", headline(r)));

  if (r.files.length === 0) {
    out.push("", "Nothing to review.");
  } else {
    if (r.summary) {
      out.push("", c("bold", "Summary"));
      r.summary.split(/\n\s*\n/).forEach((para, i) => {
        if (i > 0) out.push("");
        out.push(...wrap(para, width - 2).map((l) => "  " + l));
      });
    }
    if (r.findings.length === 0) {
      out.push("", c("green", "No issues found."));
    }
    for (const f of r.findings) out.push("", ...findingText(f, c, width));
    if (opts.showRejected && r.rejected.length > 0) {
      out.push("", c("bold", `Rejected by verification (${r.rejected.length})`));
      for (const f of r.rejected) {
        out.push(c("dim", `  ${location(f)}  ${f.title}`));
        if (f.verification?.reason) out.push(...wrap(f.verification.reason, width - 6).map((l) => c("dim", "      " + l)));
      }
    }
  }

  const notes: string[] = [];
  if (r.skipped.length > 0) notes.push(`Skipped: ${r.skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`);
  if (r.stats.hiddenNits > 0) notes.push(`${r.stats.hiddenNits} nit${r.stats.hiddenNits === 1 ? "" : "s"} hidden (use --nits to show)`);
  if (r.rejected.length > 0 && !opts.showRejected) notes.push("Use --show-rejected to see what verification threw out");
  if (notes.length > 0) out.push("", ...notes.flatMap((n) => wrap(n, width)).map((l) => c("dim", l)));
  return out.join("\n") + "\n";
}

function findingText(f: Finding, c: (s: Style, t: string) => string, width: number): string[] {
  const out = [`${c(SEVERITY_STYLE[f.severity], `[${f.severity.toUpperCase()}]`)} ${c("dim", f.category)}  ${c("underline", location(f))}`];
  out.push(...wrap(f.title, width - 2).map((l) => "  " + c("bold", l)));
  out.push(...wrap(f.body, width - 2).map((l) => "  " + l));
  if (f.snippet) {
    const numWidth = String(f.snippet.start + f.snippet.lines.length - 1).length;
    f.snippet.lines.forEach((line, i) => {
      out.push(c("dim", `  ${String(f.snippet!.start + i).padStart(numWidth)} │ `) + line);
    });
  }
  if (f.suggestion) {
    out.push(c("green", "  Suggested fix:"));
    out.push(...f.suggestion.split("\n").map((l) => c("green", "    " + l)));
  }
  if (!f.inDiff) out.push(c("dim", "  (outside the changed lines)"));
  return out;
}

export function formatMarkdown(r: ReviewResult, opts: { showRejected: boolean }): string {
  const out = [`# Code review: ${r.scope}`, "", headline(r)];
  if (r.summary) out.push("", "## Summary", "", r.summary);
  out.push("", "## Findings", "");
  if (r.findings.length === 0) out.push("No issues found.");
  for (const f of r.findings) {
    out.push(`### ${capitalize(f.severity)} · ${f.category} · \`${location(f)}\``, "", `**${f.title}**`, "", f.body, "");
    if (f.snippet) out.push("```", ...f.snippet.lines, "```", "");
    if (f.suggestion) out.push("Suggested fix:", "", "```", f.suggestion, "```", "");
  }
  if (opts.showRejected && r.rejected.length > 0) {
    out.push("## Rejected by verification", "");
    for (const f of r.rejected) out.push(`- \`${location(f)}\` ${f.title}: ${f.verification?.reason ?? ""}`);
    out.push("");
  }
  if (r.skipped.length > 0) {
    out.push(`_Skipped: ${r.skipped.map((s) => `\`${s.path}\` (${s.reason})`).join(", ")}_`, "");
  }
  return out.join("\n");
}

function headline(r: ReviewResult): string {
  const added = r.files.reduce((n, f) => n + f.additions, 0);
  const removed = r.files.reduce((n, f) => n + f.deletions, 0);
  const parts = [`${r.files.length} file${r.files.length === 1 ? "" : "s"} (+${added} -${removed})`];
  if (r.stats.reviewCalls > 0) {
    parts.push(`${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}`);
    if (r.rejected.length > 0) parts.push(`${r.rejected.length} rejected by verification`);
    parts.push(`${formatDuration(r.stats.durationMs)}`);
    if (r.stats.costUsd > 0) parts.push(`est. API cost $${r.stats.costUsd.toFixed(2)}`);
  }
  return parts.join(" · ");
}

export function location(f: Finding): string {
  return f.endLine > f.line ? `${f.file}:${f.line}-${f.endLine}` : `${f.file}:${f.line}`;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function capitalize(s: string): string {
  return s[0]!.toUpperCase() + s.slice(1);
}

export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
  }
  return lines;
}
