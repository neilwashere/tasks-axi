import { encode } from "@toon-format/toon";
import {
  requireId,
  requireNonEmptySingleLineFlagValue,
  requirePositionals,
  requireSafeTagFlagValue,
  takeAllFlags,
  takeBoolFlag,
  takeFlag,
} from "../args.js";
import { renderJson, renderMutation, taskToJson } from "../confirm.js";
import { requireCtx, type TasksContext } from "../context.js";
import { AxiError } from "../errors.js";
import { pointTaskSet, type AdoptionInput } from "../store.js";
import { renderTaskDetail } from "../view.js";

export const INBOX_HELP = `usage: tasks-axi inbox [--json]
List Project items that have not yet been adopted with a Task ID.`;

export const ADOPT_HELP = `usage: tasks-axi adopt <id> <issue-url> [flags]
Adopt an existing GitHub issue as a task without replacing its title or body.
flags:
  --kind <name>, --repo <name>, --owner <home>, --priority <0-4>
  --blocked-by <id> (repeatable), --start, --json`;

export async function inboxCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  requirePositionals(args, 0, 0, INBOX_HELP.split("\n")[0]);
  const capabilities = store.capabilities();
  if (!capabilities.adoption || !store.inbox) {
    throw adoptionUnsupported(capabilities.backend);
  }
  const items = await store.inbox();
  return json
    ? renderJson({ ok: true, action: "inbox", count: items.length, items })
    : encode({ count: items.length, inbox: items });
}

export async function adoptCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const start = takeBoolFlag(args, "--start");
  const kind = requireSafeTagFlagValue("--kind", takeFlag(args, "--kind"));
  const repo = requireSafeTagFlagValue("--repo", takeFlag(args, "--repo"));
  const owner = requireSafeTagFlagValue("--owner", takeFlag(args, "--owner"));
  const priority = adoptionPriority(takeFlag(args, "--priority"));
  const blockedBy = takeAllFlags(args, "--blocked-by").map((value) =>
    requireId(value, "--blocked-by"),
  );
  const positionals = requirePositionals(args, 2, 2, ADOPT_HELP.split("\n")[0]);
  const id = requireId(positionals[0], "id");
  const issueUrl = requireNonEmptySingleLineFlagValue(
    "issue-url",
    positionals[1],
  );
  if (!issueUrl) {
    throw new AxiError("Issue URL is required", "VALIDATION_ERROR");
  }
  const capabilities = store.capabilities();
  if (!capabilities.adoption || !store.adopt) {
    throw adoptionUnsupported(capabilities.backend);
  }
  const input: AdoptionInput = {
    id,
    state: start ? "in_flight" : "queued",
    deps: blockedBy.map((depId) => ({ type: "blocked-by", id: depId })),
    links: [],
    ...(kind ? { kind } : {}),
    ...(repo ? { repo } : {}),
    ...(owner ? { owner } : {}),
    ...(priority !== undefined ? { priority } : {}),
  };
  const task = await store.adopt(issueUrl, input);
  const all = await pointTaskSet(store, task);
  return renderMutation({
    json,
    confirm: `adopted ${id} <- ${issueUrl}`,
    jsonPayload: {
      ok: true,
      action: "adopt",
      task: taskToJson(task, all),
    },
    detail: renderTaskDetail(task, all, false),
    suggestions: [],
  });
}

function adoptionPriority(
  value: string | undefined,
): 0 | 1 | 2 | 3 | 4 | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-4]$/.test(value)) {
    throw new AxiError(
      "--priority must be 0, 1, 2, 3, or 4",
      "VALIDATION_ERROR",
    );
  }
  return Number(value) as 0 | 1 | 2 | 3 | 4;
}

function adoptionUnsupported(backend: string): AxiError {
  return new AxiError(
    `The "${backend}" backend does not support issue adoption`,
    "UNSUPPORTED",
  );
}
