// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TerminalKeyBar } from "./TerminalKeyBar.tsx";

/** §13.10's key bar. What matters is what reaches the socket, so these assert
 *  bytes rather than appearance. */

afterEach(() => {
  cleanup();
});

const ESC = String.fromCharCode(27);

describe("the terminal key bar", () => {
  it("sends interrupt when the labelled key is tapped", () => {
    // The reason the bar exists, and it is one tap rather than two.
    const onSend = vi.fn();
    render(<TerminalKeyBar onSend={onSend} />);

    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));

    expect(onSend).toHaveBeenCalledWith(String.fromCharCode(3));
  });

  it("sends a real escape sequence for an arrow", () => {
    const onSend = vi.fn();
    render(<TerminalKeyBar onSend={onSend} />);

    fireEvent.click(screen.getByRole("button", { name: "Up arrow" }));

    expect(onSend).toHaveBeenCalledWith(`${ESC}[A`);
  });

  it("sends nothing when Ctrl is armed, and says it is armed", () => {
    const onSend = vi.fn();
    render(<TerminalKeyBar onSend={onSend} />);

    const ctrl = screen.getByRole("button", { name: "Control" });
    fireEvent.click(ctrl);

    expect(onSend).not.toHaveBeenCalled();
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");
  });

  it("lets a second tap disarm Ctrl, so a mis-tap is undoable", () => {
    const onSend = vi.fn();
    render(<TerminalKeyBar onSend={onSend} />);

    const ctrl = screen.getByRole("button", { name: "Control" });
    fireEvent.click(ctrl);
    fireEvent.click(ctrl);

    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("disarms Ctrl after the next key rather than stranding a hidden mode", () => {
    const onSend = vi.fn();
    render(<TerminalKeyBar onSend={onSend} />);

    const ctrl = screen.getByRole("button", { name: "Control" });
    fireEvent.click(ctrl);
    fireEvent.click(screen.getByRole("button", { name: "Tab" }));

    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
  });

  it("is a toolbar with a name, since every key on it is a glyph", () => {
    render(<TerminalKeyBar onSend={vi.fn()} />);
    expect(screen.getByRole("toolbar", { name: "Terminal keys" })).toBeTruthy();
  });
});
