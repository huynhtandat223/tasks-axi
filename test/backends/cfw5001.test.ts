import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Cfw5001Store, renderRows } from "../../src/backends/cfw5001.js";
import {
  ApiTransport,
  type Row,
  SqliteTransport,
} from "../../src/backends/cfw5001-transport.js";
import { MarkdownStore } from "../../src/backends/markdown.js";
import { AxiError } from "../../src/errors.js";
import { canCleanUp, deleteProbeTasks } from "./cfw5001-cleanup.js";

/**
 * The cfw5001 backend against the real Dev 5001 (no fakes). Every write goes
 * to a probe home (`backlog_home = probe-test-<run>-<n>`) with run-unique ids,
 * and the after hook deletes those rows with their events, documents and
 * links (`cfw5001-cleanup.ts`), pass or fail. The suite skips when 5001, its
 * token or the SysAdmin login is not on this machine (CI).
 */

const BASE = process.env.FM_TASK_BASE_URL ?? "http://127.0.0.1:5001";
const TOKEN_FILE =
  process.env.FM_TASK_TOKEN_FILE ??
  join(homedir(), ".local/share/cfw-scripts-private/notify-firstmate.token");
const LIVE_DB = join(
  homedir(),
  ".local/share/cfw-deployments/cfw-forge-dev-5001-data/runtime-api/managed/forge.db",
);
const RUN = Date.now().toString(36);
let seqNo = 0;

