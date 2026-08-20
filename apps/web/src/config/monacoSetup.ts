import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

/** Serves Monaco from our own bundle instead of a CDN.
 *
 *  @monaco-editor/react defaults to fetching Monaco from jsdelivr at runtime.
 *  That has three problems for a self-hosted tool:
 *
 *   1. The editor simply does not load on a VM without internet egress, which
 *      is a normal way to run this.
 *   2. It silently ran a DIFFERENT version from the one in package.json
 *      (0.55.1 from the CDN vs the 0.52.2 we typecheck against).
 *   3. Every user's editor session depended on a third-party CDN being up,
 *      and told that CDN who was using it.
 *
 *  Importing Monaco directly makes the bundle bigger, but it sits behind the
 *  lazily loaded playground route, so the auth and dashboard pages never pay
 *  for it.
 */
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") {
      return new cssWorker();
    }
    if (label === "html" || label === "handlebars" || label === "razor") {
      return new htmlWorker();
    }
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });
