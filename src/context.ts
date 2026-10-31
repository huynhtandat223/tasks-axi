import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Cfw5001Store } from "./backends/cfw5001.js";
import { MarkdownStore } from "./backends/markdown.js";
import {
  type ConfigOverrides,
  type ResolvedConfig,
  resolveConfig,
} from "./config.js";
import { AxiError } from "./errors.js";
import type { Store } from "./store.js";
import type { SuggestionGlobals } from "./suggestions.js";

/**
 * The resolved CLI context: the active backend Store plus the config that
 * selected it. The command layer only ever talks to `Store`, so swapping in
 * sqlite/remote backends (P2/P3) never touches arg parsing or rendering.
 */
export interface TasksContext {
  store: Store;
  config: ResolvedConfig;
  suggestionGlobals?: SuggestionGlobals;
}

export function resolveTasksContext(
  overrides: ConfigOverrides = {},
  suggestionGlobals?: SuggestionGlobals,
): TasksContext {
  const config = resolveConfig(overrides);
  const store = createStore(config, overrides);
  return {
    store,
    config,
    ...(suggestionGlobals ? { suggestionGlobals } : {}),
  };
}

/** Build the Store the config selects: markdown, or cfw5001 (Dev 5001 rows). */
export function createStore(
  config: ResolvedConfig,
  overrides: ConfigOverrides = {},
): Store {
  const base = {
    path: config.path,
    ...(config.archivePath ? { archivePath: config.archivePath } : {}),
  };
  if (config.backend === "markdown") return new MarkdownStore(base);
  if (config.backend === "cfw5001") {
    const env = overrides.env ?? process.env;
    const home = overrides.home ?? homedir();
    const cwd = overrides.cwd ?? process.cwd();
    const toml = config.cfw5001 ?? {};
    if (!toml.home) {
      throw new AxiError(
        "backend cfw5001 needs `[cfw5001] home` in .tasks.toml",
        "VALIDATION_ERROR",
        ['Set `[cfw5001] home = "main"` (the backlog_home this checkout owns)'],
      );
    }
    const auth = toml.auth ?? env.FM_TASK_AUTH ?? "bearer";
    if (auth !== "bearer" && auth !== "cookie") {
      throw new AxiError(
        "cfw5001.auth must be bearer or cookie",
        "VALIDATION_ERROR",
      );
    }
    const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));
    // The DB is read only when the owner names it for a run; no default path.
    const db = toml.db ?? env.TASKS_AXI_CFW5001_DB;
    return new Cfw5001Store({
      ...base,
      env,
      cfw: {
        home: toml.home,
        baseUrl:
          toml.base_url ?? env.FM_TASK_BASE_URL ?? "http://127.0.0.1:5001",
        tokenFile: abs(
          toml.token_file ??
            env.FM_TASK_TOKEN_FILE ??
            join(
              home,
              ".local/share/cfw-scripts-private/notify-firstmate.token",
            ),
        ),
        auth,
        ...(db ? { db: abs(db) } : {}),
      },
    });
  }
  throw new AxiError(`Unsupported backend "${config.backend}"`, "UNSUPPORTED", [
    'Set `backend = "markdown"` or `backend = "cfw5001"` in .tasks.toml',
  ]);
}

/** Narrow an optional context to a present one (the resolver always sets it). */
export function requireCtx(ctx: TasksContext | undefined): TasksContext {
  if (!ctx) {
    throw new AxiError("backlog context was not resolved", "UNKNOWN");
  }
  return ctx;
}