async function reachable(): Promise<boolean> {
  if (!existsSync(TOKEN_FILE)) return false;
  try {
    const token = readFileSync(TOKEN_FILE, "utf8").trim();
    const res = await fetch(`${BASE}/api/fm_task?$top=0`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}
// Writes need the SysAdmin login too: the after hook deletes every probe row it made.
const live = (await reachable()) && (await canCleanUp());

async function api(path: string, method = "GET", body?: unknown) {
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  const res = await fetch(`${BASE}/api/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const q = (filter: string, extra = "") =>
  `$filter=${encodeURIComponent(filter)}${extra}`;
async function rowOf(taskId: string): Promise<Row> {
  return (await api(`fm_task?${q(`taskId eq '${taskId}'`)}`)).json.value[0];
}
async function eventsOf(taskId: string): Promise<Row[]> {
  return (
    await api(`fm_task_event?${q(`taskId eq '${taskId}'`, "&$orderby=seq")}`)
  ).json.value;
}
const bodyOf = (event: Row) => JSON.parse(String(event.body));

const dirs: string[] = [];
/** Every task id a test may write on 5001; deleted after the run, pass or fail. */
const probeIds = new Set<string>();
afterAll(async () => {
  try {
    if (live && probeIds.size > 0) await deleteProbeTasks([...probeIds]);
  } finally {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  }
}, 300000);

function probe(
  options: { api?: ApiTransport; offline?: SqliteTransport } = {},
) {
  const n = ++seqNo;
  const home = `probe-test-${RUN}-${n}`;
  const dir = mkdtempSync(join(tmpdir(), "cfw5001-"));
  dirs.push(dir);
  const path = join(dir, "backlog.md");
  const cfw = {
    home,
    baseUrl: BASE,
    tokenFile: TOKEN_FILE,
    auth: "bearer" as const,
  };
  const store = new Cfw5001Store({
    path,
    cfw,
    env: { FM_TASK_ACTOR: "cfw5001-test" },
    now: () => "2026-10-31",
    ...options,
  });
  const id = (x: string) => {
    const taskId = `pt-${RUN}-${n}-${x}`;
    probeIds.add(taskId);
    return taskId;
  };
  return { home, dir, path, cfw, store, id };
}

describe("renderRows", () => {
  const row = (taskId: string, section: string, seq: number) =>
    ({
      id: taskId,
      taskId,
      section,
      title: taskId,
      notes: "",
      backlogSeq: seq,
    }) as Row;

  it("orders In flight and Done newest first and Queued oldest first", () => {
    const text = renderRows(
      [
        row("q-old", "Queued", 1),
        row("q-new", "Queued", 9),
        row("f-old", "In flight", 2),
        row("f-new", "In flight", 8),
        row("d-old", "Done", 3),
        row("d-new", "Done", 7),
      ],
      "probe",
    );
    const ids = [...text.matchAll(/^- \[[ x]\] (\S+)/gm)].map((m) => m[1]);
    expect(ids).toEqual(["f-new", "f-old", "q-old", "q-new", "d-new", "d-old"]);
    expect(text.split("\n")[0]).toContain(
      "generated from Dev 5001 fm_task (home probe)",
    );
  });

  it("refuses mv between backlog files", async () => {
    const store = new Cfw5001Store({
      path: join(tmpdir(), "unused.md"),
      cfw: { home: "x", baseUrl: BASE, tokenFile: TOKEN_FILE, auth: "bearer" },
    });
    await expect(store.moveManyTo()).rejects.toBeInstanceOf(AxiError);
  });
});

describe.skipIf(!live)("Cfw5001Store on Dev 5001", { timeout: 60000 }, () => {
  it("pages through every row of a home", async () => {
    const pages: string[] = [];
    const counting: typeof fetch = (input, init) => {
      if (String(input).includes("/api/fm_task?")) pages.push(String(input));
      return fetch(input, init);
    };
    const p = probe();
    for (const x of ["a", "b", "c"])
      await p.store.create({ id: p.id(x), title: `probe ${x}` });
    const paged = new Cfw5001Store({
      path: `${p.path}.paged`,
      cfw: p.cfw,
      api: new ApiTransport({
        baseUrl: BASE,
        tokenFile: TOKEN_FILE,
        auth: "bearer",
        fetch: counting,
        pageSize: 2,
      }),
    });
    expect((await paged.list({})).items.map((t) => t.id)).toEqual([
      p.id("a"),
      p.id("b"),
      p.id("c"),
    ]);
    expect(pages).toHaveLength(2);
  });

  it("writes one event and one PATCH per changed task and reads every field back", async () => {
    const { store, path, cfw, id } = probe();
    await store.create({
      id: id("a"),
      title: "probe a",
      kind: "ship",
      repo: "tasks-axi",
    });
    await store.create({ id: id("b"), title: "probe b", kind: "task" });
    await store.update(id("a"), {
      body: "first line\n\nsecond line",
      priority: 2,
      hold: { reason: "probe hold", kind: "captain", until: "2026-12-31" },
    });
    await store.addDep(id("b"), {
      type: "blocked-by",
      id: id("a"),
      reason: "needs a",
    });

    expect(
      (await eventsOf(id("a"))).map((e) => [e.kind, bodyOf(e).note]),
    ).toEqual([
      ["created", "tasks-axi add"],
      ["row", "tasks-axi update"],
    ]);
    expect(await eventsOf(id("b"))).toHaveLength(2);
    const created = bodyOf((await eventsOf(id("a")))[0]);
    expect(created.set).toMatchObject({
      kind: "ship",
      state: "triage",
      backlogKind: "ship",
    });
    expect(created.set).not.toHaveProperty("file");
    expect(created.file).toBe(path);
    expect(await rowOf(id("a"))).toMatchObject({
      section: "Queued",
      notes: "  first line\n\n  second line\n",
      backlogHoldReason: "probe hold",
      backlogHoldKind: "captain",
      backlogHoldUntil: "2026-12-31",
      backlogPriority: 2,
    });

    const reader = new Cfw5001Store({ path: `${path}.reader`, cfw });
    expect(await reader.get(id("a"))).toMatchObject({
      repo: "tasks-axi",
      kind: "ship",
      priority: 2,
      created: "2026-10-31",
      body: "first line\n\nsecond line",
      hold: { reason: "probe hold", kind: "captain", until: "2026-12-31" },
    });
    expect((await reader.get(id("b")))?.deps).toEqual([
      { type: "blocked-by", id: id("a"), reason: "needs a" },
    ]);
    expect(readFileSync(path, "utf8")).toContain(`- [ ] ${id("a")} - probe a`);
    expect(existsSync(`${path}.reader`)).toBe(false);
  });

  it("matches the markdown backend's render for the same verb sequence", async () => {
    const { store, path, dir, id } = probe();
    const mdPath = join(dir, "md.md");
    const md = new MarkdownStore({ path: mdPath, now: () => "2026-10-31" });
    for (const s of [store, md]) {
      await s.create({ id: id("a"), title: "first", kind: "ship" });
      await s.create({ id: id("b"), title: "second" });
      await s.update(id("a"), {
        hold: { reason: "owner call", kind: "captain" },
      });
      await s.addDep(id("b"), { type: "blocked-by", id: id("a") });
      await s.removeDep(id("b"), { type: "blocked-by", id: id("a") });
      await s.update(id("a"), { hold: null });
      await s.transition(id("a"), "in_flight");
      await s.transition(id("a"), "done", {
        pr: "https://github.com/o/r/pull/1",
      });
      await s.transition(id("a"), "queued");
      await s.remove(id("b"));
    }
    const tail = (p: string) =>
      readFileSync(p, "utf8").split("\n").slice(1).join("\n");
    expect(tail(path)).toBe(tail(mdPath));
  });

  it("removes by clearing the section and revives the same row on add", async () => {
    const { store, id } = probe();
    await store.create({ id: id("a"), title: "probe a" });
    await store.remove(id("a"));
    expect(await rowOf(id("a"))).toMatchObject({
      section: null,
      backlogSeq: null,
    });
    expect(await store.get(id("a"))).toBeNull();
    await store.create({ id: id("a"), title: "back again" });
    expect((await eventsOf(id("a"))).map((e) => e.kind)).toEqual([
      "created",
      "row",
      "row",
    ]);
    expect(await rowOf(id("a"))).toMatchObject({
      section: "Queued",
      title: "back again",
    });
  });

  it("refuses to add a task that lives in another home's backlog", async () => {
    const first = probe();
    const second = probe();
    await first.store.create({
      id: first.id("a"),
      title: "owned by the first home",
    });
    await expect(
      second.store.create({ id: first.id("a"), title: "dup" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses with CONFLICT when a second writer patches the row between prefetch and flush", async () => {
    let target = "";
    class SecondWriter extends ApiTransport {
      override async getRow(taskId: string) {
        if (taskId === target) {
          const row = await rowOf(taskId);
          const res = await api(`fm_task/${row.id}`, "PATCH", {
            title: "changed by a second writer",
          });
          expect(res.status).toBe(200);
          target = "";
        }
        return super.getRow(taskId);
      }
    }
    const p = probe();
    await p.store.create({ id: p.id("a"), title: "probe a" });
    const racing = new Cfw5001Store({
      path: p.path,
      cfw: p.cfw,
      api: new SecondWriter({
        baseUrl: BASE,
        tokenFile: TOKEN_FILE,
        auth: "bearer",
      }),
    });
    target = p.id("a");
    await expect(
      racing.update(p.id("a"), { hold: { reason: "x" } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await eventsOf(p.id("a"))).toHaveLength(1);
    expect((await rowOf(p.id("a"))).backlogHoldReason).toBeNull();
  });

  it("replays an event whose answer was lost instead of storing it twice", async () => {
    let drop = false;
    const lossy: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (
        drop &&
        init?.method === "POST" &&
        String(input).endsWith("/api/fm_task_event")
      ) {
        drop = false;
        throw new TypeError("fetch failed");
      }
      return res;
    };
    const p = probe({
      api: new ApiTransport({
        baseUrl: BASE,
        tokenFile: TOKEN_FILE,
        auth: "bearer",
        fetch: lossy,
      }),
    });
    await p.store.create({ id: p.id("a"), title: "probe a" });
    drop = true;
    await p.store.update(p.id("a"), { title: "renamed" });
    expect(drop).toBe(false);
    expect(await eventsOf(p.id("a"))).toHaveLength(2);
    expect((await rowOf(p.id("a"))).title).toBe("renamed");
  });

  it("takes the next seq after a 409 from a concurrent event", async () => {
    let stolen = 0;
    let steal = false;
    const p = probe();
    const racer: typeof fetch = async (input, init) => {
      if (
        steal &&
        init?.method === "POST" &&
        String(input).endsWith("/api/fm_task_event")
      ) {
        steal = false;
        stolen = JSON.parse(String(init.body)).seq;
        const other = await api("fm_task_event", "POST", {
          seq: stolen,
          taskId: p.id("other"),
          kind: "comment",
          actorRole: "worker",
          actor: "cfw5001-test",
          body: JSON.stringify({ v: 1, note: "racing event", set: {} }),
          idempotencyKey: `cfw5001-test:${p.id("other")}`,
        });
        expect(other.status).toBe(201);
      }
      return fetch(input, init);
    };
    const store = new Cfw5001Store({
      path: p.path,
      cfw: p.cfw,
      api: new ApiTransport({
        baseUrl: BASE,
        tokenFile: TOKEN_FILE,
        auth: "bearer",
        fetch: racer,
      }),
    });
    await store.create({ id: p.id("a"), title: "probe a" });
    steal = true;
    await store.update(p.id("a"), { title: "renamed" });
    const events = await eventsOf(p.id("a"));
    expect(events).toHaveLength(2);
    expect(stolen).toBeGreaterThan(0);
    expect(events[1].seq).toBeGreaterThan(stolen);
  });

  it("a re-run of the same command replays the stored event after a failed row write", async () => {
    let failPatch = false;
    const flaky: typeof fetch = async (input, init) => {
      if (
        failPatch &&
        init?.method === "PATCH" &&
        String(input).includes("/api/fm_task/")
      ) {
        failPatch = false;
        return new Response(JSON.stringify({ message: "injected" }), {
          status: 503,
        });
      }
      return fetch(input, init);
    };
    const p = probe({
      api: new ApiTransport({
        baseUrl: BASE,
        tokenFile: TOKEN_FILE,
        auth: "bearer",
        fetch: flaky,
      }),
    });
    await p.store.create({ id: p.id("a"), title: "probe a" });
    failPatch = true;
    await expect(
      p.store.update(p.id("a"), { title: "renamed" }),
    ).rejects.toThrow(/re-run the same command/);
    expect(await eventsOf(p.id("a"))).toHaveLength(2);
    expect((await rowOf(p.id("a"))).title).toBe("probe a");
    await p.store.update(p.id("a"), { title: "renamed" });
    expect(await eventsOf(p.id("a"))).toHaveLength(2);
    expect((await rowOf(p.id("a"))).title).toBe("renamed");
  });

  it("render repairs a lost PATCH from the fold of every event, long rows included", async () => {
    const { store, id } = probe();
    await store.create({ id: id("a"), title: "probe a" });
    await store.create({ id: id("b"), title: "probe b" });
    const long = Array.from(
      { length: 120 },
      (_, i) => `line ${i} ${"y".repeat(70)}`,
    ).join("\n");
    await store.update(id("b"), { body: long });
    await store.update(id("a"), { hold: { reason: "older hold" } });
    await store.update(id("a"), { hold: { reason: "newer hold" } });
    const a = await rowOf(id("a"));
    const b = await rowOf(id("b"));
    // Simulate PATCHes lost after their events were stored.
    expect(
      (
        await api(`fm_task/${a.id}`, "PATCH", {
          backlogHoldReason: "stale",
          title: "stale",
        })
      ).status,
    ).toBe(200);
    expect(
      (await api(`fm_task/${b.id}`, "PATCH", { notes: "  stale\n" })).status,
    ).toBe(200);
    expect(await store.render()).toBe(2);
    expect(await rowOf(id("a"))).toMatchObject({
      backlogHoldReason: "newer hold",
      title: "probe a",
    });
    expect((await rowOf(id("b"))).notes).toBe(
      `${long
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")}\n`,
    );
    expect((await store.get(id("b")))?.body).toBe(long);
  });

  it("carries a long row in a documents child and reads it back whole", async () => {
    const { store, cfw, path, id } = probe();
    await store.create({ id: id("a"), title: "probe a" });
    const long = Array.from(
      { length: 120 },
      (_, i) => `line ${i} ${"x".repeat(70)}`,
    ).join("\n");
    await store.update(id("a"), { body: long });
    const event = (await eventsOf(id("a")))[1];
    expect(bodyOf(event).set).toMatchObject({ rowDocument: true });
    expect(bodyOf(event).set.notes).toBeUndefined();
    const doc = (
      await api(`fm_event_document?${q(`fmTaskEventId eq ${event.id}`)}`)
    ).json.value[0];
    expect(doc.content).toContain("line 119");
    const reader = new Cfw5001Store({ path: `${path}.reader`, cfw });
    expect((await reader.get(id("a")))?.body).toBe(long);
  });

  it("prunes Done by clearing sections, never deleting", async () => {
    const { store, id } = probe();
    for (const x of ["a", "b", "c"]) {
      await store.create({ id: id(x), title: `probe ${x}` });
      await store.transition(id(x), "done");
    }
    const result = await store.prune({ state: "done", keep: 1, archive: true });
    expect(result.ids).toEqual([id("b"), id("a")]);
    expect((await rowOf(id("a"))).section).toBeNull();
    expect((await rowOf(id("c"))).section).toBe("Done");
  });

  it("never falls back to the DB on a refused (401) answer", async () => {
    const { dir } = probe();
    const badToken = join(dir, "bad.token");
    writeFileSync(badToken, "not-a-token\n");
    chmodSync(badToken, 0o600);
    const store = new Cfw5001Store({
      path: join(dir, "b.md"),
      cfw: {
        home: "probe-test",
        baseUrl: BASE,
        tokenFile: badToken,
        auth: "bearer",
        db: LIVE_DB,
      },
    });
    await expect(store.list({})).rejects.toThrow(/HTTP 40[13]/);
  });
});

