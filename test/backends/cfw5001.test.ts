import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Cfw5001Store, renderRows } from "../../src/backends/cfw5001.js";
import {
  ApiTransport,
  SqliteTransport,
} from "../../src/backends/cfw5001-transport.js";
import { MarkdownStore } from "../../src/backends/markdown.js";
import { AxiError } from "../../src/errors.js";
import { FakeApi } from "./cfw5001-fake.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup(home = "probe") {
  const dir = mkdtempSync(join(tmpdir(), "cfw5001-"));
  dirs.push(dir);
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "t0k3n\n");
  chmodSync(tokenFile, 0o600);
  const fake = new FakeApi();
  const api = new ApiTransport({
    baseUrl: "http://fake.test",
    tokenFile,
    auth: "bearer",
    fetch: fake.fetch,
  });
  const path = join(dir, "backlog.md");
  const make = (
    extra: Partial<ConstructorParameters<typeof Cfw5001Store>[0]> = {},
  ) =>
    new Cfw5001Store({
      path,
      cfw: { home, baseUrl: "http://fake.test", tokenFile, auth: "bearer" },
      api,
      env: { FM_TASK_ACTOR: "tester" },
      now: () => "2026-10-31",
      ...extra,
    });
  return { dir, fake, api, path, tokenFile, store: make(), make };
}

const row = (
  taskId: string,
  section: string,
  seq: number,
  extra: Record<string, unknown> = {},
) => ({
  taskId,
  section,
  title: `title of ${taskId}`,
  repo: null,
  notes: "",
  backlogHome: "probe",
  backlogSeq: seq,
  backlogKind: "ship",
  ...extra,
});

describe("Cfw5001Store read path", () => {
  it("maps rows to tasks with holds, deps, priority and body", async () => {
    const { fake, store } = setup();
    fake.addRow(
      row("a-1", "Queued", 1, {
        repo: "demo",
        notes: "  first line\n\n  second line\n",
        backlogHoldReason: "waits on owner",
        backlogHoldKind: "captain",
        backlogHoldUntil: "2026-12-01",
        backlogPriority: 2,
        backlogDeps: JSON.stringify([
          { type: "blocked-by", id: "b-1", reason: "needs b" },
        ]),
        backlogSince: "2026-10-01",
      }),
    );
    fake.addRow(row("b-1", "In flight", 2));
    fake.addRow(row("other-home", "Queued", 3, { backlogHome: "main" }));
    const task = await store.get("a-1");
    expect(task).toMatchObject({
      id: "a-1",
      state: "queued",
      repo: "demo",
      kind: "ship",
      priority: 2,
      created: "2026-10-01",
      body: "first line\n\nsecond line",
      hold: { reason: "waits on owner", kind: "captain", until: "2026-12-01" },
      deps: [{ type: "blocked-by", id: "b-1", reason: "needs b" }],
    });
    expect(await store.get("other-home")).toBeNull();
  });

  it("orders In flight and Done newest first and Queued oldest first", () => {
    const text = renderRows(
      [
        row("q-old", "Queued", 1),
        row("q-new", "Queued", 9),
        row("f-old", "In flight", 2),
        row("f-new", "In flight", 8),
        row("d-old", "Done", 3, { backlogClosed: "2026-10-01" }),
        row("d-new", "Done", 7, { backlogClosed: "2026-10-02" }),
      ],
      "probe",
    );
    const ids = [...text.matchAll(/^- \[[ x]\] (\S+)/gm)].map((m) => m[1]);
    expect(ids).toEqual(["f-new", "f-old", "q-old", "q-new", "d-new", "d-old"]);
    expect(text.split("\n")[0]).toContain(
      "generated from Dev 5001 fm_task (home probe)",
    );
  });

  it("pages past 100 rows", async () => {
    const { fake, store } = setup();
    for (let i = 0; i < 150; i++) fake.addRow(row(`t-${i}`, "Queued", i + 1));
    const { total } = await store.list({});
    expect(total).toBe(150);
    expect(
      fake.requests.filter((r) => r.startsWith("GET /api/fm_task?")),
    ).toHaveLength(2);
  });

  it("never writes the render on a read", async () => {
    const { fake, store, path } = setup();
    fake.addRow(row("a-1", "Queued", 1));
    await store.list({});
    expect(existsSync(path)).toBe(false);
  });
});

