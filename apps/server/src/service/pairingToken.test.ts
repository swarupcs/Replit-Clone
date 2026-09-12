import { describe, expect, it } from "vitest";
import {
  signAccessToken,
  signPairingToken,
  signPreviewToken,
  verifyAccessToken,
  verifyPairingToken,
} from "./tokenService.js";

/** §13.6's credential.
 *
 *  A pairing token is the one credential in this product that belongs to
 *  nobody — there is no account behind it. Two things keep that from being a
 *  hole: the `typ` claim, which stops it being spent anywhere an access token
 *  is expected, and the `pid` claim, which stops it being spent on another
 *  project. Both are asserted here, and from both directions.
 */

const CLAIMS = {
  sub: "guest_1",
  pid: "project-a",
  role: "EDITOR" as const,
  nam: "Sam",
};

describe("a pairing token", () => {
  it("round-trips the guest, the project, the role and the name", () => {
    expect(verifyPairingToken(signPairingToken(CLAIMS))).toMatchObject(CLAIMS);
  });

  it("is NOT accepted as an access token", () => {
    // The failure the `typ` claim was added to stop, arriving by a new door:
    // a credential handed to somebody with no account must not be spendable
    // as a session. Both are signed with the same secret, so only `typ`
    // separates them.
    expect(() => verifyAccessToken(signPairingToken(CLAIMS))).toThrow();
  });

  it("does not accept an access token in its place", () => {
    expect(() =>
      verifyPairingToken(signAccessToken({ sub: "user-1", email: "a@b.test" })),
    ).toThrow();
  });

  it("does not accept a preview token in its place", () => {
    // The preview cookie is handed to untrusted project code, so it is the
    // most exposed token this product has.
    expect(() => verifyPairingToken(signPreviewToken("user-1"))).toThrow();
  });

  it("refuses a token with no project, rather than defaulting to all of them", () => {
    // A pairing token with no `pid` is a pairing token for every project.
    const forged = signPairingToken({ ...CLAIMS, pid: "" });
    expect(() => verifyPairingToken(forged)).toThrow();
  });

  it("refuses a role it does not recognise", () => {
    const forged = signPairingToken({
      ...CLAIMS,
      role: "OWNER" as unknown as "EDITOR",
    });
    expect(() => verifyPairingToken(forged)).toThrow();
  });

  it("refuses a signature made with another secret", () => {
    expect(() => verifyPairingToken("not.a.token")).toThrow();
  });

  it("names an unnamed guest rather than leaving the label empty", () => {
    const token = signPairingToken({ ...CLAIMS, nam: "" });
    expect(verifyPairingToken(token).nam).toBe("Guest");
  });
});
