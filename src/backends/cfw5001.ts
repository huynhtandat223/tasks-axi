import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { AxiError } from "../errors.js";
import type {
  Dep,
  Hold,
  State,
  Task,
  TaskInput,
  TaskPatch,
  TaskQuery,
  TaskUpdateResult,
  TransitionOpts,
} from "../model.js";
import type { PublicFollowupMutation } from "../public-followup.js";
import type { Capabilities, PruneOptions, PruneResult } from "../store.js";
import {
  ApiTransport,
  BACKLOG_COLUMNS,
  NoAnswerError,
  type Row,
  SqliteTransport,
  type Transport,
  type WriteSpec,
  sha16,
} from "./cfw5001-transport.js";
import { atomicWrite, withLock } from "./lock.js";
import {
  type BacklogDoc,
  deriveLinks,
  parseBacklog,
  renderBacklog,
  renderTaskLines,
} from "./markdown-grammar.js";
import {
  type LoadedBacklogDoc,
  MarkdownStore,
  type MarkdownStoreOptions,
} from "./markdown.js";

/**
 * The `cfw5001` backend: the backlog lives in Dev 5001 `fm_task` rows.
 *
 * Every verb rule stays `MarkdownStore`'s own code. Each public method first
 * awaits a prefetch of this home's rows and renders them into a markdown doc
 * (the parent's `loadSource` returns it), runs the parent method (its
 * `persist` only captures the new doc), then awaits a flush that diffs the
 * new doc against the loaded rows, re-reads each changed row, refuses on a
 * change made meanwhile, and writes one `fm_task_event` plus the row PATCH
 * per changed task. The markdown file at `path` is a read-only render.
 */

export interface Cfw5001Settings {
  home: string;
  baseUrl: string;
  tokenFile: string;
  auth: "bearer" | "cookie";
  /** The host's SQLite file for the offline path; absent disables it. */
  db?: string;
}

export interface Cfw5001StoreOptions extends MarkdownStoreOptions {
  cfw: Cfw5001Settings;
  /** Injected transports (tests and proofs). */
  api?: Transport;
  offline?: Transport;
  env?: NodeJS.ProcessEnv;
}

const SECTION: Record<State, string> = {
  in_flight: "In flight",
  queued: "Queued",
  done: "Done",
};
const STATE_OF: Record<string, State> = {
  "In flight": "in_flight",
  Queued: "queued",
  Done: "done",
};
const ORDER: State[] = ["in_flight", "queued", "done"];
const HEADERS: Record<State, string> = {
  in_flight: "## In flight",
  queued: "## Queued",
  done: "## Done",
};
/** `fm_task.kind` keeps the contract enum; other tasks-axi kinds map to `other`. */
const CONTRACT_KINDS = ["ship", "scout", "secondmate", "plan"];
const TITLE_LIMIT = 300;
/** Columns whose change by another writer between prefetch and flush is a conflict. */
const COMPARED = BACKLOG_COLUMNS.filter((c) => c !== "row");

type BacklogSet = Record<string, unknown>;

interface Loaded {
  row: Row;
  set: BacklogSet;
}

