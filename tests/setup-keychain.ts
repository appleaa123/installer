import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// D51: each test file gets its own throwaway file keychain. With one keychain for the whole run, a test that deletes
// secrets (uninstall, disconnect) removed keys other files running at the same time had just stored, so those files
// failed only under full-suite load. Live tests use the real keychain and are left alone.
if (process.env.INSTALLER_KEYCHAIN === "file") process.env.INSTALLER_KEYCHAIN_DIR = mkdtempSync(join(tmpdir(), "installer-keychain-file-"));
