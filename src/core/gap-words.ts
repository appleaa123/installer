import type { Need, ResultKind } from "./checks.js";

/**
 * Plain words for every need on the person's page (spec section 6, scope section 6, D163). A "no" or "not checked"
 * line always comes with four parts: what is missing, why the workflow needs it, what happens without it, and the
 * person's options, safest first (TaskFollow's own tool, draft-only, by hand, the agent's own ask-every-time mode,
 * another agent). Nothing here claims a protection that was not tested.
 */
export interface GapWords {
  readonly missing: string;
  readonly why: string;
  readonly without: string;
  readonly options: readonly string[];
}

const SOURCE: Readonly<Record<string, string>> = {
  email: "your email", "email-attachment": "files attached to your email", files: "your files", records: "your records (a sheet)", messages: "your messages", chat: "what you tell it in chat",
};
const TARGET: Readonly<Record<string, string>> = { records: "your records (a sheet)", files: "your files", tasks: "your task list" };

const of = (need: Need): string => need.slice(need.indexOf(":") + 1);
const sourceWords = (need: Need): string => SOURCE[of(need)] ?? of(need);
const targetWords = (need: Need): string => TARGET[of(need)] ?? of(need);

/** The short label of a need, for the left column of the page. */
export function labelFor(need: Need): string {
  if (need.startsWith("reads:")) return `Reads ${sourceWords(need)}`;
  if (need.startsWith("writes:")) return `Writes to ${targetWords(need)}`;
  const fixed: Readonly<Record<string, string>> = {
    answers: "Done once, now", skills: "Has the workflow's skill", scheduler: "Runs on its own schedule", runner: "Runs in TaskFollow's runner",
    tools: "Reaches TaskFollow's tools", "asks-first": "Asks you before it sends", hooks: "Has checks that can stop a call",
  };
  return fixed[need] ?? need;
}

const BY_HAND = "Run it by hand with you watching: ask your assistant and it does the work right away.";
const DRAFT_ONLY = "Keep it draft-only: your assistant prepares everything and you send or act yourself.";
const OWN_TOOL = "Let the work go through TaskFollow's own tools, so its approval step holds on any assistant.";
const OTHER_AGENT = "Use another assistant that has this ability, for this one workflow.";
const ASK_MODE = "Turn on your assistant's own 'ask every time' setting, if it has one.";

function words(need: Need): GapWords {
  if (need === "answers") return { missing: "TaskFollow has not seen your assistant do this work once yet.", why: "Doing it once first shows you the result before anything runs on its own.", without: "You would be trusting the workflow before seeing what it produces.", options: ["Do it once now (taskfollow check once <workflow>) and look at the result.", BY_HAND] };
  if (need.startsWith("reads:")) return { missing: `TaskFollow has not seen your assistant read ${sourceWords(need)}.`, why: `The workflow starts from ${sourceWords(need)}.`, without: "It would run without the information it needs, or fail.", options: [`Connect ${sourceWords(need)} to your assistant, then run the reading check again.`, BY_HAND] };
  if (need.startsWith("writes:")) return { missing: `TaskFollow has not seen your assistant write to ${targetWords(need)}.`, why: `The workflow puts its result in ${targetWords(need)}.`, without: "The result would stay in the chat instead of where you keep it.", options: [OWN_TOOL, DRAFT_ONLY, BY_HAND] };
  const table: Readonly<Record<string, GapWords>> = {
    skills: { missing: "TaskFollow has not seen the workflow's skill reach your assistant in the place it will run.", why: "The skill holds your own rules for this work.", without: "Your assistant would do the work in its own general way, not yours.", options: ["Run the check for the place it will run (TaskFollow's runner, or your assistant's schedule).", BY_HAND] },
    scheduler: { missing: "TaskFollow has not seen your assistant's own schedule run this.", why: "Running on its own, on time, is what you asked for.", without: "Nothing would happen unless you ask.", options: ["Run the schedule check (it takes about 10 minutes, with the window closed).", "Let TaskFollow's runner run it on this computer instead, while it is on and awake.", BY_HAND] },
    runner: { missing: "TaskFollow has not seen its runner drive your assistant on this computer.", why: "TaskFollow's runner is what keeps its approval step and a record of each run.", without: "Work that sends, writes, pays or deletes stays draft-only.", options: ["Run the runner check (taskfollow check start t7).", DRAFT_ONLY, BY_HAND] },
    tools: { missing: "TaskFollow has not seen your assistant reach TaskFollow's own tools.", why: "TaskFollow's approval step holds only for what goes through its tools.", without: "Work that sends, writes, pays or deletes stays draft-only.", options: ["Run the tools check (taskfollow check start t5).", DRAFT_ONLY, BY_HAND] },
    "asks-first": { missing: "TaskFollow has not seen your assistant's own settings stop a send while nobody was there to ask.", why: "When your assistant uses its own email tool, only its own settings stand between it and a send.", without: "Sends through your assistant's own tool depend on its instructions alone.", options: [OWN_TOOL, DRAFT_ONLY, ASK_MODE, OTHER_AGENT] },
    hooks: { missing: "TaskFollow has not seen a check stop a call before it happened.", why: "These checks are an extra line that stops a call the step may not make.", without: "TaskFollow's approval step and the step's own list of tools still apply; this extra line does not.", options: [OWN_TOOL, DRAFT_ONLY, OTHER_AGENT] },
  };
  return table[need] ?? { missing: `TaskFollow has not checked: ${need}.`, why: "This workflow needs it.", without: "The workflow may not work as you expect.", options: [DRAFT_ONLY, BY_HAND] };
}

/** The four parts for a "no" or "not checked" line; nothing for a yes. A "no" says it was tried and did not happen. */
export function gapWords(need: Need, result: ResultKind): GapWords | null {
  if (result === "yes-tested" || result === "yes-you-told-us") return null;
  const base = words(need);
  return result === "no-tested" ? { ...base, missing: base.missing.replace(/^TaskFollow has not seen /, "TaskFollow tested and did not see ") } : base;
}

/** The four parts as indented lines under a page line. */
export function gapLines(gap: GapWords): string[] {
  return [`      Missing: ${gap.missing}`, `      Why it matters: ${gap.why}`, `      Without it: ${gap.without}`, `      Your options: ${gap.options.map((option, index) => `${index + 1}) ${option}`).join(" ")}`];
}
