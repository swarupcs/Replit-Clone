import type { editor } from "monaco-editor";
import draculaJson from "../theme/dracula.json";
import alucardJson from "../theme/alucard.json";

/** The two editor themes, as data.
 *
 *  Deliberately separate from `monacoSetup.ts`, which registers them. That file
 *  imports `monaco-editor` itself and pulls in five web workers, so anything
 *  importing it drags the whole editor along — which is right for a component
 *  that creates an editor and wrong for one that merely needs to know what the
 *  dark theme is called. Splitting them means a test can render a panel without
 *  standing up Monaco, and a component can name a theme without doing so.
 *
 *  `import type` above is erased at build time, so this module costs nothing at
 *  runtime beyond the two JSON files.
 */

export const draculaTheme = draculaJson as editor.IStandaloneThemeData;
export const alucardTheme = alucardJson as editor.IStandaloneThemeData;

/** The names anything rendering Monaco asks for.
 *
 *  Used instead of writing "dracula" at each call site, so the names and the
 *  registration cannot drift — a theme asked for by a name nothing registered
 *  does not fail loudly. Monaco silently falls back to its built-in `vs`, which
 *  is a white editor inside a dark IDE and no error anywhere.
 */
export const EDITOR_THEMES = { dark: "dracula", light: "alucard" } as const;
