import type { ResolvedGithubConfig } from "../config.js";
import { AxiError } from "../errors.js";
import type {
  GithubGateway,
  GithubIssueRecord,
  GithubProjectItemPage,
  GithubProjectItemRecord,
  GithubRelatedIssue,
} from "./github.js";

type JsonObject = Record<string, unknown>;

type FieldKind = "TEXT" | "SINGLE_SELECT" | "DATE";

interface ProjectField {
  id: string;
  name: string;
  kind: FieldKind;
  options: Map<string, string>;
}

interface ProjectSchema {
  projectId: string;
  fields: Map<string, ProjectField>;
}

interface FetchLike {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface GithubApiGatewayOptions {
  config: ResolvedGithubConfig;
  fetch?: FetchLike;
}

export class GithubApiGateway implements GithubGateway {
  private readonly config: ResolvedGithubConfig;
  private readonly fetch: FetchLike;
  private schema?: ProjectSchema;

  constructor(options: GithubApiGatewayOptions) {
    this.config = options.config;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async validateSchema(): Promise<void> {
    await this.projectSchema();
  }

  async listProjectItems(
    cursor?: string,
    query?: string,
  ): Promise<GithubProjectItemPage> {
    const schema = await this.projectSchema();
    const root = this.ownerRoot();
    const data = await this.graphql<JsonObject>(
      `query ProjectItems($owner: String!, $number: Int!, $after: String, $query: String) {
        ${root}(login: $owner) {
          projectV2(number: $number) {
            items(first: 50, after: $after, query: $query) {
              nodes { ${PROJECT_ITEM_FRAGMENT} }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      {
        owner: this.config.projectOwner,
        number: this.config.projectNumber,
        after: cursor ?? null,
        query: query ?? null,
      },
    );
    const owner = objectAt(data, root);
    const project = requiredObject(owner.projectV2, "GitHub project");
    const connection = requiredObject(project.items, "GitHub project items");
    const nodes = arrayAt(connection, "nodes");
    const items: GithubProjectItemRecord[] = [];
    for (const node of nodes) {
      const mapped = await this.mapProjectItem(
        requiredObject(node, "project item"),
        schema,
      );
      if (mapped) items.push(mapped);
    }
    const pageInfo = requiredObject(
      connection.pageInfo,
      "project item page info",
    );
    return {
      items,
      ...(pageInfo.hasNextPage === true
        ? {
            nextCursor: requiredString(
              pageInfo.endCursor,
              "project item cursor",
            ),
          }
        : {}),
    };
  }

  async getProjectItem(id: string): Promise<GithubProjectItemRecord> {
    const schema = await this.projectSchema();
    const data = await this.graphql<JsonObject>(
      `query ProjectItem($id: ID!) {
        node(id: $id) { ... on ProjectV2Item { ${PROJECT_ITEM_FRAGMENT} } }
      }`,
      { id },
    );
    const node = requiredObject(data.node, `GitHub project item ${id}`);
    const mapped = await this.mapProjectItem(node, schema);
    if (!mapped) {
      throw new AxiError(
        `GitHub project item ${id} is not backed by an issue`,
        "CONFLICT",
      );
    }
    return mapped;
  }

  async findIssuesByCreationMarker(
    marker: string,
  ): Promise<GithubIssueRecord[]> {
    const found: GithubIssueRecord[] = [];
    for (let page = 1; page <= this.config.maxPages; page++) {
      const issues = await this.rest<unknown[]>(
        "GET",
        `/repos/${this.config.issueRepository}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
      );
      for (const value of issues) {
        const raw = requiredObject(value, "GitHub issue");
        if (raw.pull_request !== undefined) continue;
        const issue = mapRestIssue(raw, this.config.issueRepository);
        if (issue.body.includes(marker)) found.push(issue);
      }
      if (issues.length < 100) return found;
    }
    throw new AxiError(
      `GitHub issue recovery exceeded the configured ${this.config.maxPages}-page bound`,
      "CONFLICT",
    );
  }

  async createIssue(input: {
    repository: string;
    title: string;
    body: string;
  }): Promise<GithubIssueRecord> {
    const raw = await this.rest<JsonObject>(
      "POST",
      `/repos/${input.repository}/issues`,
      { title: input.title, body: input.body },
    );
    return mapRestIssue(raw, input.repository);
  }

