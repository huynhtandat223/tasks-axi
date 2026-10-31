import { randomUUID } from "node:crypto";

/**
 * An in-process fake of the Dev 5001 runtime API: `fm_task` (list, get by
 * filter, create, patch) and `fm_task_event` (list, create with unique `seq`
 * and `idempotencyKey`). It understands only the OData filters the cfw5001
 * transport sends, and counts every request so tests can assert paging.
 */

type Row = Record<string, unknown>;

export interface FakeHooks {
  /** Runs before a request is answered; return a Response to override it. */
  before?: (
    method: string,
    path: string,
    body: Row | undefined,
  ) => Response | undefined | Promise<Response | undefined>;
}

export class FakeApi {
  tasks: Row[] = [];
  events: Row[] = [];
  documents: Row[] = [];
  requests: string[] = [];
  hooks: FakeHooks = {};

  addRow(fields: Row): Row {
    const row = { id: randomUUID(), lastSeq: 0, ...fields };
    this.tasks.push(row);
    return row;
  }

  row(taskId: string): Row | undefined {
    return this.tasks.find((t) => t.taskId === taskId);
  }

  eventsOf(taskId: string): Row[] {
    return this.events
      .filter((e) => e.taskId === taskId)
      .sort((a, b) => Number(a.seq) - Number(b.seq));
  }

  fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Row)
      : undefined;
    this.requests.push(`${method} ${url.pathname}${url.search}`);
    const hooked = await this.hooks.before?.(method, url.pathname, body);
    if (hooked) return hooked;
    const [, , table, id] = url.pathname.split("/");
    if (method === "GET") return this.list(table, url.searchParams);
    if (method === "POST" && table === "fm_task_event")
      return this.postEvent(body!);
    if (method === "POST" && table === "fm_task") {
      if (this.row(String(body!.taskId)))
        return json(409, { message: "duplicate task_id" });
      const row = { id: randomUUID(), ...body };
      this.tasks.push(row);
      return json(201, { success: true, data: row });
    }
    if (method === "PATCH" && table === "fm_task") {
      const row = this.tasks.find((t) => t.id === id);
      if (!row) return json(404, {});
      Object.assign(row, body);
      return json(200, { success: true, data: row });
    }
    return json(404, {});
  };

  private postEvent(body: Row): Response {
    if (
      this.events.some(
        (e) => e.seq === body.seq || e.idempotencyKey === body.idempotencyKey,
      )
    ) {
      return json(409, { message: "duplicate" });
    }
    const { documents, ...event } = body;
    const stored = { id: randomUUID(), ...event };
    this.events.push(stored);
    for (const doc of (documents as Row[] | undefined) ?? [])
      this.documents.push({ ...doc, fmTaskEventId: stored.id });
    return json(201, { success: true, data: stored });
  }

  private list(table: string, params: URLSearchParams): Response {
    const rows = table === "fm_task" ? this.tasks : this.events;
    const filter = params.get("$filter") ?? "";
    const top = Number(params.get("$top") ?? 100);
    const skip = Number(params.get("$skip") ?? 0);
    const [field, dir] = (params.get("$orderby") ?? "id").split(" ");
    const value = (r: Row) => r[field] ?? -1;
    const sorted = rows.filter(matcher(filter)).sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const c = x < y ? -1 : x > y ? 1 : 0;
      return dir === "desc" ? -c : c;
    });
    return json(200, { value: sorted.slice(skip, skip + top) });
  }
}

const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The filters the transport sends, joined by ` and `. */
function matcher(filter: string): (r: Row) => boolean {
  if (filter === "") return () => true;
  const tests = filter.split(" and ").map((clause): ((r: Row) => boolean) => {
    let m = clause.match(/^(\w+) eq '((?:[^']|'')*)'$/);
    if (m) {
      const [, f, v] = m;
      return (r) => r[f] === v.replaceAll("''", "'");
    }
    m = clause.match(/^(\w+) ne null$/);
    if (m) return (r) => r[m![1]] != null;
    m = clause.match(/^(\w+) ge (\d+)$/);
    if (m) return (r) => Number(r[m![1]]) >= Number(m![2]);
    if (clause === "(kind eq 'row' or kind eq 'created')")
      return (r) => r.kind === "row" || r.kind === "created";
    throw new Error(`fake API: unknown filter clause ${clause}`);
  });
  return (r) => tests.every((t) => t(r));
}
