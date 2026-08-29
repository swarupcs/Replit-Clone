import { expect, test } from "@playwright/test";

/** The one flow everything else is scaffolding for: sign up, make a project,
 *  change a file, run it, and see the change in the preview.
 *
 *  Static HTML is the template of choice — `serve` starts in seconds where
 *  `npm install && npm run dev` takes minutes, and the preview is the edited
 *  file itself, so the last assertion proves the whole chain: editor → save →
 *  container filesystem → dev server → preview proxy → browser.
 */

// This flow runs a real project in a real container, so it needs a daemon.
test.skip(
  () =>
    process.env["E2E_SKIP"] === "1" ||
    process.env["E2E_SKIP_CONTAINERS"] === "1",
  "dev stack is not running, or has no Docker daemon",
);

/** A unique marker per run, so a stale preview can never pass the test. */
const MARKER = `e2e-${Date.now()}-was-here`;

/** Set as the flow progresses, so cleanup can undo whatever got created.
 *
 *  Every run makes a real project with a real container, and the deployment
 *  caps how many may exist at once — without this, a handful of failed runs
 *  would fill the cap and every later run would fail at "starting". */
let accessToken = "";
let projectId = "";

const API =
  process.env["E2E_API_URL"]?.replace(/\/$/, "") ?? "http://localhost:3100";

test.describe.serial("playground flow", () => {
  test.afterEach(async ({ page }) => {
    if (!accessToken || !projectId) return;

    // Best effort: cleanup must never mask the real result.
    await page.request
      .delete(`${API}/api/v1/projects/${projectId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      .catch(() => undefined);
  });

  test("signup, create, edit, run, and see it in the preview", async ({ page }) => {
    test.setTimeout(180_000);

    // The signup response is the one place the session's access token can be
    // taken from, for the cleanup above.
    page.on("response", (response) => {
      if (response.url().endsWith("/auth/signup") && response.ok()) {
        void response
          .json()
          .then((body) => {
            accessToken = (body as { data?: { accessToken?: string } }).data
              ?.accessToken ?? "";
          })
          .catch(() => undefined);
      }
    });

    // --- Sign up. The account is per run; its projects are its own.
    await page.goto("/signup");
    await page.getByPlaceholder("you@example.com").fill(
      `e2e-${Date.now()}@example.test`,
    );
    await page.getByPlaceholder("At least 8 characters").fill("e2e-password-123");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/$/);

    // --- Create a static playground.
    await page.getByRole("button", { name: "New playground" }).first().click();
    await page
      .locator(".ant-segmented-item", { hasText: "Static HTML" })
      .click();
    await page.getByRole("button", { name: "Create", exact: true }).click();

    await expect(page).toHaveURL(/\/project\/[0-9a-f-]+$/, { timeout: 60_000 });
    projectId = page.url().split("/").pop() ?? "";

    // --- Open index.html in the editor.
    const fileRow = page.getByText("index.html", { exact: true }).first();
    await expect(fileRow).toBeVisible({ timeout: 60_000 });
    await fileRow.click();

    // Monaco keeps a hidden rendering for its own bookkeeping; the visible
    // one is the editor the user types into.
    const editor = page.locator(".view-lines:visible").first();
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await expect(editor).toContainText(
      "Hello from your static playground",
      { timeout: 30_000 },
    );

    // --- The editor is painted in the app's own theme, not Monaco's default.
    //
    //  This is the one assertion in the suite that exists because a UNIT test
    //  could not make it. The editor once came up white inside a dark IDE:
    //  @monaco-editor/react calls `setTheme("dracula")` immediately after
    //  `editor.create(...)`, the theme was being defined in `onMount` which
    //  fires afterwards, so Monaco fell back to its built-in `vs` and nothing
    //  reapplied it. Reproducing that needs workers, layout and a real canvas,
    //  which is why the guard used to be a test that read its own source with
    //  `readFileSync` — a good way to hold a fix in place and no way at all to
    //  know the editor is dark.
    //
    //  Asserted as brightness rather than as an exact hex, because what broke
    //  was "white where it should be dark", not "not #282a36". A theme change
    //  is allowed; falling back to `vs` is not.
    const paint = await page
      .locator(".monaco-editor:visible .monaco-editor-background")
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundColor);

    const channels = (/rgba?\(([^)]+)\)/.exec(paint)?.[1] ?? "")
      .split(",")
      .slice(0, 3)
      .map((part) => Number(part.trim()));

    expect(channels).toHaveLength(3);
    expect(
      channels.reduce((total, value) => total + value, 0) / 3,
      `editor background was ${paint}; Monaco fell back to its built-in theme`,
    ).toBeLessThan(128);

    // --- Replace the heading with one carrying this run's marker.
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(
      `<!doctype html>
<html>
  <body>
    <h1>${MARKER}</h1>
  </body>
</html>
`,
    );

    // --- Save. For a shared document the server owns the write, so this is
    //  the docSave path, not the plain writeFile one.
    await page.keyboard.press("Control+S");

    // --- The dev server. Opening a playground auto-starts it (runSubscribe),
    //  so there is no Run to press — the badge reaching "Running" IS the flow,
    //  container and all.
    await expect(page.getByText("Running", { exact: true })).toBeVisible({
      timeout: 90_000,
    });

    // --- Open the preview and expect the marker through the whole chain.
    const previewToggle = page.getByRole("button", { name: "Toggle preview" });
    if (!(await previewToggle.getAttribute("data-on"))) {
      await previewToggle.click();
    }

    const previewFrame = () =>
      page.frames().find((frame) => frame.url().includes(`/preview/${projectId}`));

    await expect
      .poll(
        async () => previewFrame()?.locator("h1").textContent(),
        { timeout: 60_000 },
      )
      .toContain(MARKER);
  });
});
