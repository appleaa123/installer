import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import { ToolRefusal } from "./approvals.js";
import { appendAudit } from "./audit.js";
import { MINUTE_MS, cronTimes } from "./cron.js";
import { dueReports } from "./daily-report.js";
import { readConfig, writeConfig } from "./data-source.js";
import { isAlive } from "./durable.js";
import { ActionFailure } from "./failure.js";
import { listInbox, type InboxItem } from "./inbox.js";
import { InputError } from "./inputs.js";
import { resumeRun, startRun } from "./runner.js";
import { listRuns, recordMissed, runForKey, type RunRecord } from "./runs.js";
import { loadState } from "./state.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { invokeTool, toolContext } from "./tools.js";
import { loadWorkflow, workflowIds, type Workflow } from "./workflow.js";

/**
 * The runner's minute (D82, D84, D88). One OS scheduler entry runs `installer tick` every minute; the tick, under
 * a lock so two never overlap: starts each cron run that fell due within its tolerance, records every one that did
 * not as `missed` (D38: never run late), sends one host-back-online notice when the last heartbeat is more than
 * five minutes old, starts the event-triggered runs for new inbox messages, resumes runs whose approval was decided
 * or whose process died, and writes the heartbeat: `last`, the time this tick started (where the next tick's cron
 * slots begin), and `alive`, the last time a tick was running (where downtime begins), so a slow tick is not downtime.
 * The runner decides by the clock, not by how often the OS fired it, so a scheduler that coalesces or drops firings
 * during sleep (O14) changes nothing.
 */
export const RUNNER_DIR = join("state", "runner");
export const HEARTBEAT_FILE = join(RUNNER_DIR, "heartbeat.json");
export const EVENTS_CURSOR = join(RUNNER_DIR, "events.json");
export const TICK_LOCK = join("runtime", "runner", "tick.lock");
export const BACK_ONLINE_GAP_MS = 5 * MINUTE_MS;

type Env = Readonly<Record<string, string | undefined>>;

export interface TickResult {
  readonly status: "ran" | "busy";
  readonly started: string[];
  readonly missed: string[];
  readonly resumed: string[];
  readonly events: number;
  readonly back_online: boolean;
  readonly errors: string[];
}

/** What one tick did, filled in as it goes and returned at the end. */
type Tally = { -readonly [K in keyof TickResult]: TickResult[K] };

interface Heartbeat {
  readonly last?: string;
  readonly alive?: string;
}

interface Tick {
  readonly home: string;
  readonly now: () => string;
  readonly at: string;
  readonly env?: Env;
  readonly result: Tally;
}

const isDomainError = (error: unknown): error is Error => error instanceof InputError || error instanceof ToolRefusal || error instanceof ActionFailure;
const label = (record: RunRecord): string => `${record.workflow} ${record.run_id} (${record.status})`;

async function lockTick(home: string): Promise<string | null> {
  const path = await confinedPath(home, TICK_LOCK);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(process.pid), "utf8");
      await handle.close();
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number(await readFile(path, "utf8").catch(() => "0"));
      if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) return null;
      await rm(path, { force: true });
    }
  }
  return null;
}

async function workflows(tick: Tick): Promise<Workflow[]> {
  const loaded: Workflow[] = [];
  for (const id of await workflowIds(tick.home)) {
    try {
      loaded.push(await loadWorkflow(tick.home, id, DEFAULT_TOOLS));
    } catch (error) {
      if (!isDomainError(error)) throw error;
      tick.result.errors.push(error.message);
    }
  }
  return loaded;
}

/** Cron slots since the last heartbeat (or within the tolerance, the first time): run if in time, else missed. */
async function scheduled(tick: Tick, workflow: Workflow, last: string | null): Promise<void> {
  if (workflow.trigger.kind !== "cron") return;
  const { cron, tz, tolerance_minutes: tolerance } = workflow.trigger;
  const toleranceMs = tolerance * MINUTE_MS;
  const window = new Date(Date.parse(tick.at) - toleranceMs).toISOString();
  const after = last !== null && last < window ? last : window;
  for (const slot of cronTimes(cron, tz, new Date(Date.parse(after) - 1).toISOString(), tick.at)) {
    const key = `${workflow.id}:${slot}`;
    if (await runForKey(tick.home, key)) continue;
    if (Date.parse(tick.at) - Date.parse(slot) > toleranceMs) {
      const missed = await recordMissed(tick.home, workflow.id, workflow.version, key, slot, tick.at);
      if (missed) tick.result.missed.push(label(missed));
      continue;
    }
    tick.result.started.push(label(await startRun({ home: tick.home, workflow, key, trigger: { kind: "cron", scheduled_for: slot }, now: tick.now, ...(tick.env ? { env: tick.env } : {}) })));
  }
}

