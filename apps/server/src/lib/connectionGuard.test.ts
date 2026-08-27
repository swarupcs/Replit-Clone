import { beforeEach, describe, expect, it, vi } from "vitest";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("../config/env.js", () => ({
  // A public address deliberately: it lets the tests tell the platform check
  // apart from the private-range check, which would otherwise mask it.
  env: { DATABASE_URL: "postgresql://replit:replit@203.0.113.9:15432/replit_clone" },
}));

const {
  ConnectionRefused,
  checkConnectionString,
  isPrivateAddress,
  redactConnectionString,
} = await import("./connectionGuard.js");

const refusal = async (url: string) => {
  try {
    await checkConnectionString(url);
  } catch (error) {
    if (error instanceof ConnectionRefused) return error.code;
    throw error;
  }
  throw new Error(`${url} was allowed`);
};

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "0.0.0.0",
    "100.64.0.1",
    "224.0.0.1",
    // The cloud metadata endpoint, which hands credentials to anything on
    // the host that can make a request.
    "169.254.169.254",
  ])("refuses %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.0.1"])(
    "allows %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it.each(["::1", "::", "fc00::1", "fd00::1", "fe80::1"])(
    "refuses the v6 address %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(true);
    },
  );

  /** The standard way to smuggle a v4 loopback past a check that only knows
   *  about v6 prefixes. */
  it("refuses an IPv4 loopback mapped into v6", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
  });

  it("allows a mapped public address", () => {
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("refuses anything that is not an address at all", () => {
    expect(isPrivateAddress("not-an-address")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});

describe("checkConnectionString", () => {
  beforeEach(() => {
    lookup.mockReset();
    lookup.mockResolvedValue({ address: "93.184.216.34", family: 4 });
  });

  it("allows a public Postgres host", async () => {
    const checked = await checkConnectionString(
      "postgresql://user:pw@db.example.com:5432/app",
    );
    expect(checked).toMatchObject({
      scheme: "postgresql",
      host: "db.example.com",
      port: 5432,
      address: "93.184.216.34",
    });
  });

  it("allows a public Mongo host", async () => {
    const checked = await checkConnectionString("mongodb://user:pw@db.example.com/app");
    expect(checked).toMatchObject({ scheme: "mongodb", port: 27017 });
  });

  it("refuses a scheme it does not speak", async () => {
    expect(await refusal("http://example.com")).toBe("UNSUPPORTED_SCHEME");
    expect(await refusal("redis://example.com")).toBe("UNSUPPORTED_SCHEME");
    // file:// is the one that would read the server's own disk.
    expect(await refusal("file:///etc/passwd")).toBe("UNSUPPORTED_SCHEME");
  });

  it("refuses nonsense", async () => {
    expect(await refusal("not a url")).toBe("MALFORMED");
  });

  it("refuses a literal loopback without consulting DNS", async () => {
    expect(await refusal("postgresql://u:p@127.0.0.1:5432/app")).toBe(
      "PRIVATE_ADDRESS",
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a host that resolves into a private range", async () => {
    lookup.mockResolvedValue({ address: "10.1.2.3", family: 4 });
    expect(await refusal("postgresql://u:p@sneaky.example.com/app")).toBe(
      "PRIVATE_ADDRESS",
    );
  });

  it("refuses the metadata endpoint however it is reached", async () => {
    lookup.mockResolvedValue({ address: "169.254.169.254", family: 4 });
    expect(await refusal("postgresql://u:p@metadata.example.com/app")).toBe(
      "PRIVATE_ADDRESS",
    );
  });

  /** §7.2's second line, and it does not depend on the range check: the
   *  platform's own database is refused by host and port, whatever network
   *  it happens to be on. */
  it("refuses the platform's own database by name", async () => {
    expect(await refusal("postgresql://replit:replit@203.0.113.9:15432/replit_clone"))
      .toBe("PLATFORM_DATABASE");
  });

  /** A hostname that resolves onto the platform's own database is the
   *  platform's own database. Checked against the resolved address, and
   *  before the range check, so the refusal says the useful thing. */
  it("refuses the platform's own database even when a host resolves onto it", async () => {
    lookup.mockResolvedValue({ address: "203.0.113.9", family: 4 });
    expect(await refusal("postgresql://u:p@indirect.example.com:15432/x")).toBe(
      "PLATFORM_DATABASE",
    );
  });

  it("allows the same host on a different port", async () => {
    // The platform check is host AND port; only the pair is the platform's.
    lookup.mockResolvedValue({ address: "93.184.216.34", family: 4 });
    await expect(
      checkConnectionString("postgresql://u:p@db.example.com:5432/app"),
    ).resolves.toBeTruthy();
  });

  it("refuses a host that does not resolve", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    expect(await refusal("postgresql://u:p@nowhere.example.com/app")).toBe(
      "UNRESOLVABLE",
    );
  });

  /** The point of returning the address: the caller connects to what was
   *  checked, so a second lookup cannot answer differently. */
  it("returns the address it approved, not just the name", async () => {
    lookup.mockResolvedValue({ address: "93.184.216.34", family: 4 });
    const checked = await checkConnectionString("postgresql://u:p@db.example.com/app");
    expect(checked.address).toBe("93.184.216.34");
  });

  it("lets an operator opt into private addresses deliberately", async () => {
    await expect(
      checkConnectionString("postgresql://u:p@10.0.0.5:5432/app", {
        allowPrivate: true,
      }),
    ).resolves.toMatchObject({ address: "10.0.0.5" });
  });

  it("still refuses the platform's own database under allowPrivate", async () => {
    // The opt-out is for an operator's own private network, never for this.
    await expect(
      checkConnectionString("postgresql://replit:replit@203.0.113.9:15432/replit_clone", {
        allowPrivate: true,
      }),
    ).rejects.toThrow(ConnectionRefused);
  });
});

describe("redactConnectionString", () => {
  it("removes the credentials", () => {
    expect(redactConnectionString("postgresql://user:hunter2@db.example.com/app")).toBe(
      "postgresql://***@db.example.com/app",
    );
  });

  it("leaves a string with no credentials alone", () => {
    expect(redactConnectionString("postgresql://db.example.com/app")).toBe(
      "postgresql://db.example.com/app",
    );
  });
});
