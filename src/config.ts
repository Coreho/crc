import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

export interface Config {
  /** Extra review instructions for this repo. */
  instructions: string;
  /** Globs (repo-relative, forward slashes) for files to leave out of the review. */
  ignore: string[];
  /** Files whose contents are passed to the reviewer as project guidelines. */
  guidelines: string[];
  model: string;
  verifyModel: string;
  effort: string;
  verifyEffort: string;
  verify: boolean;
  /** Show nit-severity findings. */
  nits: boolean;
}

export const CONFIG_FILE = ".crc.json";

export const DEFAULT_IGNORE = [
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/uv.lock",
  "**/composer.lock",
  "**/Gemfile.lock",
  "**/go.sum",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/*.snap",
  "**/dist/**",
  "**/build/**",
  "**/node_modules/**",
  "**/vendor/**",
];

export const DEFAULT_CONFIG: Config = {
  instructions: "",
  ignore: [],
  guidelines: ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md"],
  model: "opus",
  verifyModel: "opus",
  effort: "medium",
  verifyEffort: "medium",
  verify: true,
  nits: false,
};

const STRING_KEYS = ["instructions", "model", "verifyModel", "effort", "verifyEffort"] as const;
const LIST_KEYS = ["ignore", "guidelines"] as const;
const BOOL_KEYS = ["verify", "nits"] as const;

export async function loadConfig(root: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(join(root, CONFIG_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}

export function parseConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${CONFIG_FILE} must contain a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const known = new Set<string>([...STRING_KEYS, ...LIST_KEYS, ...BOOL_KEYS]);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) throw new Error(`${CONFIG_FILE}: unknown key "${key}"`);
  }
  const config: Config = { ...DEFAULT_CONFIG };
  for (const key of STRING_KEYS) {
    if (obj[key] === undefined) continue;
    if (typeof obj[key] !== "string") throw new Error(`${CONFIG_FILE}: "${key}" must be a string`);
    config[key] = obj[key];
  }
  for (const key of LIST_KEYS) {
    if (obj[key] === undefined) continue;
    const v = obj[key];
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) {
      throw new Error(`${CONFIG_FILE}: "${key}" must be an array of strings`);
    }
    config[key] = v;
  }
  for (const key of BOOL_KEYS) {
    if (obj[key] === undefined) continue;
    if (typeof obj[key] !== "boolean") throw new Error(`${CONFIG_FILE}: "${key}" must be true or false`);
    config[key] = obj[key];
  }
  return config;
}

export function isIgnored(path: string, config: Config): boolean {
  return [...DEFAULT_IGNORE, ...config.ignore].some((glob) => posix.matchesGlob(path, glob));
}

export const STARTER_CONFIG = {
  instructions: "",
  ignore: [],
  guidelines: DEFAULT_CONFIG.guidelines,
  model: DEFAULT_CONFIG.model,
  verifyModel: DEFAULT_CONFIG.verifyModel,
  effort: DEFAULT_CONFIG.effort,
  verify: true,
  nits: false,
};