/** D84: one notice when the host comes back, with the downtime and the runs that were missed (not run). */
async function backOnline(tick: Tick, last: string): Promise<void> {
  const minutes = Math.round((Date.parse(tick.at) - Date.parse(last)) / MINUTE_MS);
  const missed = tick.result.missed.length === 0 ? "none" : tick.result.missed.join("; ");
  const text = `The host is back online. The runner did not run from ${last} to ${tick.at} (${minutes} minutes). Missed runs, not run: ${missed}. To run one now: installer run <workflow>.`;
  const name = (await loadState(tick.home))?.roles?.decision_maker;
  let error: string | null = name ? null : "no decision maker is set (MODE phase)";
  if (name) {
    try {
      await invokeTool(await toolContext(tick.home, "runner", DEFAULT_TOOLS, tick.now), "channel.notify", { member: name, text: text.slice(0, 2000) });
    } catch (failure) {
      if (!isDomainError(failure)) throw failure;
      error = failure.message;
    }
  }
  await appendAudit(tick.home, { ts: tick.at, actor: "engine", event: "runner.back_online", ref: "runner", payload: { from: last, to: tick.at, missed: tick.result.missed, delivered: error === null, ...(error ? { error } : {}) } });
  tick.result.back_online = true;
}

function wants(workflow: Workflow, item: InboxItem): boolean {
  if (workflow.trigger.kind !== "event") return false;
  const route = workflow.trigger.from === "external" ? "event" : "conversation";
  return item.route === route && (workflow.trigger.channel === undefined || workflow.trigger.channel === item.channel);
}

/** D88: each new inbox message starts the workflows whose event trigger it matches; the first tick only sets the cursor. */
async function events(tick: Tick, loaded: readonly Workflow[]): Promise<void> {
  const cursor = (await readConfig(tick.home, EVENTS_CURSOR)) as { last_id?: number } | null;
  const items = (await listInbox(tick.home)).filter((item) => cursor?.last_id === undefined || item.id > cursor.last_id).reverse();
  if (cursor?.last_id === undefined) {
    await writeConfig(tick.home, EVENTS_CURSOR, { last_id: items.at(-1)?.id ?? 0 });
    return;
  }
  for (const item of items) {
    for (const workflow of loaded.filter((entry) => wants(entry, item))) {
      const key = `${workflow.id}:inbox:${item.id}`;
      tick.result.started.push(label(await startRun({ home: tick.home, workflow, key, trigger: { kind: "event", inbox_id: item.id }, now: tick.now, ...(tick.env ? { env: tick.env } : {}) })));
      tick.result.events += 1;
    }
    await writeConfig(tick.home, EVENTS_CURSOR, { last_id: item.id });
  }
}

/** A damaged run record is skipped, audited and named in the tick's errors; the other runs still resume. */
async function damagedRun(tick: Tick, error: Error, workflow: string, runId: string): Promise<void> {
  await appendAudit(tick.home, { ts: tick.at, actor: "engine", event: "run.damaged", ref: `run:${workflow}/${runId}`, payload: { error: error.message } });
  tick.result.errors.push(`resume: ${error.message}`);
}

/** Runs waiting for an approval, or left `running` by a process that is gone, continue (§10.7). */
async function resumable(tick: Tick, loaded: readonly Workflow[]): Promise<void> {
  for (const record of await listRuns(tick.home, undefined, (error, workflow, runId) => damagedRun(tick, error, workflow, runId))) {
    const stuck = record.status === "waiting" || (record.status === "running" && !isAlive(record.pid));
    const workflow = loaded.find((entry) => entry.id === record.workflow);
    if (!stuck || !workflow) continue;
    const after = await resumeRun({ home: tick.home, workflow, key: record.key, trigger: record.trigger, now: tick.now, ...(tick.env ? { env: tick.env } : {}) }, record);
    if (after !== record) tick.result.resumed.push(label(after));
  }
}

async function guard(tick: Tick, name: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    if (!isDomainError(error)) throw error;
    tick.result.errors.push(`${name}: ${error.message}`);
  }
}

export async function tick(home: string, now: () => string = () => new Date().toISOString(), env?: Env): Promise<TickResult> {
  const result: Tally = { status: "ran", started: [], missed: [], resumed: [], events: 0, back_online: false, errors: [] };
  const lock = await lockTick(home);
  if (lock === null) return { ...result, status: "busy" };
  try {
    const state: Tick = { home, now, at: now(), ...(env ? { env } : {}), result };
    const beat = ((await readConfig(home, HEARTBEAT_FILE)) as Heartbeat | null) ?? {};
    const last = beat.last ?? null;
    const alive = beat.alive ?? last;
    await writeConfig(home, HEARTBEAT_FILE, { ...beat, alive: state.at, pid: process.pid });
    const loaded = await workflows(state);
    for (const workflow of loaded) await guard(state, workflow.id, () => scheduled(state, workflow, last));
    await guard(state, "report", async () => {
      const reports = await dueReports(home, now, state.at, last);
      result.started.push(...reports.sent.map(label));
      result.missed.push(...reports.missed.map(label));
    });
    if (alive !== null && Date.parse(state.at) - Date.parse(alive) > BACK_ONLINE_GAP_MS) await backOnline(state, alive);
    // Written before the parts that can still fail, so a failing tick never sends the back-online notice twice.
    await writeConfig(home, HEARTBEAT_FILE, { last: state.at, alive: state.at, pid: process.pid });
    await guard(state, "events", () => events(state, loaded));
    await guard(state, "resume", () => resumable(state, loaded));
    await writeConfig(home, HEARTBEAT_FILE, { last: state.at, alive: now(), pid: process.pid });
    return { ...result };
  } finally {
    await rm(lock, { force: true });
  }
}
