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
 *
 *  **E2E_REQUIRE turns every skip into a failure**, and CI sets it. A suite
 *  whose default is to skip quietly is the right default for a laptop and a
 *  catastrophic one for a pipeline: a job that skips all four specs and
 *  reports green is worse than no job at all, because it says the real stack
 *  was exercised when nothing was. The flag makes "the stack was not up" the
 *  failure it is when CI was supposed to have started it.
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

  const required = process.env["E2E_REQUIRE"] === "1";

  if (!webUp || !health.database) {
    if (required) {
      // Thrown rather than recorded: a global setup that throws fails the
      // run before a single spec is collected, which is the only outcome
      // that cannot be mistaken for a pass.
      throw new Error(
        `E2E_REQUIRE is set and the stack is not up (${web}, ${api}). ` +
          "Refusing to skip: a run that skips everything and reports " +
          "success is worse than no run at all.",
      );
    }

    process.env["E2E_SKIP"] = "1";
    process.env["E2E_SKIP_CONTAINERS"] = "1";
    console.log(
      `\nE2E: the dev stack is not up (${web}, ${api}) — start it with \`pnpm dev\` (plus \`pnpm db:up\`) to run these tests. Skipping.\n`,
    );
    return;
  }

  if (!health.docker) {
    if (required) {
      // The subtler failure of the two: the specs that need no container
      // still run and still pass, so the job goes green having quietly
      // dropped exactly the flows that justify having an E2E suite.
      throw new Error(
        "E2E_REQUIRE is set and the API reports no Docker daemon. The " +
          "container flows are the ones worth running end to end, and " +
          "skipping them while the rest pass reports a green run for " +
          "half a suite.",
      );
    }

    // A flow that starts a container would otherwise fail halfway through and
    // look like a bug in the feature rather than a missing daemon.
    process.env["E2E_SKIP_CONTAINERS"] = "1";
    console.log(
      "\nE2E: no Docker daemon — running the flows that do not start a project container, skipping the rest.\n",
    );
  }
}