interface Change {
  type: "new" | "changed" | "gone";
  id: string;
  set: BacklogSet;
  placeSeq: boolean;
  loaded?: Loaded;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

/** Map one `fm_task` row to a Task (the body comes from `notes` lines). */
export function rowToTask(row: Row): { task: Task; notesLines: string[] } {
  const state = STATE_OF[String(row.section)];
  if (!state) {
    throw new AxiError(
      `task ${row.taskId} has an unknown section ${JSON.stringify(row.section)}`,
      "VALIDATION_ERROR",
    );
  }
  const title = String(row.title ?? "");
  const task: Task = {
    id: row.taskId,
    title,
    state,
    links: deriveLinks(title),
    deps: str(row.backlogDeps)
      ? (JSON.parse(String(row.backlogDeps)) as Dep[])
      : [],
  };
  const kind = str(row.backlogKind);
  if (kind) task.kind = kind;
  const repo = str(row.repo);
  if (repo) task.repo = repo;
  const reason = str(row.backlogHoldReason);
  if (reason) {
    const hold: Hold = { reason };
    const holdKind = str(row.backlogHoldKind);
    if (holdKind) hold.kind = holdKind as Hold["kind"];
    const until = str(row.backlogHoldUntil);
    if (until) hold.until = until;
    task.hold = hold;
  }
  if (typeof row.backlogPriority === "number")
    task.priority = row.backlogPriority;
  const since = str(row.backlogSince);
  if (since) task.created = since;
  const closed = str(row.backlogClosed);
  if (closed) task.closed = closed;
  const pf = str(row.backlogPublicFollowup);
  if (pf) task.public_followup = JSON.parse(pf);
  const notes = typeof row.notes === "string" ? row.notes : "";
  const notesLines = notes === "" ? [] : notes.replace(/\n$/, "").split("\n");
  return { task, notesLines };
}

/** Render rows as a backlog doc: In flight and Done newest first, Queued oldest first. */
export function renderRows(rows: Row[], home: string): string {
  const lines = [
    `# Backlog - generated from Dev 5001 fm_task (home ${home}); change it through bin/fm-tasks-axi.sh`,
    "",
  ];
  const seq = (r: Row) => Number(r.backlogSeq ?? 0);
  for (const state of ORDER) {
    lines.push(HEADERS[state]);
    const own = rows
      .filter((r) => r.section === SECTION[state])
      .sort((a, b) =>
        seq(a) === seq(b)
          ? a.taskId.localeCompare(b.taskId)
          : state === "queued"
            ? seq(a) - seq(b)
            : seq(b) - seq(a),
      );
    for (const row of own) {
      const { task, notesLines } = rowToTask(row);
      lines.push(...renderTaskLines(task), ...notesLines);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The backlog columns of a Task; `row` and `notes` come from its canonical lines. */
export function taskToSet(task: Task, home: string): BacklogSet {
  if (task.title.length > TITLE_LIMIT) {
    throw new AxiError(
      `title is ${task.title.length} characters; fm_task.title holds ${TITLE_LIMIT}`,
      "VALIDATION_ERROR",
    );
  }
  const lines = renderTaskLines(task);
  const header = lines[0].replace(/^- \[[ x]\] /, "");
  const rest = lines
    .slice(1)
    .filter((line) => !line.includes("tasks-axi:public-followup"));
  return {
    section: SECTION[task.state],
    row: header,
    notes: rest.length > 0 ? `${rest.join("\n")}\n` : "",
    title: task.title,
    repo: task.repo ?? null,
    backlogHome: home,
    backlogKind: task.kind ?? null,
    backlogHoldReason: task.hold?.reason ?? null,
    backlogHoldKind: task.hold?.kind ?? null,
    backlogHoldUntil: task.hold?.until ?? null,
    backlogPriority: task.priority ?? null,
    backlogDeps: task.deps.length > 0 ? JSON.stringify(task.deps) : null,
    backlogSince: task.created ?? null,
    backlogClosed: task.closed ?? null,
    backlogPublicFollowup: task.public_followup
      ? JSON.stringify(task.public_followup)
      : null,
  };
}

const norm = (v: unknown) => (v === undefined || v === "" ? null : v);

function sameValues(
  a: BacklogSet,
  b: BacklogSet,
  cols: readonly string[],
): boolean {
  return cols.every((c) => norm(a[c]) === norm(b[c]));
}

/** The set without its placement, for content comparison and idempotency keys. */
const content = (set: BacklogSet): BacklogSet =>
  Object.fromEntries(
    Object.entries(set).filter(
      ([key]) => key !== "backlogSeq" && key !== "row",
    ),
  );

function docTasks(doc: BacklogDoc): Task[] {
  return doc.sections.flatMap((section) =>
    section.entries.flatMap((entry) =>
      entry.kind === "task" ? [entry.task] : [],
    ),
  );
}

export class Cfw5001Store extends MarkdownStore {
  private readonly renderPath: string;
  private readonly cfw: Cfw5001Settings;
  private readonly env: NodeJS.ProcessEnv;
  private transport: Transport;
  private readonly offline: Transport | undefined;
  private cache: string | undefined;
  private loaded = new Map<string, Loaded>();
  private pending = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: Cfw5001StoreOptions) {
    super(options);
    this.renderPath = options.path;
    this.cfw = options.cfw;
    this.env = options.env ?? process.env;
    this.transport =
      options.api ??
      new ApiTransport({
        baseUrl: options.cfw.baseUrl,
        tokenFile: options.cfw.tokenFile,
        auth: options.cfw.auth,
      });
    this.offline =
      options.offline ??
      (options.cfw.db ? new SqliteTransport(options.cfw.db) : undefined);
  }

  override capabilities(): Capabilities {
    return { ...super.capabilities(), backend: "cfw5001" };
  }

  // -------------------------------------------------------------------------
  // The parent's I/O seam
  // -------------------------------------------------------------------------

  protected override loadSource(): string | undefined {
    if (this.cache === undefined) {
      throw new AxiError("cfw5001 store read before its prefetch", "UNKNOWN");
    }
    return this.cache;
  }

  protected override persist(loaded: LoadedBacklogDoc): void {
    if (this.loadSource() !== loaded.source) {
      throw new AxiError(
        "Backlog changed meanwhile; retry the command",
        "CONFLICT",
      );
    }
    this.cache = renderBacklog(loaded.doc);
    this.pending = true;
  }

  // -------------------------------------------------------------------------
  // Prefetch / flush
  // -------------------------------------------------------------------------

  private async fetchRows(): Promise<Row[]> {
    try {
      return await this.transport.listHome(this.cfw.home);
    } catch (error) {
      if (!(error instanceof NoAnswerError)) throw error;
      if (!this.offline) {
        throw new AxiError(
          `Dev 5001 at ${this.cfw.baseUrl} gave no answer; reading the DB needs the owner's permission (set TASKS_AXI_CFW5001_DB=<path> for that run)`,
          "UNKNOWN",
          ["Check that Dev 5001 is running"],
        );
      }
      if (this.cfw.db && !existsSync(this.cfw.db)) throw error;
      // The API gave no answer: this command reads and writes the host DB.
      this.transport = this.offline;
      return this.transport.listHome(this.cfw.home);
    }
  }

  private async prefetch(): Promise<void> {
    const rows = await this.fetchRows();
    this.cache = renderRows(rows, this.cfw.home);
    this.pending = false;
    // The loaded sets come from the parsed render, so an untouched task diffs equal.
    const byId = new Map(rows.map((row) => [row.taskId, row]));
    this.loaded = new Map();
    for (const task of docTasks(parseBacklog(this.cache))) {
      const row = byId.get(task.id);
      if (!row) continue;
      this.loaded.set(task.id, {
        row,
        set: {
          ...taskToSet(task, this.cfw.home),
          backlogSeq: row.backlogSeq ?? null,
        },
      });
    }
  }

  private who(): { actor: string; actorRole: string } {
    const actor =
      this.env.FM_TASK_ACTOR || this.env.FM_TASK_ID || userInfo().username;
    return { actor, actorRole: this.env.FM_TASK_ID ? "worker" : "firstmate" };
  }

  private diff(): Change[] {
    const doc = parseBacklog(this.cache ?? "");
    const changes: Change[] = [];
    const seen = new Set<string>();
    for (const task of docTasks(doc)) {
      seen.add(task.id);
      const set = taskToSet(task, this.cfw.home);
      const loaded = this.loaded.get(task.id);
      if (!loaded) {
        changes.push({ type: "new", id: task.id, set, placeSeq: true });
        continue;
      }
      if (
        sameValues(
          set,
          loaded.set,
          COMPARED.filter((c) => c !== "backlogSeq"),
        )
      )
        continue;
      const moved = set.section !== loaded.set.section;
      changes.push({
        type: "changed",
        id: task.id,
        set: { ...set, backlogSeq: moved ? null : loaded.set.backlogSeq },
        placeSeq: moved,
        loaded,
      });
    }
    for (const [id, loaded] of this.loaded) {
      if (seen.has(id)) continue;
      changes.push({
        type: "gone",
        id,
        set: { section: null, backlogSeq: null },
        placeSeq: false,
        loaded,
      });
    }
    return changes;
  }

  private async flush(verb: string): Promise<void> {
    const changes = this.diff();
    const fresh = new Map<string, Row | null>();
    // Re-read every row first; any change by another writer refuses the whole write.
    for (const change of changes) {
      const row = await this.transport.getRow(change.id);
      if (change.loaded) {
        if (!row || !sameValues(row, change.loaded.row, COMPARED)) {
          throw new AxiError(
            `Task "${change.id}" changed on Dev 5001 meanwhile; retry the command`,
            "CONFLICT",
            ["Re-run the command; it reads the newest rows first"],
          );
        }
      } else if (row && row.section != null) {
        throw new AxiError(
          `Task "${change.id}" already lives in a backlog on Dev 5001 (home ${String(row.backlogHome ?? "none")})`,
          "CONFLICT",
        );
      }
      fresh.set(change.id, row);
    }
    const who = this.who();
    let stored = 0;
    for (const change of changes) {
      const row = fresh.get(change.id) ?? null;
      const spec: WriteSpec = {
        taskId: change.id,
        kind: row ? "row" : "created",
        note: `tasks-axi ${verb}`,
        set: change.set,
        placeSeq: change.placeSeq,
        key: `axi:${change.id}:${Number(row?.lastSeq ?? 0)}:${sha16(content(change.set))}`,
        ...who,
        file: this.renderPath,
        row,
      };
      if (!row) {
        const kind = String(change.set.backlogKind ?? "");
        spec.defaults = {
          state: "triage",
          assignee: change.id.slice(0, 64),
          nextActor: "firstmate",
          kind: CONTRACT_KINDS.includes(kind) ? kind : "other",
          blockRepeats: 0,
          blockKind: null,
          blockReason: null,
          issueUrl: null,
          prUrl: null,
          surface: null,
          holdUntil: null,
        };
        // The created event carries the contract defaults too, so the writer's fold sees a whole row.
        spec.set = { ...spec.defaults, ...spec.set };
      }
      try {
        await this.transport.write(spec);
        stored++;
      } catch (error) {
        if (stored === 0) throw error;
        throw new AxiError(
          `${stored} of ${changes.length} task writes stored, then: ${(error as Error).message}`,
          "UNKNOWN",
          [
            "Re-run the same command: its key replays each stored event, then writes the row",
          ],
        );
      }
    }
    if (changes.length > 0 || !existsSync(this.renderPath)) this.writeRender();
  }

  private writeRender(): void {
    atomicWrite(this.renderPath, this.cache ?? "");
  }

  /** Serialize calls in this process; writes also hold a cross-process lock. */
  private run<T>(verb: string | null, fn: () => Promise<T>): Promise<T> {
    const go = async () => {
      await this.prefetch();
      try {
        const result = await fn();
        if (verb !== null && this.pending) await this.flush(verb);
        return result;
      } finally {
        this.cache = undefined;
        this.pending = false;
      }
    };
    const next = this.queue.then(() =>
      verb === null ? go() : withLock(`${this.renderPath}.cfw5001`, go),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  // -------------------------------------------------------------------------
  // Store methods
  // -------------------------------------------------------------------------

  override get(id: string): Promise<Task | null> {
    return this.run(null, () => super.get(id));
  }

  override list(query: TaskQuery): Promise<{ items: Task[]; total: number }> {
    return this.run(null, () => super.list(query));
  }

  override create(input: TaskInput): Promise<Task> {
    return this.run("add", () => super.create(input));
  }

  override update(id: string, patch: TaskPatch): Promise<TaskUpdateResult> {
    return this.run("update", () => super.update(id, patch));
  }

  override remove(id: string): Promise<Task> {
    return this.run("rm", () => super.remove(id));
  }

  override transition(
    id: string,
    to: State,
    opts?: TransitionOpts,
  ): Promise<Task> {
    const verb =
      to === "done" ? "done" : to === "in_flight" ? "start" : "reopen";
    return this.run(verb, () => super.transition(id, to, opts));
  }

  override addDep(id: string, dep: Dep): Promise<boolean> {
    return this.run("block", () => super.addDep(id, dep));
  }

  override removeDep(id: string, dep: Dep): Promise<boolean> {
    return this.run("unblock", () => super.removeDep(id, dep));
  }

  override updatePublicFollowup(
    id: string,
    mutation: PublicFollowupMutation,
  ): Promise<Task> {
    return this.run("public-followup", () =>
      super.updatePublicFollowup(id, mutation),
    );
  }

  override prune(options: PruneOptions): Promise<PruneResult> {
    return this.run("prune", () => super.prune(options));
  }

  override moveTo(): Promise<Task> {
    return Promise.reject(this.noMove());
  }

  override moveManyTo(): Promise<Task[]> {
    return Promise.reject(this.noMove());
  }

  private noMove(): AxiError {
    return new AxiError(
      "mv between backlog files is not supported by the cfw5001 backend",
      "UNSUPPORTED",
    );
  }

  /**
   * Repair every home row from the fold of its events (a PATCH lost after a
   * stored event), then rewrite the render. Returns the task count.
   */
  override render(): Promise<number> {
    return this.run(null, async () => {
      return withLock(`${this.renderPath}.cfw5001`, async () => {
        for (const { row } of this.loaded.values()) {
          const set = await this.transport.foldedSet(row.taskId);
          if (!set) continue;
          const repair: BacklogSet = {};
          for (const col of BACKLOG_COLUMNS) {
            if (col in set && norm(set[col]) !== norm(row[col]))
              repair[col] = set[col];
          }
          if (Object.keys(repair).length === 0) continue;
          await this.transport.write({
            taskId: row.taskId,
            kind: "row",
            note: "tasks-axi render",
            set: { ...repair },
            placeSeq: false,
            key: `axi-render:${row.taskId}:${Number(row.lastSeq ?? 0)}:${sha16(repair)}`,
            ...this.who(),
            file: this.renderPath,
            row,
          });
        }
        const rows = await this.transport.listHome(this.cfw.home);
        this.cache = renderRows(rows, this.cfw.home);
        this.writeRender();
        return rows.length;
      });
    });
  }
}
