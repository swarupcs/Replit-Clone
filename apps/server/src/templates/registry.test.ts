import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEMPLATE_ID,
  getTemplate,
  listTemplates,
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
    const built = new Set(["sandbox-node:latest", "sandbox-python:latest"]);

    for (const template of listTemplates()) {
      expect(built.has(template.image)).toBe(true);
    }
  });
});
