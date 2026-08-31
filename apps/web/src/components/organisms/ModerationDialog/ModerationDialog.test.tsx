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
import type { ModerationAction } from "@replit-clone/shared";

const listModeration = vi.fn();
const appealTakedown = vi.fn();

vi.mock("../../../apis/projects.ts", () => ({
  listProjectModerationApi: (id: string) => listModeration(id) as unknown,
  appealTakedownApi: (id: string, text: string) =>
    appealTakedown(id, text) as unknown,
}));

import { ModerationDialog } from "./ModerationDialog.tsx";

const TAKEN_DOWN = "2026-08-30T09:00:00.000Z";

function action(over: Partial<ModerationAction> = {}): ModerationAction {
  return {
    id: "a1",
    projectId: "p1",
    projectName: "Leaky App",
    reportId: "r1",
    action: "ACTIONED",
    actor: "mod@example.com",
    reason: null,
    createdAt: TAKEN_DOWN,
    ...over,
  };
}

function show(takenDownAt: string | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <ModerationDialog
        projectId="p1"
        projectName="Leaky App"
        takenDownAt={takenDownAt}
        open
        onClose={() => undefined}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listModeration.mockReset().mockResolvedValue([]);
  appealTakedown.mockReset().mockResolvedValue(action({ action: "APPEALED" }));
});

afterEach(cleanup);

/** The dialog exists because §2.17 shipped all of this on the server and
 *  nothing that called it: the owner was told their project was taken down and
 *  handed no way to read the decision or answer it. */
describe("a project that was taken down", () => {
  it("says what the takedown actually did", async () => {
    show(TAKEN_DOWN);

    expect(
      await screen.findByText(/took this project down after a report/i),
    ).toBeTruthy();
    // Not a vague "this project is unavailable". Each line is a query on the
    // server, and the owner is the person entitled to know which.
    expect(screen.getByText(/scheduled jobs are held/i)).toBeTruthy();
    expect(screen.getByText(/cannot be forked, duplicated or deployed/i)).toBeTruthy();
  });

  it("offers the appeal, and sends what was written", async () => {
    listModeration.mockResolvedValue([action()]);
    show(TAKEN_DOWN);

    const box = await screen.findByLabelText("Your appeal");
    fireEvent.change(box, { target: { value: "  The key was already rotated  " } });
    fireEvent.click(screen.getByRole("button", { name: /send appeal/i }));

    await waitFor(() => {
      expect(appealTakedown).toHaveBeenCalledWith(
        "p1",
        "The key was already rotated",
      );
    });
  });

  it("will not send an empty appeal", async () => {
    show(TAKEN_DOWN);

    const button = await screen.findByRole("button", { name: /send appeal/i });
    fireEvent.change(screen.getByLabelText("Your appeal"), {
      target: { value: "   " },
    });

    expect(button.hasAttribute("disabled")).toBe(true);
  });

  /** One appeal per takedown, and the owner should be told their appeal is
   *  somewhere rather than shown the form again as though nothing happened. */
  it("stops offering it once one has been filed", async () => {
    listModeration.mockResolvedValue([
      action(),
      action({ id: "a2", action: "APPEALED", createdAt: "2026-08-30T10:00:00.000Z" }),
    ]);
    show(TAKEN_DOWN);

    expect(await screen.findByText(/with an operator/i)).toBeTruthy();
    expect(screen.queryByLabelText("Your appeal")).toBeNull();
  });

  /** Compared against the CURRENT takedown, the way the server compares it. A
   *  project taken down, put back, and taken down again is a new case, and an
   *  appeal from the old one must not be mistaken for an answer to this one. */
  it("offers it again after a second takedown", async () => {
    listModeration.mockResolvedValue([
      action({ id: "a0", createdAt: "2026-08-01T09:00:00.000Z" }),
      action({
        id: "a1",
        action: "APPEALED",
        createdAt: "2026-08-02T09:00:00.000Z",
      }),
      action({
        id: "a2",
        action: "REINSTATED",
        createdAt: "2026-08-03T09:00:00.000Z",
      }),
      action({ id: "a3", createdAt: TAKEN_DOWN }),
    ]);
    show(TAKEN_DOWN);

    expect(await screen.findByLabelText("Your appeal")).toBeTruthy();
  });
});

describe("a project nobody took down", () => {
  it("shows the trail without offering an appeal", async () => {
    listModeration.mockResolvedValue([
      action({ action: "DISMISSED", reason: "Nothing in the report." }),
    ]);
    show(null);

    // Dismissals are in the trail on purpose: "reported and cleared" reads
    // differently from "never reported", but only if the clearings are shown.
    expect(await screen.findByText("Report dismissed")).toBeTruthy();
    expect(screen.getByText("Nothing in the report.")).toBeTruthy();
    expect(screen.queryByLabelText("Your appeal")).toBeNull();
    expect(screen.queryByText(/took this project down/i)).toBeNull();
  });

  it("says so when nothing has ever happened", async () => {
    show(null);

    expect(await screen.findByText(/nobody has ever reported this project/i)).toBeTruthy();
  });

  /** Owner-only on the server. A 403 has to read as a refusal rather than an
   *  empty history, which would look like "nothing happened". */
  it("does not render a refusal as an empty history", async () => {
    listModeration.mockRejectedValue(new Error("403"));
    show(null);

    expect(
      await screen.findByText(/could not load this project's moderation history/i),
    ).toBeTruthy();
  });
});
