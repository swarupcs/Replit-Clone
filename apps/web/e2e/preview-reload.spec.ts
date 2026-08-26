import { expect, test } from "@playwright/test";

/** Saving while the dev server is ALREADY running reloads the preview.
 *
 *  `playground-flow` proves the chain end to end, but it saves once before the
 *  run starts — the preview is right there because it was never wrong. This is
 *  the other half: a second save, with the dev server up and the preview open,
 *  and nobody touching the reload button. That is the `previewChanged`
 *  announcement doing its job, and it is the mechanism the "changes not
 *  reflected" reports were actually about.
 *
 *  Runs a real container, so it needs a Docker daemon.
 */
test.skip(
  () =>
    process.env["E2E_SKIP"] === "1" ||
    process.env["E2E_SKIP_CONTAINERS"] === "1",
  "dev stack is not running, or has no Docker daemon",
);

/** One marker per save, so a preview showing the FIRST version can never be
 *  mistaken for one that reloaded. */
const FIRST = `first-${Date.now()}`;
const SECOND = `second-${Date.now()}`;

let accessToken = "";
let projectId = "";

const API =
  process.env["E2E_API_URL"]?.replace(/\/$/, "") ?? "http://localhost:3100";

/** The document the editor writes, carrying whichever marker. */
function page_(marker: string): string {
  return `<!doctype html>
<html>
  <body>
    <h1>${marker}</h1>
  </body>
</html>
`;
}

test.describe.serial("preview reload on save", () => {
  test.afterEach(async ({ page }) => {
    if (!accessToken || !projectId) return;

    // Best effort: cleanup must never mask the real result. Without it every
    // run leaves a container behind and fills the concurrency cap.
    await page.request
      .delete(`${API}/api/v1/projects/${projectId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      .catch(() => undefined);
  });

  test("a save with the dev server up reloads the preview by itself", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    page.on("response", (response) => {
      if (response.url().endsWith("/auth/signup") && response.ok()) {
        void response
          .json()
          .then((body) => {
            accessToken =
              (body as { data?: { accessToken?: string } }).data?.accessToken ??
              "";
          })
          .catch(() => undefined);
      }
    });

    await page.goto("/signup");
    await page
      .getByPlaceholder("you@example.com")
      .fill(`e2e-reload-${Date.now()}@example.test`);
    await page
      .getByPlaceholder("At least 8 characters")
      .fill("e2e-password-123");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/$/);

    await page.getByRole("button", { name: "New playground" }).first().click();
    await page.locator(".ant-segmented-item", { hasText: "Static HTML" }).click();
    await page.getByRole("button", { name: "Create", exact: true }).click();

    await expect(page).toHaveURL(/\/project\/[0-9a-f-]+$/, { timeout: 60_000 });
    projectId = page.url().split("/").pop() ?? "";

    const fileRow = page.getByText("index.html", { exact: true }).first();
    await expect(fileRow).toBeVisible({ timeout: 60_000 });
    await fileRow.click();

    const editor = page.locator(".view-lines:visible").first();
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await expect(editor).toContainText("Hello from your static playground", {
      timeout: 30_000,
    });

    // --- First save, before the dev server is necessarily up.
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(page_(FIRST));
    await page.keyboard.press("Control+S");

    // --- Wait for the run, then show the preview and let it settle on FIRST.
    await expect(page.getByText("Running", { exact: true })).toBeVisible({
      timeout: 90_000,
    });

    const previewToggle = page.getByRole("button", { name: "Toggle preview" });
    if (!(await previewToggle.getAttribute("data-on"))) {
      await previewToggle.click();
    }

    /** The preview's heading, or undefined while it is mid-reload.
     *
     *  A reload detaches the frame, and querying a detached one throws rather
     *  than returning a stale value — which would fail the poll on exactly the
     *  event the poll is waiting for. Swallowed so it simply tries again. */
    const previewHeading = async (): Promise<string | null | undefined> => {
      const frame = page
        .frames()
        .find((entry) => entry.url().includes(`/preview/${projectId}`));

      if (!frame) return undefined;

      return frame
        .locator("h1")
        .textContent()
        .catch(() => undefined);
    };

    await expect.poll(previewHeading, { timeout: 60_000 }).toContain(FIRST);

    // --- The part this spec exists for: save again, with the dev server up
    //  and the preview already on screen, and touch nothing else.
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(page_(SECOND));
    await page.keyboard.press("Control+S");

    // No reload, no navigation, no clicking the preview's refresh: if the
    // second marker arrives, the server told the iframe to reload itself.
    await expect.poll(previewHeading, { timeout: 60_000 }).toContain(SECOND);
  });
});
