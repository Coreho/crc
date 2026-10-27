# crc

_Last updated: 2026-10-27_

A personal AI code reviewer for your local git changes, in the spirit of CodeRabbit. It reads your diff, has Claude review it with read access to the rest of the repo, runs a second skeptical pass that throws out false positives, and prints the findings that survive, each with file, line, severity, and an optional fix.

It runs through [Claude Code](https://code.claude.com) in headless mode (`claude -p`), so it uses your existing Claude Code login. You don't need an API key.

## Requirements

- Node.js 22.18 or newer
- git
- Claude Code, installed and logged in (`claude` on your PATH, or set `CRC_CLAUDE_BIN`)

## Setup

```sh
npm install
npm run build
npm link        # puts `crc` on your PATH
```

## Usage

Run it anywhere inside a git repository:

```sh
crc                      # feature branch: everything since main; on main: uncommitted changes
crc --base develop       # everything since the merge base with develop, plus uncommitted work
crc --uncommitted        # staged + unstaged + untracked changes only
crc --staged             # staged changes only
crc --format md -o review.md
crc --format json        # machine-readable, for scripts or an editor integration
crc --fail-on major      # exit 1 if anything major or critical is found
```

Other options: `--no-verify` skips the second pass (faster, noisier), `--nits` shows trivial findings, `--show-rejected` lists what the verification pass threw out and why, `--model`/`--verify-model`/`--effort` pick models and effort, `--no-untracked` leaves out new untracked files. `crc --help` lists everything.

A review usually takes a few minutes, because Claude reads around the codebase to confirm each suspicion. The "est. API cost" in the report is what the run would cost at API list prices. Your usage counts against your Claude Code plan.

### Pre-push hook

```sh
# .git/hooks/pre-push
#!/bin/sh
crc --fail-on critical
```

## How it works

1. **Collect.** It runs `git diff` for the chosen scope and adds untracked files. It leaves out lockfiles, build output, minified files, binaries, untracked files over 512 KB, nested repositories, and anything matching your `ignore` globs. With `--staged`, the reviewer is told the working tree may hold unstaged edits, and snippets come from the staged version.
2. **Review.** Files go into batches of about 1,500 diff lines. Each batch goes to `claude -p` with a reviewer system prompt, the diff with new-file line numbers, your project guidelines, and a JSON schema for the findings. Claude has read-only tools (Read, Grep, Glob), so it can check callers and definitions before reporting something. Batches run two at a time.
3. **Verify.** Every finding goes to a second `claude -p` run whose only job is to try to disprove it against the actual code. Rejected findings are dropped (see them with `--show-rejected`). The verifier can lower a severity but not raise it.
4. **Report.** Results are sorted by severity, with the cited code lines attached, and printed as text, Markdown, or JSON.

Reviewer sessions run with `--safe-mode`, so your own hooks, plugins, MCP servers, and CLAUDE.md don't load into them. crc passes your project guidelines in explicitly instead.

## Configuration

Run `crc init` to write a `.crc.json` in the repo root. Every key is optional:

```json
{
  "instructions": "We use Result types instead of exceptions; flag any new throw.",
  "ignore": ["generated/**", "**/*.pb.go"],
  "guidelines": ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md"],
  "model": "opus",
  "verifyModel": "opus",
  "effort": "high",
  "verifyEffort": "medium",
  "verify": true,
  "nits": false
}
```

- `instructions`: extra review rules for this repo.
- `guidelines`: files passed to the reviewer as project standards (each one up to 40,000 characters).
- `ignore`: globs added to the built-in ignore list.
- `model`, `verifyModel`: any model name or alias Claude Code accepts (`opus`, `sonnet`, `fable`, ...).

Command-line flags override the config file.

## Exit codes

- `0`: the review ran. Findings alone don't change this unless you use `--fail-on`.
- `1`: `--fail-on` was set and a finding met the threshold.
- `2`: an error, such as not being in a git repo, an unknown base ref, or Claude Code failing.

## Development

```sh
npm run check    # typecheck + tests
npm run dev -- --help   # run from source without building
```

Set `CRC_DEBUG=1` to print one line per Claude run to stderr, showing its turn count, permission denials, duration, and estimated cost. This is useful for confirming that the reviewer is actually using its read-only tools.

The tests cover diff parsing, git scope collection against throwaway repos, and the review pipeline with a fake model. They make no Claude calls.

Source layout: `src/git.ts` (what changed), `src/diff.ts` (diff parsing and rendering), `src/prompts.ts` (system prompts and schemas), `src/backend.ts` (the `claude -p` runner), `src/review.ts` (batching, verification, normalization), `src/format.ts` (text and Markdown output), and `src/cli.ts`.

## Not built yet

- A VS Code extension with a sidebar and inline comments, built on `crc --format json`
- GitHub pull request comments
- A backend that calls the Anthropic API directly with an API key
