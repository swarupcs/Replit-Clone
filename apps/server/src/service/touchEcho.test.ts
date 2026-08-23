import { beforeEach, describe, expect, it } from "vitest";
import {
  expectTouchEcho,
  forgetTouchEchoes,
  resetTouchEchoes,
  withoutOurOwnTouches,
} from "./touchEcho.js";

/** The loop this module exists to break:
 *
 *  the host watcher reports a save → the server touches those files inside the
 *  container so the container's own watchers hear about it → the touch lands on
 *  the host file through the bind mount → the host watcher reports it → …
 *
 *  Measured on Docker Desktop for Windows at roughly a cycle a second, which
 *  refetched the file tree and remounted the preview iframe continuously.
 */

const PROJECT = "3d317834-566d-474a-bb94-7af2c649aa2e";
const OTHER = "bfc6cdde-d0bb-4731-b873-be67ea3e5a69";

beforeEach(() => {
  resetTouchEchoes();
});

describe("a change nobody announced", () => {
  it("is the user's, and is reported", () => {
    expect(withoutOurOwnTouches(PROJECT, ["app/page.jsx"])).toEqual([
      "app/page.jsx",
    ]);
  });

  it("is reported for a project that has never been touched", () => {
    expectTouchEcho(OTHER, ["app/page.jsx"]);

    expect(withoutOurOwnTouches(PROJECT, ["app/page.jsx"])).toEqual([
      "app/page.jsx",
    ]);
  });

  /** Expectations are per file, not per project — a touch of one file must not
   *  hide a save of the one beside it. */
  it("is reported for a file we did not touch", () => {
    expectTouchEcho(PROJECT, ["app/page.jsx"]);

    expect(withoutOurOwnTouches(PROJECT, ["app/layout.jsx"])).toEqual([
      "app/layout.jsx",
    ]);
  });
});

describe("the echo of our own touch", () => {
  it("is recognised and not reported", () => {
    expectTouchEcho(PROJECT, ["app/page.jsx"]);

    expect(withoutOurOwnTouches(PROJECT, ["app/page.jsx"])).toEqual([]);
  });

  /** The loop, in one assertion: without this the second pass reports the file
   *  again, and every pass after it does the same. */
  it("does not come back a second time", () => {
    expectTouchEcho(PROJECT, ["app/page.jsx"]);
    withoutOurOwnTouches(PROJECT, ["app/page.jsx"]);

    // Nothing touched it again, so a further event is somebody else's.
    expect(withoutOurOwnTouches(PROJECT, ["app/page.jsx"])).toEqual([
      "app/page.jsx",
    ]);
  });

  /** Two touches owe two events. Spending one on both would leave the second
   *  to restart the loop. */
  it("is spent once per touch", () => {
    expectTouchEcho(PROJECT, ["app/page.jsx"]);
    expectTouchEcho(PROJECT, ["app/page.jsx"]);

    expect(withoutOurOwnTouches(PROJECT, ["app/page.jsx"])).toEqual([]);
    expect(withoutOurOwnTouches(PROJECT, ["app/page.jsx"])).toEqual([]);
    expect(withoutOurOwnTouches(PROJECT, ["app/page.jsx"])).toEqual([
      "app/page.jsx",
    ]);
  });

  /** A burst can carry both. Reporting the save is the point; settling the
   *  echo in the same pass is what stops it surfacing on its own afterwards. */
  it("is settled even when a real save arrives with it", () => {
    expectTouchEcho(PROJECT, ["app/page.jsx"]);

    expect(
      withoutOurOwnTouches(PROJECT, ["app/page.jsx", "app/layout.jsx"]),
    ).toEqual(["app/layout.jsx"]);

    expect(withoutOurOwnTouches(PROJECT, ["app/page.jsx"])).toEqual([
      "app/page.jsx",
    ]);
  });
});

describe("an echo that never arrives", () => {
  const START = 1_000_000;

  /** On Linux the touch does not happen at all, and a failed exec owes
   *  nothing either. An expectation kept forever would swallow the user's next
   *  save of that file however much later it came. */
  it("stops being expected", () => {
    expectTouchEcho(PROJECT, ["app/page.jsx"], START);

    expect(
      withoutOurOwnTouches(PROJECT, ["app/page.jsx"], START + 60_000),
    ).toEqual(["app/page.jsx"]);
  });

  it("is still expected within the window", () => {
    expectTouchEcho(PROJECT, ["app/page.jsx"], START);

    expect(
      withoutOurOwnTouches(PROJECT, ["app/page.jsx"], START + 1000),
    ).toEqual([]);
  });

  /** A fresh touch after a lapsed one owes ONE event, not two: the debt that
   *  expired is gone, and carrying it forward would eat a real save. */
  it("does not add to the debt of a later touch", () => {
    expectTouchEcho(PROJECT, ["app/page.jsx"], START);
    expectTouchEcho(PROJECT, ["app/page.jsx"], START + 60_000);

    expect(
      withoutOurOwnTouches(PROJECT, ["app/page.jsx"], START + 60_100),
    ).toEqual([]);
    expect(
      withoutOurOwnTouches(PROJECT, ["app/page.jsx"], START + 60_200),
    ).toEqual(["app/page.jsx"]);
  });
});

describe("forgetting a project", () => {
  it("leaves its outstanding echoes behind", () => {
    expectTouchEcho(PROJECT, ["app/page.jsx"]);
    forgetTouchEchoes(PROJECT);

    expect(withoutOurOwnTouches(PROJECT, ["app/page.jsx"])).toEqual([
      "app/page.jsx",
    ]);
  });

  it("leaves other projects alone", () => {
    expectTouchEcho(PROJECT, ["app/page.jsx"]);
    expectTouchEcho(OTHER, ["app/page.jsx"]);
    forgetTouchEchoes(PROJECT);

    expect(withoutOurOwnTouches(OTHER, ["app/page.jsx"])).toEqual([]);
  });
});
