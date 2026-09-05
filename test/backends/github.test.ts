import { describe, expect, it } from "vitest";
import type { ResolvedGithubConfig } from "../../src/config.js";
import {
  GithubStore,
  type GithubGateway,
  type GithubIssueRecord,
  type GithubProjectItemPage,
  type GithubProjectItemRecord,
} from "../../src/backends/github.js";

const config: ResolvedGithubConfig = {
  issueRepository: "example/fleet",
  projectOwner: "example",
  projectOwnerType: "organization",
  projectNumber: 12,
  token: "test-token",
  apiUrl: "https://api.github.test",
  graphqlUrl: "https://api.github.test/graphql",
  taskIdField: "Task ID",
  statusField: "Fleet status",
  ownerField: "Owning home",
  kindField: "Task kind",
  priorityField: "Priority",
  targetRepositoryField: "Target repository",
  waitKindField: "Wait kind",
  waitReasonField: "Wait reason",
  waitUntilField: "Wait until",
  linksField: "Task links",
  dependenciesField: "Task dependencies",
  closedField: "Fleet closed",
  requestTimeoutMs: 10_000,
  snapshotTimeoutMs: 30_000,
  maxPages: 100,
};

class FakeGateway implements GithubGateway {
  readonly items: GithubProjectItemRecord[] = [];
  readonly comments = new Map<string, string[]>();
  readonly queries: Array<string | undefined> = [];
  mutations = 0;
  pageSize = 100;
  failCreateAfterCommit = false;
  failFieldOnce?: { itemId?: string; field: string };
  private nextIssue = 1;

  async validateSchema(): Promise<void> {}

