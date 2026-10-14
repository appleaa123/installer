import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { confinedPath } from "./actions.js";
import { appendAudit } from "./audit.js";
import { connectorUrl } from "./connectors.js";
import { readConfig, writeConfig } from "./data-source.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { JUDGE_DIR, parseJsonAnswer, profileBackend, type JudgeBackend } from "./judge.js";
import { getSecret } from "./keychain.js";
import { loadProfileById } from "./profile.js";
import type { InstallState } from "./types.js";

/**
 * The direct-model fallback (spec §7.4, D85): when the agent cannot be called headless (C4), or its terms forbid it,
 * a judge goes straight to a model API with the client's own key (keychain item `model`, entered on the D47 page
 * with `taskfollow secret model`). Provider-neutral: one `ModelClient.complete(prompt) → text` interface, two wire
 * formats over `fetch` (Anthropic Messages, and OpenAI-compatible chat completions, which covers OpenRouter and
 * most hosted models); Gemini is deferred. The model id is the person's choice, never a default in the engine.
 * The answer is text; the runner reads the JSON in it and validates it like any judge answer (D16).
 */
export const MODEL_CONFIG = join("config", "model.json");
export const MODEL_SECRET_ID = "model";
export const PROVIDERS = ["anthropic", "openai_compatible"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const MODEL_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;

export interface ModelConfig {
  readonly provider: Provider;
  readonly model: string;
  readonly max_tokens: number;
  /** OpenAI-compatible only: the API's https base, for example https://openrouter.ai/api/v1. */
  readonly base_url?: string;
}

export interface ModelClient {
  readonly complete: (prompt: string) => Promise<string>;
}

type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const USAGE = `--value '{"provider":"anthropic" | "openai_compatible","model":"<model id>","base_url":"https://… (openai_compatible only)","max_tokens":4096}'`;

export function parseModelConfig(value: unknown): ModelConfig {
  if (!isRecord(value)) throw new InputError(`model needs ${USAGE}`);
  const unknown = Object.keys(value).find((key) => !["provider", "model", "base_url", "max_tokens"].includes(key));
  if (unknown !== undefined) throw new InputError(`model does not take '${unknown}'; ${USAGE}`);
  if (!(PROVIDERS as readonly unknown[]).includes(value.provider)) throw new InputError(`model: provider must be one of ${PROVIDERS.join(", ")}`);
  if (typeof value.model !== "string" || !/^[\w.:/@-]{1,200}$/.test(value.model)) throw new InputError("model: 'model' must be the provider's model id");
  const maxTokens = value.max_tokens ?? DEFAULT_MAX_TOKENS;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 16 || maxTokens > 64_000) throw new InputError("model: max_tokens must be a whole number from 16 to 64000");
  const provider = value.provider as Provider;
  if (provider === "anthropic" && value.base_url !== undefined) throw new InputError("model: base_url is only for openai_compatible");
  if (provider === "openai_compatible" && (typeof value.base_url !== "string" || !/^https:\/\/[^\s]+$/.test(value.base_url))) throw new InputError("model: openai_compatible needs base_url, an https URL");
  return { provider, model: value.model, max_tokens: maxTokens, ...(provider === "openai_compatible" ? { base_url: (value.base_url as string).replace(/\/+$/, "") } : {}) };
}

export async function loadModelConfig(home: string): Promise<ModelConfig | null> {
  const raw = await readConfig(home, MODEL_CONFIG);
  return raw === null ? null : parseModelConfig(raw);
}

/** The settings decide where the model key is sent, so like the mail servers (D61, D73) only a person at a terminal sets them. */
async function requireTerminal(home: string, interactive: boolean, now: string): Promise<void> {
  if (interactive) return;
  await appendAudit(home, { ts: now, actor: "agent", event: "model.refused", ref: MODEL_CONFIG, payload: { command: "taskfollow model --value" } });
  throw new InputError("The direct model is set by a person in their own terminal, not by the agent: ask them to open a terminal and run 'taskfollow model --value <json>' there");
}

