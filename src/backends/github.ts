import { createHash } from "node:crypto";
import type { ResolvedGithubConfig } from "../config.js";
import { AxiError, unsupported } from "../errors.js";
import type {
  Dep,
  Hold,
  State,
  Task,
  TaskInput,
  TaskLink,
  TaskPatch,
  TaskQuery,
  TaskUpdateChange,
  TaskUpdateResult,
  TransitionOpts,
} from "../model.js";
import type { PublicFollowupMutation } from "../public-followup.js";
import type {
  AdoptionCandidate,
  AdoptionInput,
  Capabilities,
  Store,
  TaskSnapshot,
} from "../store.js";

export interface GithubIssueRecord {
  id: string;
  number: number;
  repository: string;
  url: string;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface GithubRelatedIssue {
  issue: GithubIssueRecord;
  taskId?: string;
}

export interface GithubProjectItemRecord {
  id: string;
  issue: GithubIssueRecord;
  fields: Record<string, string | null>;
  blockedBy: GithubRelatedIssue[];
  parent?: GithubRelatedIssue;
}

export interface GithubProjectItemPage {
  items: GithubProjectItemRecord[];
  nextCursor?: string;
}

export interface GithubGateway {
  validateSchema(): Promise<void>;
  listProjectItems(
    cursor?: string,
    query?: string,
  ): Promise<GithubProjectItemPage>;
  getProjectItem(id: string): Promise<GithubProjectItemRecord>;
  findIssuesByCreationMarker(marker: string): Promise<GithubIssueRecord[]>;
  createIssue(input: {
    repository: string;
    title: string;
    body: string;
  }): Promise<GithubIssueRecord>;
  getIssueByUrl(url: string): Promise<GithubIssueRecord>;
  ensureProjectItem(issue: GithubIssueRecord): Promise<GithubProjectItemRecord>;
  updateProjectField(
    itemId: string,
    fieldName: string,
    value: string | null,
  ): Promise<void>;
  updateIssue(
    issue: GithubIssueRecord,
    patch: { title?: string; state?: "OPEN" | "CLOSED" },
  ): Promise<GithubIssueRecord>;
  ensureBlockedBy(issueId: string, blockerId: string): Promise<void>;
  removeBlockedBy(issueId: string, blockerId: string): Promise<void>;
  ensureParent(parentId: string, childId: string): Promise<void>;
  removeParent(parentId: string, childId: string): Promise<void>;
  hasIssueComment(issue: GithubIssueRecord, marker: string): Promise<boolean>;
  addIssueComment(issue: GithubIssueRecord, body: string): Promise<void>;
}

export interface GithubStoreOptions {
  config: ResolvedGithubConfig;
  gateway: GithubGateway;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

const STATUS_TO_STATE = {
  Inbox: "queued",
  Backlog: "queued",
  Ready: "queued",
  Blocked: "queued",
  "Awaiting captain": "queued",
  "In progress": "in_flight",
  "Awaiting landing": "in_flight",
  Done: "done",
  Cancelled: "done",
} satisfies Record<string, State>;

export class GithubStore implements Store {
  private readonly config: ResolvedGithubConfig;
  private readonly gateway: GithubGateway;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly itemIds = new Map<string, string>();

  constructor(options: GithubStoreOptions) {
    this.config = options.config;
    this.gateway = options.gateway;
    this.now = options.now ?? (() => new Date());
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
  }

  capabilities(): Capabilities {
    return {
      backend: "github",
      deps: true,
      prune: false,
      comments: true,
      fullTextSearch: false,
      realtimeSync: true,
      customStates: true,
      serverMintsIds: false,
      bodyReplace: false,
      adoption: true,
      cancellation: true,
      hardRemove: false,
      ownershipTransfer: true,
      structuredSnapshot: true,
      collectionTransfer: false,
      publicFollowups: false,
    };
  }

  async get(id: string): Promise<Task | null> {
    await this.gateway.validateSchema();
    const exact = await this.exactItems(id);
    if (exact.length === 0) return null;
    if (exact.length > 1) throw duplicateTaskId(id, exact);
    return this.taskFromItem(exact[0]).task;
  }

