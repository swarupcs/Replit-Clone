// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TwoFactorStatus } from "@replit-clone/shared";

/** The security panel.
 *
 *  Three things are worth pinning and none of them is the layout. The recovery
 *  codes are shown once and there is no second chance to read them, so they
 *  have to actually appear. The two destructive actions must not be reachable
 *  without a password, because the server refuses them and a button that
 *  always fails is worse than no button. And "no recovery codes left" has to
 *  say so — it is one lost phone away from a lost account and nothing else in
 *  the product would ever mention it.
 */

const twoFactorStatus = vi.fn();
const beginTwoFactor = vi.fn();
const confirmTwoFactor = vi.fn();
const disableTwoFactor = vi.fn();
const regenerateRecoveryCodes = vi.fn();

vi.mock("../../../apis/auth.ts", () => ({
  twoFactorStatusApi: () => twoFactorStatus() as unknown,
  beginTwoFactorApi: () => beginTwoFactor() as unknown,
  confirmTwoFactorApi: (code: string) => confirmTwoFactor(code) as unknown,
  disableTwoFactorApi: (password: string) =>
    disableTwoFactor(password) as unknown,
  regenerateRecoveryCodesApi: (password: string) =>
    regenerateRecoveryCodes(password) as unknown,
}));

import { Security } from "./Security.tsx";

function status(over: Partial<TwoFactorStatus> = {}): TwoFactorStatus {
  return { enabled: false, pending: false, recoveryCodesLeft: 0, ...over };
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <Security />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  twoFactorStatus.mockReset().mockResolvedValue(status());
  beginTwoFactor.mockReset().mockResolvedValue({
    secret: "ABCDEFGHABCDEFGHABCDEFGHABCDEFGH",
    otpauthUrl: "otpauth://totp/x",
  });
  confirmTwoFactor.mockReset().mockResolvedValue({
    recoveryCodes: ["abcd-efgh", "ijkl-mnop"],
    status: status({ enabled: true, recoveryCodesLeft: 2 }),
  });
  disableTwoFactor.mockReset().mockResolvedValue(status());
  regenerateRecoveryCodes.mockReset().mockResolvedValue({
    recoveryCodes: ["qrst-uvwx"],
    status: status({ enabled: true, recoveryCodesLeft: 1 }),
  });
});

afterEach(cleanup);

describe("an account with nothing set up", () => {
  it("offers to set it up", async () => {
    show();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Set up two-factor" }),
      ).toBeTruthy();
    });
  });

  /** An unfinished enrolment shown as "off" leaves somebody with no way to
   *  understand why starting again behaves oddly. */
  it("says when a setup was started and abandoned", async () => {
    twoFactorStatus.mockResolvedValue(status({ pending: true }));

    show();

    await waitFor(() => {
      expect(screen.getByText("Half set up")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Start again" })).toBeTruthy();
  });

  it("shows the setup key to type into an app", async () => {
    show();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Set up two-factor" }),
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Set up two-factor" }));

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>("Setup key").value).toBe(
        "ABCDEFGHABCDEFGHABCDEFGHABCDEFGH",
      );
    });
  });

  /** Shown once, and no second chance to read them. */
  it("shows the recovery codes after confirming", async () => {
    show();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Set up two-factor" }),
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Set up two-factor" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Code from the app")).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText("Code from the app"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn it on" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Recovery codes").textContent).toContain(
        "abcd-efgh",
      );
    });
    expect(confirmTwoFactor).toHaveBeenCalledWith("123456");
  });

  /** The refusal is the useful part — "check your phone's clock" is a sentence
   *  somebody can act on — so it has to survive the round trip. */
  it("shows the server's reason for refusing a code", async () => {
    confirmTwoFactor.mockRejectedValue({
      response: { data: { message: "That code did not match. Check your clock." } },
    });

    show();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Set up two-factor" }),
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Set up two-factor" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Code from the app")).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText("Code from the app"), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn it on" }));

    await waitFor(() => {
      expect(screen.getByText(/Check your clock/)).toBeTruthy();
    });
  });
});

describe("an account with it on", () => {
  beforeEach(() => {
    twoFactorStatus.mockResolvedValue(
      status({ enabled: true, recoveryCodesLeft: 7 }),
    );
  });

  it("says how many recovery codes are left", async () => {
    show();

    await waitFor(() => {
      expect(screen.getByText(/7 recovery codes left/)).toBeTruthy();
    });
  });

  /** The server refuses both of these without a password, so offering them
   *  before one is typed is offering a button that always fails. */
  it("will not disable or reissue until a password is typed", async () => {
    show();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy();
    });
    expect(
      screen.getByRole("button", { name: "Turn off" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "New recovery codes" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("sends the password when turning it off", async () => {
    show();

    await waitFor(() => {
      expect(screen.getByLabelText("Confirm your password")).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText("Confirm your password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));

    await waitFor(() => {
      expect(disableTwoFactor).toHaveBeenCalledWith("hunter2");
    });
  });

  it("shows the new codes after reissuing them", async () => {
    show();

    await waitFor(() => {
      expect(screen.getByLabelText("Confirm your password")).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText("Confirm your password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "New recovery codes" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Recovery codes").textContent).toContain(
        "qrst-uvwx",
      );
    });
  });

  /** One lost phone from a lost account, and nothing else would say so. */
  it("warns loudly when there are none left", async () => {
    twoFactorStatus.mockResolvedValue(
      status({ enabled: true, recoveryCodesLeft: 0 }),
    );

    show();

    await waitFor(() => {
      expect(screen.getByText("No recovery codes left")).toBeTruthy();
    });
  });
});
