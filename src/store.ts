import type { PublicFollowupMutation } from "./public-followup.js";
import type {
  Dep,
  State,
  Task,
  TaskInput,
  TaskPatch,
  TaskUpdateResult,
  TaskQuery,
  TransitionOpts,
} from "./model.js";

/**
 * Backend capability descriptor (report §8). Optional capabilities degrade
 * gracefully: the CLI computes a missing capability from the core verbs, or
 * returns a structured error naming the capability — never a raw backend error.
 */
export interface Capabilities {
  /** Backend identifier, e.g. "markdown". */
  backend: string;
  deps: boolean;
  prune: boolean;
  comments: boolean;
  fullTextSearch: boolean;
  realtimeSync: boolean;
  /** Can it represent backend-specific states beyond queued/in_flight/done? */
  customStates: boolean;
  /** Does the server assign its own ids (remote trackers)? */
  serverMintsIds: boolean;
  /** Can it replace human-authored task bodies without losing concurrent edits? */
  bodyReplace: boolean;
  /** Can it retain a task as explicitly cancelled without claiming delivery? */
  cancellation: boolean;
  /** Can it physically erase a task rather than retain a terminal record? */
  hardRemove: boolean;
  /** Can it change execution ownership without moving the task collection? */
  ownershipTransfer: boolean;
  /** Can it return a complete task set plus dependency closure? */
  structuredSnapshot: boolean;
  /** Can it move a connected set of tasks into another collection atomically? */
  collectionTransfer: boolean;
  /** Supports the durable, receipt-gated public-followup state machine. */
  publicFollowups: boolean;
}

export interface PruneOptions {
  state: State;
  keep: number;
  archive: boolean;
}

export interface PruneResult {
  archived: number;
  ids: string[];
}

export interface TaskSnapshot {
  items: Task[];
  dependencyClosure: Task[];
  total: number;
  complete: boolean;
  observedAt: string;
  source: "live" | "cache";
}

export function snapshotTaskSet(snapshot: TaskSnapshot): Task[] {
  const byId = new Map(
    snapshot.dependencyClosure.map((task) => [task.id, task]),
  );
  for (const task of snapshot.items) byId.set(task.id, task);
  return [...byId.values()];
}

export async function pointTaskSet(store: Store, task: Task): Promise<Task[]> {
  const tasks = new Map([[task.id, task]]);
  for (const dep of task.deps) {
    if (dep.type !== "blocked-by" || tasks.has(dep.id)) continue;
    const blocker = await store.get(dep.id);
    if (blocker) tasks.set(blocker.id, blocker);
  }
  return [...tasks.values()];
}

/**
 * The single narrow seam every backend implements (report §8). The CLI layer
 * (arg parsing, TOON rendering, suggestions, help) never knows which backend
 * is active. `ready`/`blocked`/`held` are derived in the CLI from `list`, the
 * dependency graph, structured hold tags, and public-followup state, so every
 * backend gets them for free.
 *
 * The core contract is create/get/update/remove/list/transition/addDep/
 * removeDep/updatePublicFollowup. `transferMany`, `prune` and `render` are
 * optional and capability-gated.
 */
export interface Store {
  capabilities(): Capabilities;

  // CRUD
  create(input: TaskInput): Promise<Task>;
  get(id: string): Promise<Task | null>;
  /** Apply a patch and report which fields actually changed. */
  update(id: string, patch: TaskPatch): Promise<TaskUpdateResult>;
  remove(id: string): Promise<Task>;
  cancel?(id: string, reason: string): Promise<Task>;

  // query
  list(query: TaskQuery): Promise<{ items: Task[]; total: number }>;
  snapshot(query: TaskQuery): Promise<TaskSnapshot>;

  // state + dependencies
  transition(id: string, to: State, opts?: TransitionOpts): Promise<Task>;
  addDep(id: string, dep: Dep): Promise<boolean>;
  removeDep(id: string, dep: Dep): Promise<boolean>;

  /** Atomically replace one typed obligation revision and optionally complete it. */
  updatePublicFollowup(
    id: string,
    mutation: PublicFollowupMutation,
  ): Promise<Task>;

  /**
   * Move a connected set of tasks into `destination` in one transaction, gated
   * on the `collectionTransfer` capability: either every task lands in the
   * destination and leaves this store, or none do. Backends that cannot honour
   * that all-or-nothing guarantee omit it, and the command layer falls back to
   * a single-task copy-then-remove rather than risking a half-applied move.
   */
  transferMany?(ids: string[], destination: Store): Promise<Task[]>;
  transferOwnership?(
    ids: string[],
    from: string,
    to: string,
  ): Promise<Task[]>;

  // maintenance (optional, capability-gated)
  prune?(options: PruneOptions): Promise<PruneResult>;
  /** Normalize the persisted view (markdown: rewrite every item canonically). */
  render?(): Promise<number>;
}
