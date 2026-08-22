import { describe, expect, it } from "vitest";
import {
  POLL_INTERVAL_MS,
  pollingEnv,
  shouldPollForChanges,
} from "./fileWatching.js";

/** The host this was written on: the server running directly on Windows, with
 *  the projects on an NTFS drive bind-mounted into Linux containers. Docker
 *  Desktop delivers the contents but not the events. */
const windowsHost = { inContainer: false, platform: "win32" };

/** The deployment: the server under docker compose beside the sandboxes,
 *  sharing one Linux kernel and one real filesystem. */
const composeHost = { inContainer: true, platform: "linux" };

describe("shouldPollForChanges", () => {
  it("polls when the server runs on Windows outside a container", () => {
    expect(shouldPollForChanges(windowsHost)).toBe(true);
  });

  it("polls on macOS, where Docker Desktop has the same boundary", () => {
    expect(
      shouldPollForChanges({ inContainer: false, platform: "darwin" }),
    ).toBe(true);
  });

  /** Polling is not free — every watcher stats every watched file on a timer —
   *  so the deployment target must not pay for a problem it does not have. */
  it("does not poll on a Linux host", () => {
    expect(shouldPollForChanges({ inContainer: false, platform: "linux" })).toBe(
      false,
    );
  });

  /** The server's own image may be built FROM anything; what decides is the
   *  kernel it shares with the sandboxes, and being in a container beside them
   *  means that kernel is Linux. */
  it("does not poll when the server is itself containerised", () => {
    expect(shouldPollForChanges(composeHost)).toBe(false);
    expect(
      shouldPollForChanges({ inContainer: true, platform: "win32" }),
    ).toBe(false);
  });

  /** WSL2 with the project on /mnt/c looks exactly like a Linux host from here
   *  and behaves exactly like Windows, so there has to be a way to say so. */
  it("obeys an explicit setting over anything it would have inferred", () => {
    expect(shouldPollForChanges({ ...composeHost, override: true })).toBe(true);
    expect(shouldPollForChanges({ ...windowsHost, override: false })).toBe(
      false,
    );
  });
});

describe("pollingEnv", () => {
  it("is empty when polling is off, so it can be spread unconditionally", () => {
    expect(pollingEnv(false)).toEqual([]);
  });

  /** Next goes through webpack's watchpack; Vite and `tsx watch` go through
   *  chokidar. Naming only one leaves half the templates still blind. */
  it("covers both watchers the templates use", () => {
    const names = pollingEnv(true).map((entry) => entry.split("=")[0]);

    expect(names).toContain("WATCHPACK_POLLING");
    expect(names).toContain("CHOKIDAR_USEPOLLING");
  });

  /** `WATCHPACK_POLLING=true` means watchpack's own default of about five
   *  seconds, which is long enough that a save feels ignored. A number is an
   *  interval in milliseconds. */
  it("gives watchpack an interval rather than letting it choose", () => {
    const watchpack = pollingEnv(true).find((entry) =>
      entry.startsWith("WATCHPACK_POLLING="),
    );

    expect(watchpack).toBe(`WATCHPACK_POLLING=${String(POLL_INTERVAL_MS)}`);
    expect(POLL_INTERVAL_MS).toBeLessThanOrEqual(2000);
  });

  it("gives chokidar the same interval", () => {
    expect(pollingEnv(true)).toContain(
      `CHOKIDAR_INTERVAL=${String(POLL_INTERVAL_MS)}`,
    );
  });
});
