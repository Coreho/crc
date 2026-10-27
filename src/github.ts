import { execFile } from "node:child_process";

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  html_url: string;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
}

export interface PullFile {
  filename: string;
  status: string;
  previous_filename?: string;
  /** Absent for binary files and diffs GitHub considers too large. */
  patch?: string;
}

export interface Review {
  id: number;
  body: string | null;
  commit_id: string | null;
  html_url: string;
}

export interface ReviewComment {
  path: string;
  body: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
}

export interface NewReview {
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: ReviewComment[];
}

export class GitHubError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface PrRef {
  repo: string;
  number: number;
}

/** Accepts 12, #12, owner/repo#12, or a github.com pull request URL. */
export function parsePrRef(arg: string, defaultRepo: string | undefined): PrRef {
  const url = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(arg);
  if (url) return { repo: url[1]!, number: Number(url[2]) };
  const full = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(arg);
  if (full) return { repo: full[1]!, number: Number(full[2]) };
  const bare = /^#?(\d+)$/.exec(arg);
  if (bare) {
    if (!defaultRepo) throw new Error(`Can't tell which repository PR ${arg} is in. Pass --repo owner/repo.`);
    return { repo: defaultRepo, number: Number(bare[1]) };
  }
  throw new Error(`"${arg}" is not a pull request number or URL`);
}

/** GITHUB_TOKEN or GH_TOKEN, else the GitHub CLI's login. */
export async function githubToken(): Promise<string> {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  return new Promise((resolve, reject) => {
    execFile("gh", ["auth", "token"], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout.trim()) {
        reject(new Error("No GitHub token. Set GITHUB_TOKEN, or log in with `gh auth login`."));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

type Fetch = typeof fetch;

export class GitHub {
  private readonly token: string;
  private readonly fetchImpl: Fetch;
  private readonly apiUrl: string;

  constructor(token: string, fetchImpl: Fetch = fetch, apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com") {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.apiUrl = apiUrl.replace(/\/$/, "");
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "crc",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      let detail = text;
      try {
        const data = JSON.parse(text) as { message?: string; errors?: unknown };
        detail = [data.message, data.errors ? JSON.stringify(data.errors) : ""].filter(Boolean).join(" ");
      } catch {
        // Not JSON; keep the raw text.
      }
      throw new GitHubError(`GitHub ${method} ${path} failed (${res.status}): ${detail.slice(0, 500)}`, res.status);
    }
    return (await res.json()) as T;
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; ; page++) {
      const items = await this.request<T[]>("GET", `${path}${sep}per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100) return out;
    }
  }

  getPull(repo: string, n: number): Promise<PullRequest> {
    return this.request("GET", `/repos/${repo}/pulls/${n}`);
  }

  listFiles(repo: string, n: number): Promise<PullFile[]> {
    return this.paginate(`/repos/${repo}/pulls/${n}/files`);
  }

  listReviews(repo: string, n: number): Promise<Review[]> {
    return this.paginate(`/repos/${repo}/pulls/${n}/reviews`);
  }

  createReview(repo: string, n: number, review: NewReview): Promise<Review> {
    return this.request("POST", `/repos/${repo}/pulls/${n}/reviews`, review);
  }
}
