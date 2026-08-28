import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import {
  alucardTheme,
  draculaTheme,
  EDITOR_THEMES,
} from "./editorThemes.ts";
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

/** Both editor themes, registered before any editor can be created.
 *
 *  This has to happen at module load and NOT in an editor's `onMount`, which is
 *  where it used to live. @monaco-editor/react calls `editor.setTheme(theme)`
 *  immediately after `editor.create(...)` and only fires `onMount` afterwards --
 *  so a theme defined in `onMount` does not exist yet at the moment it is asked
 *  for, Monaco falls back to its built-in `vs`, and the editor comes up WHITE
 *  inside a dark IDE. Nothing corrected it later either: the library reapplies
 *  the theme only when the prop CHANGES, so the first paint was the one you
 *  kept until you toggled light/dark and back.
 *
 *  Registering here also means every editor in the app gets them by importing
 *  this module, rather than by being lucky enough to mount after the one
 *  component that happened to define them.
 */
monaco.editor.defineTheme(EDITOR_THEMES.dark, draculaTheme);
monaco.editor.defineTheme(EDITOR_THEMES.light, alucardTheme);
