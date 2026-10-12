import { connectorUrl, type ConnectorDef } from "./connectors.js";
import { ActionFailure } from "./failure.js";
import type { AccessTokenSource } from "./google-auth.js";

/**
 * The Google Sheets adapter: Sheets API v4 REST through fetch, nothing else (D67). Cells travel as text
 * (`valueInputOption=RAW`), so a value is stored exactly as given and never parsed as a formula.
 * A location without a tab means the spreadsheet's first sheet.
 */
export interface SheetLocation {
  readonly spreadsheet_id: string;
  readonly tab?: string;
}

export interface RowUpdate {
  readonly row: number;
  readonly cells: readonly string[];
}

export interface CreatedSheet {
  readonly spreadsheet_id: string;
  readonly url: string;
}

export interface SheetsClient {
  /** Every row of the sheet, header first, each cell as text; trailing empty cells may be missing. */
  readonly readRows: (location: SheetLocation) => Promise<string[][]>;
  readonly appendRow: (location: SheetLocation, row: readonly string[]) => Promise<void>;
  /** Appends several rows in one call. */
  readonly appendRows: (location: SheetLocation, rows: readonly (readonly string[])[]) => Promise<void>;
  /** Replaces row `rowNumber` (1 = the header row) from column A, as wide as `row`. */
  readonly writeRow: (location: SheetLocation, rowNumber: number, row: readonly string[]) => Promise<void>;
  /** Rewrites several rows in one `values.batchUpdate` call. */
  readonly writeRows: (location: SheetLocation, updates: readonly RowUpdate[]) => Promise<void>;
  /** `spreadsheets.create` in the signed-in account, then the header row on its one tab (§9.1 default store). */
  readonly createSpreadsheet: (title: string, tab: string, header: readonly string[]) => Promise<CreatedSheet>;
}

const SHEETS_TIMEOUT_MS = 30_000;
/** Reads cover columns A to ZZ (702 columns). */
const LAST_COLUMN = "ZZ";
type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

/** 1 → A, 26 → Z, 27 → AA. */
export function columnLetter(index: number): string {
  return index <= 0 ? "" : columnLetter(Math.floor((index - 1) / 26)) + String.fromCharCode(65 + ((index - 1) % 26));
}

/** A1 notation: a tab name is quoted and its quotes doubled; no tab = the first sheet. */
export function a1Range(location: SheetLocation, cells: string): string {
  return location.tab === undefined ? cells : `'${location.tab.replace(/'/g, "''")}'!${cells}`;
}

function failureFor(status: number, message: string, location: SheetLocation | null, secretId: string): ActionFailure {
  const id = location?.spreadsheet_id ?? "";
  if (status === 401) return new ActionFailure(`Google Sheets refused the sign-in: run 'installer secret ${secretId}' to sign in again`);
  if (status === 403) return new ActionFailure(`Google Sheets denied access to spreadsheet ${id}: open it with the Google account you signed in with, or share it with that account`);
  if (status === 404) return new ActionFailure(`Google Sheets has no spreadsheet ${id}: check the link`);
  if (status === 400) return new ActionFailure(`Google Sheets refused the request: ${message}`);
  return new ActionFailure(`Google Sheets answered HTTP ${status}; try again in a minute`);
}

interface Call {
  readonly method: "GET" | "POST" | "PUT";
  readonly path: string;
  readonly body?: unknown;
  readonly location: SheetLocation | null;
}

async function callSheets(def: ConnectorDef, tokens: AccessTokenSource, call: Call, env: Env): Promise<Raw> {
  const headers = { authorization: `Bearer ${await tokens.accessToken()}`, ...(call.body === undefined ? {} : { "content-type": "application/json" }) };
  let response: Response;
  try {
    response = await fetch(`${connectorUrl(def.api.base_url, env)}${call.path}`, {
      method: call.method, headers, ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }), signal: AbortSignal.timeout(SHEETS_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ActionFailure(`Cannot reach Google Sheets (${(error as Error).message})`);
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return isRecord(body) ? body : {};
  const message = isRecord(body) && isRecord(body.error) && typeof body.error.message === "string" ? body.error.message : `HTTP ${response.status}`;
  throw failureFor(response.status, message, call.location, def.auth.secret_id);
}

const rowRange = (location: SheetLocation, update: RowUpdate): string => a1Range(location, `A${update.row}:${columnLetter(Math.max(update.cells.length, 1))}${update.row}`);

const valuesPath = (location: SheetLocation, range: string): string => `/spreadsheets/${encodeURIComponent(location.spreadsheet_id)}/values/${encodeURIComponent(range)}`;

const asRows = (values: unknown): string[][] => (Array.isArray(values) ? values.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : [])) : []);