  async list(query: TaskQuery): Promise<{ items: Task[]; total: number }> {
    const snapshot = await this.snapshot(query);
    return { items: snapshot.items, total: snapshot.total };
  }

  async snapshot(query: TaskQuery): Promise<TaskSnapshot> {
    await this.gateway.validateSchema();
    const observedAt = this.now().toISOString();
    const allItems = await this.allProjectItems(this.snapshotQuery(query));
    const tasks: Task[] = [];
    const closure = new Map<string, Task>();
    const ids = new Map<string, GithubProjectItemRecord[]>();

    for (const item of allItems) {
      const id = item.fields[this.config.taskIdField];
      if (!id) continue;
      const grouped = ids.get(id) ?? [];
      grouped.push(item);
      ids.set(id, grouped);
      const mapped = this.taskFromItem(item);
      this.itemIds.set(mapped.task.id, item.id);
      tasks.push(mapped.task);
      for (const related of mapped.closure) closure.set(related.id, related);
    }
    for (const [id, duplicates] of ids) {
      if (duplicates.length > 1) throw duplicateTaskId(id, duplicates);
    }

    let matched = tasks;
    if (query.state)
      matched = matched.filter((task) => task.state === query.state);
    if (query.repo)
      matched = matched.filter((task) => task.repo === query.repo);
    if (query.kind)
      matched = matched.filter((task) => task.kind === query.kind);
    if (query.owner)
      matched = matched.filter((task) => task.owner === query.owner);
    const total = matched.length;
    if (query.limit !== undefined) matched = matched.slice(0, query.limit);

    return {
      items: matched,
      dependencyClosure: [...closure.values()],
      total,
      complete: true,
      observedAt,
      source: "live",
    };
  }

  async create(input: TaskInput): Promise<Task> {
    this.requireSupportedInput(input);
    await this.gateway.validateSchema();
    this.requireCanonicalId(input.id);
    await this.requireDependencies(input.id, input.deps ?? []);

    const marker = creationMarker(input.id);
    const exact = await this.exactItems(input.id);
    if (exact.length > 1) throw duplicateTaskId(input.id, exact);
    let item = exact[0];
    if (item && !item.issue.body.includes(marker)) {
      throw new AxiError(`Task "${input.id}" already exists`, "CONFLICT");
    }

    if (!item) {
      const issues = await this.gateway.findIssuesByCreationMarker(marker);
      if (issues.length > 1) throw duplicateCreation(input.id, issues);
      let issue = issues[0];
      if (!issue) {
        try {
          issue = await this.gateway.createIssue({
            repository: this.config.issueRepository,
            title: input.title,
            body: appendMarker(input.body, marker),
          });
        } catch (error) {
          const recovered = await this.recoverCreatedIssue(input.id, marker);
          if (!recovered) throw error;
          issue = recovered;
        }
      }
      item = await this.gateway.ensureProjectItem(issue);
    }

    this.itemIds.set(input.id, item.id);
    await this.convergeCreate(item, input);
    return this.taskFromItem(await this.gateway.getProjectItem(item.id)).task;
  }

