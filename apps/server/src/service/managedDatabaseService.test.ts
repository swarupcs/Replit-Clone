import { beforeEach, describe, expect, it, vi } from "vitest";

const { listContainers, createContainer, getContainer, getVolume, removeVolume } =
  vi.hoisted(() => ({
    listContainers: vi.fn(),
    createContainer: vi.fn(),
    getContainer: vi.fn(),
    getVolume: vi.fn(),
    removeVolume: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("dockerode", () => ({
  default: class {
    listContainers = listContainers;
    createContainer = createContainer;
    getContainer = getContainer;
    getVolume = getVolume;
    listNetworks = vi.fn().mockResolvedValue([{ Name: "replit-clone-sandbox" }]);
    createNetwork = vi.fn();
  },
}));

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    managedDatabase: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
    },
  },
}));
vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));

vi.mock("../lib/secretBox.js", () => ({
  seal: (value: string) => `v1.${Buffer.from(value).toString("base64url")}`,
  open: (value: string) => {
    if (!value.startsWith("v1.")) throw new Error("cannot open");
    return Buffer.from(value.slice(3), "base64url").toString();
  },
}));

const { execCapture } = vi.hoisted(() => ({ execCapture: vi.fn() }));
vi.mock("../containers/execCapture.js", () => ({ execCapture }));

const service = await import("./managedDatabaseService.js");

const RECORD = {
  engine: "postgres",
  passwordCipher: `v1.${Buffer.from("s3cret").toString("base64url")}`,
  databaseName: "app",
  volumeName: "rc-dbdata-p1",
};

describe("provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listContainers.mockResolvedValue([]);
    execCapture.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    createContainer.mockResolvedValue({
      start: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({ State: { Running: true } }),
    });
    prismaMock.managedDatabase.findUnique.mockResolvedValue(null);
    prismaMock.managedDatabase.create.mockResolvedValue(RECORD);
  });

  it("generates a password rather than taking one", async () => {
    await service.provision("p1");
    const created = prismaMock.managedDatabase.create.mock.calls[0]?.[0];
    expect(created.data.passwordCipher).toBeTruthy();
  });

  it("stores the password sealed", async () => {
    await service.provision("p1");
    const created = prismaMock.managedDatabase.create.mock.calls[0]?.[0];
    expect(created.data.passwordCipher).toMatch(/^v1\./);
  });

  /** /proc makes a process's arguments readable by anything else in the
   *  container, which is why the git token is passed this way too. */
  it("passes the password in Env, never in argv", async () => {
    prismaMock.managedDatabase.findUnique.mockResolvedValue(RECORD);
    await service.start("p1");

    const options = createContainer.mock.calls[0]?.[0];
    expect(options.Env).toEqual(
      expect.arrayContaining(["POSTGRES_PASSWORD=s3cret"]),
    );
    expect(options.Cmd).toBeUndefined();
  });

  it("publishes nothing to the host", async () => {
    prismaMock.managedDatabase.findUnique.mockResolvedValue(RECORD);
    await service.start("p1");

    const options = createContainer.mock.calls[0]?.[0];
    // Only the sandbox network reaches it, exactly as project containers.
    expect(options.HostConfig.PortBindings).toBeUndefined();
    expect(options.HostConfig.NetworkMode).toBe("replit-clone-sandbox");
  });

  it("keeps the data on a named volume", async () => {
    prismaMock.managedDatabase.findUnique.mockResolvedValue(RECORD);
    await service.start("p1");

    const options = createContainer.mock.calls[0]?.[0];
    expect(options.HostConfig.Binds).toEqual([
      "rc-dbdata-p1:/var/lib/postgresql/data",
    ]);
  });

  /** Polled rather than slept through: a fixed sleep is too short on a
   *  loaded host and wasted time on an idle one. */
  it("waits for the database to answer before returning", async () => {
    prismaMock.managedDatabase.findUnique.mockResolvedValue(RECORD);
    execCapture
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    await service.start("p1");
    expect(execCapture).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["pg_isready"]),
    );
  });

  it("refuses to start when the password cannot be read", async () => {
    prismaMock.managedDatabase.findUnique.mockResolvedValue({
      ...RECORD,
      passwordCipher: "garbage",
    });
    // Starting anyway would bring up a container whose password does not
    // match what initialised the volume.
    await expect(service.start("p1")).rejects.toThrow(/could not be read/);
  });
});

describe("the connection it hands the project", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.managedDatabase.findUnique.mockResolvedValue(RECORD);
  });

  it("addresses the database by container name on the sandbox network", async () => {
    expect(await service.connectionUrl("p1")).toBe(
      "postgresql://app:s3cret@rc-db-p1:5432/app",
    );
  });

  /** Injected into the run environment, never written into a file in the
   *  user's tree — where it would be committed, exported and listed. */
  it("offers DATABASE_URL as environment, not as a file", async () => {
    expect(await service.databaseEnv("p1")).toEqual({
      DATABASE_URL: "postgresql://app:s3cret@rc-db-p1:5432/app",
    });
  });

  it("says nothing for a project with no database", async () => {
    prismaMock.managedDatabase.findUnique.mockResolvedValue(null);
    expect(await service.databaseEnv("p1")).toEqual({});
    expect(await service.connectionUrl("p1")).toBeNull();
  });
});

describe("destroying", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.managedDatabase.findUnique.mockResolvedValue(RECORD);
    listContainers.mockResolvedValue([]);
    getVolume.mockReturnValue({ remove: removeVolume });
  });

  /** `deployService.unpublish` learned this about published files: a volume
   *  outliving the row that pointed at it is unreachable and unreclaimed. */
  it("removes the volume, not just the container", async () => {
    await service.destroy("p1");
    expect(getVolume).toHaveBeenCalledWith("rc-dbdata-p1");
    expect(removeVolume).toHaveBeenCalled();
  });

  it("removes the row", async () => {
    await service.destroy("p1");
    expect(prismaMock.managedDatabase.delete).toHaveBeenCalledWith({
      where: { projectId: "p1" },
    });
  });

  it("copes with a project that never had one", async () => {
    prismaMock.managedDatabase.findUnique.mockResolvedValue(null);
    await expect(service.destroy("p1")).resolves.toBeUndefined();
  });
});
