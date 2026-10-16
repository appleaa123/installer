import { whenWords } from "./clock-words.js";
import { coworkCleanUp } from "./deliver.js";
import { plantAndAudit, plantByChannel, subjectFor } from "./check-plant.js";
import { cancelChallenge, saveChallenge, settleByPerson, type Challenge, type ResultKind } from "./checks.js";
import type { CheckForm, FormContext, FormResult } from "./check-forms.js";
import { escapeHtml } from "./secret-page.js";
import { verifyWord } from "./words.js";

/**
 * T8's page (spec 5.2, plan Task 10, D160): a checklist, then the confirmation. The order keeps the open chat from
 * faking it: the person sees the task in their assistant's list, closes the window, and only then is the test email
 * planted (by this page process, the only one still running), so nothing said or sent in the chat can carry its word.
 * The confirmation opens at the scheduled time and lives 24 hours; what the person types is checked, never kept.
 */
const MAX_TRIES = 2;
const TITLE = "a check of your assistant's own schedule";
const ok = (body: string): FormResult => ({ status: 200, title: TITLE, body });
const time = (iso: string | undefined): string => (iso ? whenWords(iso) : "the set time");
const button = (path: string, route: string, label: string): string => `<form method="post" action="${path}${route}"><button type="submit">${escapeHtml(label)}</button></form>`;
const LOST_WORD = "<p>The computer may have restarted, or the page was reopened, so it no longer has the test's word. Ask your assistant to start the check again.</p>";
const cleanUp = (challenge: Challenge): string => `<p>${escapeHtml(coworkCleanUp("the TaskFollow check task", challenge.details?.skill ?? "the test skill"))}.</p>`;

function checklist(challenge: Challenge, context: FormContext): FormResult {
  const details = challenge.details ?? {};
  if (!details.seen_task) {
    return ok(`<h1>Check your assistant's own schedule</h1>
<ol><li>Add the test skill to your assistant: in Claude, open <strong>Settings, then Skills</strong>, and upload <code>${escapeHtml(details.zip ?? "")}</code>.</li>
<li>In a chat with your assistant (for Claude, a Cowork chat), paste this:<blockquote>${escapeHtml(details.instruction ?? "")}</blockquote></li>
<li>Check that the task shows in its list of scheduled tasks.</li></ol>${button(context.path, "/seen", "I see the task in its list")}`);
  }
  if (!details.closed_at) {
    // Review H1: without its word (a restart, or a page reopened in the terminal) nothing can be planted or shown.
    if (!context.word) return ok(`<h1>This page lost its word</h1>${LOST_WORD}`);
    const subject = details.plant === "person"
      ? `<p>Before you close the window, write down this subject. After closing it, send yourself an email from your phone with exactly this subject:</p><p class="word">${escapeHtml(subjectFor(challenge.id, context.word))}</p><p>Please write it down now and do not tell your assistant.</p>`
      : "<p>When you have closed the window, TaskFollow sends the test email to your own address.</p>";
    return ok(`<h1>Now close the window</h1>${subject}<p>Close your assistant's window (and the laptop's lid, if you want it to run while the laptop is closed). Keep this page.</p>${button(context.path, "/closed", "I closed the window")}`);
  }
  return confirmation(challenge, context);
}

function confirmation(challenge: Challenge, context: FormContext): FormResult {
  if (challenge.opens_at && context.now < challenge.opens_at) return { status: 200, title: TITLE, body: `<h1>Wait until ${escapeHtml(time(challenge.opens_at))}</h1><p>The task runs then. Come back to this page afterwards (or run 'taskfollow check page ${escapeHtml(challenge.id)}' in your own terminal). You have 24 hours.</p>` };
  const radio = (value: string, label: string, first = false) => `<label><input type="radio" name="when" value="${value}"${first ? " required" : ""}> ${label}</label><br>`;
  return ok(`<h1>What did you receive?</h1><p>Look at the message your assistant sent you (in Claude: a notification, or the task's result in your Scheduled list). Anything it said in the chat does not count.</p>
<form method="post" action="${context.path}/confirm"><p><label>The subject it gave<br><input name="email_word" autocomplete="off"></label></p><p><label>The check word it gave<br><input name="skill_word" autocomplete="off"></label></p>
<p><strong>When did it arrive?</strong><br>${radio("around", `Around ${escapeHtml(time(challenge.opens_at))}`, true)}${radio("before", `Before ${escapeHtml(time(challenge.opens_at))}`)}${radio("after", "Well after that")}${radio("nothing", "Nothing arrived")}</p><button type="submit">Confirm</button></form>`);
}

const SKILL_HONEST = "the message carried the skill's word; whether the task loads the skill on each run or copied it at setup, TaskFollow cannot tell";

