import { encode } from "@toon-format/toon";
import { requirePositionals, takeBoolFlag } from "../args.js";
import { renderJson } from "../confirm.js";
import { requireCtx, type TasksContext } from "../context.js";

export const CAPABILITIES_HELP = `usage: tasks-axi capabilities [--json]
Report the active backend and its supported operations.`;

export async function capabilitiesCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  requirePositionals(args, 0, 0, CAPABILITIES_HELP.split("\n")[0]);
  const capabilities = store.capabilities();
  return json
    ? renderJson({ ok: true, action: "capabilities", capabilities })
    : encode({ capabilities });
}
