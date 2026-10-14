/**
 * An action or check could not finish for a reason the person can fix: a network call, the keychain,
 * a child process (D53). The engine records it as a failed step with this message as the hint and
 * retries it through `taskpilot resume`; the third failure blocks the step. Authoring errors
 * (InputError, SolutionError, ProfileError) are not failures: they still throw.
 */
export class ActionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionFailure";
  }
}
