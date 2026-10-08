import { spawnSync } from "node:child_process";

export function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  const pid = child.pid;
  if (!pid) throw new Error("Failed to get pid from child process");
  // Assert the process is dead
  try {
    process.kill(pid, 0);
    throw new Error(`Process ${pid} is still alive`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  return pid;
}
