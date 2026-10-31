import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { AxiError } from "../errors.js";

/**
 * The two ways the cfw5001 backend reaches the Dev 5001 task record:
 * the runtime API (normal path) and the host's SQLite file (offline path).
 * Both expose the same three calls, so the store logic is written once.
 */

/** One `fm_task` row with camelCase field names (the API body names). */
export type Row = Record<string, unknown> & {
  id: string;
  taskId: string;
  lastSeq?: number;
};

/** Every column the backend owns or shares; the event `set` and the PATCH carry these. */
export const BACKLOG_COLUMNS = [
  "section",
  "row",
  "notes",
  "title",
  "repo",
  "backlogHome",
  "backlogKind",
  "backlogHoldReason",
  "backlogHoldKind",
  "backlogHoldUntil",
  "backlogPriority",
  "backlogDeps",
  "backlogSince",
  "backlogClosed",
  "backlogSeq",
  "backlogPublicFollowup",
] as const;

/** One backlog write: one event plus the row PATCH (or the row POST for a new task). */
export interface WriteSpec {
  taskId: string;
  kind: "row" | "created";
  note: string;
  /** Backlog columns to write; `backlogSeq` is replaced by the event seq when `placeSeq`. */
  set: Record<string, unknown>;
  placeSeq: boolean;
  key: string;
  actor: string;
  actorRole: string;
  /** The `file` the event names (the render path), for firstmate's view reader. */
  file: string;
  /** A body `update --archive-body` superseded; kept in the event, never a file. */
  archivedBody?: string;
  /** The existing row, or null to create one with `defaults`. */
  row: Row | null;
  defaults?: Record<string, unknown>;
}

export interface Transport {
  readonly kind: "api" | "db";
  listHome(home: string): Promise<Row[]>;
  getRow(taskId: string): Promise<Row | null>;
  /** Append the event and patch/create the row; returns the event seq. */
  write(spec: WriteSpec): Promise<number>;
  /** The backlog columns folded from every event of a task, for `render` repair. */
  foldedSet(taskId: string): Promise<Record<string, unknown> | null>;
}

/** Raised when the API gives no answer (connection refused, timeout). */
export class NoAnswerError extends AxiError {
  constructor(message: string) {
    super(message, "UNKNOWN", ["Check that Dev 5001 is running"]);
  }
}

/** Raised on a 5xx answer: a refusal, never a reason to fall back to the DB. */
export class ServerError extends AxiError {
  constructor(message: string) {
    super(message, "UNKNOWN");
  }
}

const EVENT_BODY_LIMIT = 8000;
const EVENT_STAGE_BUDGET = 64;
const MAX_ATTEMPTS = 50;

export function sha16(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

/** Event body JSON; a row too long for one body moves `row`+`notes` into a documents child. */
export function eventBody(
  spec: WriteSpec,
  set: Record<string, unknown>,
  offline = false,
): { body: string; documents?: Array<Record<string, string>> } {
  const note = offline ? `${spec.note} (offline)` : spec.note;
  const archived =
    spec.archivedBody === undefined ? {} : { archivedBody: spec.archivedBody };
  const body = JSON.stringify({
    v: 1,
    note,
    set,
    file: spec.file,
    ...archived,
  });
  if (body.length <= EVENT_BODY_LIMIT - EVENT_STAGE_BUDGET) return { body };
  const { row, notes, ...rest } = set;
  const small = JSON.stringify({
    v: 1,
    note,
    set: { ...rest, rowDocument: true },
    file: spec.file,
    ...archived,
  });
  if (small.length > EVENT_BODY_LIMIT) {
    throw new AxiError(
      `the event body is ${small.length} characters; the table holds ${EVENT_BODY_LIMIT}`,
      "VALIDATION_ERROR",
    );
  }
  return {
    body: small,
    documents: [
      {
        title: `backlog row ${spec.taskId}`,
        mediaType: "text/markdown",
        content: `${String(row ?? "")}\n${String(notes ?? "")}`,
      },
    ],
  };
}

function bodySet(body: unknown): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(body));
    return parsed && typeof parsed.set === "object" ? parsed.set : null;
  } catch {
    return null;
  }
}

/**
 * Fold the backlog columns of a task's events (oldest first): each column
 * takes the value of the newest event whose `set` carries it. A row too long
 * for one body lives in a documents child (`<row>\n<notes>`), read only for
 * the newest event that carries row text, like the firstmate writer's fold.
 */
