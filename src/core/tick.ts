import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import { ToolRefusal } from "./approvals.js";
import { remindApprovals, repeatAlerts } from "./alerts.js";
import { appendAudit } from "./audit.js";
import { MINUTE_MS, cronTimes } from "./cron.js";
import { dueReports } from "./daily-report.js";
import { dailyDoctor } from "./doctor.js";
import { noticeHabits } from "./watch-notice.js";
import { readConfig, writeConfig } from "./data-source.js";
import { createExclusive, isAlive } from "./durable.js";
import { ActionFailure } from "./failure.js";
import { keepGatewayRunning, startGateway } from "./gateway-process.js";
import { listInbox, type InboxItem } from "./inbox.js";
import { isPaused } from "./pause.js";
import { collectLearnings, submitLearnings } from "./learning.js";
import { InputError } from "./inputs.js";
import { resumeRun, startRun } from "./runner.js";
import { listRuns, recordMissed, runForKey, type OnDamaged, type RunRecord } from "./runs.js";
import { loadState } from "./state.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { invokeTool, toolContext } from "./tools.js";
import { loadWorkflow, workflowIds, type Workflow } from "./workflow.js";

/**
 * The runner's minute (D82, D84, D88). One OS scheduler entry runs `taskfollow tick` every minute; the tick, under
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
  /** `paused`: the kill switch is on (D101); the tick only notes that the host is alive. */
  readonly status: "ran" | "busy" | "paused";
  readonly started: string[];
  readonly missed: string[];
  readonly resumed: string[];
  readonly events: number;
  readonly back_online: boolean;
  /** Urgent alerts sent again, approvals reminded, and event runs not started because of the rate limits (D95, D96). */
  readonly alerts: number;
  readonly reminded: number[];
  readonly rate_limited: number;
  /** Learnings sent to Skills Wiki (D97). */
  readonly learnings: number;
  /** What the tick did about the gateway (D130): `started` after finding it dead, `null` when the tick stopped early. */
  readonly gateway: "running" | "started" | "stopped" | "no_channel" | "skipped" | null;
  /** The daily doctor's overall status when it ran in this tick (D103). */
  readonly doctor: "ok" | "warn" | "fail" | null;
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
    if (await createExclusive(path, String(process.pid))) return path;
    const holder = Number(await readFile(path, "utf8").catch(() => "0"));
    if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) return null;
    await rm(path, { force: true });
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
  const text = `The host is back online. The runner did not run from ${last} to ${tick.at} (${minutes} minutes). Missed runs, not run: ${missed}. To run one now: taskfollow run <workflow>.`;
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

export function wants(workflow: Workflow, item: InboxItem): boolean {
  if (workflow.trigger.kind !== "event") return false;
  const route = workflow.trigger.from === "external" ? "event" : "conversation";
  return item.route === route && (workflow.trigger.channel === undefined || workflow.trigger.channel === item.channel);
}
/** D96: a sender may start EVENT_RUNS_PER_SENDER runs of one workflow an hour, and a workflow EVENT_RUNS_PER_HOUR event runs. */
export const EVENT_RUNS_PER_SENDER = 3;
export const EVENT_RUNS_PER_HOUR = 30;

async function eventLimited(tick: Tick, workflow: Workflow, item: InboxItem, inbox: readonly InboxItem[]): Promise<string | null> {
  const since = new Date(Date.parse(tick.at) - 60 * MINUTE_MS).toISOString();
  const recent = (await listRuns(tick.home, workflow.id)).filter((run) => run.trigger.kind === "event" && run.started_at > since);
  const sender = (run: RunRecord): InboxItem | undefined => inbox.find((entry) => entry.id === run.trigger.inbox_id);
  const bySender = recent.filter((run) => sender(run)?.channel === item.channel && sender(run)?.from === item.from).length;
  if (bySender >= EVENT_RUNS_PER_SENDER) return `${item.channel} sender ${item.from} started ${bySender} runs of '${workflow.id}' in the last hour`;
  return recent.length >= EVENT_RUNS_PER_HOUR ? `'${workflow.id}' started ${recent.length} event runs in the last hour` : null;
}

async function startEvent(tick: Tick, workflow: Workflow, item: InboxItem, inbox: readonly InboxItem[]): Promise<void> {
  const limited = await eventLimited(tick, workflow, item, inbox);
  if (limited !== null) {
    await appendAudit(tick.home, { ts: tick.at, actor: "engine", event: "run.rate_limited", ref: `inbox:${item.id}`, payload: { workflow: workflow.id, reason: limited } });
    tick.result.rate_limited += 1;
    return;
  }
  const key = `${workflow.id}:inbox:${item.id}`;
  tick.result.started.push(label(await startRun({ home: tick.home, workflow, key, trigger: { kind: "event", inbox_id: item.id }, now: tick.now, ...(tick.env ? { env: tick.env } : {}) })));
  tick.result.events += 1;
}

