import type { InstallState } from "./types.js";

/** The name results are recorded under for an agent TaskFollow has no profile for (D175). */
export const UNPROFILED_AGENT = "your agent (no TaskFollow profile)";

/**
 * The agent the probe found, as every check records and looks up results (D175): its profile, or one fixed name when
 * the probe knew no profile for it; null before any probe.
 */
export function probedAgent(state: InstallState | undefined): { readonly agent: string; readonly version: string | null } | null {
  if (!state?.runtime) return null;
  return state.runtime.profile ? { agent: state.runtime.profile, version: state.runtime.agent_version ?? null } : { agent: UNPROFILED_AGENT, version: null };
}