export async function foldEvents(
  events: Array<{ id: string; body?: unknown }>,
  readDocument: (eventId: string) => Promise<string | null>,
): Promise<Record<string, unknown> | null> {
  if (events.length === 0) return null;
  const folded: Record<string, unknown> = {};
  let carrier: { id: string } | undefined;
  for (const event of events) {
    const set = bodySet(event.body);
    if (!set) continue;
    for (const col of BACKLOG_COLUMNS) if (col in set) folded[col] = set[col];
    if (set.rowDocument) {
      carrier = event;
      delete folded.row;
      delete folded.notes;
    } else if ("row" in set) {
      carrier = undefined;
    }
  }
  if (carrier) {
    const content = await readDocument(carrier.id);
    if (content === null) {
      throw new AxiError(
        `the row document of event ${carrier.id} is missing`,
        "UNKNOWN",
      );
    }
    const cut = content.indexOf("\n");
    folded.row = content.slice(0, cut);
    folded.notes = content.slice(cut + 1);
  }
  return folded;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;

// ---------------------------------------------------------------------------
// API transport
// ---------------------------------------------------------------------------

export interface ApiOptions {
  baseUrl: string;
  tokenFile: string;
  auth: "bearer" | "cookie";
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Rows per list request; the host caps `$top` at 100. */
  pageSize?: number;
}

/** The writer's token rule: a regular file the user owns, no group or other bits. */
export function readToken(file: string): string {
  let info;
  try {
    info = lstatSync(file);
  } catch {
    throw new AxiError(
      `the token file is missing: ${file}`,
      "VALIDATION_ERROR",
    );
  }
  const uid = process.getuid?.();
  if (
    !info.isFile() ||
    (uid !== undefined && info.uid !== uid) ||
    info.mode & 0o077
  ) {
    throw new AxiError(
      "the token must be a regular file you own, with no group or other permissions",
      "VALIDATION_ERROR",
    );
  }
  const token = readFileSync(file, "utf8").trim();
  if (!token || /[\r\n"\\]/.test(token)) {
    throw new AxiError(
      "the token file does not hold a token",
      "VALIDATION_ERROR",
    );
  }
  return token;
}

interface Answer {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export class ApiTransport implements Transport {
  readonly kind = "api" as const;
  private token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ApiOptions) {
    if (!/^https?:\/\//.test(options.baseUrl)) {
      throw new AxiError(
        "cfw5001 base_url must use http or https",
        "VALIDATION_ERROR",
      );
    }
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async http(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Answer> {
    this.token ??= readToken(this.options.tokenFile);
    const base = this.options.baseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.options.auth === "cookie") {
      headers.cookie = `cfw.auth.session=${this.token}`;
    } else {
      headers.authorization = `Bearer ${this.token}`;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20000),
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause;
      throw new NoAnswerError(
        `${method} ${path}: no answer from ${base} (${cause?.code ?? (error as Error).message})`,
      );
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text.trim() ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status >= 500) {
      throw new ServerError(
        `${method} ${path}: ${base} answered HTTP ${res.status}`,
      );
    }
    return { status: res.status, json };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ok(res: Answer, what: string): any {
    if (res.status >= 200 && res.status < 300) {
      const j = res.json;
      return j && typeof j === "object" && "success" in j && "data" in j
        ? j.data
        : j;
    }
    const j = res.json ?? {};
    throw new AxiError(
      `${what} refused by the API (HTTP ${res.status}${j.errorCode ? ` ${j.errorCode}` : ""})${j.message ? `: ${j.message}` : ""}`,
      "UNKNOWN",
    );
  }

  /**
   * Every row matching `filter`, paged by key (`key gt <last>`, ties on `id`)
   * rather than by offset, so a row whose key changes mid-read (a concurrent
   * move) is never skipped; a row seen twice keeps its newer copy.
   */
  private async listAll(table: string, filter: string, key: string) {
    const byId = new Map<string, Row>();
    const size = this.options.pageSize ?? 100;
    let after = "";
    for (;;) {
      const where = after ? `(${filter}) and (${after})` : filter;
      const q = `$top=${size}&$orderby=${encodeURIComponent(`${key},id`)}&$filter=${encodeURIComponent(where)}`;
      const page = (this.ok(
        await this.http("GET", `/api/${table}?${q}`),
        `list ${table}`,
      )?.value ?? []) as Row[];
      for (const row of page) {
        byId.delete(row.id);
        byId.set(row.id, row);
      }
      if (page.length < size) return [...byId.values()];
      const last = page[page.length - 1];
      const value = last[key];
      after =
        value === null || value === undefined
          ? `(${key} eq null and id gt ${last.id}) or ${key} ne null`
          : `${key} gt ${String(value)} or (${key} eq ${String(value)} and id gt ${last.id})`;
    }
  }

  private async first(table: string, filter: string, orderby = "id") {
    const q = `$top=1&$orderby=${encodeURIComponent(orderby)}&$filter=${encodeURIComponent(filter)}`;
    const page = this.ok(
      await this.http("GET", `/api/${table}?${q}`),
      `list ${table}`,
    )?.value as Row[] | undefined;
    return page?.[0] ?? null;
  }

  listHome(home: string): Promise<Row[]> {
    return this.listAll(
      "fm_task",
      `backlogHome eq ${lit(home)} and section ne null`,
      "backlogSeq",
    );
  }

  getRow(taskId: string): Promise<Row | null> {
    return this.first("fm_task", `taskId eq ${lit(taskId)}`);
  }

  async foldedSet(taskId: string) {
    const events = await this.listAll(
      "fm_task_event",
      `taskId eq ${lit(taskId)}`,
      "seq",
    );
    return foldEvents(events, async (eventId) => {
      const doc = await this.first(
        "fm_event_document",
        `fmTaskEventId eq ${eventId}`,
      );
      return doc ? String(doc.content) : null;
    });
  }

  private eventByKey(key: string) {
    return this.first("fm_task_event", `idempotencyKey eq ${lit(key)}`);
  }

  private async append(spec: WriteSpec): Promise<number> {
    const prior = await this.eventByKey(spec.key);
    if (prior) {
      if (prior.taskId !== spec.taskId) {
        throw new AxiError(
          `the key ${spec.key} was used by task ${prior.taskId}`,
          "CONFLICT",
        );
      }
      return Number(prior.seq);
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const high = await this.first("fm_task_event", "seq ge 0", "seq desc");
      const seq = Number(high?.seq ?? 0) + 1;
      const set = spec.placeSeq ? { ...spec.set, backlogSeq: seq } : spec.set;
      const { body, documents } = eventBody(spec, set);
      const payload: Record<string, unknown> = {
        seq,
        taskId: spec.taskId,
        kind: spec.kind,
        actorRole: spec.actorRole,
        actor: spec.actor,
        body,
        idempotencyKey: spec.key,
      };
      if (documents) payload.documents = documents;
      let res: Answer;
      try {
        res = await this.http("POST", "/api/fm_task_event", payload);
      } catch (error) {
        if (!(error instanceof NoAnswerError || error instanceof ServerError)) {
          throw error;
        }
        // The answer may be lost after the event was stored: look it up first.
        const found = await this.eventByKey(spec.key);
        if (found) return Number(found.seq);
        throw error;
      }
      if (res.status === 201 || res.status === 200) return seq;
      if (res.status === 409) {
        const found = await this.eventByKey(spec.key);
        if (found) return Number(found.seq);
        await sleep(Math.min(5 + attempt * 3, 40) + Math.random() * 25);
        continue;
      }
      this.ok(res, "the event");
    }
    throw new AxiError(
      `gave up after ${MAX_ATTEMPTS} tries to take the next seq`,
      "CONFLICT",
    );
  }

  async write(spec: WriteSpec): Promise<number> {
    const seq = await this.append(spec);
    const set = spec.placeSeq ? { ...spec.set, backlogSeq: seq } : spec.set;
    try {
      if (spec.row) {
        const lastSeq = Math.max(Number(spec.row.lastSeq ?? 0), seq);
        this.ok(
          await this.http("PATCH", `/api/fm_task/${spec.row.id}`, {
            ...set,
            lastSeq,
          }),
          `the row ${spec.taskId}`,
        );
      } else {
        this.ok(
          await this.http("POST", "/api/fm_task", {
            taskId: spec.taskId,
            ...spec.defaults,
            ...set,
            lastSeq: seq,
            stage: "queued",
          }),
          `the row ${spec.taskId}`,
        );
      }
    } catch (error) {
      throw new AxiError(
        `event ${seq} stored but the row write failed (${(error as Error).message}); re-run the same command (its key replays the stored event, then writes the row)`,
        "UNKNOWN",
      );
    }
    return seq;
  }
}

// ---------------------------------------------------------------------------
// SQLite transport (offline fallback)
// ---------------------------------------------------------------------------

const snake = (name: string) =>
  name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (name: string) =>
  name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** `created_at` in the stored form: `YYYY-MM-DD HH:MM:SS.fffffff` UTC. */
function storedNow(): string {
  return `${new Date().toISOString().replace("T", " ").replace("Z", "")}0000`;
}

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...args: unknown[]): Record<string, unknown>[];
    get(...args: unknown[]): Record<string, unknown> | undefined;
    run(...args: unknown[]): unknown;
  };
  close(): void;
};

