// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { TwoFactorPrompt } from "./TwoFactorPrompt.tsx";

/** The second step of a sign-in.
 *
 *  Small, and three of these are about the input rather than the flow — which
 *  is where this kind of screen actually goes wrong. A `type="number"` box
 *  strips the leading zero a TOTP code can start with and refuses the letters
 *  a recovery code contains, and either would look like "the server keeps
 *  saying my code is wrong".
 */

afterEach(cleanup);

function show(onSubmit = vi.fn().mockResolvedValue(undefined)) {
  const onCancel = vi.fn();
  render(<TwoFactorPrompt onSubmit={onSubmit} onCancel={onCancel} />);
  return { onSubmit, onCancel };
}

describe("the code prompt", () => {
  it("sends what was typed", async () => {
    const { onSubmit } = show();

    fireEvent.change(screen.getByLabelText("Authentication code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("123456");
    });
  });

  /** A TOTP code can begin with a zero and a recovery code contains letters.
   *  `type="number"` would eat the first and refuse the second. */
  it("accepts a leading zero and letters", async () => {
    const { onSubmit } = show();

    const field = screen.getByLabelText<HTMLInputElement>(
      "Authentication code",
    );
    expect(field.getAttribute("type")).not.toBe("number");

    fireEvent.change(field, { target: { value: "abcd-efgh" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("abcd-efgh");
    });
  });

  /** What lets a phone offer the code straight from the notification. */
  it("tells the browser this is a one-time code", () => {
    show();

    expect(
      screen
        .getByLabelText("Authentication code")
        .getAttribute("autocomplete"),
    ).toBe("one-time-code");
  });

  it("submits on Enter, because that is what people press", async () => {
    const { onSubmit } = show();

    const field = screen.getByLabelText("Authentication code");
    fireEvent.change(field, { target: { value: "123456" } });
    fireEvent.keyDown(field, { key: "Enter", keyCode: 13 });

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("123456");
    });
  });

  it("does nothing at all with an empty box", () => {
    const { onSubmit } = show();

    expect(
      screen.getByRole("button", { name: "Sign in" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  /** The failure is the interesting case: the code that just failed is either
   *  wrong or already spent, and in both cases the next thing to type is a
   *  different one. Leaving it in the box invites pressing the button again. */
  it("shows why it failed and clears the box", async () => {
    const onSubmit = vi.fn().mockRejectedValue({
      response: { data: { message: "That code has already been used." } },
    });
    show(onSubmit);

    fireEvent.change(screen.getByLabelText("Authentication code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByText(/already been used/)).toBeTruthy();
    });
    expect(
      screen.getByLabelText<HTMLInputElement>("Authentication code").value,
    ).toBe("");
  });

  it("offers a way back to the sign-in form", () => {
    const { onCancel } = show();

    fireEvent.click(
      screen.getByRole("button", { name: "Use a different account" }),
    );

    expect(onCancel).toHaveBeenCalled();
  });
});
