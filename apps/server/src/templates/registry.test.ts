import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEMPLATE_ID,
  getTemplate,
  listTemplates,
  TEMPLATE_FILES_ROOT,
  TEMPLATES,
} from "./registry.js";

describe("template registry", () => {
  it("has a default that exists", () => {
    expect(() => getTemplate(DEFAULT_TEMPLATE_ID)).not.toThrow();
  });

  it("rejects an unknown id rather than falling back silently", () => {
    expect(() => getTemplate("does-not-exist")).toThrow(/Unknown template/);
  });

  it("keys every entry by its own id", () => {
    for (const [key, template] of Object.entries(TEMPLATES)) {
      expect(template.id).toBe(key);
    }
  });

  it("gives every template a start command and a dev port", () => {
    for (const template of listTemplates()) {
      expect(template.startCommand.length).toBeGreaterThan(0);
      expect(template.devPort).toBeGreaterThan(0);
      expect(template.devPort).toBeLessThan(65536);
    }
  });

  it("never repeats the dev port among a template's extra ports", () => {
    // A duplicate would show the same target twice in the preview's picker.
    for (const template of listTemplates()) {
      const extras = template.extraPorts ?? [];
      expect(extras).not.toContain(template.devPort);
      expect(new Set(extras).size).toBe(extras.length);
    }
  });

  it("only names images the repository actually builds", () => {
    const built = new Set([
      "sandbox-node:latest",
      "sandbox-python:latest",
      "sandbox-go:latest",
    ]);

    for (const template of listTemplates()) {
      expect(built.has(template.image)).toBe(true);
    }
  });

  it("points every template at starter files that exist", () => {
    // A missing directory only surfaces when someone tries to create that kind
    // of project, and it fails after the row has already been written.
    for (const template of listTemplates()) {
      const dir = path.join(TEMPLATE_FILES_ROOT, template.filesDir);

      expect(fs.existsSync(dir), `${template.id}: ${dir}`).toBe(true);
      expect(fs.readdirSync(dir).length).toBeGreaterThan(0);
    }
  });

  it("gives each Node template a package.json with the script it runs", () => {
    for (const template of listTemplates()) {
      const manifest = path.join(
        TEMPLATE_FILES_ROOT,
        template.filesDir,
        "package.json",
      );
      if (!fs.existsSync(manifest)) continue;

      const scripts = (
        JSON.parse(fs.readFileSync(manifest, "utf8")) as {
          scripts?: Record<string, string>;
        }
      ).scripts;

      // "npm install && npm run dev" is worthless if `dev` is not defined.
      const named = /npm run (\w+)|npm (start)/.exec(template.startCommand);
      if (named) {
        expect(Object.keys(scripts ?? {})).toContain(named[1] ?? named[2]);
      }
    }
  });
});
