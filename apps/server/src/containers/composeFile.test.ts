import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ComposeError, interpretCompose } from "./composeFile.js";

/** plan.md §11.3.
 *
 *  **The refusals are the point of this file, not the parsing.** This reads a
 *  `docker-compose.yml` out of a repository that may have been cloned from a
 *  stranger, and shelling out to `docker compose` would hand that repository
 *  `privileged: true`, `network_mode: host` and `volumes: ["/:/host"]` — an
 *  arbitrary-container-run primitive on the host. Every test below that
 *  asserts something is refused is testing that boundary; the ones that assert
 *  something parses are testing that the boundary did not eat the feature.
 */

/** Parsed exactly as `readCompose` parses -- `merge: true` included, which is
 *  what makes `<<: *anchor` work. */
function read(yaml: string) {
  return interpretCompose(parse(yaml, { merge: true }), "docker-compose.yml");
}

/** The file the row was written about: an app, a Postgres and a Redis. */
const TYPICAL = `
services:
  app:
    build: .
    ports:
      - "3000:3000"
    depends_on:
      - db
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: app
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
  cache:
    image: redis:7-alpine
volumes:
  pgdata:
`;

describe("the file the row was written about", () => {
  const project = read(TYPICAL);

  it("reads the services that are not the app", () => {
    expect(project.services.map((service) => service.name)).toEqual([
      "db",
      "cache",
    ]);
  });

  /** The project's own container already IS this service. Named rather than
   *  dropped, so it does not read as one that went missing. */
  it("names the buildable service instead of running it", () => {
    expect(project.appService).toBe("app");
  });

  it("keeps the environment the file set", () => {
    expect(project.services[0]?.env).toEqual({
      POSTGRES_PASSWORD: "secret",
      POSTGRES_DB: "app",
    });
  });

  /** Nothing is published to the host, so the host side of "5432:5432" is
   *  dropped. The container side is kept because it is the useful half: the
   *  app connects to `db:5432`. */
  it("keeps the container port and drops the host binding", () => {
    expect(project.services[0]?.ports).toEqual([5432]);
  });

  it("mounts a declared named volume", () => {
    expect(project.services[0]?.volumes).toEqual([
      { volume: "pgdata", target: "/var/lib/postgresql/data" },
    ]);
  });

  it("has nothing to complain about", () => {
    expect(project.unsupported).toEqual([]);
  });
});

describe("the keys that would hand over the host", () => {
  it.each([
    ["privileged: true", "privileged"],
    ["network_mode: host", "network_mode"],
    ["pid: host", "pid"],
    ["ipc: host", "ipc"],
    ["cap_add: [SYS_ADMIN]", "cap_add"],
    ["security_opt: [seccomp=unconfined]", "security_opt"],
    ["devices: ['/dev/kvm:/dev/kvm']", "devices"],
    ["userns_mode: host", "userns_mode"],
  ])("refuses %s", (line, key) => {
    const project = read(`
services:
  db:
    image: postgres:17-alpine
    ${line}
`);

    expect(project.unsupported.map((entry) => entry.key)).toContain(
      `services.db.${key}`,
    );
  });

  /** The one that matters most, because it is the most ordinary-looking. A
   *  host path chosen by a cloned repository is the whole filesystem one `..`
   *  away — and refusing it is not enough on its own, so the message says what
   *  to write instead. */
  it("refuses a host path as a volume, and says what to use", () => {
    const project = read(`
services:
  db:
    image: postgres:17-alpine
    volumes:
      - ./data:/var/lib/postgresql/data
`);

    expect(project.services[0]?.volumes).toEqual([]);
    expect(project.unsupported[0]?.reason).toMatch(/is a host path/);
    expect(project.unsupported[0]?.reason).toMatch(/named volumes/);
  });

  it("refuses an absolute host path too", () => {
    const project = read(`
services:
  db:
    image: postgres:17-alpine
    volumes:
      - /:/host
`);

    expect(project.services[0]?.volumes).toEqual([]);
    expect(project.unsupported[0]?.reason).toMatch(/host path/);
  });

  /** A named volume that was never declared is not a host path — but mounting
   *  it would create one out of thin air, which is not what the file asked
   *  for either. */
  it("will not mount a volume the file never declared", () => {
    const project = read(`
services:
  db:
    image: postgres:17-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
`);

    expect(project.services[0]?.volumes).toEqual([]);
    expect(project.unsupported[0]?.reason).toMatch(/not declared/);
  });

  /** `container_name` is not a security key, it is a collision: two projects
   *  declaring the same one would fight over a name on the host. */
  it("refuses container_name", () => {
    const project = read(`
services:
  db:
    image: postgres:17-alpine
    container_name: my-postgres
`);

    expect(project.unsupported[0]?.key).toBe("services.db.container_name");
  });
});

