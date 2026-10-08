/** Test-only fault injection: when INSTALLER_CRASH_AT names this point, the process kills itself. */
export const CRASH_ENV = "INSTALLER_CRASH_AT";

export function crashPoint(name: string): void {
  if (process.env[CRASH_ENV] === name) process.kill(process.pid, "SIGKILL");
}