  async update(id: string, patch: TaskPatch): Promise<TaskUpdateResult> {
    if (patch.body !== undefined || patch.archiveBody) {
      throw unsupported("body replacement", "github");
    }
    if (patch.meta !== undefined) {
      throw unsupported("arbitrary metadata replacement", "github");
    }
    const item = await this.requireItem(id);
    const current = this.taskFromItem(item).task;
    const changed: TaskUpdateChange[] = [];

    if (patch.title !== undefined && patch.title !== current.title) {
      await this.gateway.updateIssue(item.issue, { title: patch.title });
      changed.push("title");
    }
    await this.changeTextField(item, changed, {
      field: this.config.targetRepositoryField,
      current: current.repo,
      requested: patch.repo,
      change: "repo",
    });
    await this.changeTextField(item, changed, {
      field: this.config.kindField,
      current: current.kind,
      requested: patch.kind,
      change: "kind",
    });
    await this.changeTextField(item, changed, {
      field: this.config.ownerField,
      current: current.owner,
      requested: patch.owner,
      change: "owner",
    });

    if (patch.priority !== undefined && patch.priority !== current.priority) {
      await this.setFieldVerified(
        item.id,
        this.config.priorityField,
        `P${patch.priority}`,
      );
      changed.push("priority");
    }
    if (
      patch.hold !== undefined &&
      !sameHold(current.hold, patch.hold ?? undefined)
    ) {
      await this.writeHold(item.id, patch.hold ?? undefined);
      changed.push("hold");
    }
    if (patch.addLinks?.length) {
      const links = mergeLinks(current.links, patch.addLinks);
      if (links.length !== current.links.length) {
        await this.setFieldVerified(
          item.id,
          this.config.linksField,
          JSON.stringify(links),
        );
        changed.push("links");
      }
    }
    for (const line of patch.addBodyLines ?? []) {
      if (line === "") continue;
      const marker = eventMarker("note", line);
      if (!(await this.gateway.hasIssueComment(item.issue, marker))) {
        await this.gateway.addIssueComment(item.issue, `${line}\n\n${marker}`);
        if (!changed.includes("body")) changed.push("body");
      }
    }

    return { task: await this.requireTask(id), changed };
  }

  async remove(id: string): Promise<Task> {
    void id;
    throw unsupported("hard removal", "github");
  }

  async inbox(): Promise<AdoptionCandidate[]> {
    await this.gateway.validateSchema();
    const items = await this.allProjectItems(
      `no:${projectFieldKey(this.config.taskIdField)}`,
    );
    return items
      .filter((item) => !item.fields[this.config.taskIdField])
      .map((item) => ({
        url: item.issue.url,
        title: item.issue.title,
        repository: item.issue.repository,
        number: item.issue.number,
      }));
  }

  async adopt(issueUrl: string, input: AdoptionInput): Promise<Task> {
    this.requireSupportedInput(input);
    await this.gateway.validateSchema();
    this.requireCanonicalId(input.id);
    await this.requireDependencies(input.id, input.deps ?? []);
    const issue = await this.gateway.getIssueByUrl(issueUrl);
    const exact = await this.exactItems(input.id);
    if (exact.length > 1) throw duplicateTaskId(input.id, exact);
    if (exact[0] && exact[0].issue.id !== issue.id) {
      throw new AxiError(`Task "${input.id}" already exists`, "CONFLICT", [
        exact[0].issue.url,
      ]);
    }
    const item = exact[0] ?? (await this.gateway.ensureProjectItem(issue));
    const currentId = item.fields[this.config.taskIdField];
    if (currentId && currentId !== input.id) {
      throw new AxiError(
        `GitHub issue is already adopted as task "${currentId}"`,
        "CONFLICT",
        [item.issue.url],
      );
    }
    this.itemIds.set(input.id, item.id);
    await this.convergeCreate(item, { ...input, title: issue.title });
    return this.taskFromItem(await this.gateway.getProjectItem(item.id)).task;
  }

  async transition(
    id: string,
    to: State,
    opts: TransitionOpts = {},
  ): Promise<Task> {
    const item = await this.requireItem(id);
    const current = this.taskFromItem(item).task;
    if (opts.pr || opts.report) {
      const links: TaskLink[] = [];
      if (opts.pr) links.push({ kind: "pr", url: opts.pr });
      if (opts.report) links.push({ kind: "report", url: opts.report });
      await this.update(id, { addLinks: links });
    }
    if (opts.note) await this.update(id, { addBodyLines: [opts.note] });

    const fleetIssue = item.issue.repository === this.config.issueRepository;
    if (fleetIssue && to === "done" && item.issue.state !== "CLOSED") {
      await this.gateway.updateIssue(item.issue, { state: "CLOSED" });
    }
    if (fleetIssue && to !== "done" && item.issue.state !== "OPEN") {
      await this.gateway.updateIssue(item.issue, { state: "OPEN" });
    }
    if (to === "done") {
      await this.setFieldVerified(
        item.id,
        this.config.closedField,
        opts.date ?? this.now().toISOString().slice(0, 10),
      );
    } else {
      await this.setFieldVerified(item.id, this.config.closedField, null);
    }
    await this.setFieldVerified(
      item.id,
      this.config.statusField,
      statusFor(to, current),
    );
    return this.requireTask(id);
  }

