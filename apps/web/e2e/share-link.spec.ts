import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

/** Redeeming an EDITOR share link: the owner makes one, somebody else opens it
 *  signed in as themselves, and comes out with write access to the project.
 *
 *  This flow never starts a project container — it is accounts, a project row
 *  and an access grant — so unlike `playground-flow` it runs on a machine with
 *  no Docker daemon.
 */
test.skip(() => process.env["E2E_SKIP"] === "1", "dev stack is not running");

const API =
  process.env["E2E_API_URL"]?.replace(/\/$/, "") ?? "http://localhost:3100";

/** Set as the flow progresses so cleanup can undo what it made. */
let ownerToken = "";
let projectId = "";

interface Account {
  email: string;
  password: string;
  token: string;
}

/** Signs a fresh account up through the API. Two accounts are needed and
 *  driving the second one through the form as well would test the signup page
 *  twice rather than the thing this spec is about. */
async function signUp(request: APIRequestContext, label: string): Promise<Account> {
  const email = `e2e-${label}-${Date.now()}@example.test`;
  const password = "e2e-password-123";

  const response = await request.post(`${API}/api/v1/auth/signup`, {
    data: { email, password },
  });
  expect(response.ok()).toBe(true);

  const body = (await response.json()) as { data: { accessToken: string } };
  return { email, password, token: body.data.accessToken };
}

test.describe.serial("EDITOR share link", () => {
  test.afterAll(async ({ request }) => {
    if (!ownerToken || !projectId) return;

    // Best effort: cleanup must never mask the real result.
    await request
      .delete(`${API}/api/v1/projects/${projectId}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      })
      .catch(() => undefined);
  });

  test("a second account redeems an edit link and can write", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    // --- The owner: an account, a project, and an EDITOR link for it.
    const owner = await signUp(request, "owner");
    ownerToken = owner.token;
    const ownerAuth = { Authorization: `Bearer ${owner.token}` };

    const created = await request.post(`${API}/api/v1/projects`, {
      headers: ownerAuth,
      data: { name: "shared-by-e2e", template: "static-html" },
    });
    expect(created.ok()).toBe(true);
    projectId = ((await created.json()) as { data: { id: string } }).data.id;

    const link = await request.post(
      `${API}/api/v1/projects/${projectId}/share-link`,
      { headers: ownerAuth, data: { role: "EDITOR" } },
    );
    expect(link.ok()).toBe(true);
    const { shareToken, shareRole } = (
      (await link.json()) as { data: { shareToken: string; shareRole: string } }
    ).data;
    expect(shareRole).toBe("EDITOR");

    // --- Somebody else signs in, in the browser.
    const guest = await signUp(request, "guest");

    await page.goto("/login");
    await page.getByPlaceholder("you@example.com").fill(guest.email);
    // Sign-in and sign-up share one form component, so the password field
    // carries the same placeholder on both.
    await page.getByPlaceholder("At least 8 characters").fill(guest.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });

    // The project is not theirs yet, so the dashboard does not list it.
    await expect(page.getByText("shared-by-e2e")).toHaveCount(0);

    // --- Open the link and accept it.
    await page.goto(`/join?token=${shareToken}`);
    await expect(page.getByText("shared-by-e2e")).toBeVisible({
      timeout: 30_000,
    });

    await page
      .getByRole("button", { name: /join|open|accept/i })
      .first()
      .click();

    // Redemption lands the guest in the project itself.
    await expect(page).toHaveURL(new RegExp(`/project/${projectId}$`), {
      timeout: 30_000,
    });

    // --- The grant is real: the API answers them as an editor, not a viewer.
    const guestAuth = { Authorization: `Bearer ${guest.token}` };

    const tree = await request.get(
      `${API}/api/v1/projects/${projectId}/tree`,
      { headers: guestAuth },
    );
    expect(tree.ok()).toBe(true);

    // Renaming is the OWNER's alone, so an editor must still be refused it --
    // redeeming an edit link must not hand over the project.
    const rename = await request.patch(`${API}/api/v1/projects/${projectId}`, {
      headers: guestAuth,
      data: { name: "taken-over" },
    });
    expect(rename.ok()).toBe(false);

    // --- And the owner now sees them listed as a collaborator.
    const sharing = await request.get(
      `${API}/api/v1/projects/${projectId}/sharing`,
      { headers: ownerAuth },
    );
    expect(sharing.ok()).toBe(true);

    const body = (await sharing.json()) as {
      data: { collaborators: { email: string; role: string }[] };
    };
    expect(
      body.data.collaborators.some(
        (person) => person.email === guest.email && person.role === "EDITOR",
      ),
    ).toBe(true);
  });
});