describe("Cfw5001Store backfill", () => {
  it("imports a markdown backlog with content-hash keys; a re-run writes only changes", async () => {
    const { fake, store, dir } = setup();
    const src = join(dir, "source.md");
    writeFileSync(
      src,
      [
        "# Backlog",
        "",
        "## In flight",
        "- [ ] f-1 - top (kind: ship)",
        "- [ ] f-2 - second (kind: ship)",
        "## Queued",
        "- [ ] q-1 - first queued (since 2026-10-01)",
        "  a note",
        "## Done",
        "- [x] d-1 - finished (done 2026-10-02)",
        "",
      ].join("\n"),
    );
    fake.addRow({
      taskId: "q-1",
      title: "short",
      section: "Queued",
      notes: "  a note\n",
    });
    expect(await store.backfillFromMarkdown(src)).toEqual({
      written: 4,
      unchanged: 0,
    });
    expect(fake.eventsOf("q-1")).toHaveLength(1);
    expect(fake.eventsOf("q-1")[0]).toMatchObject({ kind: "row" });
    expect(fake.eventsOf("f-1")[0]).toMatchObject({ kind: "created" });
    expect(String(fake.eventsOf("f-1")[0].idempotencyKey)).toMatch(
      /^axi-backfill:f-1:[0-9a-f]{16}$/,
    );
    const listed = (await store.list({})).items.map((t) => t.id);
    expect(listed).toEqual(["f-1", "f-2", "q-1", "d-1"]);

    expect(await store.backfillFromMarkdown(src)).toEqual({
      written: 0,
      unchanged: 4,
    });
    writeFileSync(
      src,
      readFileSync(src, "utf8").replace(
        "first queued",
        "first queued, renamed",
      ),
    );
    expect(await store.backfillFromMarkdown(src)).toEqual({
      written: 1,
      unchanged: 3,
    });
    expect(fake.eventsOf("q-1")).toHaveLength(2);
    expect((await store.get("q-1"))?.title).toBe("first queued, renamed");
  });
});