describe.skipIf(!existsSync(LIVE_DB))(
  "Cfw5001Store offline fallback",
  { timeout: 60000 },
  () => {
    /** A scratch DB with the live 5001 schema of fm_task and fm_task_event. */
    async function scratchDb(dir: string): Promise<string> {
      const { DatabaseSync } = await import("node:sqlite");
      const liveDb = new DatabaseSync(LIVE_DB, { readOnly: true });
      const ddl = liveDb
        .prepare(
          "SELECT sql FROM sqlite_master WHERE tbl_name IN ('fm_task','fm_task_event') AND sql IS NOT NULL",
        )
        .all()
        .map((r) => String(r.sql));
      liveDb.close();
      const path = join(dir, "forge.db");
      const db = new DatabaseSync(path);
      for (const sql of ddl) db.exec(sql);
      db.exec(`INSERT INTO fm_task (id, assignee, block_repeats, created_at, created_by, kind, last_seq, next_actor, state, task_id, title, notes, section, backlog_home, backlog_seq, backlog_kind)
      VALUES ('G1', 'a-1', 0, '2026-10-31 00:00:00.0000000', 'U1', 'ship', 0, 'firstmate', 'ready', 'a-1', 'from the db', '', 'Queued', 'probe-s3', 1, 'ship')`);
      db.close();
      return path;
    }

    it("reads and writes the DB when the API gives no answer", async () => {
      const dir = mkdtempSync(join(tmpdir(), "cfw5001-"));
      dirs.push(dir);
      const dbPath = await scratchDb(dir);
      const store = new Cfw5001Store({
        path: join(dir, "backlog.md"),
        cfw: {
          home: "probe-s3",
          baseUrl: "http://127.0.0.1:1",
          tokenFile: TOKEN_FILE,
          auth: "bearer",
          db: dbPath,
        },
        env: { FM_TASK_ACTOR: "cfw5001-test" },
      });
      expect((await store.get("a-1"))?.title).toBe("from the db");
      await store.update("a-1", {
        hold: { reason: "offline hold", kind: "external" },
      });
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const event = db
        .prepare("SELECT seq, kind, body, created_by FROM fm_task_event")
        .get() as Row;
      const task = db
        .prepare(
          "SELECT backlog_hold_reason, last_seq FROM fm_task WHERE task_id = 'a-1'",
        )
        .get();
      db.close();
      expect(event).toMatchObject({ seq: 1, kind: "row", created_by: "U1" });
      expect(bodyOf(event).note).toBe("tasks-axi update (offline)");
      expect(task).toMatchObject({
        backlog_hold_reason: "offline hold",
        last_seq: 1,
      });
    });

    it("opens the DB read-only for reads", async () => {
      const dir = mkdtempSync(join(tmpdir(), "cfw5001-"));
      dirs.push(dir);
      const dbPath = await scratchDb(dir);
      chmodSync(dbPath, 0o444);
      const rows = await new SqliteTransport(dbPath).listHome("probe-s3");
      expect(rows.map((r) => r.taskId)).toEqual(["a-1"]);
    });
  },
);
