import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Removes probe data from the real Dev 5001: the `fm_task` rows of the named
 * task ids, their `fm_task_event` rows (with `fm_event_document` children) and
 * `fm_task_link` rows. `fm_task`, `fm_task_event` and `fm_event_document`
 * declare no `delete`, so this follows the contract README: as SysAdmin it
 * opens `delete` on those definitions, deletes, and restores the original
 * operations in a `finally`, even when a delete fails.
 *
 * Only ids whose row is absent or has a `backlogHome` starting with `probe`
 * are touched.
 */

const BASE = process.env.FM_TASK_BASE_URL ?? "http://127.0.0.1:5001";
export const SYSADMIN_ENV = join(
  homedir(),
  ".local/share/cfw-deployments/cfw-forge-dev-5001-secrets/deploy-5001.env",
);
const DELETABLE = ["fm_task", "fm_task_event", "fm_event_document"];

type Row = Record<string, unknown> & { id: string };

function envValue(text: string, key: string): string {
  const line = text.split("\n").find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} missing from ${SYSADMIN_ENV}`);
  return line
    .slice(key.length + 1)
    .trim()
    .replace(/^"|"$/g, "");
}

async function signIn(): Promise<string> {
  const text = readFileSync(SYSADMIN_ENV, "utf8");
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: envValue(text, "Auth__SysAdminUsername"),
      password: envValue(text, "Auth__SysAdminPassword"),
    }),
  });
  if (res.status !== 200)
    throw new Error(`SysAdmin sign-in answered ${res.status}`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  return cookies.join("; ");
}

/** True only when the SysAdmin login that cleanup uses really signs in. */
export async function canCleanUp(): Promise<boolean> {
  if (!existsSync(SYSADMIN_ENV)) return false;
  try {
    await signIn();
    return true;
  } catch (error) {
    console.warn(
      `cfw5001 live tests skipped: SysAdmin sign-in failed (${(error as Error).message})`,
    );
    return false;
  }
}

export interface CleanupResult {
  tasks: number;
  events: number;
  documents: number;
  links: number;
}

export async function deleteProbeTasks(
  taskIds: string[],
): Promise<CleanupResult> {
  const result: CleanupResult = { tasks: 0, events: 0, documents: 0, links: 0 };
  if (taskIds.length === 0) return result;
  const cookie = await signIn();
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}/api/${path}`, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const list = async (table: string, filter: string): Promise<Row[]> => {
    const out: Row[] = [];
    for (let skip = 0; ; skip += 100) {
      const res = await call(
        "GET",
        `${table}?$top=100&$skip=${skip}&$orderby=id&$filter=${encodeURIComponent(filter)}`,
      );
      if (res.status !== 200)
        throw new Error(`list ${table} answered ${res.status}`);
      out.push(...(res.json.value as Row[]));
      if (res.json.value.length < 100) return out;
    }
  };
  const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;

  // Guard: never touch a row outside a probe home.
  for (const id of taskIds) {
    const [row] = await list("fm_task", `taskId eq ${lit(id)}`);
    if (row && !String(row.backlogHome ?? "").startsWith("probe")) {
      throw new Error(
        `refusing to delete ${id}: backlogHome ${String(row.backlogHome)}`,
      );
    }
  }

  const definitions = new Map<string, { id: string; operations: string }>();
  for (const name of DELETABLE) {
    const res = await call(
      "GET",
      `api_builder_definitions?$filter=${encodeURIComponent(`name eq '${name}'`)}`,
    );
    const def = res.json.value[0] as { id: string; operations: string };
    definitions.set(name, { id: def.id, operations: def.operations });
  }
  const setOperations = async (name: string, operations: string) => {
    const def = definitions.get(name)!;
    const res = await call("PATCH", `api_builder_definitions/${def.id}`, {
      operations,
    });
    if (res.status !== 200)
      throw new Error(`PATCH ${name} operations answered ${res.status}`);
  };
  const remove = async (table: string, id: string) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const res = await call("DELETE", `${table}/${id}`);
      if (res.status === 200 || res.status === 204) return;
      // a freshly published revision may take a moment to serve the new verb
      if (res.status !== 404 && res.status !== 405) {
        throw new Error(`DELETE ${table}/${id} answered ${res.status}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`DELETE ${table}/${id} never served`);
  };

  try {
    for (const name of DELETABLE) {
      const ops = definitions.get(name)!.operations;
      if (!ops.split(",").includes("delete"))
        await setOperations(name, `${ops},delete`);
    }
    for (const id of taskIds) {
      for (const link of [
        ...(await list("fm_task_link", `parentTaskId eq ${lit(id)}`)),
        ...(await list("fm_task_link", `childTaskId eq ${lit(id)}`)),
      ]) {
        await remove("fm_task_link", link.id);
        result.links++;
      }
      for (const event of await list("fm_task_event", `taskId eq ${lit(id)}`)) {
        for (const doc of await list(
          "fm_event_document",
          `fmTaskEventId eq ${event.id}`,
        )) {
          await remove("fm_event_document", doc.id);
          result.documents++;
        }
        await remove("fm_task_event", event.id);
        result.events++;
      }
      for (const row of await list("fm_task", `taskId eq ${lit(id)}`)) {
        await remove("fm_task", row.id);
        result.tasks++;
      }
    }
  } finally {
    for (const name of DELETABLE) {
      await setOperations(name, definitions.get(name)!.operations);
    }
  }
  return result;
}