describe("environment, in both the shapes compose allows", () => {
  it("reads the list form", () => {
    const project = read(`
services:
  db:
    image: postgres:17-alpine
    environment:
      - POSTGRES_PASSWORD=secret
      - POSTGRES_DB=app
`);

    expect(project.services[0]?.env).toEqual({
      POSTGRES_PASSWORD: "secret",
      POSTGRES_DB: "app",
    });
  });

  /** **A bare name asks for the HOST's value**, and the host here is this
   *  platform's own server process. Passing that through is how a JWT secret
   *  ends up in somebody's Postgres, so it is dropped. */
  it("drops a bare name rather than reading this server's environment", () => {
    const project = read(`
services:
  db:
    image: postgres:17-alpine
    environment:
      - JWT_ACCESS_SECRET
      - POSTGRES_PASSWORD=secret
`);

    expect(project.services[0]?.env).toEqual({ POSTGRES_PASSWORD: "secret" });
  });

  it("keeps a value that itself contains an equals sign", () => {
    const project = read(`
services:
  db:
    image: postgres:17-alpine
    environment:
      - DSN=host=db user=app
`);

    expect(project.services[0]?.env["DSN"]).toBe("host=db user=app");
  });

  /** YAML types a bare number as a number, and Docker wants strings. */
  it("stringifies a numeric value", () => {
    const project = read(`
services:
  db:
    image: postgres:17-alpine
    environment:
      PGPORT: 5432
`);

    expect(project.services[0]?.env["PGPORT"]).toBe("5432");
  });
});

describe("command", () => {
  it("reads the list form", () => {
    const project = read(`
services:
  db:
    image: postgres:17-alpine
    command: ["postgres", "-c", "max_connections=200"]
`);

    expect(project.services[0]?.command).toEqual([
      "postgres",
      "-c",
      "max_connections=200",
    ]);
  });

  it("splits a plain string", () => {
    const project = read(`
services:
  cache:
    image: redis:7-alpine
    command: redis-server --appendonly yes
`);

    expect(project.services[0]?.command).toEqual([
      "redis-server",
      "--appendonly",
      "yes",
    ]);
  });

  /** The command is handed to the daemon, not to `sh`. Running half of what
   *  the file asked for would be worse than refusing it, and quietly ignoring
   *  the `&&` is exactly that. */
  it("refuses shell syntax rather than half-running it", () => {
    expect(() =>
      read(`
services:
  cache:
    image: redis:7-alpine
    command: sh -c "redis-server && echo up"
`),
    ).toThrow(ComposeError);
  });
});

describe("files that cannot be honoured at all", () => {
  it("refuses a service with no image", () => {
    expect(() =>
      read(`
services:
  worker:
    command: ["python", "worker.py"]
`),
    ).toThrow(/has no "image"/);
  });

  it("refuses a file with no services", () => {
    expect(() => read("volumes:\n  pgdata:\n")).toThrow(/declares no services/);
  });

  it("refuses an image name that is not one", () => {
    expect(() =>
      read(`
services:
  db:
    image: "postgres:17 --privileged"
`),
    ).toThrow(/not valid/);
  });
});

describe("what it deliberately says nothing about", () => {
  /** Present in nearly every real file, understood, and not the user's
   *  problem. A panel listing `restart` and `depends_on` as "not applied" on
   *  every project would be noise, and noise is how the entries that matter
   *  stop being read. */
  it("ignores the keys every real file carries", () => {
    const project = read(`
services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "pg_isready"]
    depends_on:
      - cache
    labels:
      com.example.thing: yes
    logging:
      driver: json-file
  cache:
    image: redis:7-alpine
`);

    expect(project.unsupported).toEqual([]);
  });

  it("ignores extension fields and the deprecated version key", () => {
    const project = read(`
version: "3.9"
x-shared: &shared
  restart: always
services:
  db:
    image: postgres:17-alpine
    x-note: hello
`);

    expect(project.unsupported).toEqual([]);
  });

  /** YAML anchors are common in real files and are the parser's job, not
   *  this file's. Worth pinning: a hand-rolled parser would have silently
   *  produced a service with no image here. */
  it("resolves a YAML anchor into the service that uses it", () => {
    const project = read(`
x-db: &db
  image: postgres:17-alpine
services:
  db:
    <<: *db
    environment:
      POSTGRES_PASSWORD: secret
`);

    expect(project.services[0]?.image).toBe("postgres:17-alpine");
  });
});

describe("more than one buildable service", () => {
  /** The first is this project; the second cannot also be, and saying so is
   *  better than picking one silently. */
  it("takes the first and reports the rest", () => {
    const project = read(`
services:
  app:
    build: .
  worker:
    build: .
  db:
    image: postgres:17-alpine
`);

    expect(project.appService).toBe("app");
    expect(project.unsupported[0]?.key).toBe("services.worker.build");
    expect(project.services.map((service) => service.name)).toEqual(["db"]);
  });
});
