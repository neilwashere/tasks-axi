import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFileSafe } from "./backends/lock.js";
import { AxiError } from "./errors.js";

/**
 * Backend + path resolution (report §8 config selection).
 *
 * Override order:
 *   --backend / --file flag > TASKS_AXI_* env > project .tasks.toml >
 *   ~/.tasks-axi/config.toml > defaults (markdown, first existing
 *   backlog.md/data/backlog.md, otherwise backlog.md).
 *
 * Backend tables are discriminated, and GitHub credentials are accepted only
 * from the process environment.
 */

export type GithubProjectOwnerType = "organization" | "user";

export interface ResolvedGithubConfig {
  issueRepository: string;
  projectOwner: string;
  projectOwnerType: GithubProjectOwnerType;
  projectNumber: number;
  token: string;
  apiUrl: string;
  graphqlUrl: string;
  taskIdField: string;
  statusField: string;
  ownerField: string;
  kindField: string;
  priorityField: string;
  targetRepositoryField: string;
  waitKindField: string;
  waitReasonField: string;
  waitUntilField: string;
  linksField: string;
  dependenciesField: string;
  closedField: string;
  requestTimeoutMs: number;
  snapshotTimeoutMs: number;
  maxPages: number;
}

export interface ResolvedMarkdownConfig {
  backend: "markdown";
  /** Markdown backlog path (resolved to an absolute path). */
  path: string;
  /** Optional archive path for pruned tasks (resolved to an absolute path). */
  archivePath?: string;
  doneKeep: number;
}

export interface ResolvedGithubBackendConfig {
  backend: "github";
  github: ResolvedGithubConfig;
  doneKeep: 0;
}

export type ResolvedConfig =
  | ResolvedMarkdownConfig
  | ResolvedGithubBackendConfig;

export interface ConfigOverrides {
  backend?: string;
  file?: string;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

interface GithubTomlConfig {
  issue_repository?: string;
  project_owner?: string;
  project_owner_type?: string;
  project_number?: number;
  api_url?: string;
  graphql_url?: string;
  task_id_field?: string;
  status_field?: string;
  owner_field?: string;
  kind_field?: string;
  priority_field?: string;
  target_repository_field?: string;
  wait_kind_field?: string;
  wait_reason_field?: string;
  wait_until_field?: string;
  links_field?: string;
  dependencies_field?: string;
  closed_field?: string;
  request_timeout_seconds?: number;
  snapshot_timeout_seconds?: number;
  max_pages?: number;
}

interface TomlConfig {
  backend?: string;
  markdown?: {
    path?: string;
    archive?: string;
    done_keep?: number;
  };
  github?: GithubTomlConfig;
}

const DEFAULT_KEEP = 10;
const PATH_CANDIDATES = ["backlog.md", "data/backlog.md"];
const GITHUB_STRING_KEYS = new Set([
  "issue_repository",
  "project_owner",
  "project_owner_type",
  "api_url",
  "graphql_url",
  "task_id_field",
  "status_field",
  "owner_field",
  "kind_field",
  "priority_field",
  "target_repository_field",
  "wait_kind_field",
  "wait_reason_field",
  "wait_until_field",
  "links_field",
  "dependencies_field",
  "closed_field",
]);
const GITHUB_NUMBER_KEYS = new Set([
  "project_number",
  "request_timeout_seconds",
  "snapshot_timeout_seconds",
  "max_pages",
]);
type ConfigTable = "root" | "markdown" | "github" | "unsupported";

/**
 * Minimal TOML reader for the tiny config surface we need: a top-level
 * `backend` key and a `[markdown]` table with `path` / `archive` / `done_keep`.
 * `archive` points at the file that receives pruned tasks.
 * Intentionally not a general TOML parser.
 */
export function parseConfigToml(src: string): TomlConfig {
  const config: TomlConfig = {};
  let table: ConfigTable = "root";

  for (const rawLine of src.split("\n")) {
    const line = stripTomlComment(rawLine).trim();
    if (line === "") continue;

    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      const name = section[1].trim();
      table =
        name === "markdown"
          ? "markdown"
          : name === "github"
            ? "github"
            : "unsupported";
      continue;
    }

    if (table === "unsupported") continue;

    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!kv) {
      throw new AxiError(
        "Invalid config line: expected `key = value`",
        "VALIDATION_ERROR",
        ["Use `key = value` assignments in .tasks.toml"],
      );
    }
    const key = kv[1];
    const source = configKeySource(table, key);
    if (!source) continue;
    const value = parseTomlValue(kv[2], source);

    if (table === "root") {
      config.backend = requireTomlString(value, source);
      continue;
    }
    if (table === "github") {
      config.github ??= {};
      const github = config.github as unknown as Record<
        string,
        string | number | undefined
      >;
      if (GITHUB_STRING_KEYS.has(key)) {
        github[key] = requireTomlString(value, source);
      } else if (GITHUB_NUMBER_KEYS.has(key)) {
        if (typeof value !== "number") {
          throw new AxiError(
            `${source} must be an integer`,
            "VALIDATION_ERROR",
          );
        }
        github[key] = value;
      }
      continue;
    }