/** `taskfollow model [--value <json>]`: shows the direct model, or saves it (no call is made, nothing is spent). */
export async function modelCommand(home: string, value: string | undefined, now: () => string, interactive = false): Promise<Record<string, unknown>> {
  if (value === undefined) {
    return { model: await loadModelConfig(home), key_stored: (await getSecret(MODEL_SECRET_ID)) !== null, note: "Judges use the agent's headless command when the probe found one; this model only when it did not (D85)" };
  }
  await requireTerminal(home, interactive, now());
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InputError(`model: --value must be JSON, ${USAGE}`);
  }
  const config = parseModelConfig(parsed);
  await writeConfig(home, MODEL_CONFIG, config);
  await appendAudit(home, { ts: now(), actor: "agent", event: "model.configured", ref: MODEL_CONFIG, payload: config });
  const key = (await getSecret(MODEL_SECRET_ID)) !== null;
  return { status: "saved", model: config, key_stored: key, ...(key ? {} : { next: "Ask the person to run 'taskfollow secret model' and enter their API key on the page that opens" }) };
}

async function post(url: string, headers: Readonly<Record<string, string>>, body: unknown): Promise<Raw> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) });
  } catch (error) {
    throw new ActionFailure(`The model API could not be reached (${(error as Error).message})`);
  }
  const json = (await response.json().catch(() => ({}))) as unknown;
  if (response.status === 401 || response.status === 403) throw new ActionFailure(`The model provider refused the key (HTTP ${response.status}): run 'taskfollow secret model' with a valid key`);
  if (!response.ok) {
    const message = isRecord(json) && isRecord(json.error) && typeof json.error.message === "string" ? json.error.message.slice(0, 200) : "no details";
    throw new ActionFailure(`The model API answered HTTP ${response.status}: ${message}`);
  }
  return isRecord(json) ? json : {};
}

function anthropicClient(config: ModelConfig, key: string, env: Env): ModelClient {
  return {
    complete: async (prompt) => {
      const body = { model: config.model, max_tokens: config.max_tokens, messages: [{ role: "user", content: prompt }] };
      const json = await post(connectorUrl(ANTHROPIC_MESSAGES_URL, env), { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION }, body);
      if (json.stop_reason === "refusal") throw new ActionFailure("The model declined to answer (stop_reason refusal)");
      const blocks = Array.isArray(json.content) ? json.content : [];
      return blocks.filter((block): block is Raw => isRecord(block) && block.type === "text").map((block) => String(block.text)).join("");
    },
  };
}

function openAiClient(config: ModelConfig, key: string, env: Env): ModelClient {
  return {
    complete: async (prompt) => {
      const body = { model: config.model, max_tokens: config.max_tokens, messages: [{ role: "user", content: prompt }] };
      const json = await post(connectorUrl(`${config.base_url ?? ""}/chat/completions`, env), { authorization: `Bearer ${key}` }, body);
      const choice = Array.isArray(json.choices) && isRecord(json.choices[0]) ? json.choices[0] : {};
      const content = isRecord(choice.message) ? choice.message.content : undefined;
      if (typeof content !== "string") throw new ActionFailure(`The model gave no text (finish_reason ${String(choice.finish_reason ?? "unknown")})`);
      return content;
    },
  };
}

export function modelClient(config: ModelConfig, key: string, env: Env = process.env): ModelClient {
  return config.provider === "anthropic" ? anthropicClient(config, key, env) : openAiClient(config, key, env);
}

export function modelBackend(client: ModelClient): JudgeBackend {
  return {
    name: "model",
    ask: async (prompt) => {
      try {
        return parseJsonAnswer(await client.complete(prompt));
      } catch (error) {
        if (error instanceof ActionFailure) return { ok: false, error: error.message };
        throw error;
      }
    },
  };
}

async function judgeDir(home: string): Promise<string> {
  const cwd = await confinedPath(home, JUDGE_DIR);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  return cwd;
}

/** D85: the agent when the probe found it can answer headless (C4) and its terms allow it; else the direct model. */
export async function judgeBackend(home: string, state: InstallState | undefined, env: Env = process.env): Promise<JudgeBackend> {
  const runtime = state?.runtime;
  if (runtime?.profile && runtime.c4_headless) {
    const profile = await loadProfileById(runtime.profile);
    if (profile.tos_review.status === "ok") return profileBackend(profile, await judgeDir(home));
  }
  const config = await loadModelConfig(home);
  if (!config) throw new ActionFailure("No way to ask a judge: the agent cannot be called headless here (C4), and no direct model is set up: run 'taskfollow model --value <json>' and 'taskfollow secret model'");
  const key = await getSecret(MODEL_SECRET_ID, env);
  if (key === null) throw new ActionFailure("The direct model has no key yet: ask the person to run 'taskfollow secret model'");
  return modelBackend(modelClient(config, key, env));
}
