#!/usr/bin/env node
// Test double for the two Google services the Sheets connector may call: the OAuth token endpoint
// (POST /token) and the Google Sheets API v4 (/v4/spreadsheets…), shaped like Google's documented
// answers. Offline; one process per test file. Prints {"url": …} once listening.
// FAKE_GOOGLE_CLIENT_ID / FAKE_GOOGLE_CLIENT_SECRET: the accepted OAuth client (default client-1 / secret-1).
// The authorization code "code-1" is exchanged for the refresh token "refresh-1".
// Test-only endpoints, no auth: GET|PUT /debug/sheets/<id> reads or seeds a spreadsheet as
// {"title":…,"tabs":{"<tab>":[[…row…],…]}} (the first tab is the first sheet); GET /debug/token-requests counts
// token calls; POST /debug/revoke makes the refresh token invalid; POST /debug/fail {"status":500,"times":1}
// makes the next Sheets answers fail (add "reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT" for a Google error reason, "error_status":"NOT_FOUND" for Google's error status, default UNAVAILABLE);
// POST /debug/disable-sheets and /debug/enable-sheets switch the Sheets API off and on (403 SERVICE_DISABLED, like a
// project that never enabled it).
import { createServer } from "node:http";

const clientId = process.env.FAKE_GOOGLE_CLIENT_ID ?? "client-1";
const clientSecret = process.env.FAKE_GOOGLE_CLIENT_SECRET ?? "secret-1";
const CODE = "code-1";
const REFRESH = "refresh-1";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const issued = new Set();
const sheets = new Map();
let tokenRequests = 0;
let revoked = false;
let testingMode = false;
let sheetsDisabled = false;
let failing = { status: 0, times: 0 };
let created = 0;

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
const googleError = (res, status, message, reason) => send(res, status, { error: { code: status, message, status: reason } });

function readBody(req) {
  return new Promise((done) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => done(body));
  });
}

function newAccessToken() {
  const token = `access-${issued.size + 1}`;
  issued.add(token);
  return token;
}

function token(res, form) {
  tokenRequests += 1;
  if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret) return send(res, 401, { error: "invalid_client", error_description: "The OAuth client was not found." });
  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    const ok = form.get("code") === CODE && (form.get("code_verifier") ?? "").length >= 43 && (form.get("redirect_uri") ?? "").startsWith("http://127.0.0.1:");
    if (!ok) return send(res, 400, { error: "invalid_grant", error_description: "Bad Request" });
    return send(res, 200, { access_token: newAccessToken(), expires_in: 3599, refresh_token: REFRESH, scope: SCOPE, token_type: "Bearer" });
  }
  if (grant === "refresh_token" && form.get("refresh_token") === REFRESH && !revoked) {
    return send(res, 200, { access_token: newAccessToken(), expires_in: 3599, scope: SCOPE, token_type: "Bearer", ...(testingMode ? { refresh_token_expires_in: 604799 } : {}) });
  }
  return send(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
}

/** `'My tab'!A1:ZZ`, `Tab!A5:D5` or `A1:ZZ` (no tab: the first sheet). */
function parseRange(text) {
  const match = /^(?:(?:'((?:[^']|'')+)'|([^!']+))!)?([A-Z]+)(\d+):([A-Z]+)(\d+)?$/.exec(text);
  if (!match) return null;
  const tab = match[1] !== undefined ? match[1].replace(/''/g, "'") : match[2];
  return { tab, fromRow: Number(match[4]), toRow: match[6] === undefined ? Infinity : Number(match[6]) };
}

function tabRows(sheet, tab) {
  const name = tab ?? [...sheet.tabs.keys()][0];
  return sheet.tabs.has(name) ? { name, rows: sheet.tabs.get(name) } : null;
}

