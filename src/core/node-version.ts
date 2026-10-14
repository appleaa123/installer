/** The Node major version the package needs (package.json "engines"); npm only warns, so the CLI checks it itself. */
export const MIN_NODE_MAJOR = 22;

/** A plain sentence when this Node is too old, otherwise null. */
export function nodeTooOld(version: string): string | null {
  const major = Number(/^v?(\d+)/.exec(version)?.[1]);
  if (!Number.isFinite(major) || major >= MIN_NODE_MAJOR) return null;
  return `TaskFollow needs Node ${MIN_NODE_MAJOR} or newer, and this computer has ${version}. Download the LTS version from https://nodejs.org, install it, then try again.`;
}