    config.markdown ??= {};
    if (key === "path") config.markdown.path = requireTomlString(value, source);
    if (key === "archive")
      config.markdown.archive = requireTomlString(value, source);
    if (key === "done_keep") {
      if (typeof value !== "number") {
        throw new AxiError(
          "markdown.done_keep must be an integer",
          "VALIDATION_ERROR",
          ["Set `[markdown] done_keep = 10` in .tasks.toml"],
        );
      }
      config.markdown.done_keep = value;
    }
  }

  return config;
}

function stripTomlComment(raw: string): string {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return raw.slice(0, i);
  }
  return raw;
}

function configKeySource(table: ConfigTable, key: string): string | undefined {
  if (table === "root" && key === "backend") return "backend";
  if (
    table === "markdown" &&
    (key === "path" || key === "archive" || key === "done_keep")
  ) {
    return `markdown.${key}`;
  }
  if (
    table === "github" &&
    (GITHUB_STRING_KEYS.has(key) || GITHUB_NUMBER_KEYS.has(key))
  ) {
    return `github.${key}`;
  }
  return undefined;
}

function parseTomlValue(raw: string, source: string): string | number {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    if (!trimmed.endsWith(quote) || trimmed.length === 1) {
      throw new AxiError(
        `${source} has an unterminated quoted value`,
        "VALIDATION_ERROR",
      );
    }
    return trimmed.slice(1, -1);
  }
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  throw new AxiError(`${source} has an invalid value`, "VALIDATION_ERROR");
}

function requireTomlString(value: string | number, source: string): string {
  if (typeof value === "string") return value;
  throw new AxiError(`${source} must be a quoted string`, "VALIDATION_ERROR");
}

function loadToml(path: string): TomlConfig {
  const src = readFileSafe(path);
  return src ? parseConfigToml(src) : {};
}

function resolveMarkdownPath(
  explicit: string | undefined,
  tomlPath: string | undefined,
  cwd: string,
): string {
  const chosen = explicit ?? tomlPath;
  if (chosen) return isAbsolute(chosen) ? chosen : resolve(cwd, chosen);

  for (const candidate of PATH_CANDIDATES) {
    const full = resolve(cwd, candidate);
    if (existsSync(full)) return full;
  }
  return resolve(cwd, PATH_CANDIDATES[0]);
}

function validatePathValue(
  value: string | undefined,
  source: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    throw new AxiError(`${source} must not be empty`, "VALIDATION_ERROR", [
      "Set it to a backlog path or remove the empty override",
    ]);
  }
  return value;
}

function validateDoneKeep(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AxiError(
      "markdown.done_keep must be a non-negative integer",
      "VALIDATION_ERROR",
      ["Set `[markdown] done_keep = 10` in .tasks.toml"],
    );
  }
  return value;
}

function requiredGithubString(
  value: string | undefined,
  source: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new AxiError(`${source} is required`, "VALIDATION_ERROR");
  }
  return trimmed;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  source: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new AxiError(
      `${source} must be a positive integer`,
      "VALIDATION_ERROR",
    );
  }
  return resolved;
}

