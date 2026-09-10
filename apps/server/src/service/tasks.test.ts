import { describe, expect, it } from "vitest";
import { matchProblems, normalisePath } from "./problemMatchers.js";
import { parseTasks, resolveOrder } from "./taskService.js";

/** Real output from each tool, pasted rather than invented: a matcher is a
 *  regex over somebody else's format, and a regex written against imagined
 *  output is a regex that matches imagined output. */

describe("reading tasks.json", () => {
  it("reads a task with args", () => {
    const { tasks } = parseTasks({
      tasks: [{ label: "build", command: "npm", args: ["run", "build"] }],
    });
    expect(tasks[0]).toMatchObject({ label: "build", command: "npm run build" });
  });

  it("quotes only the args that need it", () => {
    // Quoting every arg would break `npm run build -- --flag`, which is a form
    // people actually write.
    const { tasks } = parseTasks({
      tasks: [{ label: "t", command: "echo", args: ["--flag", "two words"] }],
    });
    expect(tasks[0]?.command).toBe('echo --flag "two words"');
  });

  it("reads both spellings of group", () => {
    const { tasks } = parseTasks({
      tasks: [
        { label: "a", command: "x", group: "build" },
        { label: "b", command: "x", group: { kind: "test", isDefault: true } },
      ],
    });
    expect(tasks[0]?.group).toBe("build");
    expect(tasks[1]?.group).toBe("test");
  });

  it("reads problemMatcher as a string or a list", () => {
    const { tasks } = parseTasks({
      tasks: [
        { label: "a", command: "x", problemMatcher: "$tsc" },
        { label: "b", command: "x", problemMatcher: ["$eslint", "$tsc"] },
      ],
    });
    expect(tasks[0]?.matchers).toEqual(["$tsc"]);
    expect(tasks[1]?.matchers).toEqual(["$eslint", "$tsc"]);
  });

  it("ignores an inline object matcher rather than half-understanding it", () => {
    const { tasks } = parseTasks({
      tasks: [{ label: "a", command: "x", problemMatcher: { pattern: {} } }],
    });
    expect(tasks[0]?.matchers).toEqual([]);
  });

  it("defaults dependsOrder to parallel, as VS Code does", () => {
    const { tasks } = parseTasks({ tasks: [{ label: "a", command: "x" }] });
    expect(tasks[0]?.dependsOrder).toBe("parallel");
  });

  it("names a task with no command instead of running an empty line", () => {
    const { tasks, problems } = parseTasks({ tasks: [{ label: "broken" }] });
    expect(tasks).toEqual([]);
    expect(problems[0]).toMatch(/no command/);
  });

  it("names a duplicate label, which makes dependsOn ambiguous", () => {
    // Ambiguity here means running the wrong thing rather than failing.
    const { problems } = parseTasks({
      tasks: [
        { label: "build", command: "a" },
        { label: "build", command: "b" },
      ],
    });
    expect(problems[0]).toMatch(/more than one task/);
  });

  it("refuses a file with no tasks array", () => {
    expect(parseTasks({ version: "2.0.0" }).problems[0]).toMatch(/"tasks" array/);
  });

  it("marks a background task rather than dropping it", () => {
    const { tasks } = parseTasks({
      tasks: [{ label: "watch", command: "tsc -w", isBackground: true }],
    });
    expect(tasks[0]?.background).toBe(true);
  });
});

describe("what runs first", () => {
  const tasks = parseTasks({
    tasks: [
      { label: "install", command: "npm ci" },
      { label: "build", command: "npm run build", dependsOn: ["install"] },
      { label: "test", command: "npm test", dependsOn: ["build"] },
    ],
  }).tasks;

  it("runs dependencies before the task", () => {
    expect(resolveOrder(tasks, "test")).toEqual(["install", "build", "test"]);
  });

  it("runs a task with no dependencies alone", () => {
    expect(resolveOrder(tasks, "install")).toEqual(["install"]);
  });

  it("refuses a cycle rather than picking an order", () => {
    // Picking one arbitrarily produces a build that works here and not in VS
    // Code, which is worse than not running.
    const cyclic = parseTasks({
      tasks: [
        { label: "a", command: "x", dependsOn: ["b"] },
        { label: "b", command: "x", dependsOn: ["a"] },
      ],
    }).tasks;

    expect(() => resolveOrder(cyclic, "a")).toThrow(/depend on each other/);
  });

  it("names a dependency that does not exist", () => {
    const orphan = parseTasks({
      tasks: [{ label: "a", command: "x", dependsOn: ["missing"] }],
    }).tasks;

    expect(() => resolveOrder(orphan, "a")).toThrow(/no task called "missing"/);
  });
});