describe("Cfw5001Store writes", () => {
  it("writes one event and one PATCH per changed task, none for untouched ones", async () => {
    const { fake, store, path } = setup();
    fake.addRow(row("a-1", "Queued", 1));
    fake.addRow(row("b-1", "Queued", 2));
    await store.update("a-1", { body: "new note" });
    expect(fake.eventsOf("a-1")).toHaveLength(1);
    expect(fake.eventsOf("b-1")).toHaveLength(0);
    const body = JSON.parse(String(fake.eventsOf("a-1")[0].body));
    expect(body).toMatchObject({
      note: "tasks-axi update",
      set: { notes: "  new note\n", backlogSeq: 1 },
      file: path,
    });
    expect(fake.row("a-1")).toMatchObject({
      notes: "  new note\n",
      lastSeq: 1,
    });
    expect(readFileSync(path, "utf8")).toContain("- [ ] a-1 - title of a-1");
  });

  it("matches the markdown backend's render for the same verb sequence", async () => {
    const { store, path, dir } = setup();
    const md = new MarkdownStore({
      path: join(dir, "md.md"),
      now: () => "2026-10-31",
    });
    for (const s of [store, md]) {
      await s.create({ id: "a-1", title: "first", kind: "ship" });
      await s.create({ id: "b-1", title: "second" });
      await s.update("a-1", {
        hold: { reason: "owner call", kind: "captain", until: "2026-12-01" },
      });
      await s.addDep("b-1", { type: "blocked-by", id: "a-1" });
      await s.removeDep("b-1", { type: "blocked-by", id: "a-1" });
      await s.update("a-1", { hold: null });
      await s.transition("a-1", "in_flight");
      await s.transition("a-1", "done", {
        pr: "https://github.com/o/r/pull/1",
      });
      await s.transition("a-1", "queued");
    }
    const tail = (p: string) =>
      readFileSync(p, "utf8").split("\n").slice(1).join("\n");
    expect(tail(path)).toBe(tail(join(dir, "md.md")).replace(/\n$/, "\n"));
  });

  it("creates a new task with a created event and a POST", async () => {
    const { fake, store } = setup();
    await store.create({ id: "n-1", title: "new one", kind: "task" });
    expect(fake.eventsOf("n-1")[0]).toMatchObject({
      kind: "created",
      actor: "tester",
      actorRole: "firstmate",
    });
    expect(fake.row("n-1")).toMatchObject({
      section: "Queued",
      backlogHome: "probe",
      kind: "other",
      state: "triage",
      backlogKind: "task",
      backlogSeq: 1,
    });
  });

  it("replays an event whose answer was lost instead of storing it twice", async () => {
    const { fake, store } = setup();
    fake.addRow(row("a-1", "Queued", 1));
    let dropped = false;
    fake.hooks.before = async (method, path, body) => {
      if (method === "POST" && path === "/api/fm_task_event" && !dropped) {
        dropped = true;
        fake.events.push({ ...body, id: "stored" });
        throw new TypeError("fetch failed");
      }
      return undefined;
    };
    await store.update("a-1", { title: "renamed" });
    expect(fake.eventsOf("a-1")).toHaveLength(1);
    expect(fake.row("a-1")?.title).toBe("renamed");
  });

  it("retries the next seq after a 409", async () => {
    const { fake, store } = setup();
    fake.addRow(row("a-1", "Queued", 1));
    let raced = false;
    fake.hooks.before = (method, path) => {
      if (method === "POST" && path === "/api/fm_task_event" && !raced) {
        raced = true;
        fake.events.push({
          id: "other",
          seq: 1,
          taskId: "x",
          idempotencyKey: "other-writer",
        });
      }
      return undefined;
    };
    await store.update("a-1", { title: "renamed" });
    expect(fake.eventsOf("a-1")[0].seq).toBe(2);
  });

  it("refuses with CONFLICT when another writer changed the row between prefetch and flush", async () => {
    const { fake, store } = setup();
    const a = fake.addRow(row("a-1", "Queued", 1));
    let gets = 0;
    fake.hooks.before = (method, path) => {
      // the second GET of the row is the flush re-read: a direct PATCH lands first
      if (method === "GET" && path === "/api/fm_task" && ++gets === 2)
        a.title = "changed by someone else";
      return undefined;
    };
    await expect(
      store.update("a-1", { hold: { reason: "x" } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fake.events).toHaveLength(0);
    expect(a.backlogHoldReason).toBeUndefined();
  });

  it("removes by clearing the section and revives the same row on add", async () => {
    const { fake, store } = setup();
    fake.addRow(row("a-1", "Queued", 1));
    await store.remove("a-1");
    expect(fake.row("a-1")).toMatchObject({ section: null, backlogSeq: null });
    expect(await store.get("a-1")).toBeNull();
    await store.create({ id: "a-1", title: "back again" });
    expect(fake.tasks.filter((t) => t.taskId === "a-1")).toHaveLength(1);
    expect(fake.eventsOf("a-1").map((e) => e.kind)).toEqual(["row", "row"]);
    expect(fake.row("a-1")).toMatchObject({
      section: "Queued",
      title: "back again",
    });
  });

  it("refuses to add a task that lives in another home's backlog", async () => {
    const { fake, store } = setup();
    fake.addRow(row("a-1", "Queued", 1, { backlogHome: "main" }));
    await expect(
      store.create({ id: "a-1", title: "dup" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("carries a long row in a documents child and reads it back whole", async () => {
    const { fake, store } = setup();
    fake.addRow(row("a-1", "Queued", 1));
    const long = Array.from(
      { length: 120 },
      (_, i) => `line ${i} ${"x".repeat(70)}`,
    ).join("\n");
    await store.update("a-1", { body: long });
    const body = JSON.parse(String(fake.eventsOf("a-1")[0].body));
    expect(body.set).toMatchObject({ rowDocument: true });
    expect(body.set.notes).toBeUndefined();
    expect(fake.documents[0]).toMatchObject({ mediaType: "text/markdown" });
    expect((await store.get("a-1"))?.body).toBe(long);
  });

  it("prunes Done by clearing sections, never deleting", async () => {
    const { fake, store } = setup();
    for (let i = 1; i <= 4; i++)
      fake.addRow(row(`d-${i}`, "Done", i, { backlogClosed: "2026-10-01" }));
    const result = await store.prune({ state: "done", keep: 2, archive: true });
    expect(result.ids).toEqual(["d-2", "d-1"]);
    expect(fake.tasks).toHaveLength(4);
    expect(fake.row("d-1")?.section).toBeNull();
    expect(fake.row("d-4")?.section).toBe("Done");
  });

  it("refuses mv between files", async () => {
    const { store, dir } = setup();
    await expect(store.moveManyTo()).rejects.toBeInstanceOf(AxiError);
    void dir;
  });
});

describe("Cfw5001Store offline fallback", () => {
  function makeDb(path: string) {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE fm_task_event (id TEXT PRIMARY KEY, actor TEXT NOT NULL, actor_role TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, idempotency_key TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL, task_id TEXT NOT NULL);
      CREATE UNIQUE INDEX ux_key ON fm_task_event (idempotency_key); CREATE UNIQUE INDEX ux_seq ON fm_task_event (seq);
      CREATE TABLE fm_task (id TEXT PRIMARY KEY, assignee TEXT NOT NULL, block_kind TEXT, block_reason TEXT, block_repeats INTEGER NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, hold_until TEXT, issue_url TEXT, kind TEXT NOT NULL, last_seq INTEGER NOT NULL, next_actor TEXT NOT NULL, pr_url TEXT, repo TEXT, state TEXT NOT NULL, surface TEXT, task_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, notes TEXT, row TEXT, section TEXT, stage TEXT,
        backlog_closed TEXT, backlog_deps TEXT, backlog_hold_kind TEXT, backlog_hold_reason TEXT, backlog_hold_until TEXT, backlog_home TEXT, backlog_kind TEXT, backlog_priority INTEGER, backlog_public_followup TEXT, backlog_seq INTEGER, backlog_since TEXT);
      INSERT INTO fm_task (id, assignee, block_repeats, created_at, created_by, kind, last_seq, next_actor, state, task_id, title, notes, section, backlog_home, backlog_seq, backlog_kind)
        VALUES ('G1', 'a-1', 0, '2026-10-31 00:00:00.0000000', 'U1', 'ship', 0, 'firstmate', 'ready', 'a-1', 'from the db', '', 'Queued', 'probe', 1, 'ship');`);
    db.close();
  }

  it("reads and writes the DB when the API gives no answer", async () => {
    const { make, dir, tokenFile } = setup();
    const dbPath = join(dir, "forge.db");
    makeDb(dbPath);
    const down = new ApiTransport({
      baseUrl: "http://127.0.0.1:1",
      tokenFile,
      auth: "bearer",
      timeoutMs: 2000,
    });
    const store = make({
      api: down,
      offline: new SqliteTransport(dbPath),
      cfw: {
        home: "probe",
        baseUrl: "http://127.0.0.1:1",
        tokenFile,
        auth: "bearer",
        db: dbPath,
      },
    });
    expect((await store.get("a-1"))?.title).toBe("from the db");
    await store.update("a-1", {
      hold: { reason: "offline hold", kind: "external" },
    });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const event = db
      .prepare("SELECT seq, kind, body, created_by FROM fm_task_event")
      .get() as Record<string, unknown>;
    const task = db
      .prepare(
        "SELECT backlog_hold_reason, last_seq FROM fm_task WHERE task_id = 'a-1'",
      )
      .get();
    db.close();
    expect(event).toMatchObject({ seq: 1, kind: "row", created_by: "U1" });
    expect(JSON.parse(String(event.body)).note).toBe(
      "tasks-axi update (offline)",
    );
    expect(task).toMatchObject({
      backlog_hold_reason: "offline hold",
      last_seq: 1,
    });
  });

  it("never falls back on a 4xx or 5xx answer", async () => {
    for (const status of [401, 503]) {
      const { fake, make, dir } = setup();
      const dbPath = join(dir, "forge.db");
      makeDb(dbPath);
      fake.hooks.before = () => new Response("{}", { status });
      const store = make({ offline: new SqliteTransport(dbPath) });
      await expect(store.list({})).rejects.toThrow(
        new RegExp(`HTTP ${status}`),
      );
    }
  });

  it("opens the DB read-only for reads", async () => {
    const { dir } = setup();
    const dbPath = join(dir, "forge.db");
    makeDb(dbPath);
    chmodSync(dbPath, 0o444);
    const rows = await new SqliteTransport(dbPath).listHome("probe");
    expect(rows.map((r) => r.taskId)).toEqual(["a-1"]);
  });
});
