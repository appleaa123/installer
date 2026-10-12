// Prints how Google's token endpoint and the Sheets API answer; never prints a secret.
const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret, GOOGLE_REFRESH_TOKEN: refresh } = process.env;
if (!id || !secret || !refresh) throw new Error("Load ~/.config/installer-dev/.env first");

const token = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: id, client_secret: secret }).toString(),
});
const tokenBody = await token.json();
console.log("token endpoint:", token.status, "keys:", Object.keys(tokenBody).join(","));
if (!token.ok) process.exit(1);

const probe = await fetch("https://sheets.googleapis.com/v4/spreadsheets/installer-readiness-probe?fields=spreadsheetId", {
  headers: { authorization: `Bearer ${tokenBody.access_token}` },
});
const probeBody = await probe.json().catch(() => ({}));
const error = probeBody.error ?? {};
console.log("sheets probe:", probe.status, "status:", error.status, "reasons:", (error.details ?? []).map((d) => d.reason).filter(Boolean).join(","));
