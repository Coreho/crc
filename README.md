# crc

_Last updated: 2026-10-27_

A personal AI code reviewer in the spirit of CodeRabbit. It reads a diff, has Claude review it with read access to the rest of the repo, runs a second skeptical pass that throws out false positives, and reports the findings that survive, each with file, line, severity, and an optional fix. It works on local changes from your terminal and on GitHub pull requests, where it posts a review with inline comments and one-click suggested changes.

It runs through [Claude Code](https://code.claude.com) in headless mode (`claude -p`), so it uses your Claude subscription. You don't need an API key.

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

## Pull request reviews

crc posts a GitHub review on a pull request. The review body has a summary, the finding counts, and any findings that don't sit on a line in the PR's diff. Every other finding becomes an inline comment, with a `suggestion` block you can apply in one click when the fix is short. After new commits are pushed, the next run reviews only the commits since crc's last review. crc finds that point from a hidden marker it leaves in each review, and it trusts that marker only when the review came from `github-actions[bot]` or someone with write access. If the branch was force-pushed, or a merge (such as GitHub's "Update branch") landed since the last review, crc reviews the whole PR again so base-branch changes aren't treated as PR changes. Drafts, closed PRs, and commits it has already reviewed are skipped unless you pass `--force`.

### From your machine

Inside a clone of the repository, with the GitHub CLI logged in (or `GITHUB_TOKEN` set):

```sh
crc pr 12                 # review PR #12 of the origin repo and post the review
crc pr 12 --dry-run       # print the review instead of posting it
crc pr https://github.com/owner/repo/pull/12
crc pr 12 --full          # review the whole PR again, not just the new commits
```

If the PR's head isn't what you have checked out, crc reviews it in a temporary git worktree, so your working copy isn't touched. It fetches the PR's commits if your clone doesn't have them.

### Automatically, with GitHub Actions

To review every pull request in a repository as it's opened or updated:

1. Run `claude setup-token` and copy the token it prints (valid for a year).
2. In the repository, save it as an Actions secret named `CLAUDE_CODE_OAUTH_TOKEN`:
   `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo owner/repo` (paste the token when asked).
3. Copy [`examples/crc-review.yml`](examples/crc-review.yml) to `.github/workflows/crc-review.yml` in that repository.

The workflow uses `Coreho/crc@main` as its action. While this repo is private, other repositories can use the action only if *Settings → Actions → General → Access* allows repositories owned by Coreho:
`gh api -X PUT repos/Coreho/crc/actions/permissions/access -f access_level=user`.

Reviews posted from Actions appear under `github-actions[bot]`. Reviews posted with `crc pr` from your machine appear under your own account. Pass extra flags with the action's `args` input, such as `args: --no-verify --model sonnet`.

**Security.** The Claude process that reads PR content never sees a GitHub token: crc strips `GITHUB_TOKEN`, `GH_TOKEN`, and the Actions runtime tokens from its environment. It also has only read-only tools. GitHub doesn't give secrets to workflows triggered by PRs from forks, so on a fork PR the action fails at the credentials check instead of running.

## How it works

1. **Collect.** It runs `git diff` for the chosen scope and adds untracked files. It leaves out lockfiles, build output, minified files, binaries, untracked files over 512 KB, nested repositories, and anything matching your `ignore` globs. With `--staged`, the reviewer is told the working tree may hold unstaged edits, and snippets come from the staged version.
2. **Review.** Files go into batches of about 1,500 diff lines. Each batch goes to `claude -p` with a reviewer system prompt, the diff with new-file line numbers, your project guidelines, and a JSON schema for the findings. Claude has read-only tools (Read, Grep, Glob), so it can check callers and definitions before reporting something. Batches run two at a time.
3. **Verify.** Every finding goes to a second `claude -p` run whose only job is to try to disprove it against the actual code. Rejected findings are dropped (see them with `--show-rejected`). The verifier can lower a severity but not raise it.
4. **Report.** Results are sorted by severity, with the cited code lines attached, and printed as text, Markdown, or JSON. For a pull request, each finding is placed on a line GitHub accepts comments on (taken from the PR's own diff), or listed in the review body if it can't be. If GitHub still rejects an inline position, crc posts the review again with every finding in the body.

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
- `2`: an error, such as not being in a git repo, an unknown base ref, Claude Code failing, or a GitHub API error.

## Development

```sh
npm run check    # typecheck + tests
npm run dev -- --help   # run from source without building
```

Set `CRC_DEBUG=1` to print one line per Claude run to stderr, showing its turn count, permission denials, duration, and estimated cost. This is useful for confirming that the reviewer is actually using its read-only tools.

The tests cover diff parsing, git scope collection against throwaway repos, the review pipeline with a fake model, and the pull request flow against a fake GitHub API. They make no Claude or GitHub calls.

Source layout: `src/git.ts` (what changed), `src/diff.ts` (diff parsing and rendering), `src/prompts.ts` (system prompts and schemas), `src/backend.ts` (the `claude -p` runner), `src/review.ts` (batching, verification, normalization), `src/format.ts` (text and Markdown output), `src/github.ts` (GitHub REST client), `src/pr.ts` (pull request reviews), `src/cli.ts`, and `action.yml` (the GitHub Action).

## Not built yet

- A VS Code extension with a sidebar and inline comments, built on `crc --format json`
- Replying to follow-up comments on a review, as CodeRabbit does in chat
- A backend that calls the Anthropic API directly with an API key