function outcomes(when: string): readonly { need: "scheduler" | "reads:email" | "skills"; result: ResultKind; reason: string; while_away?: boolean }[] {
  if (when === "before") {
    const reason = "It arrived before the set time, so it cannot have come from the scheduled task";
    return [{ need: "scheduler", result: "not-checked", reason }, { need: "reads:email", result: "not-checked", reason }, { need: "skills", result: "not-checked", reason }];
  }
  const scheduler = when === "around" ? "You told us: it arrived around the set time, with the window closed" : "You told us: it arrived well after the set time, so it ran, but not while you were away (the computer may have been asleep)";
  return [
    // Review H2: "well after" passes the schedule but not the wish to have it run while the person is away.
    { need: "scheduler", result: "yes-you-told-us", reason: scheduler, while_away: when === "around" },
    { need: "reads:email", result: "yes-you-told-us", reason: "You told us: the scheduled task sent you the subject of the test email planted after the window closed" },
    { need: "skills", result: "yes-you-told-us", reason: `You told us: ${SKILL_HONEST}` },
  ];
}

async function confirm(challenge: Challenge, form: URLSearchParams, context: FormContext): Promise<FormResult> {
  if (!challenge.details?.closed_at) return { status: 409, title: TITLE, body: "<h1>Please follow the steps first</h1><p>See the task in its list and close the window before confirming.</p>" };
  if (challenge.opens_at && context.now < challenge.opens_at) return { ...confirmation(challenge, context), status: 409 };
  const when = form.get("when") ?? "";
  if (!["around", "before", "after", "nothing"].includes(when)) return { ...confirmation(challenge, context), status: 400 };
  if (when === "nothing") {
    await settleByPerson(context.home, challenge, [
      { need: "scheduler", result: "no-tested", reason: "You told us nothing arrived after the set time" },
      { need: "reads:email", result: "not-checked", reason: "Nothing arrived, so nobody has seen it yet" },
      { need: "skills", result: "not-checked", reason: "Nothing arrived, so nobody has seen it yet" },
    ], context.now);
    return ok(`<h1>Thank you</h1><p>Saved: nothing arrived. Your assistant's schedule did not run this task.</p>${cleanUp(challenge)}`);
  }
  const typed = `${form.get("email_word") ?? ""} ${form.get("skill_word") ?? ""}`;
  if (!challenge.word_salt || !challenge.word_hash || !verifyWord(typed, challenge.word_salt, challenge.word_hash)) {
    const tries = challenge.tries + 1;
    if (tries >= MAX_TRIES) {
      await cancelChallenge(context.home, { ...challenge, tries }, "the words did not match twice", context.now);
      return ok("<h1>That did not match twice</h1><p>The check is cancelled. Ask your assistant to start it again.</p>");
    }
    await saveChallenge(context.home, { ...challenge, tries });
    return ok(`<h1>That did not match</h1><p>Check both words and try once more.</p><p><a href="${context.path}/confirm">Try again</a></p>`);
  }
  await settleByPerson(context.home, challenge, outcomes(when), context.now);
  return ok(`<h1>Thank you</h1><p>Saved. You can see the result with your assistant.</p>${cleanUp(challenge)}`);
}

export const scheduledForm: CheckForm = {
  render: (challenge, context, route) => (route === "/confirm" ? (challenge.details?.closed_at ? confirmation(challenge, context) : checklist(challenge, context)) : checklist(challenge, context)),
  submit: async (challenge, form, context, route) => {
    if (route === "/seen") {
      const next = { ...challenge, details: { ...(challenge.details ?? {}), seen_task: context.now } };
      await saveChallenge(context.home, next);
      return checklist(next, context);
    }
    if (route === "/closed") {
      if (!challenge.details?.seen_task) return checklist(challenge, context);
      if (!context.word) return ok(`<h1>This page lost its word</h1>${LOST_WORD}`);
      const wantsPlant = challenge.details.plant !== "person";
      const planted = wantsPlant ? await plantAndAudit(context.home, context.plant ?? plantByChannel, challenge.id, context.word, "t8", context.now) : false;
      // Review H4: the window is closed either way; a failed plant becomes the person sending it from their phone now.
      const plant: Record<string, string> = wantsPlant && !planted ? { plant: "person" } : {};
      await saveChallenge(context.home, { ...challenge, details: { ...(challenge.details ?? {}), ...plant, closed_at: context.now } });
      const note = planted
        ? "TaskFollow has sent the test email to your own address."
        : wantsPlant
          ? `TaskFollow could not send the test email, so please send it yourself now, from your phone, with exactly this subject (and do not tell your assistant):</p><p class="word">${escapeHtml(subjectFor(challenge.id, context.word))}`
          : "Now send yourself the email with the subject you wrote down, from your phone.";
      return ok(`<h1>Thank you</h1><p>${note}</p><p>The task runs at ${escapeHtml(time(challenge.opens_at))}. Come back to this page afterwards.</p>`);
    }
    if (route === "/confirm") return confirm(challenge, form, context);
    return { status: 404, title: "not found", body: "<h1>Not found</h1>" };
  },
};
