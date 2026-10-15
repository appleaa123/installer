import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Runs the real relay file (relay/whatsapp-relay.mjs) the way Cloudflare does: its default export's fetch(request, env),
 * with env.DB a D1-shaped adapter over node:sqlite, so the SQL it sends is real SQL.
 */
interface Statement {
  bind: (...args: unknown[]) => Statement;
  run: () => Promise<{ success: true; meta: { changes: number } }>;
  all: () => Promise<{ success: true; results: Record<string, unknown>[] }>;
  first: (column?: string) => Promise<unknown>;
}

export function d1(db: DatabaseSync) {
  return {
    prepare(sql: string): Statement {
      let args: unknown[] = [];
      const statement: Statement = {
        bind: (...values: unknown[]) => {
          args = values;
          return statement;
        },
        run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
        all: async () => ({ success: true, results: db.prepare(sql).all(...(args as never[])) as Record<string, unknown>[] }),
        first: async (column?: string) => {
          const row = db.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined;
          return row === undefined ? null : column ? row[column] : row;
        },
      };
      return statement;
    },
  };
}

export interface Relay {
  readonly call: (method: string, path: string, init?: { headers?: Record<string, string>; body?: string | Buffer }) => Promise<Response>;
  readonly db: DatabaseSync;
  readonly env: Record<string, unknown>;
}

export async function startRelay(secrets: { VERIFY_TOKEN: string; PULL_TOKEN: string; PATH_KEY: string }, clock: () => number = Date.now): Promise<Relay> {
  const module = (await import(pathToFileURL(resolve("relay/whatsapp-relay.mjs")).href)) as { default: { fetch: (request: Request, env: unknown) => Promise<Response> }; SCHEMA: readonly string[] };
  const db = new DatabaseSync(":memory:");
  for (const sql of module.SCHEMA) db.exec(sql);
  const env = { ...secrets, DB: d1(db), NOW: clock };
  const call = (method: string, path: string, init: { headers?: Record<string, string>; body?: string | Buffer } = {}) =>
    module.default.fetch(new Request(`https://taskfollow-whatsapp.example.workers.dev${path}`, { method, headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : new Uint8Array(init.body) }) }), env);
  return { call, db, env };
}
