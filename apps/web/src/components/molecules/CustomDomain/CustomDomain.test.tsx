// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { CustomDomain as CustomDomainRow } from "@replit-clone/shared";

const claimDomain = vi.fn();
const verifyDomain = vi.fn();
const releaseDomain = vi.fn();

/** antd renders messages into a portal of its own. Stubbed rather than
 *  queried out of the document, because what this test cares about is which
 *  text was handed to it -- and asserting on a toast's DOM is asserting on
 *  antd. */
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return { ...actual, message: toast };
});

vi.mock("../../../apis/deployments.ts", () => ({
  claimDomainApi: (projectId: string, domain: string) =>
    claimDomain(projectId, domain) as unknown,
  verifyDomainApi: (projectId: string) => verifyDomain(projectId) as unknown,
  releaseDomainApi: (projectId: string) => releaseDomain(projectId) as unknown,
}));

import { CustomDomain } from "./CustomDomain.tsx";

/** The panel that points a domain at a deployment.
 *
 *  The state worth testing is the middle one. A domain exists on the row
 *  before anybody has proved they own it, so there is necessarily a window
 *  where the claim is stored and the address does not work — and the failure
 *  this component could have is rendering that window as though the site were
 *  live at the name.
 */
const UNVERIFIED: CustomDomainRow = {
  domain: "www.example.com",
  verified: false,
  verifiedAt: null,
  checkedAt: null,
  txtName: "_replit-clone-verify.www.example.com",
  txtValue: "a-token-worth-copying",
};

const VERIFIED: CustomDomainRow = {
  ...UNVERIFIED,
  verified: true,
  verifiedAt: new Date().toISOString(),
  checkedAt: new Date().toISOString(),
};

const onChange = vi.fn();

function show(domain: CustomDomainRow | null) {
  return render(
    <CustomDomain projectId="p1" domain={domain} onChange={onChange} />,
  );
}

beforeEach(() => {
  claimDomain.mockReset().mockResolvedValue(UNVERIFIED);
  verifyDomain.mockReset().mockResolvedValue(VERIFIED);
  releaseDomain.mockReset().mockResolvedValue({});
  onChange.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(cleanup);

describe("with no domain claimed", () => {
  it("offers the form and nothing else", () => {
    show(null);

    expect(screen.getByLabelText("Custom domain")).toBeTruthy();
    // Nothing to verify or remove yet, and offering either would be offering
    // a button that cannot do anything.
    expect(screen.queryByText("Verify")).toBeNull();
    expect(screen.queryByLabelText("Remove domain")).toBeNull();
  });

  it("will not submit an empty name", () => {
    show(null);

    fireEvent.click(screen.getByText("Add").closest("button")!);
    expect(claimDomain).not.toHaveBeenCalled();
  });

  it("claims what was typed, trimmed", async () => {
    show(null);

    fireEvent.change(screen.getByLabelText("Custom domain"), {
      target: { value: "  www.example.com  " },
    });
    fireEvent.click(screen.getByText("Add").closest("button")!);

    await waitFor(() => {
      expect(claimDomain).toHaveBeenCalledWith("p1", "www.example.com");
    });
    // The panel above owns the deployment, so this refetches rather than
    // keeping a second copy of it here.
    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
  });
});

describe("claimed but not yet proved", () => {
  it("says it is waiting, and shows the record to publish", () => {
    show(UNVERIFIED);

    expect(screen.getByText("awaiting DNS")).toBeTruthy();
    expect(screen.getByText("_replit-clone-verify.www.example.com")).toBeTruthy();
    expect(screen.getByText("a-token-worth-copying")).toBeTruthy();
  });

  it("does not link to the domain", () => {
    show(UNVERIFIED);

    // The address does not work yet. A link here is an invitation to conclude
    // the platform is broken.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("verifies on request", async () => {
    show(UNVERIFIED);

    fireEvent.click(screen.getByText("Verify").closest("button")!);

    await waitFor(() => {
      expect(verifyDomain).toHaveBeenCalledWith("p1");
    });
  });

  it("keeps the server's reason when verification fails", async () => {
    // Every refusal here is actionable -- the record is not there yet, the
    // name is taken -- and replacing them with "something went wrong" throws
    // away the only part the user can act on.
    verifyDomain.mockRejectedValue(new Error("No matching TXT record yet."));
    show(UNVERIFIED);

    fireEvent.click(screen.getByText("Verify").closest("button")!);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("No matching TXT record yet.");
    });
  });
});

describe("verified", () => {
  it("links to the domain and stops asking for DNS", () => {
    show(VERIFIED);

    expect(screen.getByText("verified")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://www.example.com",
    );
    expect(screen.queryByText("Verify")).toBeNull();
    // The record has done its job; leaving it on screen implies there is
    // still something to do.
    expect(screen.queryByText("_replit-clone-verify.www.example.com")).toBeNull();
  });

  it("can still be given up", async () => {
    show(VERIFIED);

    fireEvent.click(screen.getByLabelText("Remove domain"));

    await waitFor(() => {
      expect(releaseDomain).toHaveBeenCalledWith("p1");
    });
  });
});
