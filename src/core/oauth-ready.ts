import type { CheckResult } from "./actions.js";
import { oauthConnectorFor } from "./connectors.js";
import { connectorTokens, symptomHelp } from "./google-auth.js";
import { InputError } from "./inputs.js";
import { probeSheetsApi } from "./sheets.js";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The `oauth_ready` check (live setup guides, 4.5): the stored sign-in refreshes and the connector's API answers, so a
 * setup mistake shows up now with its fix, where to look and what to search, not on the first real call. A refused
 * sign-in or an unreachable Google throws an ActionFailure, which the engine turns into a failed, retryable step.
 */
export async function oauthReady(secretId: string, env: Env = process.env): Promise<CheckResult> {
  const def = await oauthConnectorFor(secretId);
  if (def === null) throw new InputError(`'${secretId}' is not the sign-in of a connector in this installer's catalog`);
  const probe = await probeSheetsApi(def, await connectorTokens(def, env), env);
  switch (probe.state) {
    case "enabled":
      return { ok: true };
    case "disabled":
      return { ok: false, hint: `Google says the ${def.name} API is not enabled in your project${symptomHelp("SERVICE_DISABLED", def.setup?.symptoms)}` };
    case "refused":
      return { ok: false, hint: `${def.name} refused the sign-in: run 'taskpilot secret ${def.auth.secret_id}' to sign in again` };
    case "other":
      return { ok: false, hint: `${def.name} answered HTTP ${probe.status}${probe.reason ? ` (${probe.reason})` : ""} to the readiness check${probe.status === 429 || probe.status >= 500 ? "; try again in a minute" : ""}${symptomHelp(probe.reason, def.setup?.symptoms)}` };
  }
}
