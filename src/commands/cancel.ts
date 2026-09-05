import {
  requireId,
  requireNonEmptySingleLineFlagValue,
  requirePositionals,
  takeBoolFlag,
  takeFlag,
} from "../args.js";
import { renderMutation, taskToJson } from "../confirm.js";
import { requireCtx, type TasksContext } from "../context.js";
import { AxiError } from "../errors.js";
import { renderTaskDetail } from "../view.js";

export const CANCEL_HELP = `usage: tasks-axi cancel <id> --reason <text> [--json]
Retain a task as cancelled without claiming that its work was delivered.`;

export async function cancelCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const reason = requireNonEmptySingleLineFlagValue(
    "--reason",
    takeFlag(args, "--reason"),
  );
  if (!reason) {
    throw new AxiError("--reason is required", "VALIDATION_ERROR", [
      CANCEL_HELP.split("\n")[0],
    ]);
  }
  const positionals = requirePositionals(
    args,
    1,
    1,
    CANCEL_HELP.split("\n")[0],
  );
  const id = requireId(positionals[0], "id");
  const capabilities = store.capabilities();
  if (!capabilities.cancellation || !store.cancel) {
    throw new AxiError(
      `The "${capabilities.backend}" backend does not support retained cancellation`,
      "UNSUPPORTED",
    );
  }
  const task = await store.cancel(id, reason);
  return renderMutation({
    json,
    confirm: `cancelled ${id}`,
    jsonPayload: {
      ok: true,
      action: "cancel",
      task: taskToJson(task),
    },
    detail: renderTaskDetail(task, [task], true),
    suggestions: [],
  });
}
