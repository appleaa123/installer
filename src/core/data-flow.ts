import { readdir } from "node:fs/promises";
import { confinedPath } from "./actions.js";
import { listChannels } from "./channels.js";
import type { DataContract } from "./contract.js";
import { SOURCES_DIR, loadSource, readConfig } from "./data-source.js";
import { loadDoctorReport } from "./doctor.js";
import { READINESS_FILE, type Readiness } from "./host.js";
import type { FieldTag } from "./levels.js";
import { loadModelConfig } from "./model.js";
import { loadPause, type PauseState } from "./pause.js";
import { loadPinnedContract } from "./pin.js";
import type { InstallState } from "./types.js";

/**
 * The data-flow summary (spec §14.6, D106): which fields, by tag, go to which outside party: the model vendor (through
 * the agent's headless calls or the direct model), each connected source, each channel, Skills Wiki, and a support
 * bundle when the person sends one. Worked out from the pinned contract and what is set up, never from the model.
 * Clients need it for their privacy duties (PIPEDA, GDPR). The report shows it with the kill switch, the last
 * doctor run and the host readiness score, without changing `buildReport` (which stays pure).
 */
export interface FlowRow {
  readonly party: string;
  readonly via: string;
  readonly receives: string;
  readonly never?: string;
}

export interface OperationsView {
  readonly paused: PauseState | null;
  readonly doctor: { readonly status: string; readonly checked_at: string } | null;
  readonly readiness: { readonly score: string; readonly applies: boolean; readonly checked_at: string } | null;
  readonly data_flow: readonly FlowRow[];
}

type Tagged = FieldTag | "untagged";

/** `personal: contact.email, contact.name; untagged: contact.notes` for the entities given, leaving out `without`. */
export function fieldsByTag(contract: DataContract | null, entities: readonly string[] | null, without: readonly FieldTag[] = []): string {
  const groups = new Map<Tagged, string[]>();
  for (const [entity, def] of Object.entries(contract?.entities ?? {})) {
    if (entities !== null && !entities.includes(entity)) continue;
    for (const [field, spec] of Object.entries(def.fields)) {
      if (spec.tags.some((tag) => without.includes(tag))) continue;
      for (const tag of spec.tags.length === 0 ? (["untagged"] as const) : spec.tags) groups.set(tag, [...(groups.get(tag) ?? []), `${entity}.${field}`]);
    }
  }
  return groups.size === 0 ? "no record fields" : [...groups.entries()].map(([tag, fields]) => `${tag}: ${fields.join(", ")}`).join("; ");
}

async function modelRow(home: string, state: InstallState, contract: DataContract | null): Promise<FlowRow | null> {
  const runtime = state.runtime;
  const config = await loadModelConfig(home);
  const via = runtime?.profile && runtime.c4_headless ? `your agent (${runtime.profile}) in headless calls with every tool off` : config ? `the direct model API (${config.provider}, ${config.model}) with your own key` : null;
  if (via === null) return null;
  return { party: "Model vendor", via, receives: `what judge and agent steps are given: ${fieldsByTag(contract, null, ["protected_ground"])}`, never: "fields tagged protected_ground (removed before every judge and agent call)" };
}

async function sourceRows(home: string, contract: DataContract | null): Promise<FlowRow[]> {
  let names: string[];
  try {
    names = (await readdir(await confinedPath(home, SOURCES_DIR))).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: FlowRow[] = [];
  for (const name of names) {
    const source = await loadSource(home, name.slice(0, -".json".length));
    if (source) rows.push({ party: source.connector.id, via: `the spreadsheet of '${source.entity}', your system of record`, receives: `every field of '${source.entity}': ${fieldsByTag(contract, [source.entity])}` });
  }
  return rows;
}

export async function dataFlow(home: string, state: InstallState): Promise<FlowRow[]> {
  const contract = await loadPinnedContract(home);
  const model = await modelRow(home, state, contract);
  const channels = (await listChannels(home)).map((config): FlowRow => ({
    party: config.channel, via: "the gateway, for messages in and out",
    receives: "the text of each message a workflow or a person sends; messages to outside contacts are approved first (L2) and respect opt-outs",
  }));
  return [
    ...(model ? [model] : []),
    ...(await sourceRows(home, contract)),
    ...channels,
    ...(state.skillswiki ? [{ party: "Skills Wiki", via: "the engine's MCP client", receives: "skill and combo requests; learnings from people's corrections with personal and protected_ground values, email addresses and long numbers removed", never: "business records, secrets, inbound messages, the audit" }] : []),
    { party: "Support (only when you send it)", via: "'taskfollow support bundle', a file you send yourself", receives: "the install's state, report, errors and settings, redacted", never: "secrets, names, addresses, message text, personal and protected_ground values" },
  ];
}

export async function operationsView(home: string, state: InstallState): Promise<OperationsView> {
  const doctor = await loadDoctorReport(home);
  const readiness = (await readConfig(home, READINESS_FILE)) as Readiness | null;
  return {
    paused: await loadPause(home),
    doctor: doctor ? { status: doctor.status, checked_at: doctor.checked_at } : null,
    readiness: readiness ? { score: readiness.score, applies: readiness.applies, checked_at: readiness.checked_at } : null,
    data_flow: await dataFlow(home, state),
  };
}

/** The lines the text report adds after Plan 2's (`renderReport`). */
export function renderOperations(view: OperationsView): string[] {
  const host = view.readiness ? `readiness ${view.readiness.score}${view.readiness.applies ? "" : " (Personal mode: for information only)"}` : "not checked yet: run 'taskfollow host'";
  return [
    ...(view.paused?.paused ? [`⏸️ Paused     since ${view.paused.at} by ${view.paused.by}: nothing is sent, no run starts ('taskfollow unpause' in a person's terminal)`] : []),
    `🩺 Doctor     ${view.doctor ? `${view.doctor.status} (${view.doctor.checked_at})` : "never run: run 'taskfollow doctor'"}`,
    `🖥️ Host       ${host}`,
    "🔀 Data flow",
    ...view.data_flow.map((row) => `   ${row.party} — ${row.via}: ${row.receives}${row.never ? `. Never: ${row.never}` : ""}`),
  ];
}
