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

export interface CreatedSheet {
  readonly spreadsheet_id: string;
  readonly url: string;
}

export interface SheetsClient {
  /** Every row of the sheet, header first, each cell as text; trailing empty cells may be missing. */
  readonly readRows: (location: SheetLocation) => Promise<string[][]>;
  readonly appendRow: (location: SheetLocation, row: readonly string[]) => Promise<void>;
  /** Replaces row `rowNumber` (1 = the header row) from column A, as wide as `row`. */
  readonly writeRow: (location: SheetLocation, rowNumber: number, row: readonly string[]) => Promise<void>;
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

const valuesPath = (location: SheetLocation, range: string): string => `/spreadsheets/${encodeURIComponent(location.spreadsheet_id)}/values/${encodeURIComponent(range)}`;

const asRows = (values: unknown): string[][] => (Array.isArray(values) ? values.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : [])) : []);

export function sheetsClient(def: ConnectorDef, tokens: AccessTokenSource, env: Env = process.env): SheetsClient {
  const call = (request: Call): Promise<Raw> => callSheets(def, tokens, request, env);
  const writeRow = async (location: SheetLocation, rowNumber: number, row: readonly string[]): Promise<void> => {
    const range = a1Range(location, `A${rowNumber}:${columnLetter(Math.max(row.length, 1))}${rowNumber}`);
    await call({ method: "PUT", path: `${valuesPath(location, range)}?valueInputOption=RAW`, body: { values: [row] }, location });
  };
  return {
    readRows: async (location) => asRows((await call({ method: "GET", path: valuesPath(location, a1Range(location, `A1:${LAST_COLUMN}`)), location })).values),
    appendRow: async (location, row) => {
      const path = `${valuesPath(location, a1Range(location, `A1:${LAST_COLUMN}`))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
      await call({ method: "POST", path, body: { values: [row] }, location });
    },
    writeRow,
    createSpreadsheet: async (title, tab, header) => {
      const created = await call({ method: "POST", path: "/spreadsheets", body: { properties: { title }, sheets: [{ properties: { title: tab } }] }, location: null });
      const id = created.spreadsheetId;
      if (typeof id !== "string") throw new ActionFailure("Google Sheets created no spreadsheet id");
      await writeRow({ spreadsheet_id: id, tab }, 1, header);
      return { spreadsheet_id: id, url: typeof created.spreadsheetUrl === "string" ? created.spreadsheetUrl : `https://docs.google.com/spreadsheets/d/${id}/edit` };
    },
  };
}
