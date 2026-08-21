import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Whether a POSIX shell is available to exec.
 *
 *  The quoting tests are worth little against a reimplementation of bash; they
 *  run the real thing and compare what it received. On Windows there is none,
 *  so they cannot run at all. */
export const hasBash = existsSync("/bin/bash");

/** Whether this process may create a symlink.
 *
 *  Windows restricts symlink creation to administrators, or to accounts with
 *  Developer Mode enabled, and fails with EPERM otherwise. Probing beats
 *  checking the platform: an elevated shell or Developer Mode can run these,
 *  and CI on Linux always can.
 */
export const canSymlink = ((): boolean => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(tmpdir(), "rc-symlink-probe-"));
    symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A probe that cannot clean up after itself is still a valid probe.
      }
    }
  }
})();
