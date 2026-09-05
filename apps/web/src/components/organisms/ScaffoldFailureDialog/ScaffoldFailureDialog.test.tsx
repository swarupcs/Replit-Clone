// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@replit-clone/shared";

/** Why a "Latest" project did not get built.
 *
 *  The reason is the whole content, and these tests are about that rather than
 *  about the buttons. "Creation failed" is not something anybody can act on;
 *  "npm ERR! network timeout" says try again, and "Cannot find module" says do
 *  not bother until upstream is fixed. Summarising the scaffolder's words into
 *  something reassuring would throw away the only actionable part.
 */

const getScaffoldState = vi.fn();
const retryScaffold = vi.fn();

vi.mock("../../../apis/projects.ts", () => ({
  getScaffoldStateApi: (id: string) => getScaffoldState(id) as unknown,
  retryScaffoldApi: (id: string) => retryScaffold(id) as unknown,
}));

import { ScaffoldFailureDialog } from "./ScaffoldFailureDialog.tsx";

const PROJECT = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "my-app",
} as Project;

function show(overrides: Partial<Parameters<typeof ScaffoldFailureDialog>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <ScaffoldFailureDialog
        project={PROJECT}
        onClose={() => undefined}
        onRetried={() => undefined}
        onDelete={() => undefined}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getScaffoldState.mockReset().mockResolvedValue({
    status: "FAILED",
    log: "npm ERR! network timeout at registry.npmjs.org",
  });
  retryScaffold.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("what it tells the person", () => {
  it("shows the setup tool's own words, not a summary of them", async () => {
    show();

    expect(
      await screen.findByText(/npm ERR! network timeout at registry\.npmjs\.org/),
    ).toBeTruthy();
  });

  /** A stack trace reflowed as prose is unreadable, and this is output from a
   *  program rather than a sentence. */
  it("keeps the output as output", async () => {
    show();

    const block = await screen.findByLabelText(/what the setup tool said/i);
    expect(block.tagName).toBe("PRE");
  });

  it("says plainly that nothing was installed", async () => {
    show();

    expect(await screen.findByText(/nothing was installed/i)).toBeTruthy();
  });

  /** A scaffolder that died before writing anything is a real case, and a
   *  dialog that rendered an empty box for it would look broken. */
  it("still renders when there is no output at all", async () => {
    getScaffoldState.mockResolvedValue({ status: "FAILED", log: null });
    show();

    await screen.findByText(/nothing was installed/i);
    expect(screen.queryByLabelText(/what the setup tool said/i)).toBeNull();
  });
});

describe("the ways out", () => {
  /** Both are offered because they are genuinely different decisions: retry is
   *  right when the network was down, delete when the recipe itself is broken
   *  and retrying would fail identically. */
  it("offers both trying again and deleting it", async () => {
    show();

    await screen.findByText(/nothing was installed/i);
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /delete it/i })).toBeTruthy();
  });

  it("starts the rebuild and tells the dashboard to refresh", async () => {
    const onRetried = vi.fn();
    show({ onRetried });
    await screen.findByText(/nothing was installed/i);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => {
      expect(retryScaffold).toHaveBeenCalledWith(PROJECT.id);
      expect(onRetried).toHaveBeenCalled();
    });
  });

  /** Never silently: a retry that failed and closed would look like it worked,
   *  and the project would still be FAILED on the dashboard behind it. */
  it("says so when the rebuild could not be started", async () => {
    retryScaffold.mockRejectedValue({
      response: { data: { message: "This template has no recipe to build from." } },
    });
    const onRetried = vi.fn();
    show({ onRetried });
    await screen.findByText(/nothing was installed/i);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByText(/no recipe to build from/i)).toBeTruthy();
    expect(onRetried).not.toHaveBeenCalled();
  });

  /** It does not delete anything itself -- it hands the project to the
   *  dashboard's existing delete confirmation, which is the one place that
   *  asks the question properly. */
  it("hands a deletion to the dialog that confirms it", async () => {
    const onDelete = vi.fn();
    show({ onDelete });
    await screen.findByText(/nothing was installed/i);

    fireEvent.click(screen.getByRole("button", { name: /delete it/i }));

    expect(onDelete).toHaveBeenCalledWith(PROJECT);
  });
});

it("asks for nothing while no project is being shown", () => {
  show({ project: null });

  expect(getScaffoldState).not.toHaveBeenCalled();
});
