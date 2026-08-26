import { beforeEach, describe, expect, it, vi } from "vitest";

const execCapture = vi.hoisted(() => vi.fn());
vi.mock("../containers/execCapture.js", () => ({ execCapture }));
vi.mock("../containers/containerManager.js", () => ({
  ensureContainer: vi.fn(() => Promise.resolve({ id: "container" })),
}));

const { pushRemote } = await import("./gitService.js");

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const TOKEN = "a-real-looking-token";

/** The last call's argv and options. */
function lastCall() {
  const call = execCapture.mock.calls.at(-1);
  return {
    argv: (call?.[1] ?? []) as string[],
    options: (call?.[2] ?? {}) as { env?: Record<string, string> },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Every call succeeds: check-ref-format for the names, then the push.
  execCapture.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
});

describe("pushRemote", () => {
  it("passes the token in the environment, never in the arguments", async () => {
    await pushRemote(PROJECT, "origin", "main", TOKEN);

    const { argv, options } = lastCall();

    // This is the whole security property: process arguments are readable by
    // anything in the container through /proc; an environment is not.
    expect(options.env?.["RC_GIT_TOKEN"]).toBe(TOKEN);
    expect(argv.join(" ")).not.toContain(TOKEN);
  });

  it("names the remote and branch after a `--`, so neither is read as a flag", async () => {
    await pushRemote(PROJECT, "origin", "main", TOKEN);

    const { argv } = lastCall();
    const separator = argv.indexOf("--");

    expect(argv).toContain("push");
    expect(separator).toBeGreaterThan(-1);
    expect(argv.slice(separator + 1)).toEqual(["origin", "main"]);
  });

  it("turns off git's terminal prompt, which would hang the exec", async () => {
    await pushRemote(PROJECT, "origin", "main", TOKEN);

    expect(lastCall().options.env?.["GIT_TERMINAL_PROMPT"]).toBe("0");
  });

  it("refuses without a token rather than pushing unauthenticated", async () => {
    await expect(pushRemote(PROJECT, "origin", "main", "")).rejects.toThrow();

    expect(
      execCapture.mock.calls.some((call) =>
        (call[1] as string[]).includes("push"),
      ),
    ).toBe(false);
  });

  it("redacts the token out of a failure message", async () => {
    execCapture.mockImplementation((_container, argv: string[]) => {
      if (!argv.includes("push")) {
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      }
      // The shape git takes when it echoes a URL back at you.
      return Promise.resolve({
        stdout: "",
        stderr: `fatal: https://token:${TOKEN}@github.com/a/b.git rejected`,
        exitCode: 1,
      });
    });

    // Caught and inspected rather than matched, so the assertion is about the
    // message that actually reaches the caller.
    const error = await pushRemote(PROJECT, "origin", "main", TOKEN).catch(
      (thrown: unknown) => thrown,
    );

    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain(TOKEN);
    expect(message).toContain("***");
  });

  it("refuses a remote name that would be read as a flag", async () => {
    await expect(
      pushRemote(PROJECT, "--upload-pack=evil", "main", TOKEN),
    ).rejects.toThrow();
  });
});
