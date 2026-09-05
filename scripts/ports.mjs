import { execFileSync } from "node:child_process";

/** Which host port reaches which project, by name.
 *
 *  On Windows and macOS the server publishes each project's dev ports on a
 *  RANDOM loopback port, because Docker Desktop gives the host no route to a
 *  container's IP (`PREVIEW_TARGET_MODE=host-loopback`). The browser never
 *  needs to know that — it goes through `/preview/:projectId/`, which resolves
 *  the mapping server-side and is the same URL in production. But curl,
 *  Postman and a REST client are not the browser, and for them the number is
 *  the only way in.
 *
 *  It is deliberately not shown in the editor: it is an implementation detail
 *  of one platform's networking, it changes whenever a container is recreated,
 *  and a UI that displayed it would be teaching a habit that breaks the moment
 *  this is deployed. A script is the right home for it — you run it when you
 *  need it and it tells you the truth at that moment.
 *
 *  Reads Docker alone. Project NAMES come from the database when DATABASE_URL
 *  is set and reachable, and the id is printed when it is not: knowing the port
 *  should not depend on Postgres being up.
 */

const PREFIX = "rc-project-";

function docker(args) {
  try {
    return execFileSync("docker", args, { encoding: "utf8" });
  } catch (error) {
    console.error(
      "Could not talk to Docker. Is it running?\n  " +
        (error instanceof Error ? error.message : String(error)),
    );
    process.exit(1);
  }
}

/** Running project containers, with what each publishes.
 *
 *  `{{.Ports}}` rather than `docker port` per container: one call, and the
 *  format is stable enough to split on. Entries with no host binding are
 *  dropped — in `container-ip` mode nothing is published at all, and printing
 *  a bare "3000/tcp" would read as an address somebody could visit.
 */
function projects() {
  const raw = docker([
    "ps",
    "--filter",
    `name=${PREFIX}`,
    "--format",
    "{{.Names}}\t{{.Ports}}",
  ]).trim();

  if (!raw) return [];

  return raw.split("\n").map((line) => {
    const [name = "", ports = ""] = line.split("\t");

    return {
      id: name.slice(PREFIX.length),
      ports: ports
        .split(", ")
        .map((entry) => /^(\S+?):(\d+)->(\d+)\/tcp$/.exec(entry.trim()))
        .filter((match) => match !== null)
        .map((match) => ({
          host: `${match[1]}:${match[2]}`,
          container: Number(match[3]),
        })),
    };
  });
}

/** Project names by id, or an empty map.
 *
 *  Queried with `pg` rather than through the server's Prisma client, which is
 *  TypeScript and would make this script need `tsx` to run. It is a
 *  read-only, three-column lookup; a query builder buys nothing here and costs
 *  a toolchain.
 *
 *  Every failure is non-fatal and silent by design: no DATABASE_URL, no
 *  Postgres, no `pg` installed. The ports are what was asked for and they are
 *  already in hand by this point — a name is a nicety and must never be the
 *  reason the answer does not arrive.
 */
async function names(ids) {
  const url = process.env["DATABASE_URL"];
  if (ids.length === 0 || !url) return new Map();

  let client;
  try {
    // From apps/server, where it is a dependency. The root has no node_modules
    // of its own for it.
    const { default: pg } = await import(
      new URL("../apps/server/node_modules/pg/lib/index.js", import.meta.url)
    );

    client = new pg.Client({ connectionString: url });
    await client.connect();

    // Parameterised, though every id here came from a container name this
    // script itself filtered. Interpolating would still be a habit worth not
    // having.
    const { rows } = await client.query(
      'SELECT "id", "name" FROM "projects" WHERE "id" = ANY($1)',
      [ids],
    );

    return new Map(rows.map((row) => [row.id, row.name]));
  } catch {
    return new Map();
  } finally {
    await client?.end().catch(() => {
      // Already closed, or never opened.
    });
  }
}

const running = projects();

if (running.length === 0) {
  console.log("No project containers are running.");
  process.exit(0);
}

const labels = await names(running.map((entry) => entry.id));

for (const project of running) {
  console.log(`\n${labels.get(project.id) ?? project.id}`);
  if (labels.has(project.id)) console.log(`  ${project.id}`);

  if (project.ports.length === 0) {
    // container-ip mode, or a container created before ports were published.
    console.log("  nothing published — reach it through the preview instead");
    continue;
  }

  for (const port of project.ports) {
    console.log(`  ${String(port.container).padStart(5)}  ->  http://${port.host}`);
  }
}

console.log(
  "\nThese change whenever a container is recreated. In the browser use the\n" +
    "preview instead, which needs no port and is the same URL in production.",
);
