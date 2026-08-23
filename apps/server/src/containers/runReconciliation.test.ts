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

/** The state a NEW project is in for its first few minutes: `npm install` is
 *  running, nothing is listening yet, and the run has no exec in this process
 *  because the server restarted under it.
 *
 *  Without a second witness that reads as a project nobody has ever started —
 *  so opening it launched a second install into the same directory as the
 *  first, and the user watched two npms fight over one node_modules while the
 *  Output pane showed neither.
 */
describe("a run that is alive but not yet serving", () => {
  it("is taken over rather than read as never started", () => {
    expect(
      reconcileDecision(
        reality({
          status: "idle",
          processGroupAlive: true,
          containerRunning: true,
          listening: false,
        }),
      ),
    ).toBe("adopt");
  });

  /** Already accounted for. Adopting a run this process is already tracking
   *  would replay its log over output it never lost. */
  it("is left alone when the state already says starting", () => {
    expect(
      reconcileDecision(
        reality({
          status: "starting",
          processGroupAlive: true,
          containerRunning: true,
          listening: false,
        }),
      ),
    ).toBe("none");
  });

  /** A run wedged at `running` with nothing serving, but whose process really
   *  is alive, is mid-something — a rebuild, a restart of its own — not gone.
   *  Demoting it to idle would let the automatic start put a second one beside
   *  a process still holding the port. */
  it("is not declared lost while its process is still there", () => {
    expect(
      reconcileDecision(
        reality({
          status: "running",
          processGroupAlive: true,
          containerRunning: true,
          listening: false,
        }),
      ),
    ).toBe("none");
  });

  /** The exec settles it first when we have one: it is Docker's answer about
   *  the very process we started, where the recorded group is a pid read out
   *  of a file the run wrote. */
  it("does not override the exec this process holds", () => {
    expect(
      reconcileDecision(
        reality({
          status: "starting",
          execRunning: true,
          processGroupAlive: false,
          containerRunning: true,
          listening: false,
        }),
      ),
    ).toBe("none");
  });

  /** Serving outranks everything. A group id that has gone stale — the run
   *  finished and the kernel reused the pid — must not stop an adoption that
   *  a live HTTP response has already justified. */
  it("does not stop a serving run being adopted", () => {
    expect(
      reconcileDecision(
        reality({
          status: "idle",
          processGroupAlive: false,
          containerRunning: true,
          listening: true,
        }),
      ),
    ).toBe("adopt");
  });

  /** The distinction the whole thing rests on: nothing listening AND nothing
   *  alive is a run that has gone, whatever the state still claims. */
  it("is still lost when no process group answers", () => {
    expect(
      reconcileDecision(
        reality({
          status: "running",
          processGroupAlive: false,
          containerRunning: true,
          listening: false,
        }),
      ),
    ).toBe("lost");
  });
});
