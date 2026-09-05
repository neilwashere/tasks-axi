import {
  requireId,
  requireNonEmptySingleLineFlagValue,
  requireNoUnknownFlags,
  takeBoolFlag,
  takeFlag,
} from "../args.js";
import { renderMutation, taskToJson } from "../confirm.js";
import { requireCtx, type TasksContext } from "../context.js";
import { AxiError } from "../errors.js";

export const OWNER_TRANSFER_HELP = `usage: tasks-axi owner-transfer <id> [<id>...] --from <owner> --to <owner>
Replayably assign one or more tasks to another operational owner.
flags:
  --json   print the transferred tasks as JSON`;

export async function ownerTransferCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const from = requireNonEmptySingleLineFlagValue(
    "--from",
    takeFlag(args, "--from"),
  );
  const to = requireNonEmptySingleLineFlagValue("--to", takeFlag(args, "--to"));
  if (!from || !to) {
    throw new AxiError("--from and --to are required", "VALIDATION_ERROR", [
      OWNER_TRANSFER_HELP.split("\n")[0],
    ]);
  }
  requireNoUnknownFlags(args);
  const ids = [...new Set(args.map((value) => requireId(value, "id")))];
  if (ids.length === 0) {
    throw new AxiError("Expected at least one task id", "VALIDATION_ERROR");
  }
  const capabilities = store.capabilities();
  if (!capabilities.ownershipTransfer || !store.transferOwnership) {
    throw new AxiError(
      `The "${capabilities.backend}" backend does not support ownershipTransfer`,
      "UNSUPPORTED",
    );
  }
  const tasks = await store.transferOwnership(ids, from, to);
  return renderMutation({
    json,
    confirm: `owner-transfer ${ids.join(" ")} ${from} -> ${to}`,
    jsonPayload: {
      ok: true,
      action: "owner-transfer",
      from,
      to,
      tasks: tasks.map((task) => taskToJson(task)),
    },
    suggestions: [],
  });
}