describe("turning output into problems", () => {
  it("reads tsc", () => {
    const output = "src/a.ts(12,5): error TS2304: Cannot find name 'x'.";
    expect(matchProblems(output, ["$tsc"], "build")).toEqual([
      {
        relPath: "src/a.ts",
        line: 12,
        column: 5,
        severity: "error",
        message: "TS2304: Cannot find name 'x'.",
        source: "build",
      },
    ]);
  });

  it("reads eslint's stylish reporter, which is the default", () => {
    const output = [
      "/home/sandbox/app/src/a.js",
      "  1:7  error  'x' is assigned but never used  no-unused-vars",
      "  3:1  warning  Unexpected console  no-console",
      "",
      "✖ 2 problems",
    ].join("\n");

    const problems = matchProblems(output, ["$eslint-stylish"], "lint");
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatchObject({
      relPath: "src/a.js",
      line: 1,
      column: 7,
      severity: "error",
    });
    expect(problems[0]?.message).toContain("no-unused-vars");
    expect(problems[1]?.severity).toBe("warning");
  });

  it("does not invent a problem from an indented line with no file above it", () => {
    expect(matchProblems("  1:7  error  stray", ["$eslint-stylish"], "lint")).toEqual([]);
  });

  it("reads go build", () => {
    const problems = matchProblems("./main.go:7:2: undefined: foo", ["$go"], "build");
    expect(problems[0]).toMatchObject({
      relPath: "main.go",
      line: 7,
      column: 2,
      severity: "error",
    });
  });

  it("reads gcc, including its notes as info", () => {
    const output = [
      "main.c:5:9: error: 'x' undeclared",
      "main.c:6:1: warning: unused variable",
      "main.c:7:1: note: declared here",
    ].join("\n");

    const problems = matchProblems(output, ["$gcc"], "build");
    expect(problems.map((problem) => problem.severity)).toEqual([
      "error",
      "warning",
      "info",
    ]);
  });

  it("strips the container's mount point from a path", () => {
    // The panel matches on this string to open a file, and an absolute
    // container path matches nothing in the tree.
    expect(normalisePath("/home/sandbox/app/src/a.ts")).toBe("src/a.ts");
  });

  it("drops a leading ./, because the panel compares strings", () => {
    expect(normalisePath("./src/a.ts")).toBe("src/a.ts");
  });

  it("prefixes a task's cwd, so a sub-project's paths resolve", () => {
    expect(normalisePath("a.ts", "packages/web")).toBe("packages/web/a.ts");
  });

  it("does not double-report when two matchers overlap", () => {
    // `$eslint` and `$eslint-stylish` on one task is a real thing people write,
    // and a panel that double-counts is one people stop trusting.
    const output = "/app/a.js: line 1, col 1, Error - Unexpected (no-undef)";
    const once = matchProblems(output, ["$eslint", "$eslint-compact"], "lint");
    expect(once).toHaveLength(1);
  });

  it("finds nothing for a matcher it has never heard of", () => {
    // Refusing the TASK over an unknown matcher would be refusing to run a
    // build because its output could not be parsed.
    expect(matchProblems("anything", ["$rustc"], "build")).toEqual([]);
  });

  it("finds nothing when no matcher is named", () => {
    expect(matchProblems("src/a.ts(1,1): error TS1: x", [], "build")).toEqual([]);
  });

  it("ignores lines that are not problems", () => {
    const output = ["> tsc --noEmit", "", "Compilation complete."].join("\n");
    expect(matchProblems(output, ["$tsc"], "build")).toEqual([]);
  });
});
