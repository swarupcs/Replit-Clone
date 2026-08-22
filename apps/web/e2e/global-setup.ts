/** Decides once, before any test runs, whether the real stack is there.
 *
 *  Sets E2E_SKIP on failure; the runner's process env is inherited by every
 *  worker, so each spec file's `test.skip` sees the same verdict.
 */
export default async function globalSetup(): Promise<void> {
  const web = process.env["E2E_BASE_URL"] ?? "http://localhost:15273";
  const api = process.env["E2E_API_URL"] ?? "http://localhost:3100";

  const reachable = await Promise.all([
    fetch(web).then(
      (response) => response.ok,
      () => false,
    ),
    fetch(`${api}/health`)
      .then(async (response) => {
        const body = (await response.json()) as {
          checks?: { database?: { ok?: boolean }; docker?: { ok?: boolean } };
        };
        // A stack without Docker or Postgres would fail every flow halfway
        // through; better to say why up front than to time out inside one.
        return Boolean(body.checks?.database?.ok && body.checks?.docker?.ok);
      })
      .catch(() => false),
  ]);

  if (reachable.every(Boolean)) return;

  process.env["E2E_SKIP"] = "1";
  console.log(
    `\nE2E: the dev stack is not fully up (${web}, ${api}) — start it with \`pnpm dev\` (plus \`pnpm db:up\`) to run these tests. Skipping.\n`,
  );
}
