import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { confinedPath } from "./actions.js";
import { appendAudit } from "./audit.js";
import { listChannels } from "./channels.js";
import { readConfig } from "./data-source.js";
import { createExclusive, isAlive } from "./durable.js";
import { ActionFailure } from "./failure.js";
import { GATEWAY_DIR, LOG_FILE, gatewayLog, runGateway, statusFile } from "./gateway.js";
import { InputError } from "./inputs.js";
import { installerCliPath } from "./register.js";

/**
 * `taskfollow gateway start | stop | status` (D72): the gateway is a detached process of its own,
 * `taskfollow --home <home> gateway-serve`, recorded in `runtime/gateway/gateway.pid`. Start is idempotent: a live
 * gateway is left alone, and a pid file whose process is gone (a crash, a reboot) is removed and a new gateway
 * started. Stop sends SIGTERM, which ends the long poll at once. Starting it at boot and restarting it after a
 * crash by the OS (launchd, systemd) is Plan 9's host service (D104). The pid file is claimed with an exclusive create,
 * so two starts at the same moment leave one gateway (D103).
 */
export const PID_FILE = join(GATEWAY_DIR, "gateway.pid");
const READY_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 10_000;
export const POLL_SECONDS = 25;
export const PAUSE_MS = 60_000;
const LOOPS = ["telegram", "email", "approvals"];

interface PidRecord {
  readonly pid: number;
  readonly started_at: string;
}

async function readPid(home: string): Promise<PidRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(await confinedPath(home, PID_FILE), "utf8")) as Partial<PidRecord>;
    return typeof parsed.pid === "number" && typeof parsed.started_at === "string" ? { pid: parsed.pid, started_at: parsed.started_at } : null;
  } catch {
    return null;
  }
}

const removePid = async (home: string): Promise<void> => rm(await confinedPath(home, PID_FILE), { force: true });

export async function gatewayStatus(home: string): Promise<Record<string, unknown>> {
  const record = await readPid(home);
  if (!record) return { status: "stopped" };
  if (!isAlive(record.pid)) return { status: "stale", pid: record.pid, note: "The gateway stopped without cleaning up (a crash or a restart): run 'taskfollow gateway start'" };
  const rounds = Object.fromEntries(await Promise.all(LOOPS.map(async (name) => [name, ((await readConfig(home, statusFile(name))) as { last_round?: string } | null)?.last_round ?? null])));
  return { status: "running", ...record, last_round: rounds, log: await confinedPath(home, LOG_FILE) };
}

/** Spawns `gateway-serve` detached and waits until it says it is ready (or fails to start). */
function spawnGateway(home: string): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [installerCliPath(), "--home", home, "gateway-serve"], { detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const timer = setTimeout(() => fail(new ActionFailure(`The gateway did not start within ${READY_TIMEOUT_MS / 1000} s; see ${LOG_FILE} in the home`)), READY_TIMEOUT_MS);
    child.once("message", () => {
      clearTimeout(timer);
      child.disconnect();
      child.unref();
      done(child.pid ?? 0);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new ActionFailure(`The gateway could not start (exit ${code}); see ${LOG_FILE} in the home`));
    });
  });
}

export async function startGateway(home: string, now: () => string): Promise<Record<string, unknown>> {
  if ((await listChannels(home)).length === 0) throw new InputError("No channel is set up yet: run 'taskfollow channel telegram' or 'taskfollow channel email' first");
  const current = await gatewayStatus(home);
  if (current.status === "running") return { ...current, note: "The gateway is already running" };
  if (current.status === "stale") await removePid(home);
  let pid: number;
  try {
    pid = await spawnGateway(home);
  } catch (error) {
    // Another start may have won the race for the pid file: then the gateway runs, which is what was asked.
    const raced = await gatewayStatus(home);
    if (raced.status === "running") return { ...raced, note: "Another start won the race: the gateway is running" };
    throw error;
  }
  await appendAudit(home, { ts: now(), actor: "engine", event: "gateway.started", ref: "gateway", payload: { pid, replaced_stale: current.status === "stale" } });
  return { status: "started", pid, log: await confinedPath(home, LOG_FILE), ...(current.status === "stale" ? { note: `Replaced a gateway that had stopped without cleaning up (pid ${String(current.pid)})` } : {}) };
}