function githubConfig(
  project: GithubTomlConfig | undefined,
  home: GithubTomlConfig | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedGithubConfig {
  const value = <K extends keyof GithubTomlConfig>(key: K) =>
    project?.[key] ?? home?.[key];
  const issueRepository = requiredGithubString(
    value("issue_repository") as string | undefined,
    "github.issue_repository",
  );
  if (!/^[^/\s]+\/[^/\s]+$/.test(issueRepository)) {
    throw new AxiError(
      "github.issue_repository must be owner/repository",
      "VALIDATION_ERROR",
    );
  }
  const projectOwner = requiredGithubString(
    value("project_owner") as string | undefined,
    "github.project_owner",
  );
  const ownerType = (value("project_owner_type") ?? "organization") as string;
  if (ownerType !== "organization" && ownerType !== "user") {
    throw new AxiError(
      'github.project_owner_type must be "organization" or "user"',
      "VALIDATION_ERROR",
    );
  }
  const token = requiredGithubString(
    env.TASKS_AXI_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN,
    "TASKS_AXI_GITHUB_TOKEN, GITHUB_TOKEN, or GH_TOKEN",
  );
  const requestTimeoutSeconds = positiveInteger(
    value("request_timeout_seconds") as number | undefined,
    10,
    "github.request_timeout_seconds",
  );
  const snapshotTimeoutSeconds = positiveInteger(
    value("snapshot_timeout_seconds") as number | undefined,
    30,
    "github.snapshot_timeout_seconds",
  );

  return {
    issueRepository,
    projectOwner,
    projectOwnerType: ownerType,
    projectNumber: positiveInteger(
      value("project_number") as number | undefined,
      0,
      "github.project_number",
    ),
    token,
    apiUrl: requiredGithubString(
      (value("api_url") as string | undefined) ??
        env.GITHUB_API_URL ??
        "https://api.github.com",
      "github.api_url",
    ).replace(/\/$/, ""),
    graphqlUrl: requiredGithubString(
      (value("graphql_url") as string | undefined) ??
        env.GITHUB_GRAPHQL_URL ??
        "https://api.github.com/graphql",
      "github.graphql_url",
    ),
    taskIdField: requiredGithubString(
      (value("task_id_field") as string | undefined) ?? "Task ID",
      "github.task_id_field",
    ),
    statusField: requiredGithubString(
      (value("status_field") as string | undefined) ?? "Fleet status",
      "github.status_field",
    ),
    ownerField: requiredGithubString(
      (value("owner_field") as string | undefined) ?? "Owning home",
      "github.owner_field",
    ),
    kindField: requiredGithubString(
      (value("kind_field") as string | undefined) ?? "Task kind",
      "github.kind_field",
    ),
    priorityField: requiredGithubString(
      (value("priority_field") as string | undefined) ?? "Priority",
      "github.priority_field",
    ),
    targetRepositoryField: requiredGithubString(
      (value("target_repository_field") as string | undefined) ??
        "Target repository",
      "github.target_repository_field",
    ),
    waitKindField: requiredGithubString(
      (value("wait_kind_field") as string | undefined) ?? "Wait kind",
      "github.wait_kind_field",
    ),
    waitReasonField: requiredGithubString(
      (value("wait_reason_field") as string | undefined) ?? "Wait reason",
      "github.wait_reason_field",
    ),
    waitUntilField: requiredGithubString(
      (value("wait_until_field") as string | undefined) ?? "Wait until",
      "github.wait_until_field",
    ),
    linksField: requiredGithubString(
      (value("links_field") as string | undefined) ?? "Task links",
      "github.links_field",
    ),
    dependenciesField: requiredGithubString(
      (value("dependencies_field") as string | undefined) ??
        "Task dependencies",
      "github.dependencies_field",
    ),
    closedField: requiredGithubString(
      (value("closed_field") as string | undefined) ?? "Fleet closed",
      "github.closed_field",
    ),
    requestTimeoutMs: requestTimeoutSeconds * 1000,
    snapshotTimeoutMs: snapshotTimeoutSeconds * 1000,
    maxPages: positiveInteger(
      value("max_pages") as number | undefined,
      100,
      "github.max_pages",
    ),
  };
}

export function resolveConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  const env = overrides.env ?? process.env;
  const cwd = overrides.cwd ?? process.cwd();
  const home = overrides.home ?? homedir();

  const homeToml = loadToml(join(home, ".tasks-axi", "config.toml"));
  const projectToml = loadToml(resolve(cwd, ".tasks.toml"));

  const backend =
    overrides.backend ??
    env.TASKS_AXI_BACKEND ??
    projectToml.backend ??
    homeToml.backend ??
    "markdown";
  if (backend !== "markdown" && backend !== "github") {
    throw new AxiError(`Unsupported backend "${backend}"`, "UNSUPPORTED", [
      'Set `backend = "markdown"` or `backend = "github"` in .tasks.toml',
    ]);
  }

  const explicitPath =
    overrides.file !== undefined
      ? validatePathValue(overrides.file, "--file")
      : env.TASKS_AXI_FILE !== undefined
        ? validatePathValue(env.TASKS_AXI_FILE, "TASKS_AXI_FILE")
        : undefined;
  if (backend === "github") {
    if (explicitPath !== undefined) {
      throw new AxiError(
        "--file and TASKS_AXI_FILE are available only with the markdown backend",
        "VALIDATION_ERROR",
      );
    }
    return {
      backend,
      github: githubConfig(projectToml.github, homeToml.github, env),
      doneKeep: 0,
    };
  }

  const tomlPath =
    explicitPath !== undefined
      ? undefined
      : projectToml.markdown?.path !== undefined
        ? validatePathValue(projectToml.markdown.path, "markdown.path")
        : validatePathValue(homeToml.markdown?.path, "markdown.path");
  const path = resolveMarkdownPath(explicitPath, tomlPath, cwd);
  const archive =
    projectToml.markdown?.archive !== undefined
      ? validatePathValue(projectToml.markdown.archive, "markdown.archive")
      : validatePathValue(homeToml.markdown?.archive, "markdown.archive");
  const doneKeep = validateDoneKeep(
    projectToml.markdown?.done_keep ??
      homeToml.markdown?.done_keep ??
      DEFAULT_KEEP,
  );
  return {
    backend,
    path,
    doneKeep,
    ...(archive
      ? { archivePath: isAbsolute(archive) ? archive : resolve(cwd, archive) }
      : {}),
  };
}
