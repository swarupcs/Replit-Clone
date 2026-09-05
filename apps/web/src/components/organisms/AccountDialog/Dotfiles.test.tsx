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
import type { Personalization } from "@replit-clone/shared";

/** The dotfiles panel.
 *
 *  Three things worth pinning, and none of them is the layout. That the stored
 *  values REACH the form -- a form filled from an `initialValues` read before
 *  the request answers stays empty for ever, which is the failure this
 *  component is one `useEffect` away from. That an empty field is sent as an
 *  empty string rather than dropped, because dropping it is how "clear my
 *  dotfiles" silently becomes "leave them alone". And that the server's own
 *  refusal is what the user is shown, rather than a generic apology, because
 *  the refusals here are the useful part: "an ssh URL would authenticate as
 *  the server" is a sentence somebody can act on.
 */

const getPersonalization = vi.fn();
const updatePersonalization = vi.fn();

vi.mock("../../../apis/projects.ts", () => ({
  getPersonalizationApi: () => getPersonalization() as unknown,
  updatePersonalizationApi: (update: unknown) =>
    updatePersonalization(update) as unknown,
}));

import { Dotfiles } from "./Dotfiles.tsx";

// antd's Form reads `matchMedia` for its responsive layout, and jsdom ships
// none. Nothing here depends on the answer, so a fixed one is enough.
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
}));

function settings(over: Partial<Personalization> = {}): Personalization {
  return {
    dotfilesRepo: null,
    dotfilesTarget: null,
    dotfilesInstall: null,
    ...over,
  };
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <Dotfiles />
    </QueryClientProvider>,
  );
}

function field(label: string): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(label);
}

beforeEach(() => {
  getPersonalization.mockReset().mockResolvedValue(settings());
  updatePersonalization.mockReset().mockResolvedValue(settings());
});

afterEach(cleanup);

describe("the dotfiles panel", () => {
  /** The one a `initialValues` version would fail. */
  it("shows what is already saved", async () => {
    getPersonalization.mockResolvedValue(
      settings({
        dotfilesRepo: "https://github.com/you/dotfiles",
        dotfilesTarget: "~/.dots",
        dotfilesInstall: "./setup.sh",
      }),
    );

    show();

    await waitFor(() => {
      expect(field("Repository").value).toBe(
        "https://github.com/you/dotfiles",
      );
    });
    expect(field("Clone into").value).toBe("~/.dots");
    expect(field("Install command").value).toBe("./setup.sh");
  });

  it("saves nothing until something changes", async () => {
    show();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
      ).toBe(true);
    });
  });

  it("sends what was typed", async () => {
    show();

    await waitFor(() => {
      expect(field("Repository")).toBeTruthy();
    });
    fireEvent.change(field("Repository"), {
      target: { value: "https://github.com/you/dotfiles" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updatePersonalization).toHaveBeenCalledWith(
        expect.objectContaining({
          dotfilesRepo: "https://github.com/you/dotfiles",
        }),
      );
    });
  });

  /** Emptying a field has to be a request to CLEAR it. A body that simply
   *  omits the empty ones would make this panel one-way: you could set
   *  dotfiles and never stop using them. */
  it("clears a field by sending it empty rather than by omitting it", async () => {
    getPersonalization.mockResolvedValue(
      settings({ dotfilesRepo: "https://github.com/you/dotfiles" }),
    );

    show();

    await waitFor(() => {
      expect(field("Repository").value).toContain("github.com");
    });
    fireEvent.change(field("Repository"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updatePersonalization).toHaveBeenCalled();
    });
    const sent = updatePersonalization.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(sent).toHaveProperty("dotfilesRepo", "");
  });

  /** The refusals are the useful part of this feature, so they have to survive
   *  the round trip rather than becoming "something went wrong". */
  it("shows the server's own reason for refusing a URL", async () => {
    updatePersonalization.mockRejectedValue({
      response: {
        data: {
          message:
            "Only https:// repositories can be cloned. An ssh:// URL would authenticate as the server rather than as you.",
        },
      },
    });

    show();

    await waitFor(() => {
      expect(field("Repository")).toBeTruthy();
    });
    fireEvent.change(field("Repository"), {
      target: { value: "ssh://git@github.com/you/dotfiles" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText(/authenticate as the server/)).toBeTruthy();
    });
  });

  /** A project already open keeps the shell it started with. Somebody who saw
   *  no change would otherwise conclude the feature does not work. */
  it("says when the settings take effect", () => {
    show();

    expect(
      screen.getByText(/Applied when a container is created/),
    ).toBeTruthy();
  });
});