  async addDep(id: string, dep: Dep): Promise<boolean> {
    const item = await this.requireItem(id);
    const target = await this.requireItem(dep.id);
    const current = this.taskFromItem(item).task;
    const existing = current.deps.some(
      (candidate) => candidate.type === dep.type && candidate.id === dep.id,
    );
    const deps = upsertDependency(current.deps, dep);

    if (
      dep.type === "blocked-by" &&
      !item.blockedBy.some((related) => related.issue.id === target.issue.id)
    ) {
      await this.gateway.ensureBlockedBy(item.issue.id, target.issue.id);
    } else if (
      dep.type === "parent" &&
      item.parent?.issue.id !== target.issue.id
    ) {
      await this.gateway.ensureParent(target.issue.id, item.issue.id);
    }
    await this.setFieldVerified(
      item.id,
      this.config.dependenciesField,
      JSON.stringify(deps),
    );
    return !existing;
  }

  async removeDep(id: string, dep: Dep): Promise<boolean> {
    const item = await this.requireItem(id);
    const target = await this.requireItem(dep.id);
    const current = this.taskFromItem(item).task;
    const existing = current.deps.some(
      (candidate) => candidate.type === dep.type && candidate.id === dep.id,
    );
    if (!existing) return false;

    if (
      dep.type === "blocked-by" &&
      item.blockedBy.some((related) => related.issue.id === target.issue.id)
    ) {
      await this.gateway.removeBlockedBy(item.issue.id, target.issue.id);
    } else if (
      dep.type === "parent" &&
      item.parent?.issue.id === target.issue.id
    ) {
      await this.gateway.removeParent(target.issue.id, item.issue.id);
    }
    const deps = current.deps.filter(
      (candidate) => candidate.type !== dep.type || candidate.id !== dep.id,
    );
    await this.setFieldVerified(
      item.id,
      this.config.dependenciesField,
      JSON.stringify(deps),
    );
    return true;
  }

  async cancel(id: string, reason: string): Promise<Task> {
    const item = await this.requireItem(id);
    const marker = eventMarker("cancel", reason);
    if (!(await this.gateway.hasIssueComment(item.issue, marker))) {
      await this.gateway.addIssueComment(
        item.issue,
        `Cancelled: ${reason}\n\n${marker}`,
      );
    }
    if (
      item.issue.repository === this.config.issueRepository &&
      item.issue.state !== "CLOSED"
    ) {
      await this.gateway.updateIssue(item.issue, { state: "CLOSED" });
    }
    await this.setFieldVerified(
      item.id,
      this.config.closedField,
      this.now().toISOString().slice(0, 10),
    );
    await this.setFieldVerified(item.id, this.config.statusField, "Cancelled");
    return this.requireTask(id);
  }

  async transferOwnership(
    ids: string[],
    from: string,
    to: string,
  ): Promise<Task[]> {
    if (from === to) {
      throw new AxiError(
        "Ownership source and destination must differ",
        "VALIDATION_ERROR",
      );
    }
    const planned: Array<{ item: GithubProjectItemRecord; owner?: string }> =
      [];
    for (const id of [...new Set(ids)]) {
      const item = await this.requireItem(id);
      const owner = item.fields[this.config.ownerField] ?? undefined;
      if (owner !== from && owner !== to) {
        throw new AxiError(
          `Task "${id}" is owned by "${owner ?? "unassigned"}", not "${from}" or "${to}"`,
          "CONFLICT",
          [item.issue.url],
        );
      }
      planned.push({ item, owner });
    }
    for (const { item, owner } of planned) {
      if (owner === from) {
        await this.setFieldVerified(item.id, this.config.ownerField, to);
      }
    }
    const transferred: Task[] = [];
    for (const { item } of planned) {
      const current = await this.gateway.getProjectItem(item.id);
      if (current.fields[this.config.ownerField] !== to) {
        throw new AxiError(
          `Task "${current.fields[this.config.taskIdField] ?? item.id}" ownership transfer was not verified`,
          "CONFLICT",
          [current.issue.url],
        );
      }
      transferred.push(this.taskFromItem(current).task);
    }
    return transferred;
  }

