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

const reportProject = vi.fn();
vi.mock("../../../apis/projects.ts", () => ({
  reportProjectApi: (projectId: string, reason: string, details?: string) =>
    reportProject(projectId, reason, details) as unknown,
}));

import { ReportProject } from "./ReportProject.tsx";

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <ReportProject projectId="p1" projectName="Leaky App" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  reportProject.mockReset();
  reportProject.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("reporting a published project", () => {
  /** The rare action on a card whose other two are the point of the page.
   *  It should be reachable and it should not compete. */
  it("is an icon with a name a screen reader can use", () => {
    show();

    expect(
      screen.getByRole("button", { name: "Report Leaky App" }),
    ).toBeTruthy();
  });

  it("does not send anything until the dialog is confirmed", () => {
    show();

    fireEvent.click(screen.getByRole("button", { name: "Report Leaky App" }));

    expect(reportProject).not.toHaveBeenCalled();
  });

  it("sends the reason and the description", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Report Leaky App" }));

    fireEvent.change(
      await screen.findByLabelText("What is wrong with it"),
      { target: { value: "  AWS key in .env  " } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Report" }));

    await waitFor(() => {
      expect(reportProject).toHaveBeenCalledWith("p1", "SECRETS", "AWS key in .env");
    });
  });

  /** Exposed secrets is the default because it is the case where speed
   *  matters and where the owner is usually grateful rather than aggrieved.
   *  A default of "something else" would make the common report the one that
   *  takes the most work to file. */
  it("defaults to the reason worth defaulting to", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Report Leaky App" }));

    expect(await screen.findByText("Exposed secrets")).toBeTruthy();
  });

  /** The server's message is the useful one: "you have already reported
   *  this", "that is your own project". Replacing it with a generic failure
   *  would throw away the only sentence that says what to do next. */
  it("shows what the server said when it refuses", async () => {
    reportProject.mockRejectedValue({
      response: { data: { message: "You have already reported this project." } },
    });

    show();
    fireEvent.click(screen.getByRole("button", { name: "Report Leaky App" }));
    fireEvent.click(await screen.findByRole("button", { name: "Report" }));

    expect(
      await screen.findByText("You have already reported this project."),
    ).toBeTruthy();
  });

  it("says the report was filed, and that there is no reply", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Report Leaky App" }));
    fireEvent.click(await screen.findByRole("button", { name: "Report" }));

    expect(await screen.findByText(/not hear back individually/)).toBeTruthy();
  });
});