export class SqliteTransport implements Transport {
  readonly kind = "db" as const;

  constructor(private readonly path: string) {}

  private async open(readOnly: boolean): Promise<SqliteDb> {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(this.path, { readOnly }) as unknown as SqliteDb;
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  }

  private static toRow(raw: Record<string, unknown>): Row {
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) row[camel(key)] = value;
    return row as Row;
  }

  async listHome(home: string): Promise<Row[]> {
    const db = await this.open(true);
    try {
      return db
        .prepare(
          "SELECT * FROM fm_task WHERE backlog_home = ? AND section IS NOT NULL",
        )
        .all(home)
        .map(SqliteTransport.toRow);
    } finally {
      db.close();
    }
  }

  async getRow(taskId: string): Promise<Row | null> {
    const db = await this.open(true);
    try {
      const raw = db
        .prepare("SELECT * FROM fm_task WHERE task_id = ?")
        .get(taskId);
      return raw ? SqliteTransport.toRow(raw) : null;
    } finally {
      db.close();
    }
  }

  async foldedSet(taskId: string) {
    const db = await this.open(true);
    try {
      const events = db
        .prepare(
          "SELECT id, body FROM fm_task_event WHERE task_id = ? ORDER BY seq",
        )
        .all(taskId) as Array<{ id: string; body: unknown }>;
      return await foldEvents(events, async (eventId) => {
        const doc = db
          .prepare(
            "SELECT content FROM fm_event_document WHERE fm_task_event_id = ? LIMIT 1",
          )
          .get(eventId);
        return doc ? String(doc.content) : null;
      });
    } finally {
      db.close();
    }
  }

  async write(spec: WriteSpec): Promise<number> {
    // Offline writes only go to a regular local file this user owns.
    const info = lstatSync(this.path);
    const uid = process.getuid?.();
    if (!info.isFile() || (uid !== undefined && info.uid !== uid)) {
      throw new AxiError(
        `offline write refused: ${this.path} is not a regular file you own`,
        "VALIDATION_ERROR",
      );
    }
    const db = await this.open(false);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const prior = db
          .prepare(
            "SELECT seq, task_id FROM fm_task_event WHERE idempotency_key = ?",
          )
          .get(spec.key);
        if (prior) {
          db.exec("ROLLBACK");
          if (prior.task_id !== spec.taskId) {
            throw new AxiError(
              `the key ${spec.key} was used by task ${String(prior.task_id)}`,
              "CONFLICT",
            );
          }
          return Number(prior.seq);
        }
        const high = db
          .prepare("SELECT MAX(seq) AS seq FROM fm_task_event")
          .get();
        const seq = Number(high?.seq ?? 0) + 1;
        const set = spec.placeSeq ? { ...spec.set, backlogSeq: seq } : spec.set;
        const { body, documents } = eventBody(spec, set, true);
        if (documents) {
          throw new AxiError(
            "the row is too long for one event body; the offline path writes no documents child",
            "VALIDATION_ERROR",
          );
        }
        const owner =
          db
            .prepare(
              "SELECT created_by FROM fm_task WHERE backlog_home = ? ORDER BY created_at DESC LIMIT 1",
            )
            .get(String(spec.set.backlogHome ?? "")) ??
          db
            .prepare(
              "SELECT created_by FROM fm_task_event ORDER BY seq DESC LIMIT 1",
            )
            .get();
        const createdBy = String(owner?.created_by ?? "");
        const now = storedNow();
        db.prepare(
          "INSERT INTO fm_task_event (id, actor, actor_role, body, created_at, created_by, idempotency_key, kind, seq, task_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
        ).run(
          randomUUID().toUpperCase(),
          spec.actor,
          spec.actorRole,
          body,
          now,
          createdBy,
          spec.key,
          spec.kind,
          seq,
          spec.taskId,
        );
        if (spec.row) {
          const lastSeq = Math.max(Number(spec.row.lastSeq ?? 0), seq);
          const fields: Record<string, unknown> = { ...set, lastSeq };
          const cols = Object.keys(fields);
          db.prepare(
            `UPDATE fm_task SET ${cols.map((c) => `"${snake(c)}" = ?`).join(", ")} WHERE id = ?`,
          ).run(...cols.map((c) => fields[c] as unknown), spec.row.id);
        } else {
          const fields: Record<string, unknown> = {
            id: randomUUID().toUpperCase(),
            taskId: spec.taskId,
            ...spec.defaults,
            ...set,
            lastSeq: seq,
            stage: "queued",
            createdAt: now,
            createdBy,
          };
          const cols = Object.keys(fields);
          db.prepare(
            `INSERT INTO fm_task (${cols.map((c) => `"${snake(c)}"`).join(", ")}) VALUES (${cols.map(() => "?").join(",")})`,
          ).run(...cols.map((c) => fields[c] as unknown));
        }
        db.exec("COMMIT");
        return seq;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // already rolled back
        }
        throw error;
      }
    } finally {
      db.close();
    }
  }
}
