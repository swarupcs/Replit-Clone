import type { editor } from "monaco-editor";
import type { EditorSettings } from "../store/editorSettingsStore.ts";

/** The columns the guides are drawn at when they are switched on.
 *
 *  80 and 120 rather than one or the other: 80 is the older convention that
 *  most style guides still anchor to, 120 is what a wide screen actually
 *  affords, and showing both lets someone see which one they are past.
 */
export const RULER_COLUMNS = [80, 120] as const;

/** Monaco options for the main editing surface.
 *
 *  Split out of the component so the option set can be asserted in a test
 *  rather than read off a JSX prop. Most of what VS Code does that this did
 *  not is a line in here, not a feature: bracket colourisation, sticky scroll,
 *  inlay hints and linked editing all ship inside Monaco and were simply
 *  never switched on.
 *
 *  The split between what is a preference and what is unconditional is
 *  deliberate. A preference is something people genuinely disagree about —
 *  whether a minimap earns its width, whether ghost text is help or noise.
 *  The rest is on for everyone, because a toggle whose off position has no
 *  constituency is a settings row that only costs attention.
 */
export const buildEditorOptions = (
  settings: EditorSettings,
  { canEdit, reducedMotion = false }: { canEdit: boolean; reducedMotion?: boolean },
): editor.IStandaloneEditorConstructionOptions => ({
  // Read-only access is presented as read-only rather than letting every
  // keystroke be rejected one at a time.
  readOnly: !canEdit,

  fontSize: settings.fontSize,
  fontFamily: '"JetBrains Mono", "Fira Code", monospace',
  fontLigatures: true,
  lineHeight: 1.6,
  minimap: { enabled: settings.minimap },
  lineNumbers: settings.lineNumbers ? "on" : "off",
  wordWrap: settings.wordWrap ? "on" : "off",
  tabSize: settings.tabSize,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  padding: { top: 16, bottom: 16 },
  // Monaco's animations are its own, out of reach of the stylesheet's
  // reduced-motion rule, so they are switched off here instead. A caret that
  // glides and a viewport that eases are exactly the motion someone asking
  // for less of it means.
  smoothScrolling: !reducedMotion,
  cursorBlinking: reducedMotion ? "solid" : "smooth",
  cursorSmoothCaretAnimation: reducedMotion ? "off" : "on",
  renderLineHighlight: "line",
  roundedSelection: true,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  guides: { indentation: true, bracketPairs: true },

  // --- Preferences ---

  // On by default, as it has been in VS Code since 1.67. Nesting depth is
  // most of what makes an unfamiliar function hard to read.
  bracketPairColorization: { enabled: settings.bracketPairColorization },

  // The enclosing class and function pinned above the viewport. Worth a
  // preference because it costs viewport height, which people weigh
  // differently on a laptop and on a monitor.
  stickyScroll: { enabled: settings.stickyScroll },

  // Inferred parameter names and types inline. TypeScript and JavaScript
  // only for now — the worker already computes them and nothing consumed
  // them. Every other language gets these when §3 lands a language server.
  inlayHints: { enabled: settings.inlayHints ? "on" : "off" },

  // Ghost text for the current completion, previewed in place rather than
  // only in the suggest list.
  inlineSuggest: { enabled: settings.inlineSuggest },
  suggest: { preview: settings.inlineSuggest },

  renderWhitespace: settings.renderWhitespace,

  // Off by default, and for the same reason format-on-save is: reformatting
  // something nobody asked to reformat is a rude surprise, and in a project
  // with no formatter config of its own it makes diffs enormous.
  formatOnPaste: settings.formatOnPaste,
  formatOnType: settings.formatOnType,

  rulers: settings.rulers ? [...RULER_COLUMNS] : [],

  // scrolloff: keeps this many lines below the cursor, so the line being
  // typed is never the last one visible.
  cursorSurroundingLines: settings.cursorSurroundingLines,

  // --- Unconditional ---

  // Editing an HTML or JSX tag renames its closing tag. There is no reading
  // of this where someone wants the tags to fall out of step.
  linkedEditing: true,

  // Every other use of the symbol under the cursor, highlighted.
  occurrencesHighlight: "singleFile",

  // Homoglyph and invisible-character warnings. This is a security
  // affordance rather than a preference — a Cyrillic 'а' in an identifier is
  // worth flagging whether or not somebody thought to ask for it.
  unicodeHighlight: {
    ambiguousCharacters: true,
    invisibleCharacters: true,
  },
});

/** Monaco options for the two read-only diff surfaces.
 *
 *  Deliberately not the editing options with `readOnly` bolted on: a diff is
 *  being read, not written, so the affordances that help while typing —
 *  inlay hints, ghost text, sticky scroll — are noise over someone else's
 *  change. Font settings still apply, because legibility is not a mode.
 */
export const buildDiffOptions = (
  settings: EditorSettings,
): editor.IDiffEditorConstructionOptions => ({
  readOnly: true,
  renderSideBySide: true,
  fontSize: settings.fontSize,
  fontFamily: '"JetBrains Mono", "Fira Code", monospace',
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
});
