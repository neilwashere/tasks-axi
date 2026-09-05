import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfigToml, resolveConfig } from "../src/config.js";

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-cfg-"));
  home = mkdtempSync(join(tmpdir(), "tasks-axi-home-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("parseConfigToml", () => {
  it("reads backend and the [markdown] table", () => {
    const cfg = parseConfigToml(
      [
        "# a comment",
        'backend = "markdown"',
        "",
        "[markdown]",
        'path = "data/backlog.md"',
        "done_keep = 15",
        'archive = "data/done-archive.md"',
      ].join("\n"),
    );
    expect(cfg.backend).toBe("markdown");
    expect(cfg.markdown).toEqual({
      path: "data/backlog.md",
      done_keep: 15,
      archive: "data/done-archive.md",
    });
  });

  it("reads the [github] table", () => {
    const cfg = parseConfigToml(
      [
        'backend = "github"',
        "[github]",
        'issue_repository = "example/fleet"',
        'project_owner = "example"',
        'project_owner_type = "organization"',
        "project_number = 12",
        'task_id_field = "Task ID"',
        "max_pages = 25",
      ].join("\n"),
    );
    expect(cfg.github).toMatchObject({
      issue_repository: "example/fleet",
      project_owner: "example",
      project_owner_type: "organization",
      project_number: 12,
      task_id_field: "Task ID",
      max_pages: 25,
    });
  });

  it("ignores unknown keys and tables", () => {
    const cfg = parseConfigToml('[sqlite]\npath = ".tasks.db"\npath: broken\n');
    expect(cfg.markdown).toBeUndefined();
  });

  it("keeps # inside quoted values while stripping trailing comments", () => {
    const cfg = parseConfigToml(
      '[markdown]\npath = "data/back#log.md" # keep the hash\n',
    );
    expect(cfg.markdown?.path).toBe("data/back#log.md");
  });

  it("rejects an unquoted known string value", () => {
    expect(() =>
      parseConfigToml("[markdown]\npath = data/backlog.md\n"),
    ).toThrow(/markdown\.path/);
  });

  it("rejects an unterminated quoted value", () => {
    expect(() =>
      parseConfigToml('[markdown]\npath = "data/backlog.md\n'),
    ).toThrow(/unterminated/);
  });

  it("rejects a non-numeric done_keep value", () => {
    expect(() => parseConfigToml("[markdown]\ndone_keep = many\n")).toThrow(
      /done_keep/,
    );
  });

  it("rejects malformed assignments in the top-level scope", () => {
    expect(() => parseConfigToml('backend: "markdown"\n')).toThrow(
      /key = value/,
    );
  });

  it("rejects malformed assignments in the markdown table", () => {
    expect(() =>
      parseConfigToml('[markdown]\npath: "data/backlog.md"\n'),
    ).toThrow(/key = value/);
    expect(() => parseConfigToml("[markdown]\ndone_keep 5\n")).toThrow(
      /key = value/,
    );
  });
});

