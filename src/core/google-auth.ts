import { createHash, randomBytes } from "node:crypto";
import { connectorUrl, type ConnectorAuth, type ConnectorDef } from "./connectors.js";
import { ActionFailure } from "./failure.js";
import { getSecret } from "./keychain.js";

/**
 * Access tokens for a connector's API (D66). v1: the client's own OAuth client (created in their own Google
 * Cloud project, R3) plus the refresh token from one loopback sign-in, all three in one keychain item.
 * Callers only see `AccessTokenSource`, so a shared verified app can replace this later without touching them.
 */
export interface AccessTokenSource {
  readonly accessToken: () => Promise<string>;
}

export interface OAuthClient {
  readonly client_id: string;
  readonly client_secret: string;
}

export interface SignIn extends OAuthClient {
  readonly refresh_token: string;
}

const TOKEN_TIMEOUT_MS = 30_000;
/** A cached access token is renewed this long before Google says it expires. */
const EXPIRY_MARGIN_MS = 60_000;
type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const again = (secretId: string): string => `run 'installer secret ${secretId}' to sign in again`;

export function parseSignIn(text: string, secretId = "google"): SignIn {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const keys = ["client_id", "client_secret", "refresh_token"] as const;
  if (!isRecord(raw) || !keys.every((key) => typeof raw[key] === "string" && raw[key] !== "")) {
    throw new ActionFailure(`The stored Google sign-in is damaged: ${again(secretId)}`);
  }
  return { client_id: raw.client_id as string, client_secret: raw.client_secret as string, refresh_token: raw.refresh_token as string };
}

/** POSTs a form to the token endpoint; a refusal names Google's error code, never the secret. */
async function postToken(auth: ConnectorAuth, form: Readonly<Record<string, string>>, refused: (code: string) => string, env: Env): Promise<Raw> {
  let response: Response;
  try {
    response = await fetch(connectorUrl(auth.token_url, env), {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ActionFailure(`Cannot reach Google's sign-in service (${(error as Error).message})`);
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok && isRecord(body)) return body;
  const code = isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
  throw new ActionFailure(refused(code));
}

/** Refreshes on first use and again shortly before expiry; one keychain read per source. */
export function clientOwnedTokens(auth: ConnectorAuth, signIn: SignIn, env: Env = process.env): AccessTokenSource {
  let cached: { readonly token: string; readonly until: number } | null = null;
  return {
    accessToken: async () => {
      if (cached && Date.now() < cached.until) return cached.token;
      const form = { grant_type: "refresh_token", refresh_token: signIn.refresh_token, client_id: signIn.client_id, client_secret: signIn.client_secret };
      const body = await postToken(auth, form, (code) => `Google refused the stored sign-in (${code}): ${again(auth.secret_id)}`, env);
      if (typeof body.access_token !== "string") throw new ActionFailure("Google's sign-in service returned no access token");
      const lifetime = typeof body.expires_in === "number" ? body.expires_in * 1000 : 0;
      cached = { token: body.access_token, until: Date.now() + lifetime - EXPIRY_MARGIN_MS };
      return cached.token;
    },
  };
}

/** The token source for a connector, from its keychain item (`auth.secret_id`). */
export async function connectorTokens(def: ConnectorDef, env: Env = process.env): Promise<AccessTokenSource> {
  const stored = await getSecret(def.auth.secret_id, env);
  if (stored === null) throw new ActionFailure(`No Google sign-in is stored yet: run 'installer secret ${def.auth.secret_id}' and sign in on the page it opens`);
  return clientOwnedTokens(def.auth, parseSignIn(stored, def.auth.secret_id), env);
}

/** PKCE (RFC 7636, S256): the verifier stays on this machine, Google sees only the challenge. */
export function pkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Google's consent page for this connector's scopes, answering to the loopback page. */
export function authorizeUrl(auth: ConnectorAuth, clientId: string, redirectUri: string, state: string, challenge: string): string {
  const query = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: auth.scopes.join(" "),
    access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256",
  });
  return `${auth.authorize_url}?${query.toString()}`;
}

export interface CodeGrant {
  readonly code: string;
  readonly redirectUri: string;
  readonly verifier: string;
}

/** Exchanges the code from the consent page for the refresh token kept in the keychain. */
export async function exchangeCode(auth: ConnectorAuth, client: OAuthClient, grant: CodeGrant, env: Env = process.env): Promise<string> {
  const form = { grant_type: "authorization_code", code: grant.code, redirect_uri: grant.redirectUri, code_verifier: grant.verifier, ...client };
  const body = await postToken(auth, form, (code) => `Google refused the sign-in (${code})`, env);
  if (typeof body.refresh_token !== "string") {
    throw new ActionFailure("Google returned no refresh token: remove the installer's access in your Google account's third-party access page, then sign in again");
  }
  return body.refresh_token;
}
