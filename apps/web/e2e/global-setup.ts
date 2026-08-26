/** Decides once, before any test runs, what the stack here can actually do.
 *
 *  Two verdicts rather than one, because the flows differ in what they need.
 *  Everything needs the web app and the database; only the flows that run a
 *  project need Docker. Gating all of them on Docker meant a machine without a
 *  daemon — or a CI job that has one but should not spend minutes starting
 *  containers — skipped specs that would have passed.
 *
 *  The runner's process env is inherited by every worker, so each spec file's
 *  `test.skip` sees the same verdict.
 */
export default async function globalSetup(): Promise<void> {
  const web = process.env["E2E_BASE_URL"] ?? "http://localhost:15273";
  const api = process.env["E2E_API_URL"] ?? "http://localhost:3100";

  const webUp = await fetch(web).then(
    (response) => response.ok,
    () => false,
  );

  const health = await fetch(`${api}/health`)
    .then(async (response) => {
      const body = (await response.json()) as {
        checks?: { database?: { ok?: boolean }; docker?: { ok?: boolean } };
      };
      return {
        database: Boolean(body.checks?.database?.ok),
        docker: Boolean(body.checks?.docker?.ok),
      };
    })
    .catch(() => ({ database: false, docker: false }));

  if (!webUp || !health.database) {
    process.env["E2E_SKIP"] = "1";
    process.env["E2E_SKIP_CONTAINERS"] = "1";
    console.log(
      `\nE2E: the dev stack is not up (${web}, ${api}) — start it with \`pnpm dev\` (plus \`pnpm db:up\`) to run these tests. Skipping.\n`,
    );
    return;
  }

  if (!health.docker) {
    // A flow that starts a container would otherwise fail halfway through and
    // look like a bug in the feature rather than a missing daemon.
    process.env["E2E_SKIP_CONTAINERS"] = "1";
    console.log(
      "\nE2E: no Docker daemon — running the flows that do not start a project container, skipping the rest.\n",
    );
  }
}