/** D88: each new inbox message starts the workflows whose event trigger it matches; the first tick only sets the cursor. */
async function events(tick: Tick, loaded: readonly Workflow[]): Promise<void> {
  const cursor = (await readConfig(tick.home, EVENTS_CURSOR)) as { last_id?: number } | null;
  const inbox = await listInbox(tick.home);
  const items = inbox.filter((item) => cursor?.last_id === undefined || item.id > cursor.last_id).reverse();
  if (cursor?.last_id === undefined) {
    await writeConfig(tick.home, EVENTS_CURSOR, { last_id: items.at(-1)?.id ?? 0 });
    return;
  }
  for (const item of items) {
    for (const workflow of loaded.filter((entry) => wants(entry, item))) await startEvent(tick, workflow, item, inbox);
    await writeConfig(tick.home, EVENTS_CURSOR, { last_id: item.id });
  }
}

/** A damaged run record is skipped, audited and named in the tick's errors; the other runs still resume or report. */
const damagedRun = (tick: Tick, pass: string): OnDamaged => async (error, workflow, runId) => {
  await appendAudit(tick.home, { ts: tick.at, actor: "engine", event: "run.damaged", ref: `run:${workflow}/${runId}`, payload: { error: error.message } });
  tick.result.errors.push(`${pass}: ${error.message}`);
};

/** Runs waiting for an approval, or left `running` by a process that is gone, continue (§10.7). */
async function resumable(tick: Tick, loaded: readonly Workflow[]): Promise<void> {
  for (const record of await listRuns(tick.home, undefined, damagedRun(tick, "resume"))) {
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

export async function tick(home: string, now: () => string = () => new Date().toISOString(), env?: Env, start: typeof startGateway = startGateway): Promise<TickResult> {
  const result: Tally = { status: "ran", started: [], missed: [], resumed: [], events: 0, back_online: false, alerts: 0, reminded: [], rate_limited: 0, learnings: 0, gateway: null, doctor: null, errors: [] };
  const lock = await lockTick(home);
  if (lock === null) return { ...result, status: "busy" };
  try {
    const state: Tick = { home, now, at: now(), ...(env ? { env } : {}), result };
    const beat = ((await readConfig(home, HEARTBEAT_FILE)) as Heartbeat | null) ?? {};
    const last = beat.last ?? null;
    const alive = beat.alive ?? last;
    await writeConfig(home, HEARTBEAT_FILE, { ...beat, alive: state.at, pid: process.pid });
    // Paused (D101): no run starts or resumes; `last` stays, so slots that fall due meanwhile are recorded as missed afterwards.
    if (await isPaused(home)) return { ...result, status: "paused" };
    const loaded = await workflows(state);
    for (const workflow of loaded) await guard(state, workflow.id, () => scheduled(state, workflow, last));
    await guard(state, "report", async () => {
      const reports = await dueReports(home, now, state.at, last, damagedRun(state, "report"));
      result.started.push(...reports.sent.map(label));
      result.missed.push(...reports.missed.map(label));
    });
    if (alive !== null && Date.parse(state.at) - Date.parse(alive) > BACK_ONLINE_GAP_MS) await backOnline(state, alive);
    // Written before the parts that can still fail, so a failing tick never sends the back-online notice twice.
    await writeConfig(home, HEARTBEAT_FILE, { last: state.at, alive: state.at, pid: process.pid });
    await guard(state, "events", () => events(state, loaded));
    await guard(state, "resume", () => resumable(state, loaded));
    await guard(state, "alerts", async () => {
      result.alerts = await repeatAlerts(await toolContext(home, "runner", DEFAULT_TOOLS, now), (await loadState(home))?.roles);
      result.reminded = await remindApprovals(await toolContext(home, "gateway", DEFAULT_TOOLS, now));
    });
    await guard(state, "learning", async () => {
      await collectLearnings(home, state.at);
      result.learnings = (await submitLearnings(home, (await loadState(home))?.skillswiki?.url, state.at)).length;
    });
    await guard(state, "gateway", async () => {
      result.gateway = await keepGatewayRunning(home, now, env ?? process.env, start);
    });
    // D148: at most once a day, a suggestion about work the person's agent did often outside TaskFollow, to them only.
    await guard(state, "notice", async () => {
      const ctx = await toolContext(home, "runner", DEFAULT_TOOLS, now);
      await noticeHabits(home, now, async (member, text) => void (await invokeTool(ctx, "channel.notify", { member, text })));
    });
    // Item 7a: checks that expired are ended and what they made (test files, skills, tabs) is removed.
    await guard(state, "checks", async () => {
      await (await import("./check-fresh.js")).sweepChecks(home, now());
    });
    await guard(state, "doctor", async () => {
      result.doctor = (await dailyDoctor(home, now, env))?.status ?? null;
    });
    await writeConfig(home, HEARTBEAT_FILE, { last: state.at, alive: now(), pid: process.pid });
    return { ...result };
  } finally {
    await rm(lock, { force: true });
  }
}