  async listProjectItems(
    cursor?: string,
    query?: string,
  ): Promise<GithubProjectItemPage> {
    this.queries.push(query);
    let matched = this.items;
    if (query?.includes(':"')) {
      const fields = new Map([
        ["owning-home", config.ownerField],
        ["target-repository", config.targetRepositoryField],
        ["task-kind", config.kindField],
      ]);
      for (const match of query.matchAll(/([a-z-]+):"([^"]*)"/g)) {
        const field = fields.get(match[1]);
        if (field) {
          matched = matched.filter((item) => item.fields[field] === match[2]);
        }
      }
    } else if (query) {
      const requested = query.slice(query.indexOf(":") + 1).toLowerCase();
      matched = matched.filter(
        (item) => item.fields[config.taskIdField]?.toLowerCase() === requested,
      );
    }
    const offset = cursor ? Number(cursor) : 0;
    const items = matched.slice(offset, offset + this.pageSize);
    const next = offset + items.length;
    return {
      items,
      ...(next < matched.length ? { nextCursor: String(next) } : {}),
    };
  }

  async getProjectItem(id: string): Promise<GithubProjectItemRecord> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`missing item ${id}`);
    return item;
  }

  async findIssuesByCreationMarker(
    marker: string,
  ): Promise<GithubIssueRecord[]> {
    return this.items
      .map((item) => item.issue)
      .filter((issue) => issue.body.includes(marker));
  }

  async createIssue(input: {
    repository: string;
    title: string;
    body: string;
  }): Promise<GithubIssueRecord> {
    this.mutations++;
    const issue = issueRecord(
      this.nextIssue++,
      input.repository,
      input.title,
      input.body,
    );
    const pending: GithubProjectItemRecord = {
      id: `pending-${issue.id}`,
      issue,
      fields: {},
      blockedBy: [],
    };
    this.items.push(pending);
    if (this.failCreateAfterCommit) {
      this.failCreateAfterCommit = false;
      throw new Error("lost create response");
    }
    return issue;
  }

  async ensureProjectItem(
    issue: GithubIssueRecord,
  ): Promise<GithubProjectItemRecord> {
    const item = this.items.find(
      (candidate) => candidate.issue.id === issue.id,
    );
    if (!item) throw new Error("issue missing");
    return item;
  }

  async updateProjectField(
    itemId: string,
    fieldName: string,
    value: string | null,
  ): Promise<void> {
    this.mutations++;
    if (
      this.failFieldOnce?.field === fieldName &&
      (!this.failFieldOnce.itemId || this.failFieldOnce.itemId === itemId)
    ) {
      delete this.failFieldOnce;
      throw new Error("injected field failure");
    }
    const item = await this.getProjectItem(itemId);
    item.fields[fieldName] = value;
  }

  async updateIssue(
    issue: GithubIssueRecord,
    patch: { title?: string; state?: "OPEN" | "CLOSED" },
  ): Promise<GithubIssueRecord> {
    this.mutations++;
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.state !== undefined) issue.state = patch.state;
    if (patch.state === "CLOSED") issue.closedAt = "2026-09-05T12:00:00Z";
    if (patch.state === "OPEN") delete issue.closedAt;
    issue.updatedAt = "2026-09-05T12:00:00Z";
    return issue;
  }

  async ensureBlockedBy(issueId: string, blockerId: string): Promise<void> {
    this.mutations++;
    const item = this.byIssue(issueId);
    const blocker = this.byIssue(blockerId);
    if (!item.blockedBy.some((related) => related.issue.id === blockerId)) {
      item.blockedBy.push({
        issue: blocker.issue,
        taskId: blocker.fields[config.taskIdField] ?? undefined,
      });
    }
  }

  async removeBlockedBy(issueId: string, blockerId: string): Promise<void> {
    this.mutations++;
    const item = this.byIssue(issueId);
    item.blockedBy = item.blockedBy.filter(
      (related) => related.issue.id !== blockerId,
    );
  }

  async ensureParent(parentId: string, childId: string): Promise<void> {
    this.mutations++;
    const parent = this.byIssue(parentId);
    const child = this.byIssue(childId);
    child.parent = {
      issue: parent.issue,
      taskId: parent.fields[config.taskIdField] ?? undefined,
    };
  }

  async removeParent(parentId: string, childId: string): Promise<void> {
    this.mutations++;
    const child = this.byIssue(childId);
    if (child.parent?.issue.id === parentId) delete child.parent;
  }

  async hasIssueComment(
    issue: GithubIssueRecord,
    marker: string,
  ): Promise<boolean> {
    return (this.comments.get(issue.id) ?? []).some((body) =>
      body.includes(marker),
    );
  }

  async addIssueComment(issue: GithubIssueRecord, body: string): Promise<void> {
    this.mutations++;
    this.comments.set(issue.id, [...(this.comments.get(issue.id) ?? []), body]);
  }

  seed(
    id: string,
    status = "Ready",
    repository = config.issueRepository,
  ): GithubProjectItemRecord {
    const issue = issueRecord(
      this.nextIssue++,
      repository,
      id,
      `body for ${id}`,
    );
    const item: GithubProjectItemRecord = {
      id: `item-${issue.id}`,
      issue,
      fields: {
        [config.taskIdField]: id,
        [config.statusField]: status,
      },
      blockedBy: [],
    };
    this.items.push(item);
    return item;
  }

  private byIssue(id: string): GithubProjectItemRecord {
    const item = this.items.find((candidate) => candidate.issue.id === id);
    if (!item) throw new Error(`missing issue ${id}`);
    return item;
  }
}

function issueRecord(
  number: number,
  repository: string,
  title: string,
  body: string,
): GithubIssueRecord {
  return {
    id: `issue-${number}`,
    number,
    repository,
    url: `https://github.test/${repository}/issues/${number}`,
    title,
    body,
    state: "OPEN",
    createdAt: "2026-09-05T10:00:00Z",
    updatedAt: "2026-09-05T10:00:00Z",
  };
}

function store(gateway: FakeGateway): GithubStore {
  return new GithubStore({
    config,
    gateway,
    now: () => new Date("2026-09-05T12:00:00Z"),
  });
}