  async updatePublicFollowup(
    id: string,
    mutation: PublicFollowupMutation,
  ): Promise<Task> {
    void id;
    void mutation;
    throw unsupported("public follow-ups", "github");
  }

  private async recoverCreatedIssue(
    id: string,
    marker: string,
  ): Promise<GithubIssueRecord | undefined> {
    const deadline = Date.now() + this.config.snapshotTimeoutMs;
    let delay = 250;
    while (true) {
      const issues = await this.gateway.findIssuesByCreationMarker(marker);
      if (issues.length > 1) {
        throw duplicateCreation(id, issues);
      }
      if (issues.length === 1) return issues[0];
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await this.sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, 4_000);
    }
  }

  private snapshotQuery(query: TaskQuery): string | undefined {
    const filters: string[] = [];
    if (query.owner) {
      filters.push(projectFieldQuery(this.config.ownerField, query.owner));
    }
    if (query.repo) {
      filters.push(
        projectFieldQuery(this.config.targetRepositoryField, query.repo),
      );
    }
    if (query.kind) {
      filters.push(projectFieldQuery(this.config.kindField, query.kind));
    }
    return filters.length ? filters.join(" ") : undefined;
  }

  private async allProjectItems(
    query?: string,
  ): Promise<GithubProjectItemRecord[]> {
    const items: GithubProjectItemRecord[] = [];
    const deadline = Date.now() + this.config.snapshotTimeoutMs;
    let cursor: string | undefined;
    for (let page = 1; page <= this.config.maxPages; page++) {
      if (Date.now() >= deadline) {
        throw new AxiError(
          `GitHub project snapshot exceeded ${this.config.snapshotTimeoutMs}ms`,
          "LOCKED",
        );
      }
      const result = await this.gateway.listProjectItems(cursor, query);
      if (Date.now() >= deadline) {
        throw new AxiError(
          `GitHub project snapshot exceeded ${this.config.snapshotTimeoutMs}ms`,
          "LOCKED",
        );
      }
      items.push(...result.items);
      if (!result.nextCursor) return items;
      cursor = result.nextCursor;
    }
    throw new AxiError(
      `GitHub project exceeded the configured ${this.config.maxPages}-page bound`,
      "CONFLICT",
    );
  }

  private async exactItems(id: string): Promise<GithubProjectItemRecord[]> {
    const cached = this.itemIds.get(id);
    if (cached) {
      const item = await this.gateway.getProjectItem(cached);
      if (item.fields[this.config.taskIdField] === id) return [item];
      this.itemIds.delete(id);
    }
    const queryKey = this.config.taskIdField
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const result = await this.gateway.listProjectItems(
      undefined,
      `${queryKey}:${id}`,
    );
    if (result.nextCursor) {
      throw new AxiError(
        `Task ID lookup for "${id}" exceeded one page`,
        "CONFLICT",
      );
    }
    return result.items.filter(
      (item) => item.fields[this.config.taskIdField] === id,
    );
  }