  async getIssueByUrl(url: string): Promise<GithubIssueRecord> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AxiError("Issue URL is invalid", "VALIDATION_ERROR");
    }
    const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(
      parsed.pathname,
    );
    if (parsed.protocol !== "https:" || !match) {
      throw new AxiError(
        "Issue URL must be an HTTPS GitHub issue URL",
        "VALIDATION_ERROR",
      );
    }
    const repository = `${match[1]}/${match[2]}`;
    const raw = await this.rest<JsonObject>(
      "GET",
      `/repos/${repository}/issues/${match[3]}`,
    );
    if (raw.pull_request !== undefined) {
      throw new AxiError(
        "Pull requests cannot be adopted as tasks",
        "VALIDATION_ERROR",
      );
    }
    return mapRestIssue(raw, repository);
  }

  async ensureProjectItem(
    issue: GithubIssueRecord,
  ): Promise<GithubProjectItemRecord> {
    const schema = await this.projectSchema();
    const existing = await this.issueProjectItem(issue.id, schema.projectId);
    if (existing) return this.getProjectItem(existing);
    const data = await this.graphql<JsonObject>(
      `mutation AddProjectItem($project: ID!, $content: ID!) {
        addProjectV2ItemById(input: {projectId: $project, contentId: $content}) {
          item { id }
        }
      }`,
      { project: schema.projectId, content: issue.id },
    );
    const payload = requiredObject(
      data.addProjectV2ItemById,
      "add project item result",
    );
    const item = requiredObject(payload.item, "added project item");
    return this.getProjectItem(
      requiredString(item.id, "added project item id"),
    );
  }

  async updateProjectField(
    itemId: string,
    fieldName: string,
    value: string | null,
  ): Promise<void> {
    const schema = await this.projectSchema();
    const field = schema.fields.get(fieldName);
    if (!field) throw missingField(fieldName);
    if (value === null) {
      await this.graphql(
        `mutation ClearProjectField($project: ID!, $item: ID!, $field: ID!) {
          clearProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field}) {
            projectV2Item { id }
          }
        }`,
        { project: schema.projectId, item: itemId, field: field.id },
      );
      return;
    }

    let encoded: JsonObject;
    if (field.kind === "TEXT") encoded = { text: value };
    else if (field.kind === "DATE") encoded = { date: value };
    else {
      const optionId = field.options.get(value);
      if (!optionId) {
        throw new AxiError(
          `GitHub field "${fieldName}" has no option named "${value}"`,
          "VALIDATION_ERROR",
        );
      }
      encoded = { singleSelectOptionId: optionId };
    }
    await this.graphql(
      `mutation UpdateProjectField($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
        updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field, value: $value}) {
          projectV2Item { id }
        }
      }`,
      {
        project: schema.projectId,
        item: itemId,
        field: field.id,
        value: encoded,
      },
    );
  }

  async updateIssue(
    issue: GithubIssueRecord,
    patch: { title?: string; state?: "OPEN" | "CLOSED" },
  ): Promise<GithubIssueRecord> {
    const body: JsonObject = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.state !== undefined) body.state = patch.state.toLowerCase();
    const raw = await this.rest<JsonObject>(
      "PATCH",
      `/repos/${issue.repository}/issues/${issue.number}`,
      body,
    );
    return mapRestIssue(raw, issue.repository);
  }

  async ensureBlockedBy(issueId: string, blockerId: string): Promise<void> {
    await this.graphql(
      `mutation AddBlockedBy($issue: ID!, $blocker: ID!) {
        addBlockedBy(input: {issueId: $issue, blockingIssueId: $blocker}) { issue { id } }
      }`,
      { issue: issueId, blocker: blockerId },
    );
  }

  async removeBlockedBy(issueId: string, blockerId: string): Promise<void> {
    await this.graphql(
      `mutation RemoveBlockedBy($issue: ID!, $blocker: ID!) {
        removeBlockedBy(input: {issueId: $issue, blockingIssueId: $blocker}) { issue { id } }
      }`,
      { issue: issueId, blocker: blockerId },
    );
  }

  async ensureParent(parentId: string, childId: string): Promise<void> {
    await this.graphql(
      `mutation AddSubIssue($parent: ID!, $child: ID!) {
        addSubIssue(input: {issueId: $parent, subIssueId: $child, replaceParent: false}) { issue { id } }
      }`,
      { parent: parentId, child: childId },
    );
  }

  async removeParent(parentId: string, childId: string): Promise<void> {
    await this.graphql(
      `mutation RemoveSubIssue($parent: ID!, $child: ID!) {
        removeSubIssue(input: {issueId: $parent, subIssueId: $child}) { issue { id } }
      }`,
      { parent: parentId, child: childId },
    );
  }

  async hasIssueComment(
    issue: GithubIssueRecord,
    marker: string,
  ): Promise<boolean> {
    for (let page = 1; page <= this.config.maxPages; page++) {
      const comments = await this.rest<unknown[]>(
        "GET",
        `/repos/${issue.repository}/issues/${issue.number}/comments?per_page=100&page=${page}`,
      );
      if (
        comments.some((value) => {
          const comment = requiredObject(value, "GitHub issue comment");
          return (
            typeof comment.body === "string" && comment.body.includes(marker)
          );
        })
      ) {
        return true;
      }
      if (comments.length < 100) return false;
    }
    throw new AxiError(
      `GitHub comment lookup exceeded the configured ${this.config.maxPages}-page bound`,
      "CONFLICT",
    );
  }

  async addIssueComment(issue: GithubIssueRecord, body: string): Promise<void> {
    await this.rest(
      "POST",
      `/repos/${issue.repository}/issues/${issue.number}/comments`,
      { body },
    );
  }

  private async projectSchema(): Promise<ProjectSchema> {
    if (this.schema) return this.schema;
    const root = this.ownerRoot();
    const fields = new Map<string, ProjectField>();
    let cursor: string | undefined;
    let projectId: string | undefined;
    for (let page = 1; page <= this.config.maxPages; page++) {
      const data = await this.graphql<JsonObject>(
        `query ProjectSchema($owner: String!, $number: Int!, $after: String) {
          ${root}(login: $owner) {
            projectV2(number: $number) {
              id
              fields(first: 100, after: $after) {
                nodes {
                  ... on ProjectV2Field { id name dataType }
                  ... on ProjectV2SingleSelectField { id name dataType options { id name } }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        {
          owner: this.config.projectOwner,
          number: this.config.projectNumber,
          after: cursor ?? null,
        },
      );
      const owner = objectAt(data, root);
      const project = requiredObject(owner.projectV2, "GitHub project");
      projectId ??= requiredString(project.id, "GitHub project id");
      const connection = requiredObject(
        project.fields,
        "GitHub project fields",
      );
      for (const node of arrayAt(connection, "nodes")) {
        if (!node) continue;
        const raw = requiredObject(node, "GitHub project field");
        const name = requiredString(raw.name, "GitHub project field name");
        const kind = requiredString(raw.dataType, `GitHub field ${name} type`);
        if (kind !== "TEXT" && kind !== "SINGLE_SELECT" && kind !== "DATE")
          continue;
        const options = new Map<string, string>();
        if (Array.isArray(raw.options)) {
          for (const optionValue of raw.options) {
            const option = requiredObject(optionValue, "GitHub field option");
            options.set(
              requiredString(option.name, "GitHub field option name"),
              requiredString(option.id, "GitHub field option id"),
            );
          }
        }
        fields.set(name, {
          id: requiredString(raw.id, `GitHub field ${name} id`),
          name,
          kind,
          options,
        });
      }
      const pageInfo = requiredObject(connection.pageInfo, "field page info");
      if (pageInfo.hasNextPage !== true) break;
      cursor = requiredString(pageInfo.endCursor, "field cursor");
      if (page === this.config.maxPages) {
        throw new AxiError(
          `GitHub field discovery exceeded the configured ${this.config.maxPages}-page bound`,
          "CONFLICT",
        );
      }
    }
    if (!projectId)
      throw new AxiError("GitHub project was not found", "NOT_FOUND");
    const schema = { projectId, fields };
    validateRequiredFields(this.config, schema);
    this.schema = schema;
    return schema;
  }

  private async mapProjectItem(
    raw: JsonObject,
    schema: ProjectSchema,
  ): Promise<GithubProjectItemRecord | null> {
    const content = raw.content;
    if (!content || typeof content !== "object") return null;
    const issue = mapGraphqlIssue(content as JsonObject);
    const fields = mapFieldValues(raw.fieldValues, schema);
    const blockedConnection = requiredObject(
      (content as JsonObject).blockedBy,
      "blocked-by connection",
    );
    const blockedBy = arrayAt(blockedConnection, "nodes").map((node) =>
      this.mapRelatedIssue(
        requiredObject(node, "blocking issue"),
        schema.projectId,
      ),
    );
    const pageInfo = requiredObject(
      blockedConnection.pageInfo,
      "blocked-by page info",
    );
    let cursor =
      pageInfo.hasNextPage === true
        ? requiredString(pageInfo.endCursor, "blocked-by cursor")
        : undefined;
    let relationPages = 1;
    while (cursor) {
      if (relationPages >= this.config.maxPages) {
        throw new AxiError(
          `GitHub dependency lookup exceeded the configured ${this.config.maxPages}-page bound`,
          "CONFLICT",
        );
      }
      const page = await this.blockedByPage(issue.id, cursor, schema.projectId);
      blockedBy.push(...page.items);
      cursor = page.nextCursor;
      relationPages++;
    }
    const parentRaw = (content as JsonObject).parent;
    const parent = parentRaw
      ? this.mapRelatedIssue(
          requiredObject(parentRaw, "parent issue"),
          schema.projectId,
        )
      : undefined;
    return {
      id: requiredString(raw.id, "project item id"),
      issue,
      fields,
      blockedBy,
      ...(parent ? { parent } : {}),
    };
  }

  private mapRelatedIssue(
    raw: JsonObject,
    projectId: string,
  ): GithubRelatedIssue {
    const issue = mapGraphqlIssue(raw);
    const projectItems = requiredObject(
      raw.projectItems,
      "related issue project items",
    );
    const nodes = arrayAt(projectItems, "nodes");
    const matching = nodes.find((value) => {
      const item = requiredObject(value, "related project item");
      const project = requiredObject(item.project, "related project");
      return project.id === projectId;
    });
    if (!matching) {
      const pageInfo = requiredObject(
        projectItems.pageInfo,
        "related issue project page info",
      );
      if (pageInfo.hasNextPage === true) {
        throw new AxiError(
          "Related issue belongs to more than 10 projects",
          "CONFLICT",
        );
      }
      return { issue };
    }
    const item = requiredObject(matching, "related project item");
    return {
      issue,
      taskId: mapFieldValues(item.fieldValues, this.schemaOrThrow()).getString(
        this.config.taskIdField,
      ),
    };
  }

  private async blockedByPage(
    issueId: string,
    cursor: string,
    projectId: string,
  ): Promise<{ items: GithubRelatedIssue[]; nextCursor?: string }> {
    const data = await this.graphql<JsonObject>(
      `query BlockedBy($id: ID!, $after: String) {
        node(id: $id) {
          ... on Issue {
            blockedBy(first: 20, after: $after) {
              nodes { ${RELATED_ISSUE_FRAGMENT} }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      { id: issueId, after: cursor },
    );
    const node = requiredObject(data.node, "blocked issue");
    const connection = requiredObject(node.blockedBy, "blocked-by connection");
    const items = arrayAt(connection, "nodes").map((value) =>
      this.mapRelatedIssue(requiredObject(value, "blocking issue"), projectId),
    );
    const pageInfo = requiredObject(
      connection.pageInfo,
      "blocked-by page info",
    );
    return {
      items,
      ...(pageInfo.hasNextPage === true
        ? {
            nextCursor: requiredString(pageInfo.endCursor, "blocked-by cursor"),
          }
        : {}),
    };
  }

  private async issueProjectItem(
    issueId: string,
    projectId: string,
  ): Promise<string | undefined> {
    const data = await this.graphql<JsonObject>(
      `query IssueProjects($id: ID!) {
        node(id: $id) {
          ... on Issue {
            projectItems(first: 100) { nodes { id project { id } } pageInfo { hasNextPage } }
          }
        }
      }`,
      { id: issueId },
    );
    const issue = requiredObject(data.node, "GitHub issue");
    const connection = requiredObject(
      issue.projectItems,
      "issue project items",
    );
    const pageInfo = requiredObject(
      connection.pageInfo,
      "issue project page info",
    );
    if (pageInfo.hasNextPage === true) {
      throw new AxiError("Issue belongs to more than 100 projects", "CONFLICT");
    }
    for (const value of arrayAt(connection, "nodes")) {
      const item = requiredObject(value, "issue project item");
      const project = requiredObject(item.project, "issue project");
      if (project.id === projectId)
        return requiredString(item.id, "project item id");
    }
    return undefined;
  }

  private ownerRoot(): "organization" | "user" {
    return this.config.projectOwnerType;
  }

  private schemaOrThrow(): ProjectSchema {
    if (!this.schema) throw new Error("GitHub project schema is not loaded");
    return this.schema;
  }

  private async graphql<T = JsonObject>(
    query: string,
    variables: JsonObject,
  ): Promise<T> {
    const response = await this.request(this.config.graphqlUrl, {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    });
    const payload = (await response.json()) as {
      data?: T;
      errors?: Array<{ message?: string; type?: string }>;
    };
    if (payload.errors?.length) {
      throw new AxiError(
        `GitHub GraphQL request failed: ${payload.errors
          .map((error) => error.message ?? error.type ?? "unknown error")
          .join("; ")}`,
        "UNKNOWN",
      );
    }
    if (!payload.data) {
      throw new AxiError("GitHub GraphQL response had no data", "UNKNOWN");
    }
    return payload.data;
  }

  private async rest<T = JsonObject>(
    method: string,
    path: string,
    body?: JsonObject,
  ): Promise<T> {
    const response = await this.request(`${this.config.apiUrl}${path}`, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return (await response.json()) as T;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch (error) {
      throw new AxiError(
        `GitHub request failed: ${error instanceof Error ? error.message : String(error)}`,
        "UNKNOWN",
      );
    }
    if (!response.ok) {
      const requestId = response.headers.get("x-github-request-id");
      throw new AxiError(
        `GitHub request failed with HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}`,
        response.status === 404 ? "NOT_FOUND" : "UNKNOWN",
      );
    }
    return response;
  }
}

const FIELD_VALUE_FRAGMENT = `
  ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } }
  ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
  ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { name } } }
`;

const RELATED_ISSUE_FRAGMENT = `
  id number title body state url createdAt updatedAt closedAt repository { nameWithOwner }
  projectItems(first: 10) {
    nodes { project { id } fieldValues(first: 20) { nodes { ${FIELD_VALUE_FRAGMENT} } pageInfo { hasNextPage } } }
    pageInfo { hasNextPage }
  }
`;

const PROJECT_ITEM_FRAGMENT = `
  id
  fieldValues(first: 50) { nodes { ${FIELD_VALUE_FRAGMENT} } pageInfo { hasNextPage } }
  content {
    ... on Issue {
      id number title body state url createdAt updatedAt closedAt repository { nameWithOwner }
      blockedBy(first: 20) {
        nodes { ${RELATED_ISSUE_FRAGMENT} }
        pageInfo { hasNextPage endCursor }
      }
      parent { ${RELATED_ISSUE_FRAGMENT} }
    }
  }
`;

function mapFieldValues(
  value: unknown,
  schema: ProjectSchema,
): Record<string, string | null> & {
  getString(name: string): string | undefined;
} {
  const connection = requiredObject(value, "project field values");
  const pageInfo = requiredObject(connection.pageInfo, "field value page info");
  if (pageInfo.hasNextPage === true) {
    throw new AxiError(
      "Project item has more than 100 field values",
      "CONFLICT",
    );
  }
  const fields: Record<string, string | null> = {};
  for (const node of arrayAt(connection, "nodes")) {
    if (!node) continue;
    const raw = requiredObject(node, "project field value");
    if (!raw.field || typeof raw.field !== "object") continue;
    const field = raw.field as JsonObject;
    const name = requiredString(field.name, "project field value name");
    if (!schema.fields.has(name)) continue;
    const fieldValue = raw.text ?? raw.name ?? raw.date ?? null;
    fields[name] = typeof fieldValue === "string" ? fieldValue : null;
  }
  return Object.assign(fields, {
    getString(name: string): string | undefined {
      return fields[name] ?? undefined;
    },
  });
}

function validateRequiredFields(
  config: ResolvedGithubConfig,
  schema: ProjectSchema,
): void {
  const expected = new Map<string, FieldKind[]>([
    [config.taskIdField, ["TEXT"]],
    [config.statusField, ["SINGLE_SELECT"]],
    [config.ownerField, ["TEXT"]],
    [config.kindField, ["TEXT", "SINGLE_SELECT"]],
    [config.priorityField, ["SINGLE_SELECT"]],
    [config.targetRepositoryField, ["TEXT"]],
    [config.waitKindField, ["SINGLE_SELECT"]],
    [config.waitReasonField, ["TEXT"]],
    [config.waitUntilField, ["DATE"]],
    [config.linksField, ["TEXT"]],
    [config.dependenciesField, ["TEXT"]],
    [config.closedField, ["DATE"]],
  ]);
  for (const [name, kinds] of expected) {
    const field = schema.fields.get(name);
    if (!field) throw missingField(name);
    if (!kinds.includes(field.kind)) {
      throw new AxiError(
        `GitHub field "${name}" has type ${field.kind}; expected ${kinds.join(" or ")}`,
        "VALIDATION_ERROR",
      );
    }
  }
  requireFieldOptions(schema, config.statusField, [
    "Inbox",
    "Backlog",
    "Ready",
    "Blocked",
    "Awaiting captain",
    "In progress",
    "Awaiting landing",
    "Done",
    "Cancelled",
  ]);
  requireFieldOptions(schema, config.priorityField, [
    "P0",
    "P1",
    "P2",
    "P3",
    "P4",
  ]);
  requireFieldOptions(schema, config.waitKindField, [
    "captain",
    "external",
    "load",
    "parked",
    "future",
  ]);
}

function requireFieldOptions(
  schema: ProjectSchema,
  fieldName: string,
  names: string[],
): void {
  const field = schema.fields.get(fieldName);
  for (const name of names) {
    if (!field?.options.has(name)) {
      throw new AxiError(
        `GitHub field "${fieldName}" has no option named "${name}"`,
        "VALIDATION_ERROR",
      );
    }
  }
}

function missingField(name: string): AxiError {
  return new AxiError(
    `GitHub project is missing required field "${name}"`,
    "VALIDATION_ERROR",
  );
}

function mapGraphqlIssue(raw: JsonObject): GithubIssueRecord {
  const repository = requiredObject(raw.repository, "GitHub issue repository");
  return {
    id: requiredString(raw.id, "GitHub issue id"),
    number: requiredNumber(raw.number, "GitHub issue number"),
    repository: requiredString(
      repository.nameWithOwner,
      "GitHub issue repository",
    ),
    url: requiredString(raw.url, "GitHub issue url"),
    title: requiredString(raw.title, "GitHub issue title"),
    body: typeof raw.body === "string" ? raw.body : "",
    state: raw.state === "CLOSED" ? "CLOSED" : "OPEN",
    createdAt: requiredString(raw.createdAt, "GitHub issue createdAt"),
    updatedAt: requiredString(raw.updatedAt, "GitHub issue updatedAt"),
    ...(typeof raw.closedAt === "string" ? { closedAt: raw.closedAt } : {}),
  };
}

function mapRestIssue(raw: JsonObject, repository: string): GithubIssueRecord {
  return {
    id: requiredString(raw.node_id, "GitHub issue node id"),
    number: requiredNumber(raw.number, "GitHub issue number"),
    repository,
    url: requiredString(raw.html_url, "GitHub issue url"),
    title: requiredString(raw.title, "GitHub issue title"),
    body: typeof raw.body === "string" ? raw.body : "",
    state: raw.state === "closed" ? "CLOSED" : "OPEN",
    createdAt: requiredString(raw.created_at, "GitHub issue created_at"),
    updatedAt: requiredString(raw.updated_at, "GitHub issue updated_at"),
    ...(typeof raw.closed_at === "string" ? { closedAt: raw.closed_at } : {}),
  };
}

function objectAt(value: JsonObject, key: string): JsonObject {
  return requiredObject(value[key], key);
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AxiError(`${label} was not returned by GitHub`, "NOT_FOUND");
  }
  return value as JsonObject;
}

function arrayAt(value: JsonObject, key: string): unknown[] {
  const result = value[key];
  if (!Array.isArray(result)) {
    throw new AxiError(
      `${key} was not an array in the GitHub response`,
      "UNKNOWN",
    );
  }
  return result;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new AxiError(`${label} was not returned by GitHub`, "UNKNOWN");
  }
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new AxiError(`${label} was not returned by GitHub`, "UNKNOWN");
  }
  return value;
}