function createSpreadsheet(res, body) {
  created += 1;
  const id = `sheet-${created}`;
  const tabs = (body.sheets ?? [{ properties: { title: "Sheet1" } }]).map((tab) => tab.properties?.title ?? "Sheet1");
  sheets.set(id, { title: body.properties?.title ?? "Untitled spreadsheet", tabs: new Map(tabs.map((name) => [name, []])) });
  return send(res, 200, { spreadsheetId: id, properties: { title: sheets.get(id).title }, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit` });
}

function values(res, method, sheet, rangeText, body) {
  const range = parseRange(rangeText);
  const found = range ? tabRows(sheet, range.tab) : null;
  if (!range || !found) return googleError(res, 400, `Unable to parse range: ${rangeText}`, "INVALID_ARGUMENT");
  const { name, rows } = found;
  if (method === "GET") {
    const slice = rows.slice(range.fromRow - 1, range.toRow === Infinity ? undefined : range.toRow);
    return send(res, 200, { range: `'${name}'!${rangeText}`, majorDimension: "ROWS", ...(slice.length > 0 ? { values: slice } : {}) });
  }
  const row = body.values?.[0] ?? [];
  if (method === "PUT") {
    while (rows.length < range.fromRow - 1) rows.push([]);
    rows[range.fromRow - 1] = row;
    return send(res, 200, { updatedRange: `'${name}'!${rangeText}`, updatedRows: 1 });
  }
  rows.push(...(body.values ?? []));
  return send(res, 200, { updates: { updatedRange: `'${name}'!A${rows.length}`, updatedRows: (body.values ?? []).length } });
}

/** values.batchUpdate: every range is one row written in place. */
function batchUpdate(res, sheet, body) {
  if (!sheet) return googleError(res, 404, "Requested entity was not found.", "NOT_FOUND");
  if (body.valueInputOption !== "RAW") return googleError(res, 400, "valueInputOption is required", "INVALID_ARGUMENT");
  for (const entry of body.data ?? []) {
    const range = parseRange(entry.range);
    const found = range ? tabRows(sheet, range.tab) : null;
    if (!range || !found) return googleError(res, 400, `Unable to parse range: ${entry.range}`, "INVALID_ARGUMENT");
    while (found.rows.length < range.fromRow - 1) found.rows.push([]);
    found.rows[range.fromRow - 1] = entry.values?.[0] ?? [];
  }
  return send(res, 200, { totalUpdatedRows: (body.data ?? []).length });
}

function sheetsApi(req, res, url, body) {
  if (!issued.has((req.headers.authorization ?? "").replace(/^Bearer /, ""))) return googleError(res, 401, "Request had invalid authentication credentials.", "UNAUTHENTICATED");
  if (sheetsDisabled) {
    return send(res, 403, {
      error: {
        code: 403, status: "PERMISSION_DENIED", message: "Google Sheets API has not been used in project 123 before or it is disabled.",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com" }],
      },
    });
  }
  if (failing.times > 0) {
    failing = { ...failing, times: failing.times - 1 };
    const error = { code: failing.status, message: "The service is currently unavailable.", status: failing.error_status ?? "UNAVAILABLE", ...(failing.reason ? { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: failing.reason }] } : {}) };
    return send(res, failing.status, { error });
  }
  if (req.method === "POST" && url.pathname === "/v4/spreadsheets") return createSpreadsheet(res, JSON.parse(body || "{}"));
  const batch = /^\/v4\/spreadsheets\/([^/]+)\/values:batchUpdate$/.exec(url.pathname);
  if (req.method === "POST" && batch) return batchUpdate(res, sheets.get(decodeURIComponent(batch[1])), JSON.parse(body || "{}"));
  const match = /^\/v4\/spreadsheets\/([^/]+)\/values\/([^/]+?)(:append)?$/.exec(url.pathname);
  if (!match) return googleError(res, 404, "Not found", "NOT_FOUND");
  const sheet = sheets.get(decodeURIComponent(match[1]));
  if (!sheet) return googleError(res, 404, "Requested entity was not found.", "NOT_FOUND");
  if (req.method !== "GET" && url.searchParams.get("valueInputOption") !== "RAW") return googleError(res, 400, "valueInputOption is required", "INVALID_ARGUMENT");
  const method = match[3] ? "APPEND" : req.method;
  return values(res, method, sheet, decodeURIComponent(match[2]), method === "GET" ? {} : JSON.parse(body || "{}"));
}

function debug(req, res, url, body) {
  if (url.pathname === "/debug/token-requests") return send(res, 200, { count: tokenRequests });
  if (url.pathname === "/debug/revoke") {
    revoked = true;
    return send(res, 200, {});
  }
  if (url.pathname === "/debug/testing-mode") {
    testingMode = true;
    return send(res, 200, {});
  }
  if (url.pathname === "/debug/fail") {
    failing = JSON.parse(body);
    return send(res, 200, {});
  }
  if (url.pathname === "/debug/disable-sheets" || url.pathname === "/debug/enable-sheets") {
    sheetsDisabled = url.pathname === "/debug/disable-sheets";
    return send(res, 200, {});
  }
  const id = decodeURIComponent(url.pathname.slice("/debug/sheets/".length));
  if (req.method === "PUT") {
    const seed = JSON.parse(body);
    sheets.set(id, { title: seed.title ?? id, tabs: new Map(Object.entries(seed.tabs)) });
    return send(res, 200, {});
  }
  const sheet = sheets.get(id);
  return sheet ? send(res, 200, { title: sheet.title, tabs: Object.fromEntries(sheet.tabs) }) : send(res, 404, {});
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const body = await readBody(req);
  if (req.method === "POST" && url.pathname === "/token") return token(res, new URLSearchParams(body));
  if (url.pathname.startsWith("/v4/")) return sheetsApi(req, res, url, body);
  if (url.pathname.startsWith("/debug/")) return debug(req, res, url, body);
  return send(res, 404, { error: "not found" });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })}\n`);
});