  private taskFromItem(item: GithubProjectItemRecord): {
    task: Task;
    closure: Task[];
  } {
    const id = item.fields[this.config.taskIdField];
    const status = item.fields[this.config.statusField];
    const state = status ? stateForStatus(status) : undefined;
    if (!id || !status || !state) {
      throw new AxiError(
        `GitHub project item ${item.id} is missing a valid task identity or fleet status`,
        "CONFLICT",
        [item.issue.url],
      );
    }
    const storedDeps = parseDeps(item.fields[this.config.dependenciesField]);
    const nativeBlockers = item.blockedBy.map((related) => ({
      type: "blocked-by" as const,
      id: related.taskId ?? externalId(related.issue),
    }));
    const deps = mergeDeps(storedDeps, nativeBlockers);
    if (item.parent) {
      deps.push({
        type: "parent",
        id: item.parent.taskId ?? externalId(item.parent.issue),
      });
    }
    const task: Task = {
      id,
      title: item.issue.title,
      state,
      body: stripCreationMarker(item.issue.body) || undefined,
      links: parseLinks(item.fields[this.config.linksField]),
      deps: dedupeDeps(deps),
      created: item.issue.createdAt.slice(0, 10),
      updated: item.issue.updatedAt,
      meta: {
        github_issue_id: item.issue.id,
        github_issue_url: item.issue.url,
        github_project_item_id: item.id,
      },
    };
    setOptional(task, "repo", item.fields[this.config.targetRepositoryField]);
    setOptional(task, "kind", item.fields[this.config.kindField]);
    setOptional(task, "owner", item.fields[this.config.ownerField]);
    const priority = item.fields[this.config.priorityField];
    if (priority && /^P[0-4]$/.test(priority))
      task.priority = Number(priority[1]);
    const hold = this.holdFromItem(item);
    if (hold) task.hold = hold;
    const closed = item.fields[this.config.closedField] ?? item.issue.closedAt;
    if (task.state === "done" && closed) task.closed = closed.slice(0, 10);
    if (task.state === "done") {
      task.outcome = status === "Cancelled" ? "cancelled" : "delivered";
    }

    const closure = item.blockedBy.map((related) =>
      relatedTask(related.issue, related.taskId),
    );
    if (item.parent) {
      closure.push(relatedTask(item.parent.issue, item.parent.taskId));
    }
    return { task, closure };
  }

  private holdFromItem(item: GithubProjectItemRecord): Hold | undefined {
    const reason = item.fields[this.config.waitReasonField];
    if (!reason) return undefined;
    const kind = item.fields[this.config.waitKindField] as Hold["kind"] | null;
    const until = item.fields[this.config.waitUntilField];
    return {
      reason,
      ...(kind ? { kind } : {}),
      ...(until ? { until } : {}),
    };
  }

  private async requireItem(id: string): Promise<GithubProjectItemRecord> {
    const exact = await this.exactItems(id);
    if (exact.length === 0) {
      throw new AxiError(`Task "${id}" not found in this backlog`, "NOT_FOUND");
    }
    if (exact.length > 1) throw duplicateTaskId(id, exact);
    return exact[0];
  }

  private async requireTask(id: string): Promise<Task> {
    return this.taskFromItem(await this.requireItem(id)).task;
  }

  private async requireDependencies(id: string, deps: Dep[]): Promise<void> {
    for (const dep of deps) {
      if (dep.id === id) {
        throw new AxiError(
          "A task cannot depend on itself",
          "VALIDATION_ERROR",
        );
      }
      await this.requireItem(dep.id);
    }
  }

  private requireCanonicalId(id: string): void {
    if (id !== id.toLowerCase()) {
      throw new AxiError(
        "GitHub task ids must use lowercase characters",
        "VALIDATION_ERROR",
      );
    }
  }

  private requireSupportedInput(input: TaskInput | AdoptionInput): void {
    if (input.public_followup || input.kind === "public-followup") {
      throw unsupported("public follow-ups", "github");
    }
    if (input.meta) throw unsupported("arbitrary metadata", "github");
  }

