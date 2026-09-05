import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../src/config.js";
import { createStore } from "../src/context.js";

const githubConfig: ResolvedConfig = {
  backend: "github",
  doneKeep: 0,
  github: {
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
  },
};

describe("createStore", () => {
  it("constructs the configured GitHub backend without making a request", () => {
    expect(createStore(githubConfig).capabilities()).toMatchObject({
      backend: "github",
      cancellation: true,
      ownershipTransfer: true,
      structuredSnapshot: true,
      collectionTransfer: false,
    });
  });
});