describe("GithubStore", () => {
  it("paginates exhaustively and reports dependency closure", async () => {
    const gateway = new FakeGateway();
    gateway.pageSize = 1;
    const blocker = gateway.seed("blocker-q1", "Ready", "example/product");
    const task = gateway.seed("task-q1");
    task.fields[config.ownerField] = "nobody";
    task.blockedBy.push({ issue: blocker.issue });

    const snapshot = await store(gateway).snapshot({ owner: "nobody" });
    expect(snapshot.complete).toBe(true);
    expect(snapshot.total).toBe(1);
    expect(gateway.queries).toContain('owning-home:"nobody"');
    expect(snapshot.dependencyClosure).toMatchObject([
      { id: "github-example-product-1", state: "queued" },
    ]);
  });

  it("keeps an out-of-scope internal blocker in narrowed dependency closure", async () => {
    const gateway = new FakeGateway();
    const blocker = gateway.seed("other-blocker-q1");
    blocker.fields[config.ownerField] = "other-home";
    const task = gateway.seed("owned-task-q1");
    task.fields[config.ownerField] = "selected-home";
    task.blockedBy.push({ issue: blocker.issue, taskId: "other-blocker-q1" });

    const snapshot = await store(gateway).snapshot({ owner: "selected-home" });
    expect(snapshot.items.map((item) => item.id)).toEqual(["owned-task-q1"]);
    expect(snapshot.dependencyClosure).toMatchObject([
      { id: "other-blocker-q1", state: "queued" },
    ]);
  });

  it("uses exact case-sensitive comparison after server narrowing", async () => {
    const gateway = new FakeGateway();
    gateway.seed("fm-0007");
    gateway.seed("FM-0007");
    gateway.seed("fm-00071");
    expect((await store(gateway).get("fm-0007"))?.id).toBe("fm-0007");
  });

  it("reports every exact duplicate URL", async () => {
    const gateway = new FakeGateway();
    gateway.seed("duplicate-q1");
    gateway.seed("duplicate-q1");
    await expect(store(gateway).get("duplicate-q1")).rejects.toMatchObject({
      code: "CONFLICT",
      suggestions: expect.arrayContaining([
        "https://github.test/example/fleet/issues/1",
        "https://github.test/example/fleet/issues/2",
      ]),
    });
  });

  it("recovers a lost create response and converges one item", async () => {
    const gateway = new FakeGateway();
    gateway.failCreateAfterCommit = true;
    const task = await store(gateway).create({
      id: "created-q1",
      title: "created work",
      owner: "secondmate-a",
      repo: "product",
      priority: 1,
    });
    expect(task).toMatchObject({
      id: "created-q1",
      owner: "secondmate-a",
      repo: "product",
      priority: 1,
    });
    expect(gateway.items).toHaveLength(1);
  });

  it("replays a partially configured create without duplicating its issue", async () => {
    const gateway = new FakeGateway();
    gateway.failFieldOnce = { field: config.ownerField };
    const backend = store(gateway);
    const input = {
      id: "replay-q1",
      title: "replay create",
      owner: "destination-home",
      priority: 2 as const,
    };
    await expect(backend.create(input)).rejects.toThrow(
      "injected field failure",
    );
    const replayed = await backend.create(input);
    expect(replayed).toMatchObject({
      id: "replay-q1",
      owner: "destination-home",
      priority: 2,
    });
    expect(gateway.items).toHaveLength(1);
  });

  it("repairs a partial terminal transition on retry", async () => {
    const gateway = new FakeGateway();
    const item = gateway.seed("transition-q1");
    gateway.failFieldOnce = {
      itemId: item.id,
      field: config.statusField,
    };
    const backend = store(gateway);
    await expect(backend.transition("transition-q1", "done")).rejects.toThrow(
      "injected field failure",
    );
    expect(item.issue.state).toBe("CLOSED");
    expect(item.fields[config.closedField]).toBe("2026-09-05");
    expect((await backend.transition("transition-q1", "done")).state).toBe(
      "done",
    );
  });

  it("refuses body replacement and hard removal before mutation", async () => {
    const gateway = new FakeGateway();
    gateway.seed("safe-q1");
    const before = gateway.mutations;
    await expect(
      store(gateway).update("safe-q1", { body: "replacement" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(store(gateway).remove("safe-q1")).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(gateway.mutations).toBe(before);
  });

  it("closes fleet issues but leaves reused product issues open", async () => {
    const gateway = new FakeGateway();
    const fleet = gateway.seed("fleet-q1");
    const product = gateway.seed("product-q1", "Ready", "example/product");
    await store(gateway).transition("fleet-q1", "done");
    await store(gateway).transition("product-q1", "done");
    expect(fleet.issue.state).toBe("CLOSED");
    expect(product.issue.state).toBe("OPEN");
    expect(product.fields[config.statusField]).toBe("Done");
  });

  it("round-trips native blockers and dependency reasons idempotently", async () => {
    const gateway = new FakeGateway();
    gateway.seed("blocker-q1");
    gateway.seed("task-q1");
    const backend = store(gateway);
    expect(
      await backend.addDep("task-q1", {
        type: "blocked-by",
        id: "blocker-q1",
        reason: "wait for blocker",
      }),
    ).toBe(true);
    expect(
      await backend.addDep("task-q1", {
        type: "blocked-by",
        id: "blocker-q1",
        reason: "wait for blocker",
      }),
    ).toBe(false);
    expect((await backend.get("task-q1"))?.deps).toEqual([
      {
        type: "blocked-by",
        id: "blocker-q1",
        reason: "wait for blocker",
      },
    ]);
  });

  it("records notes once as idempotently marked comments", async () => {
    const gateway = new FakeGateway();
    const item = gateway.seed("note-q1");
    const backend = store(gateway);
    await backend.update("note-q1", { addBodyLines: ["operator note"] });
    await backend.update("note-q1", { addBodyLines: ["operator note"] });
    expect(gateway.comments.get(item.issue.id)).toHaveLength(1);
  });

  it("retains cancellation as a distinct terminal outcome", async () => {
    const gateway = new FakeGateway();
    const item = gateway.seed("cancel-q1");
    const cancelled = await store(gateway).cancel(
      "cancel-q1",
      "no longer required",
    );
    expect(cancelled).toMatchObject({
      id: "cancel-q1",
      state: "done",
      outcome: "cancelled",
      closed: "2026-09-05",
    });
    expect(item.issue.state).toBe("CLOSED");
    expect(gateway.comments.get(item.issue.id)).toHaveLength(1);
  });

  it("transfers ownership replayably after preflighting the whole batch", async () => {
    const gateway = new FakeGateway();
    const first = gateway.seed("first-q1");
    const second = gateway.seed("second-q1");
    first.fields[config.ownerField] = "source-home";
    second.fields[config.ownerField] = "source-home";
    const backend = store(gateway);
    gateway.failFieldOnce = {
      itemId: second.id,
      field: config.ownerField,
    };
    await expect(
      backend.transferOwnership(
        ["first-q1", "second-q1"],
        "source-home",
        "destination-home",
      ),
    ).rejects.toThrow("injected field failure");
    const transferred = await backend.transferOwnership(
      ["first-q1", "second-q1"],
      "source-home",
      "destination-home",
    );
    expect(transferred.map((task) => task.owner)).toEqual([
      "destination-home",
      "destination-home",
    ]);
    const writes = gateway.mutations;
    await backend.transferOwnership(
      ["first-q1", "second-q1"],
      "source-home",
      "destination-home",
    );
    expect(gateway.mutations).toBe(writes);
  });

  it("truthfully refuses unsupported public follow-ups", async () => {
    const gateway = new FakeGateway();
    const capabilities = store(gateway).capabilities();
    expect(capabilities).toMatchObject({
      backend: "github",
      bodyReplace: false,
      cancellation: true,
      hardRemove: false,
      collectionTransfer: false,
      publicFollowups: false,
      structuredSnapshot: true,
    });
  });
});
