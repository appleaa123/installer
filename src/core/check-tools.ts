import { markChallenge } from "./checks.js";
import { onlyKeys, textArg, type ToolDef } from "./tools.js";

/**
 * `check.ping` (spec T5, T7; D159): the agent answers a check through TaskFollow's own tools. Fixed L0 and meta, so it
 * is never gated and never in a workflow; the gate audits nothing at L0, so markChallenge writes its own audit line.
 */
export const CHECK_TOOLS: readonly ToolDef[] = [
  {
    name: "check.ping", meta: true,
    description: "A test call for TaskFollow's check of what you can do: send exactly the id and word you were given. It changes nothing.",
    fields: { id: { type: "string", maxLength: 16 }, word: { type: "string", maxLength: 64 } }, required: ["id", "word"],
    parse: (args) => {
      onlyKeys(args, ["id", "word"], "check.ping");
      return { id: textArg(args, "id", "check.ping"), word: textArg(args, "word", "check.ping") };
    },
    run: async (ctx, args) => {
      const result = await markChallenge(ctx.home, args.id as string, args.word as string, { interactive: false, parents: [], via: ctx.via }, ctx.now());
      return { result: result.result, reason: result.reason };
    },
  },
];