  private async convergeCreate(
    item: GithubProjectItemRecord,
    input: TaskInput,
  ): Promise<void> {
    await this.setFieldVerified(item.id, this.config.taskIdField, input.id);
    await this.setFieldVerified(
      item.id,
      this.config.kindField,
      input.kind ?? null,
    );
    await this.setFieldVerified(
      item.id,
      this.config.targetRepositoryField,
      input.repo ?? null,
    );
    await this.setFieldVerified(
      item.id,
      this.config.ownerField,
      input.owner ?? null,
    );
    await this.setFieldVerified(
      item.id,
      this.config.priorityField,
      input.priority === undefined ? null : `P${input.priority}`,
    );
    await this.writeHold(item.id, input.hold);
    await this.setFieldVerified(
      item.id,
      this.config.linksField,
      input.links?.length ? JSON.stringify(input.links) : null,
    );
    await this.setFieldVerified(
      item.id,
      this.config.dependenciesField,
      input.deps?.length ? JSON.stringify(input.deps) : null,
    );
    for (const dep of input.deps ?? []) {
      const target = await this.requireItem(dep.id);
      if (dep.type === "blocked-by") {
        await this.gateway.ensureBlockedBy(item.issue.id, target.issue.id);
      } else if (dep.type === "parent") {
        await this.gateway.ensureParent(target.issue.id, item.issue.id);
      }
    }
    const state = input.state ?? "queued";
    if (item.issue.repository === this.config.issueRepository) {
      const desiredIssueState = state === "done" ? "CLOSED" : "OPEN";
      if (item.issue.state !== desiredIssueState) {
        await this.gateway.updateIssue(item.issue, {
          state: desiredIssueState,
        });
      }
    }
    await this.setFieldVerified(
      item.id,
      this.config.closedField,
      state === "done" ? this.now().toISOString().slice(0, 10) : null,
    );
    await this.setFieldVerified(
      item.id,
      this.config.statusField,
      statusFor(state, {
        deps: input.deps ?? [],
        hold: input.hold,
      }),
    );
  }

  private async setFieldVerified(
    itemId: string,
    fieldName: string,
    value: string | null,
  ): Promise<void> {
    const before = await this.gateway.getProjectItem(itemId);
    if ((before.fields[fieldName] ?? null) === value) return;
    await this.gateway.updateProjectField(itemId, fieldName, value);
    const after = await this.gateway.getProjectItem(itemId);
    if ((after.fields[fieldName] ?? null) !== value) {
      throw new AxiError(
        `GitHub field "${fieldName}" did not reach its requested value`,
        "CONFLICT",
        [after.issue.url],
      );
    }
  }

  private async writeHold(
    itemId: string,
    hold: Hold | undefined,
  ): Promise<void> {
    await this.setFieldVerified(
      itemId,
      this.config.waitReasonField,
      hold?.reason ?? null,
    );
    await this.setFieldVerified(
      itemId,
      this.config.waitKindField,
      hold?.kind ?? null,
    );
    await this.setFieldVerified(
      itemId,
      this.config.waitUntilField,
      hold?.until ?? null,
    );
  }

  private async changeTextField(
    item: GithubProjectItemRecord,
    changed: TaskUpdateChange[],
    change: {
      field: string;
      current?: string;
      requested?: string;
      change: TaskUpdateChange;
    },
  ): Promise<void> {
    if (change.requested === undefined || change.requested === change.current) {
      return;
    }
    await this.setFieldVerified(
      item.id,
      change.field,
      change.requested || null,
    );
    changed.push(change.change);
  }
}

function stateForStatus(status: string): State | undefined {
  return (STATUS_TO_STATE as Record<string, State>)[status];
}

function statusFor(state: State, task: Pick<Task, "deps" | "hold">): string {
  if (state === "in_flight") return "In progress";
  if (state === "done") return "Done";
  if (task.deps.some((dep) => dep.type === "blocked-by")) return "Blocked";
  if (task.hold?.kind === "captain") return "Awaiting captain";
  if (task.hold) return "Backlog";
  return "Ready";
}

function creationMarker(id: string): string {
  return `<!-- tasks-axi:create/v1 task-id=${id} -->`;
}

function appendMarker(body: string | undefined, marker: string): string {
  return body ? `${body}\n\n${marker}` : marker;
}

function stripCreationMarker(body: string): string {
  return body
    .replace(/\n?\n?<!-- tasks-axi:create\/v1 task-id=[^\s>]+ -->/g, "")
    .trimEnd();
}

function eventMarker(kind: string, body: string): string {
  const digest = createHash("sha256").update(`${kind}\0${body}`).digest("hex");
  return `<!-- tasks-axi:event/v1 ${kind}=${digest} -->`;
}

function externalId(issue: GithubIssueRecord): string {
  return `github-${issue.repository.replace(/[^A-Za-z0-9]+/g, "-")}-${issue.number}`.toLowerCase();
}

function relatedTask(issue: GithubIssueRecord, taskId?: string): Task {
  return {
    id: taskId ?? externalId(issue),
    title: issue.title,
    state: issue.state === "CLOSED" ? "done" : "queued",
    links: [{ kind: "doc", url: issue.url }],
    deps: [],
    created: issue.createdAt.slice(0, 10),
    ...(issue.closedAt ? { closed: issue.closedAt.slice(0, 10) } : {}),
    meta: { github_issue_id: issue.id, github_issue_url: issue.url },
  };
}

function parseLinks(value: string | null | undefined): TaskLink[] {
  return parseJsonArray<TaskLink>(value, "task links", (link) =>
    Boolean(
      link &&
      typeof link === "object" &&
      "kind" in link &&
      "url" in link &&
      typeof link.kind === "string" &&
      typeof link.url === "string",
    ),
  );
}

function parseDeps(value: string | null | undefined): Dep[] {
  return parseJsonArray<Dep>(value, "task dependencies", (dep) =>
    Boolean(
      dep &&
      typeof dep === "object" &&
      "type" in dep &&
      "id" in dep &&
      typeof dep.type === "string" &&
      typeof dep.id === "string",
    ),
  );
}

function parseJsonArray<T>(
  value: string | null | undefined,
  label: string,
  valid: (item: unknown) => boolean,
): T[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every(valid)) throw new Error();
    return parsed as T[];
  } catch {
    throw new AxiError(`GitHub ${label} field is invalid`, "CONFLICT");
  }
}