export function sheetsClient(def: ConnectorDef, tokens: AccessTokenSource, env: Env = process.env): SheetsClient {
  const call = (request: Call): Promise<Raw> => callSheets(def, tokens, request, env);
  const writeRow = async (location: SheetLocation, rowNumber: number, row: readonly string[]): Promise<void> => {
    const range = rowRange(location, { row: rowNumber, cells: row });
    await call({ method: "PUT", path: `${valuesPath(location, range)}?valueInputOption=RAW`, body: { values: [row] }, location });
  };
  const appendRows = async (location: SheetLocation, rows: readonly (readonly string[])[]): Promise<void> => {
    const path = `${valuesPath(location, a1Range(location, `A1:${LAST_COLUMN}`))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    await call({ method: "POST", path, body: { values: rows }, location });
  };
  return {
    readRows: async (location) => asRows((await call({ method: "GET", path: valuesPath(location, a1Range(location, `A1:${LAST_COLUMN}`)), location })).values),
    appendRow: (location, row) => appendRows(location, [row]),
    appendRows,
    writeRow,
    writeRows: async (location, updates) => {
      const data = updates.map((update) => ({ range: rowRange(location, update), values: [update.cells] }));
      await call({ method: "POST", path: `/spreadsheets/${encodeURIComponent(location.spreadsheet_id)}/values:batchUpdate`, body: { valueInputOption: "RAW", data }, location });
    },
    createSpreadsheet: async (title, tab, header) => {
      const created = await call({ method: "POST", path: "/spreadsheets", body: { properties: { title }, sheets: [{ properties: { title: tab } }] }, location: null });
      const id = created.spreadsheetId;
      if (typeof id !== "string") throw new ActionFailure("Google Sheets created no spreadsheet id");
      await writeRow({ spreadsheet_id: id, tab }, 1, header);
      return { spreadsheet_id: id, url: typeof created.spreadsheetUrl === "string" ? created.spreadsheetUrl : `https://docs.google.com/spreadsheets/d/${id}/edit` };
    },
  };
}

/** A spreadsheet id that cannot exist: asking for it proves the sign-in and the API without touching any real sheet. */
export const READINESS_PROBE_ID = "installer-readiness-probe";

export type SheetsProbe =
  | { readonly state: "enabled" }
  | { readonly state: "disabled" }
  | { readonly state: "refused" }
  | { readonly state: "other"; readonly status: number; readonly reason: string };

/** Google's first error reason (`details[].reason`), else its error status, else empty. */
function errorReason(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.error)) return "";
  const details = Array.isArray(body.error.details) ? body.error.details : [];
  const reason = details.find((detail): detail is Raw => isRecord(detail) && typeof detail.reason === "string");
  return typeof reason?.reason === "string" ? reason.reason : typeof body.error.status === "string" ? body.error.status : "";
}

/** Google's answer for a project that never enabled the API: 403 with reason SERVICE_DISABLED (or its message). */
function apiDisabled(body: unknown): boolean {
  if (errorReason(body) === "SERVICE_DISABLED") return true;
  return isRecord(body) && isRecord(body.error) && typeof body.error.message === "string" && /Sheets API has not been used in project/i.test(body.error.message);
}

/**
 * Live setup guides, 4.5: one GET for a spreadsheet that cannot exist. 404 with Google's status NOT_FOUND = the API is
 * enabled and the token works (a bare 404 from a proxy is not trusted); 403 SERVICE_DISABLED = the API is off in the
 * person's project; 401 = the token was refused. Anything else is reported as it is, so the step fails and can be
 * retried. It calls only the Sheets API.
 */
export async function probeSheetsApi(def: ConnectorDef, tokens: AccessTokenSource, env: Env = process.env): Promise<SheetsProbe> {
  const token = await tokens.accessToken();
  let response: Response;
  try {
    response = await fetch(`${connectorUrl(def.api.base_url, env)}/spreadsheets/${READINESS_PROBE_ID}?fields=spreadsheetId`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(SHEETS_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ActionFailure(`Cannot reach Google Sheets (${(error as Error).message})`);
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 404 && errorReason(body) === "NOT_FOUND") return { state: "enabled" };
  if (response.status === 401) return { state: "refused" };
  if (response.status === 403 && apiDisabled(body)) return { state: "disabled" };
  return { state: "other", status: response.status, reason: errorReason(body) };
}
