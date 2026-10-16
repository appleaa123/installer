import { settleByPerson, type Challenge } from "./checks.js";
import { scheduledForm } from "./check-schedule-form.js";
import { asksForm } from "./check-asks-form.js";
import { escapeHtml } from "./secret-page.js";

/**
 * Pages for checks whose answer is not a word (plan Tasks 7 and 10): the work done once, and the scheduled job's
 * checklist and outcome. Each form renders from the challenge on disk and settles it from the person's answer; the
 * check page (check-page.ts) routes to it by the challenge's test.
 */
export interface FormContext {
  readonly path: string;
  readonly now: string;
  /** The word handed to this page process, when it has one (the email part of T8, for the person to plant). */
  readonly word?: string;
  readonly home: string;
  /** Plants a self-addressed test email (T8, after the person closed the window); tests inject it. */
  readonly plant?: (home: string, subject: string, text: string) => Promise<boolean>;
}

export interface FormResult {
  readonly status: number;
  readonly title: string;
  readonly body: string;
}

export interface CheckForm {
  readonly render: (challenge: Challenge, context: FormContext, route: string) => Promise<FormResult> | FormResult;
  readonly submit: (challenge: Challenge, form: URLSearchParams, context: FormContext, route: string) => Promise<FormResult>;
}

const radio = (name: string, options: readonly (readonly [string, string])[]): string =>
  options.map(([value, label], index) => `<label><input type="radio" name="${name}" value="${escapeHtml(value)}"${index === 0 ? " required" : ""}> ${escapeHtml(label)}</label><br>`).join("");

/** The work done once (spec principle 1): did the person see the result, and was it right? */
const once: CheckForm = {
  render: (challenge, context) => ({
    status: 200,
    title: "the work done once",
    body: `<h1>Did you see the result?</h1><p>Your assistant just did the work once${challenge.workflow ? ` (<strong>${escapeHtml(challenge.workflow)}</strong>)` : ""}, so you can judge it before anything runs on a schedule.</p>
<form method="post" action="${context.path}/confirm">${radio("seen", [["right", "Yes, and it looked right"], ["wrong", "Yes, but it was wrong"], ["unseen", "I did not see it"]])}<button type="submit">Confirm</button></form>`,
  }),
  submit: async (challenge, form, context) => {
    const seen = form.get("seen");
    if (seen !== "right" && seen !== "wrong" && seen !== "unseen") return { status: 400, title: "the work done once", body: "<h1>Please choose one answer</h1>" };
    const outcome = seen === "right"
      ? { result: "yes-you-told-us" as const, reason: "You saw it: the work was done once and you said it looked right" }
      : { result: "not-checked" as const, reason: seen === "wrong" ? "You said the result was wrong: tell your assistant what was wrong, and it tries again" : "You did not see the result, so nobody has seen it yet" };
    await settleByPerson(context.home, challenge, [{ need: "answers", ...outcome }], context.now);
    return { status: 200, title: "thank you", body: "<h1>Thank you</h1><p>Your answer is saved. You can close this tab.</p>" };
  },
};

export const FORMS: Readonly<Record<string, CheckForm>> = { once, t8: scheduledForm, t6: asksForm, t6b: asksForm };

export { whenWords } from "./clock-words.js";