function mergeLinks(current: TaskLink[], additions: TaskLink[]): TaskLink[] {
  const seen = new Set(current.map((link) => `${link.kind}\0${link.url}`));
  const merged = current.map((link) => ({ ...link }));
  for (const link of additions) {
    const key = `${link.kind}\0${link.url}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push({ ...link });
    }
  }
  return merged;
}

function upsertDependency(current: Dep[], requested: Dep): Dep[] {
  const key = `${requested.type}\0${requested.id}`;
  const existing = current.find((dep) => `${dep.type}\0${dep.id}` === key);
  if (!existing) return [...current, { ...requested }];
  if (!requested.reason) return current;
  return current.map((dep) =>
    `${dep.type}\0${dep.id}` === key
      ? { ...dep, reason: requested.reason }
      : dep,
  );
}

function mergeDeps(current: Dep[], additions: Dep[]): Dep[] {
  const byKey = new Map(current.map((dep) => [`${dep.type}\0${dep.id}`, dep]));
  for (const dep of additions) {
    const key = `${dep.type}\0${dep.id}`;
    if (!byKey.has(key)) byKey.set(key, dep);
  }
  return [...byKey.values()];
}

function dedupeDeps(deps: Dep[]): Dep[] {
  return mergeDeps([], deps);
}

function sameHold(left: Hold | undefined, right: Hold | undefined): boolean {
  return (
    left?.reason === right?.reason &&
    left?.kind === right?.kind &&
    left?.until === right?.until
  );
}

function setOptional<K extends "repo" | "kind" | "owner">(
  task: Task,
  key: K,
  value: string | null | undefined,
): void {
  if (value) task[key] = value;
}

function projectFieldKey(field: string): string {
  return field
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function projectFieldQuery(field: string, value: string): string {
  const key = projectFieldKey(field);
  const escaped = value.replace(/["\\]/g, "\\$&");
  return `${key}:"${escaped}"`;
}

function duplicateTaskId(
  id: string,
  items: GithubProjectItemRecord[],
): AxiError {
  return new AxiError(
    `Duplicate GitHub Task ID "${id}"`,
    "CONFLICT",
    items.map((item) => item.issue.url),
  );
}

function duplicateCreation(id: string, issues: GithubIssueRecord[]): AxiError {
  return new AxiError(
    `Multiple GitHub issues carry the creation marker for "${id}"`,
    "CONFLICT",
    issues.map((issue) => issue.url),
  );
}
