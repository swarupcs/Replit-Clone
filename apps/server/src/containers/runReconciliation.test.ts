import { describe, expect, it } from "vitest";
import {
  isResumable,
  reconcileDecision,
  type RunReality,
} from "./runReconciliation.js";

/** The rules on their own, with no Docker anywhere near them. */

function reality(over: Partial<RunReality> = {}): RunReality {
  return {
    status: "idle",
    containerRunning: true,
    listening: false,
    ...over,
  };
}

describe("something is serving", () => {
  it("adopts it when the state does not know about it", () => {
    expect(reconcileDecision(reality({ status: "idle", listening: true }))).toBe(
      "adopt",
    );
  });

  /** A server restart leaves this behind: the run carried on in the container
   *  while the process holding its state went away. */
  it("adopts it when the state was left at exited", () => {
    expect(
      reconcileDecision(reality({ status: "exited", listening: true })),
    ).toBe("adopt");
  });

  it("leaves it alone when the state already says running", () => {
    expect(
      reconcileDecision(reality({ status: "running", listening: true })),
    ).toBe("none");
  });
});

describe("a run that is still on its way up", () => {
  /** `npm install` before `npm run dev` means minutes with nothing listening.
   *  Reading that as a run that has vanished would restart every project in the
   *  middle of installing its own dependencies. */
  it("is left alone while Docker still reports its process alive", () => {
    expect(
      reconcileDecision(reality({ status: "starting", execRunning: true })),
    ).toBe("none");
  });

  it("is left alone even when the state already says running", () => {
    expect(
      reconcileDecision(reality({ status: "running", execRunning: true })),
    ).toBe("none");
  });
});

/** The case that wedged a project.
 *
 *  Docker does not always close a hijacked exec stream when its process dies,
 *  so the handler that records the exit never fires and the state says
 *  `running` for ever. That blocks adoption (it believes it already has the
 *  run) and blocks the automatic start (something is already going), so no
 *  number of page reloads could put it right — the user had to press Stop and
 *  then Run.
 */
describe("a run the state claims but nothing can be found of", () => {
  it("is lost when its process is no longer running", () => {
    expect(
      reconcileDecision(reality({ status: "running", execRunning: false })),
    ).toBe("lost");
  });

  /** After a server restart there is no exec to ask about at all. */
  it("is lost when there is no process to ask about", () => {
    expect(reconcileDecision(reality({ status: "running" }))).toBe("lost");
  });

  it("may start itself again, since the user never stopped it", () => {
    expect(isResumable("lost")).toBe(true);
  });
});

/** The distinction the old code could not make. Both leave nothing running;
 *  only one of them is the user's problem. */
describe("exited with nothing listening", () => {
  it("is a crash to look at while the container is still up", () => {
    expect(
      reconcileDecision(reality({ status: "exited", containerRunning: true })),
    ).toBe("none");
  });

  it("is a reclaimed container when the container went too", () => {
    expect(
      reconcileDecision(reality({ status: "exited", containerRunning: false })),
    ).toBe("reclaimed");
  });

  it("comes back by itself, because the idle reaper is not a failure", () => {
    expect(isResumable("reclaimed")).toBe(true);
  });

  /** A dev server that fails to compile would otherwise be restarted into the
   *  same failure on every reconnect. */
  it("does not come back by itself when it really did crash", () => {
    expect(isResumable("none")).toBe(false);
  });
});

describe("nothing to do", () => {
  it("leaves an idle project idle", () => {
    expect(reconcileDecision(reality({ status: "idle" }))).toBe("none");
  });

  it("leaves an idle project with no container idle", () => {
    expect(
      reconcileDecision(reality({ status: "idle", containerRunning: false })),
    ).toBe("none");
  });

  it("does not adopt on the strength of a container alone", () => {
    expect(
      reconcileDecision(
        reality({ status: "idle", containerRunning: true, listening: false }),
      ),
    ).toBe("none");
  });
});