describe("resolveConfig", () => {
  it("defaults to the markdown backend and backlog.md", () => {
    const cfg = resolveConfig({ cwd: dir, home, env: {} });
    expect(cfg.backend).toBe("markdown");
    expect(cfg.path).toBe(join(dir, "backlog.md"));
    expect(cfg.doneKeep).toBe(10);
  });

  it("rejects unknown backends during configuration resolution", () => {
    expect(() =>
      resolveConfig({
        backend: "linear",
        cwd: dir,
        home,
        env: {},
      }),
    ).toThrow('Unsupported backend "linear"');
  });

  it("prefers data/backlog.md when it exists and backlog.md does not", () => {
    const data = join(dir, "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "backlog.md"), "# Backlog\n");
    const cfg = resolveConfig({ cwd: dir, home, env: {} });
    expect(cfg.path).toBe(join(data, "backlog.md"));
  });

  it("honors the override order: flag > env > project toml", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      'backend = "markdown"\n[markdown]\npath = "from-toml.md"\n',
    );
    const fromToml = resolveConfig({ cwd: dir, home, env: {} });
    expect(fromToml.path).toBe(join(dir, "from-toml.md"));

    const fromEnv = resolveConfig({
      cwd: dir,
      home,
      env: { TASKS_AXI_FILE: "/abs/from-env.md" },
    });
    expect(fromEnv.path).toBe("/abs/from-env.md");

    const fromFlag = resolveConfig({
      cwd: dir,
      home,
      env: { TASKS_AXI_FILE: "/abs/from-env.md" },
      file: "/abs/from-flag.md",
    });
    expect(fromFlag.path).toBe("/abs/from-flag.md");
  });

  it("does not validate a lower-priority empty toml path", () => {
    writeFileSync(join(dir, ".tasks.toml"), '[markdown]\npath = ""\n');

    const fromEnv = resolveConfig({
      cwd: dir,
      home,
      env: { TASKS_AXI_FILE: "/abs/from-env.md" },
    });
    expect(fromEnv.path).toBe("/abs/from-env.md");

    const fromFlag = resolveConfig({
      cwd: dir,
      home,
      env: { TASKS_AXI_FILE: "/abs/from-env.md" },
      file: "/abs/from-flag.md",
    });
    expect(fromFlag.path).toBe("/abs/from-flag.md");
  });

  it("resolves complete GitHub settings and keeps tokens environment-only", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      [
        'backend = "github"',
        "[github]",
        'issue_repository = "example/fleet"',
        'project_owner = "example"',
        'project_owner_type = "organization"',
        "project_number = 12",
      ].join("\n"),
    );
    const cfg = resolveConfig({
      cwd: dir,
      home,
      env: { TASKS_AXI_GITHUB_TOKEN: "secret-for-test" },
    });
    expect(cfg.github).toMatchObject({
      issueRepository: "example/fleet",
      projectOwner: "example",
      projectOwnerType: "organization",
      projectNumber: 12,
      token: "secret-for-test",
      taskIdField: "Task ID",
      statusField: "Fleet status",
      maxPages: 100,
    });
  });

  it("rejects unsafe GitHub endpoints before network", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      [
        'backend = "github"',
        "[github]",
        'issue_repository = "example/fleet"',
        'project_owner = "example"',
        "project_number = 12",
        'api_url = "http://token@example.test/api?leak=yes"',
      ].join("\n"),
    );
    expect(() =>
      resolveConfig({
        cwd: dir,
        home,
        env: { TASKS_AXI_GITHUB_TOKEN: "secret-for-test" },
      }),
    ).toThrow(/credential-free HTTPS URL/);
  });

  it("rejects incomplete GitHub settings and GitHub --file before network", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      'backend = "github"\n[github]\nproject_owner = "example"\n',
    );
    expect(() =>
      resolveConfig({
        cwd: dir,
        home,
        env: { TASKS_AXI_GITHUB_TOKEN: "secret-for-test" },
      }),
    ).toThrow(/github\.issue_repository/);

    writeFileSync(
      join(dir, ".tasks.toml"),
      [
        'backend = "github"',
        "[github]",
        'issue_repository = "example/fleet"',
        'project_owner = "example"',
        "project_number = 12",
      ].join("\n"),
    );
    expect(() =>
      resolveConfig({
        cwd: dir,
        home,
        file: "backlog.md",
        env: { TASKS_AXI_GITHUB_TOKEN: "secret-for-test" },
      }),
    ).toThrow(/--file.*markdown/);
  });

  it("reads done_keep from the project toml", () => {
    writeFileSync(join(dir, ".tasks.toml"), "[markdown]\ndone_keep = 5\n");
    expect(resolveConfig({ cwd: dir, home, env: {} }).doneKeep).toBe(5);
  });

  it("rejects negative done_keep from toml", () => {
    writeFileSync(join(dir, ".tasks.toml"), "[markdown]\ndone_keep = -1\n");
    expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
      /done_keep/,
    );
  });

  it.each(["", "   "])("rejects an empty TASKS_AXI_FILE value %#", (value) => {
    expect(() =>
      resolveConfig({ cwd: dir, home, env: { TASKS_AXI_FILE: value } }),
    ).toThrow(/TASKS_AXI_FILE/);
  });

  it.each(["", "   "])(
    "rejects an empty markdown path from toml %#",
    (value) => {
      writeFileSync(
        join(dir, ".tasks.toml"),
        `[markdown]\npath = "${value}"\n`,
      );
      expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
        /markdown\.path/,
      );
    },
  );
});