/** Restarts the gateway so it reads a channel that was added after it started: it reads its channels only at start (D134). */
export async function restartGateway(
  home: string,
  now: () => string,
  deps: { status: (home: string) => Promise<Record<string, unknown>>; stop: StartGateway; start: StartGateway } = { status: gatewayStatus, stop: stopGateway, start: startGateway },
): Promise<Record<string, unknown>> {
  if ((await deps.status(home)).status === "running") await deps.stop(home, now);
  return deps.start(home, now);
}

/** `none` leaves the gateway alone (the test suite sets it, so no test starts a real process). */
export const GATEWAY_AUTOSTART_ENV = "INSTALLER_GATEWAY_AUTOSTART";
type StartGateway = (home: string, now: () => string) => Promise<Record<string, unknown>>;

/**
 * Called by every tick (D130). A personal install has no boot service, so a gateway lost to a restart or a sign-out would
 * silently stop join codes, approvals and /unpause. A stale record means it died unexpectedly: start it again. No record
 * means it was stopped on purpose (`gateway stop` removes it) or never started: leave it.
 */
export async function keepGatewayRunning(home: string, now: () => string, env: Readonly<Record<string, string | undefined>> = process.env, start: StartGateway = startGateway): Promise<"running" | "started" | "stopped" | "no_channel" | "skipped"> {
  if (env[GATEWAY_AUTOSTART_ENV] === "none") return "skipped";
  if ((await listChannels(home)).length === 0) return "no_channel";
  const status = (await gatewayStatus(home)).status;
  if (status === "running") return "running";
  if (status !== "stale") return "stopped";
  await start(home, now);
  return "started";
}

export async function stopGateway(home: string, now: () => string): Promise<Record<string, unknown>> {
  const record = await readPid(home);
  if (!record || !isAlive(record.pid)) {
    await removePid(home);
    return { status: "not_running" };
  }
  process.kill(record.pid, "SIGTERM");
  const until = Date.now() + STOP_TIMEOUT_MS;
  while (isAlive(record.pid) && Date.now() < until) await sleep(50);
  if (isAlive(record.pid)) process.kill(record.pid, "SIGKILL");
  await removePid(home);
  await appendAudit(home, { ts: now(), actor: "engine", event: "gateway.stopped", ref: "gateway", payload: { pid: record.pid } });
  return { status: "stopped", pid: record.pid };
}

export async function gatewayCommand(home: string, sub: string | undefined, now: () => string): Promise<Record<string, unknown>> {
  if (sub === "start") return startGateway(home, now);
  if (sub === "stop") return stopGateway(home, now);
  if (sub === "status") return gatewayStatus(home);
  throw new InputError("gateway needs one of: start, stop, status");
}

/**
 * Claims the pid file for this process with an exclusive create, so of two gateways starting at once exactly one
 * wins (D103: the read-then-remove of Plan 6 let both run). A live owner wins; a dead one is replaced once.
 */
export async function claimPid(home: string, startedAt: string): Promise<void> {
  const path = await confinedPath(home, PID_FILE);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await createExclusive(path, JSON.stringify({ pid: process.pid, started_at: startedAt }))) return;
    const existing = await readPid(home);
    if (existing && existing.pid !== process.pid && isAlive(existing.pid)) throw new ActionFailure(`Another gateway is running for this home (pid ${existing.pid})`);
    await rm(path, { force: true });
  }
  throw new ActionFailure("Another gateway claimed this home at the same moment: run 'taskfollow gateway status'");
}

/** The detached process itself: claims the pid file, reports ready over IPC, runs until SIGTERM. */
export async function serveGateway(home: string): Promise<number> {
  const startedAt = new Date().toISOString();
  await claimPid(home, startedAt);
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  process.once("SIGINT", () => stop.abort());
  process.send?.({ ready: true });
  try {
    await runGateway({ home, signal: stop.signal, pollSeconds: POLL_SECONDS, pauseMs: PAUSE_MS });
  } catch (error) {
    await gatewayLog(home, new Date().toISOString(), { level: "error", event: "crashed", error: (error as Error).message });
    throw error;
  } finally {
    if ((await readPid(home))?.pid === process.pid) await removePid(home);
  }
  return 0;
}
