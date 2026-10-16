import { InputError } from "./inputs.js";
import { onlyKeys, textArg, type ToolArgs, type ToolDef } from "./tools.js";

const KEYS = ["run", "since", "direct"] as const;
const EXAMPLE = { run: "a run id, for example 2026-10-14-1a2b3c4d", since: "a date, for example 2026-10-13", direct: "a day, for example 2026-10-14" } as const;

/**
 * `why.show` (D169): `taskfollow why` as a tool, for an agent that reaches TaskFollow without a shell. Meta, so fixed
 * L0, never gated and never in a workflow. It returns `why`'s own JSON; its one side effect is D164's: the list form
 * shows waiting "I noticed" suggestions once, so they come first, where a client that cuts a long answer keeps them.
 */
export const WHY_TOOLS: readonly ToolDef[] = [
  {
    name: "why.show", meta: true,
    description: "What happened and why, from TaskFollow's own records: the runs since a date (default: the last 24 hours) with their results, one run's timeline (who did what, and why) by its id, or one day's direct calls to watched services. It changes nothing, except that waiting suggestions are shown only once: tell the person about them.",
    fields: { run: { type: "string", maxLength: 32 }, since: { type: "string", maxLength: 40 }, direct: { type: "string", maxLength: 10 } }, required: [],
    parse: (args) => {
      onlyKeys(args, KEYS, "why.show");
      const given = KEYS.filter((key) => args[key] !== undefined);
      if (given.length > 1) throw new InputError("why.show takes at most one of run, since, direct");
      return Object.fromEntries(given.map((key) => [key, textArg(args, key, "why.show")]));
    },
    run: async (ctx, args) => {
      // Lazy, as check-tools does: why.ts reaches the tool set through task-step.ts, so a static import would be a cycle.
      const { DATE, DAY, RUN_ID, whyCommand } = await import("./why.js");
      const pattern = { run: RUN_ID, since: DATE, direct: DAY } as const;
      // whyCommand picks its form from the value alone, so a value under the wrong key is refused before it can cross forms.
      for (const key of KEYS) {
        const value = args[key];
        if (typeof value === "string" && !pattern[key].test(value)) throw new InputError(`why.show: ${key} must be ${EXAMPLE[key]}`);
      }
      const { run, since, direct } = args as ToolArgs & { run?: string; since?: string; direct?: string };
      const shown = await whyCommand(ctx.home, run ?? since ?? (direct !== undefined ? "direct" : undefined), ctx.now, direct);
      const { suggestions, suggestions_damaged: damaged, ...rest } = shown;
      return { ...(suggestions !== undefined ? { suggestions } : {}), ...(damaged !== undefined ? { suggestions_damaged: damaged } : {}), ...rest };
    },
  },
];
