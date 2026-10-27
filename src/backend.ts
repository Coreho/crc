import { spawn } from "node:child_process";

export interface ModelRequest {
  system: string;
  prompt: string;
  schema: object;
  model: string;
  effort: string;
  /** Repository root; the model's read-only tools work from here. */
  cwd: string;
}

export interface ModelResult {
  output: unknown;
  costUsd: number;
}

export type RunModel = (req: ModelRequest) => Promise<ModelResult>;

/** Read-only tools the reviewer may use to look around the repo. */
const TOOLS = "Read,Grep,Glob";
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Run a request through Claude Code in headless mode (`claude -p`), so it uses
 * whatever login Claude Code already has. Safe mode keeps the user's hooks,
 * plugins, MCP servers and CLAUDE.md out of the reviewer's session.
 */
export function claudeCodeRunner(opts: { bin?: string; timeoutMs?: number } = {}): RunModel {
  const bin = opts.bin ?? process.env.CRC_CLAUDE_BIN ?? "claude";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return (req) =>
    new Promise((resolve, reject) => {
      const args = [
        "-p",
        "--output-format", "json",
        "--json-schema", JSON.stringify(req.schema),
        "--system-prompt", req.system,
        "--model", req.model,
        "--effort", req.effort,
        "--tools", TOOLS,
        "--safe-mode",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--permission-prompts", "none",
      ];
      const child = spawn(bin, args, { cwd: req.cwd, env: childEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`claude timed out after ${Math.round(timeoutMs / 60000)} minutes`));
      }, timeoutMs);

      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => err.push(d));
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          e.code === "ENOENT"
            ? new Error(`Couldn't run "${bin}". Install Claude Code and log in, or set CRC_CLAUDE_BIN.`)
            : e,
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(out).toString("utf8");
        const stderr = Buffer.concat(err).toString("utf8").trim();
        try {
          resolve(parseResult(stdout));
        } catch (e) {
          const detail = stderr || stdout.trim().slice(0, 500);
          reject(new Error(`claude exited with code ${code}: ${(e as Error).message}${detail ? `\n${detail}` : ""}`));
        }
      });

      child.stdin.on("error", () => {
        // The process exited before reading stdin; the close handler reports why.
      });
      child.stdin.end(req.prompt);
    });
}

/**
 * The reviewer reads untrusted pull request content, so it gets no GitHub
 * credentials. Claude Code's own auth variables pass through.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN|INPUT_.*)$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

interface ClaudeJsonResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  permission_denials?: unknown[];
}

export function parseResult(stdout: string): ModelResult {
  let data: ClaudeJsonResult;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error("output was not JSON");
  }
  if (process.env.CRC_DEBUG) {
    const denials = data.permission_denials?.length ?? 0;
    process.stderr.write(
      `[crc] claude: ${data.subtype}, ${data.num_turns} turns, ${denials} permission denials, ` +
        `${Math.round((data.duration_ms ?? 0) / 1000)}s, $${(data.total_cost_usd ?? 0).toFixed(3)}\n`,
    );
  }
  if (data.is_error || data.subtype !== "success") {
    throw new Error(`run failed (${data.subtype ?? "error"}): ${data.result ?? "no details"}`);
  }
  if (data.structured_output === undefined) {
    throw new Error("run finished without structured output");
  }
  return { output: data.structured_output, costUsd: data.total_cost_usd ?? 0 };
}
