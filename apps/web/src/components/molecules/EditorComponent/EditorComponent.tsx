import { useEffect, useRef, useState } from "react";
// Must precede the Editor import's first render: points Monaco at our bundle
// rather than a CDN. See the file for why.
import "../../../config/monacoSetup.ts";
import { EDITOR_THEMES } from "../../../config/editorThemes.ts";
import Editor, { DiffEditor } from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { Flex, Tooltip, Typography } from "antd";
import { VscDiff, VscSparkle } from "react-icons/vsc";
import { MAX_FILE_BYTES, isNotebookPath } from "@replit-clone/shared";
import { FileIcon } from "../../atoms/FileIcon/FileIcon.tsx";
import {
  selectCanEdit,
  useEditorSocketStore,
} from "../../../store/editorSocketStore.ts";
import {
  useOpenTabsStore,
  selectPaneTab,
  type PaneId,
} from "../../../store/openTabsStore.ts";
import { useEditorStatusStore } from "../../../store/editorStatusStore.ts";
import { useThemeMode } from "../../../hooks/useThemeMode.ts";
import { useMediaQuery } from "../../../hooks/useMediaQuery.ts";
import { useSymbolStore } from "../../../store/symbolStore.ts";
import {
  findConflicts,
  resolveConflict,
  type ConflictBlock,
  type Resolution,
} from "../../../lib/mergeConflicts.ts";
import type { FileSymbol } from "../../../lib/documentSymbols.ts";
import {
  selectRegions,
  useGitGutterStore,
} from "../../../store/gitGutterStore.ts";
import { extensionToFileType } from "../../../utils/extensionToFileType.ts";
import { useLanguageServer } from "../../../hooks/useLanguageServer.ts";
import { useViewportSync } from "../../../hooks/useViewportSync.ts";
import { useTreeStructureStore } from "../../../store/treeStructureStore.ts";
import { NotebookEditor } from "../../organisms/NotebookEditor/NotebookEditor.tsx";
import { useEditorSettingsStore } from "../../../store/editorSettingsStore.ts";
import {
  buildDiffOptions,
  buildEditorOptions,
} from "../../../lib/editorOptions.ts";
import { useAiChatStore } from "../../../store/aiChatStore.ts";
import {
  flushAllWrites,
  flushWrite,
  queueWrite,
  setWriteEmitter,
} from "../../../lib/pendingWrites.ts";
import {
  bindDoc,
  colorFor,
  isCollaborative,
  peerCount,
  releaseDoc,
  retainDoc,
  saveDoc,
  subscribeCollab,
} from "../../../lib/collab.ts";
import { useAuthStore } from "../../../store/authStore.ts";
import { registerPaneEditor } from "../../../lib/editorContext.ts";
import { disposeUnwantedModels, trackModel } from "../../../lib/editorModels.ts";
import { shouldReseedFromServer } from "../../../lib/bufferReseed.ts";

const WRITE_DEBOUNCE_MS = 800;

/** Builds the model URI for a path.
 *
 *  `Uri.parse` would PARSE the path, so a `#` started a fragment, a `?`
 *  started a query, and a space was escaped — none of which survive a round
 *  trip back through `uri.path`. Files named that way lost their view state,
 *  never had their models disposed, and could collide with each other.
 *  `Uri.from` takes the path as given.
 */
function modelUri(monaco: Monaco, relPath: string) {
  return monaco.Uri.from({ scheme: "inmemory", path: `/${relPath}` });
}


/** The shape the TypeScript worker's navigation tree comes back in.
 *
 *  Declared here rather than imported: it is internal to the worker's API
 *  surface and typescript's own types are not reachable from this bundle. */
interface NavigationTree {
  text: string;
  kind: string;
  spans: { start: number; length: number }[];
  childItems?: NavigationTree[];
}

/** Monaco SymbolKind values for the few kinds worth telling apart in a
 *  breadcrumb. Anything else falls back to a generic one — the name carries
 *  the meaning, the icon only helps. */
const NAVIGATION_KINDS: Record<string, number> = {
  class: 4,
  interface: 10,
  enum: 9,
  function: 11,
  method: 5,
  property: 6,
  constructor: 8,
  module: 1,
  var: 12,
  const: 13,
  let: 12,
};

function navigationToSymbols(
  items: NavigationTree[],
  model: editor.ITextModel,
): FileSymbol[] {
  return items.map((item) => {
    const span = item.spans[0];
    const start = span ? model.getPositionAt(span.start).lineNumber : 1;
    const end = span
      ? model.getPositionAt(span.start + span.length).lineNumber
      : start;

    return {
      name: item.text,
      kind: NAVIGATION_KINDS[item.kind] ?? 12,
      startLine: start,
      endLine: end,
      children: navigationToSymbols(item.childItems ?? [], model),
    };
  });
}

interface EditorComponentProps {
  /** Which pane this instance is. Both share the tab list and the write queue;
   *  only the file they display differs. */
  pane?: PaneId;
}

export const EditorComponent = ({ pane = "primary" }: EditorComponentProps) => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  /** Per-file scroll position and folded regions, keyed by relPath. */
  const viewStates = useRef(new Map<string, editor.ICodeEditorViewState | null>());
  /** Path currently attached to the editor.
   *
   *  Tracked here rather than recovered from `model.uri`: a URI does not always
   *  round-trip back to the path it was built from, so paths with a space, a
   *  `#` or a `?` lost their view state and leaked their models. */
  const openedPath = useRef<string | null>(null);
  /** Set while the editor's contents are being replaced programmatically, so
   *  the resulting change event is not mistaken for the user typing. */
  const suppressChange = useRef(false);
  /** The tab `value` this pane last took its contents from, per path.
   *
   *  `OpenTab.value` is a snapshot of what the SERVER last sent, not a mirror
   *  of the buffer — it is set when a file is read and never again. Comparing
   *  the model against it is therefore only meaningful when it has actually
   *  changed, which is to say when the server has sent new contents. */
  const seededFrom = useRef(new Map<string, string>());
  /** Bumped each time Monaco hands us an editor.
   *
   *  State, not a ref, because the effects below need to RUN again once the
   *  editor exists. Monaco loads asynchronously, so on the very first file the
   *  attach effect fired while `editorRef` was still null and gave up — and
   *  nothing re-ran it when the editor finally arrived, so the first file
   *  opened in a session showed an empty buffer until a second file was
   *  clicked. A ref would have been read at the same wrong moment.
   *
   *  A counter rather than a flag: closing every tab unmounts the editor, and
   *  the next file mounts a fresh one. A flag would already be true and change
   *  nothing, leaving that editor just as empty as the first one was.
   */
  const [mountTick, setMountTick] = useState(0);

  const activeTab = useOpenTabsStore(selectPaneTab(pane));
  const focusedPane = useOpenTabsStore((state) => state.focusedPane);
  const focusPane = useOpenTabsStore((state) => state.focusPane);
  const splitOpen = useOpenTabsStore((state) => state.splitOpen);
  const markDirty = useOpenTabsStore((state) => state.markDirty);
  const editorSocket = useEditorSocketStore((state) => state.editorSocket);
  const canEdit = useEditorSocketStore(selectCanEdit);
  const user = useAuthStore((state) => state.user);

  /** Bumped whenever a document syncs or someone joins, so the peer badge and
   *  the "server owns saving" decision re-render. */
  const [collabTick, setCollabTick] = useState(0);
  useEffect(() => subscribeCollab(() => setCollabTick((value) => value + 1)), []);
  const settings = useEditorSettingsStore();
  /** Both themes are ours. Light used to be Monaco's stock "vs", which is a
   *  perfectly good theme and the wrong one here: it is lit differently from
   *  the app around it, so the editor read as a pane borrowed from somewhere
   *  else. Alucard is Dracula's palette with every hue darkened until it
   *  carries on white, so the two moods look like one product. */
  const monacoTheme =
    useThemeMode() === "light" ? EDITOR_THEMES.light : EDITOR_THEMES.dark;

  /** Someone who has asked their OS for less motion means Monaco's caret and
   *  scrolling too, which the stylesheet cannot reach. */
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  /** The whole store: both actions are stable, so this never re-renders. */
  const publishStatus = useEditorStatusStore.getState();

  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [selectionCount, setSelectionCount] = useState(0);
  const [writeError, setWriteError] = useState<string | null>(null);
  /** Showing the unsaved changes rather than the editor. */
  const [showDiff, setShowDiff] = useState(false);

  const review = useOpenTabsStore((state) => state.review);
  const endReview = useOpenTabsStore((state) => state.endReview);
  const resolveProposal = useAiChatStore((state) => state.resolveProposal);

  /** The proposal this pane is showing, if it is the one showing it.
   *
   *  Primary only: the same file can be open in both panes, and two diffs of
   *  one change is one more than anybody needs. */
  const reviewing =
    pane === "primary" && review && activeTab && review.relPath === activeTab.relPath
      ? review
      : null;

  /** The buffer as it stood when the review opened — the left-hand side.
   *
   *  Captured rather than read at render time because Monaco owns the live
   *  text and reading it during render would be reading through a side door.
   *  Re-taken whenever the proposal or the file changes, so the diff is never
   *  against a buffer from before. */
  const [reviewBase, setReviewBase] = useState("");
  /** The buffer as it stands, captured when the diff opens. Monaco owns the
   *  live text, so there is nothing in React state to compare against. */
  const [diffCurrent, setDiffCurrent] = useState("");

  /** This pane's file, readable from Monaco callbacks that outlive a render. */
  const paneRelPathRef = useRef<string | null>(null);
  paneRelPathRef.current = activeTab?.relPath ?? null;

  // The queue is module-level, so the two panes share one per-path timer.
  // Two queues for the same file would race each other.
  useEffect(() => {
    if (!editorSocket) return;

    setWriteEmitter((relPath, data) => {
      editorSocket.emit("writeFile", { relPath, data });
    });

    return () => setWriteEmitter(null);
  }, [editorSocket]);

  // Last resort. Blur (see handleMount) is what actually catches navigation;
  // by unmount the socket may already be gone.
  useEffect(() => flushAllWrites, []);

  /** One Monaco model per file, so undo history, cursor position, and scroll
   *  survive switching tabs. A single controlled `value` reset all three on
   *  every file change. */
  useEffect(() => {
    // Before anything else: the file being switched away from may still have a
    // debounced write queued, and nothing else would ever send it.
    flushAllWrites();

    const monaco = monacoRef.current;
    const codeEditor = editorRef.current;
    if (!monaco || !codeEditor || !activeTab) return;

    const previousPath = openedPath.current;
    if (previousPath !== null && codeEditor.getModel()) {
      viewStates.current.set(previousPath, codeEditor.saveViewState());
    }

    const uri = modelUri(monaco, activeTab.relPath);
    const language = extensionToFileType(activeTab.extension, activeTab.name);

    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(activeTab.value, language, uri);
      seededFrom.current.set(activeTab.relPath, activeTab.value);
    } else if (
      shouldReseedFromServer({
        seeded: seededFrom.current.get(activeTab.relPath),
        tabValue: activeTab.value,
        modelValue: model.getValue(),
        isDirty: activeTab.isDirty,
        isShared: isCollaborative(activeTab.relPath),
      })
    ) {
      // Suppressed because setValue raises a content-change event exactly like
      // a keystroke: without this, merely reopening a file marked it dirty and
      // queued a write of the contents it had just been given.
      suppressChange.current = true;
      model.setValue(activeTab.value);
      suppressChange.current = false;
      seededFrom.current.set(activeTab.relPath, activeTab.value);
    }

    // Claimed as ours on every open, not only on creation: the second pane to
    // show a file finds the model rather than creating it, and it still has to
    // be a model somebody is willing to dispose.
    trackModel(model);

    // The diff described the file being left, so it does not survive a switch.
    setShowDiff(false);
    openedPath.current = activeTab.relPath;

    codeEditor.setModel(model);

    // A search result asked to land on a specific line; that wins over the
    // remembered scroll position for this file.
    const reveal = useOpenTabsStore.getState().pendingReveal;
    if (reveal && reveal.relPath === activeTab.relPath) {
      useOpenTabsStore.getState().consumeReveal();
      codeEditor.revealLineInCenter(reveal.line);
      codeEditor.setPosition({ lineNumber: reveal.line, column: reveal.column });
    } else {
      const saved = viewStates.current.get(activeTab.relPath);
      if (saved) codeEditor.restoreViewState(saved);
    }

    codeEditor.focus();
  }, [activeTab, mountTick]);

  /** Shared editing for whichever file this pane is showing.
   *
   *  Retained per pane: two panes on one file share the document, and it is
   *  released only when the last of them moves away.
   */
  useEffect(() => {
    const relPath = activeTab?.relPath;
    const monaco = monacoRef.current;
    const codeEditor = editorRef.current;

    // A viewer's edits would be rejected anyway, and a CRDT binding that can
    // write would let them type into a buffer nobody will save.
    if (!relPath || !editorSocket || !monaco || !codeEditor || !canEdit) return;

    retainDoc(editorSocket, relPath, {
      name: user?.email ?? "Someone",
      color: colorFor(user?.id ?? "anonymous"),
    });

    const model = monaco.editor.getModel(modelUri(monaco, relPath));
    if (model) bindDoc(relPath, model, codeEditor);

    return () => {
      releaseDoc(editorSocket, relPath);
    };
    // `mounted` for the same reason as the attach effect above: on the first
    // file, Monaco has not produced an editor yet and this would bind nothing.
  }, [activeTab?.relPath, editorSocket, canEdit, user?.email, user?.id, mountTick]);

  /** Follow mode's second half: their scroll position, not just their file.
   *
   *  Primary pane only, and only while this pane can edit — which is the same
   *  condition the document itself is retained under, because a viewport
   *  belongs to a live document and there is none without it.
   */
  useViewportSync({
    editor: pane === "primary" ? editorRef.current : null,
    relPath: activeTab?.relPath,
    enabled: pane === "primary" && canEdit && Boolean(editorSocket),
    mountTick,
  });

  /** Document symbols, for the breadcrumbs and the outline.
   *
   *  One read feeding both: two fetches of the same symbols would be twice
   *  the work for something that can then disagree with itself. Only the
   *  primary pane publishes, so two panes on two files do not fight over one
   *  store.
   *
   *  Read from the TypeScript worker directly. Standalone Monaco has no
   *  equivalent of VS Code's `executeDocumentSymbolProvider` command, and the
   *  worker's navigation tree is the same data the outline in VS Code shows.
   *  That confines this to TypeScript and JavaScript, which is exactly what
   *  is available without a language server.
   */
  useEffect(() => {
    if (pane !== "primary") return;

    const monaco = monacoRef.current;
    const codeEditor = editorRef.current;
    const relPath = activeTab?.relPath;
    if (!monaco || !codeEditor || !relPath) return;

    let cancelled = false;

    void (async () => {
      const model = codeEditor.getModel();
      if (!model) return;

      const language = model.getLanguageId();
      if (language !== "typescript" && language !== "javascript") {
        // Not an error: most languages have no provider yet, and the
        // breadcrumb degrades to the path rather than to an empty bar.
        useSymbolStore.getState().setSymbols(relPath, []);
        return;
      }

      try {
        const getWorker =
          language === "typescript"
            ? await monaco.languages.typescript.getTypeScriptWorker()
            : await monaco.languages.typescript.getJavaScriptWorker();
        const worker = await getWorker(model.uri);
        const tree = (await worker.getNavigationTree(model.uri.toString())) as
          | NavigationTree
          | undefined;

        if (cancelled || !tree) return;
        useSymbolStore
          .getState()
          .setSymbols(relPath, navigationToSymbols(tree.childItems ?? [], model));
      } catch {
        // A worker that has not warmed up yet, or a file it will not parse.
        if (!cancelled) useSymbolStore.getState().setSymbols(relPath, []);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pane, activeTab?.relPath, activeTab?.value, mountTick]);

  /** Diagnostics from a real language server, for the languages that have one.
   *
   *  The effect above reaches into Monaco's bundled TypeScript worker, which
   *  is why TypeScript and JavaScript have had squiggles all along and Python
   *  and Go have had none: there is no worker in the browser that understands
   *  them. This is the other half — an actual `pylsp` or `gopls` running in
   *  the project's own container, where the imports resolve and the toolchain
   *  already lives.
   *
   *  Primary pane only. Two panes on the same file would open two connections
   *  and publish the same markers twice; the markers are set on the model, so
   *  the second pane displays them regardless of which pane asked. */
  const lspProjectId = useTreeStructureStore((state) => state.projectId);
  /** The same id, named for its other reader. A kernel needs the project's
   *  container exactly as a language server does. */
  const notebookProjectId = lspProjectId;
  useLanguageServer({
    monaco: pane === "primary" ? monacoRef.current : null,
    editor: pane === "primary" ? editorRef.current : null,
    projectId: lspProjectId ?? "",
    relPath: activeTab?.relPath,
    language: activeTab
      ? extensionToFileType(activeTab.extension, activeTab.name)
      : undefined,
    mountTick,
  });

  /** Keep the breadcrumb's symbol half pointed at the cursor. */
  useEffect(() => {
    if (pane !== "primary") return;
    const codeEditor = editorRef.current;
    if (!codeEditor) return;

    const subscription = codeEditor.onDidChangeCursorPosition((event) => {
      useSymbolStore.getState().setLine(event.position.lineNumber);
    });

    return () => {
      subscription.dispose();
    };
  }, [pane, mountTick]);

  /** Merge conflict blocks, with the four choices VS Code offers above each.
   *
   *  A state the product can already reach — pull produces conflicts — and
   *  had no answer for beyond rendering the raw `<<<<<<<` markers. The
   *  buttons are Monaco content widgets rather than DOM overlaid on the
   *  editor, so they scroll with the text and sit at the right line without
   *  anything measuring pixel offsets.
   */
  const [conflicts, setConflicts] = useState<ConflictBlock[]>([]);
  const conflictDecorations = useRef<string[]>([]);

  useEffect(() => {
    const codeEditor = editorRef.current;
    if (!codeEditor) return;

    const model = codeEditor.getModel();
    if (!model) return;

    setConflicts(findConflicts(model.getValue()));
  }, [activeTab?.relPath, activeTab?.value, mountTick]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const codeEditor = editorRef.current;
    if (!monaco || !codeEditor) return;

    conflictDecorations.current = codeEditor.deltaDecorations(
      conflictDecorations.current,
      conflicts.flatMap((block) => [
        {
          range: new monaco.Range(block.startLine, 1, block.separatorLine - 1, 1),
          options: {
            isWholeLine: true,
            className: "rc-conflict-current",
          },
        },
        {
          range: new monaco.Range(block.separatorLine + 1, 1, block.endLine, 1),
          options: {
            isWholeLine: true,
            className: "rc-conflict-incoming",
          },
        },
      ]),
    );
  }, [conflicts, mountTick]);

  /** Applies one choice and writes the result back through the normal path,
   *  so the change is saved and shared like any other edit. */
  const resolve = (block: ConflictBlock, resolution: Resolution) => {
    const codeEditor = editorRef.current;
    const relPath = activeTab?.relPath;
    if (!codeEditor || !relPath) return;

    const model = codeEditor.getModel();
    if (!model) return;

    const next = resolveConflict(model.getValue(), block, resolution);

    // One full-range edit rather than a series of line edits: it is a single
    // undo step, which is what somebody who picked the wrong side wants.
    codeEditor.executeEdits("resolve-conflict", [
      { range: model.getFullModelRange(), text: next },
    ]);

    setConflicts(findConflicts(next));
  };

  /** The git bars down the left margin.
   *
   *  The most visible git feature the editor did not have, and the data was
   *  already here — the source-control panel has been reading these diffs all
   *  along. What was missing is the decoration layer.
   *
   *  Decorations are replaced wholesale on every change rather than diffed
   *  against the previous set: Monaco's `deltaDecorations` already does that
   *  work against the ids it is given, and a hand-rolled reconciliation on
   *  top of it would be two things that can disagree.
   */
  const gutterRegionsForFile = useGitGutterStore(selectRegions(activeTab?.relPath ?? null));
  const gutterDecorations = useRef<string[]>([]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const codeEditor = editorRef.current;
    if (!monaco || !codeEditor) return;

    gutterDecorations.current = codeEditor.deltaDecorations(
      gutterDecorations.current,
      gutterRegionsForFile.map((region) => ({
        range: new monaco.Range(region.startLine, 1, region.endLine, 1),
        options: {
          // `linesDecorationsClassName` puts the mark in the margin between
          // the line numbers and the text, which is where VS Code's lives.
          linesDecorationsClassName: `rc-gutter rc-gutter-${region.kind}`,
          // Kept when text is inserted at the very start of the range, so
          // typing at the head of a changed line does not shed the bar.
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );
  }, [gutterRegionsForFile, mountTick]);

  /** Clicking a bar opens the diff, which is what the bar is a summary of.
   *
   *  The margin is one strip whether or not a bar is under the pointer, so
   *  the handler checks the click actually landed on a decoration rather
   *  than opening the diff on any stray click in the gutter.
   */
  useEffect(() => {
    const codeEditor = editorRef.current;
    if (!codeEditor) return;

    const monaco = monacoRef.current;
    if (!monaco) return;

    const subscription = codeEditor.onMouseDown((event) => {
      // The decorations margin is one strip whether or not a bar is under
      // the pointer, so the line has to be checked against the regions too —
      // otherwise any click in the margin would open the diff.
      if (
        event.target.type !==
        monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
      ) {
        return;
      }

      const line = event.target.position?.lineNumber;
      if (!line) return;

      const onABar = gutterRegionsForFile.some(
        (region) => line >= region.startLine && line <= region.endLine,
      );
      if (!onABar) return;

      setDiffCurrent(codeEditor.getValue());
      setShowDiff(true);
    });

    return () => {
      subscription.dispose();
    };
  }, [gutterRegionsForFile, mountTick]);

  /** Ask for a fresh diff when the file changes or is opened. */
  useEffect(() => {
    const relPath = activeTab?.relPath;
    if (relPath) useGitGutterStore.getState().refresh(relPath);
  }, [activeTab?.relPath, activeTab?.value]);

  /** Dispose models for files that are no longer open, so a long session does
   *  not accumulate them.
   *
   *  Only models this editor created are candidates. Sweeping
   *  `monaco.editor.getModels()` — the page-wide registry — also disposed the
   *  diff editor's two generated models, and the wrapper then destructured a
   *  null `getModel()` on the next language change and took the pane down. */
  const openPaths = useOpenTabsStore((state) => state.tabs.map((t) => t.relPath).join("\u0000"));
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    const open = new Set(openPaths.split("\u0000").filter(Boolean));
    disposeUnwantedModels(
      [...open].map((path) => modelUri(monaco, path).toString()),
    );

    for (const path of viewStates.current.keys()) {
      if (!open.has(path)) viewStates.current.delete(path);
    }

    for (const path of seededFrom.current.keys()) {
      if (!open.has(path)) seededFrom.current.delete(path);
    }
  }, [openPaths, mountTick]);

  /** Lets the assistant read what this pane is showing, at the moment it asks.
   *
   *  Pull rather than push: mirroring the buffer and selection into a store on
   *  every keystroke would re-render half the app to serve one panel that is
   *  usually closed. */
  useEffect(
    () =>
      registerPaneEditor(pane, () => {
        const codeEditor = editorRef.current;
        const model = codeEditor?.getModel();
        if (!codeEditor || !model) return undefined;

        const selection = codeEditor.getSelection();

        return {
          // Models are keyed by an inmemory URI whose path is the relPath with
          // a leading slash — see modelUri.
          relPath: model.uri.path.replace(/^\//, ""),
          contents: model.getValue(),
          selection:
            selection && !selection.isEmpty()
              ? model.getValueInRange(selection)
              : undefined,
        };
      }),
    [pane],
  );

  function handleMount(codeEditor: editor.IStandaloneCodeEditor, monaco: Monaco) {
    editorRef.current = codeEditor;
    monacoRef.current = monaco;

    // The themes are NOT defined here. They are registered in monacoSetup at
    // module load, because this hook fires after the editor has already been
    // created and themed -- see that file.

    // Feeds the status bar. Monaco owns the cursor, so this is the only way to
    // observe it; the listener is disposed with the editor.
    codeEditor.onDidChangeCursorPosition((event) => {
      setCursor({
        line: event.position.lineNumber,
        column: event.position.column,
      });
    });

    // Autosave on focus loss, the way editors with autosave behave. Clicking
    // the file tree, the terminal, or Back all leave the editor, and none of
    // them would otherwise wait out the debounce — while unmount cleanup is too
    // late to rely on, since the socket may already have been disconnected.
    codeEditor.onDidBlurEditorText(() => {
      flushAllWrites();
    });

    // Focus follows the cursor, so opening a file from the tree puts it in the
    // pane the user was last working in.
    codeEditor.onDidFocusEditorText(() => {
      focusPane(pane);
    });

    codeEditor.onDidChangeCursorSelection((event) => {
      const model = codeEditor.getModel();
      setSelectionCount(
        model ? model.getValueLengthInRange(event.selection) : 0,
      );
    });

    // Ctrl/Cmd+S flushes immediately instead of waiting out the debounce.
    // Reads the active path at invocation time: Monaco keeps this callback for
    // the editor's whole lifetime, so anything captured now would go stale.
    codeEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveNow(codeEditor);
    });

    // Last, so the effects this releases see fully configured refs.
    setMountTick((tick) => tick + 1);
  }

  /** Formats if asked to, then writes immediately.
   *
   *  Monaco ships the formatters already; nothing used to invoke them. The
   *  format runs first and its result is what gets saved, so the file on disk
   *  matches what the editor shows.
   */
  async function saveNow(codeEditor: editor.IStandaloneCodeEditor) {
    const relPath = paneRelPathRef.current;
    if (!relPath) return;

    if (useEditorSettingsStore.getState().formatOnSave) {
      // Suppressed so the formatter's edits are not mistaken for typing, which
      // would queue a second write of the same content.
      suppressChange.current = true;
      try {
        await codeEditor.getAction("editor.action.formatDocument")?.run();
      } catch {
        // No formatter for this language, or it declined. Save regardless —
        // refusing to save because formatting failed would be worse.
      } finally {
        suppressChange.current = false;
      }
    }

    // A shared file is written by the SERVER, from the merged document, so
    // asking it to write now is the only thing that actually saves one.
    //
    // This used to fall straight through to the client path below, where
    // `queueIfAllowed` declines to queue a shared file — and then `flushWrite`
    // sent whatever was still in the queue. Which was, at best, nothing, and
    // at worst an older buffer queued before the document synced: Ctrl+S then
    // put the PREVIOUS contents back on disk over the edit being saved.
    if (saveDoc(editorSocket, relPath)) return;

    // Saves even when nothing is queued, so Ctrl+S is never a no-op the user
    // has to guess about.
    queueIfAllowed(relPath, codeEditor.getValue(), 0);
    flushWrite(relPath);
  }

  /** Queues a write unless the buffer is over the editor's limit.
   *
   *  The server refuses those too; catching it here means the user is told
   *  while they can still act on it, rather than after a silent round trip.
   */
  function queueIfAllowed(relPath: string, data: string, delay: number) {
    // While a file is edited collaboratively the SERVER writes it, from the
    // merged document. A client write here would clobber whatever the others
    // have typed since this buffer was last in step.
    if (isCollaborative(relPath)) return;

    if (new Blob([data]).size > MAX_FILE_BYTES) {
      setWriteError(
        `This file is over the ${String(MAX_FILE_BYTES / 1024 / 1024)} MB editor limit and was not saved.`,
      );
      return;
    }

    setWriteError(null);
    queueWrite(relPath, data, delay);
  }

  // After the attach effect above, so the model for this file is in place and
  // `getValue` is the file being reviewed rather than the one before it.
  useEffect(() => {
    if (!reviewing) return;
    setReviewBase(editorRef.current?.getValue() ?? "");
  }, [reviewing, activeTab, mountTick]);

  /** Applies the proposal into the buffer, as one undoable edit.
   *
   *  Through the editor's own edit stack rather than `setValue`, so Ctrl+Z
   *  takes the whole change back out. That undo was half of what this feature
   *  was waiting on; the diff the user just read was the other half. The write
   *  itself goes the ordinary way — the change event marks the tab dirty and
   *  queues it — so a shared file is still saved by the server from the merged
   *  document, and nothing here needs to know the difference.
   */
  function acceptReview() {
    const codeEditor = editorRef.current;
    const model = codeEditor?.getModel();
    if (!codeEditor || !model || !reviewing) return;

    codeEditor.pushUndoStop();
    codeEditor.executeEdits("assistant", [
      { range: model.getFullModelRange(), text: reviewing.contents },
    ]);
    codeEditor.pushUndoStop();

    resolveProposal(reviewing.id);
    endReview();
    codeEditor.focus();
  }

  function discardReview() {
    if (reviewing) resolveProposal(reviewing.id);
    endReview();
  }

  function handleChange(value: string | undefined) {
    if (suppressChange.current) return;
    if (value === undefined || !activeTab) return;

    const { relPath } = activeTab;
    markDirty(relPath, true);
    queueIfAllowed(relPath, value, WRITE_DEBOUNCE_MS);
  }

  /** Publish what this pane is showing, for the app's one status bar.
   *
   *  An effect rather than a render, because the bar is no longer here: it is
   *  owned by the playground, so that a split does not produce two of them and
   *  closing every tab does not take it away with the editor. */
  useEffect(() => {
    if (!activeTab) {
      publishStatus.clear(pane);
      return;
    }

    // Read inside the effect so the values are the ones at publish time; both
    // live outside React and are re-read when `collabTick` moves.
    void collabTick;

    publishStatus.publish(pane, {
      relPath: activeTab.relPath,
      line: cursor.line,
      column: cursor.column,
      selectionCount,
      language: extensionToFileType(activeTab.extension, activeTab.name),
      tabSize: settings.tabSize,
      isDirty: activeTab.isDirty,
      writeError,
      canEdit,
      shared: isCollaborative(activeTab.relPath),
    });
  }, [
    activeTab,
    pane,
    cursor,
    selectionCount,
    settings.tabSize,
    writeError,
    canEdit,
    collabTick,
    publishStatus,
  ]);

  // A pane that goes away takes its entry with it, or the bar would keep
  // reporting a file that is no longer on screen.
  useEffect(() => () => { publishStatus.clear(pane); }, [pane, publishStatus]);

  if (!activeTab) {
    return (
      <Flex
        vertical
        align="center"
        justify="center"
        gap={18}
        style={{ height: "100%", backgroundColor: "var(--rc-editor-bg)" }}
      >
        <span className="rc-logo" style={{ opacity: 0.55 }}>
          &lt;/&gt;
        </span>

        <Typography.Text style={{ color: "var(--rc-text-muted)", fontSize: 14 }}>
          Nothing open
        </Typography.Text>

        {/* The routes in, with their keys. This was a dimmed logo and one line
            about autosaving -- true, and useless to someone who has just
            arrived and cannot see how to get anywhere. The bindings are
            written here rather than derived from the registry because this
            pane has no access to it; `useHotkeys` in the playground is where
            they are actually bound. */}
        <div className="rc-onramp">
          {[
            ["Open a file", "Ctrl+P"],
            ["Find a command", "Ctrl+Shift+P"],
            ["Search the project", "Ctrl+Shift+F"],
            ["Show the terminal", "Ctrl+`"],
            ["Save (it also autosaves)", "Ctrl+S"],
          ].map(([what, keys]) => (
            <div key={what} className="rc-onramp-row">
              <span>{what}</span>
              <kbd className="rc-kbd">{keys}</kbd>
            </div>
          ))}
        </div>
      </Flex>
    );
  }

  const segments = activeTab.relPath.split("/");
  const language = extensionToFileType(activeTab.extension, activeTab.name);

  /** A `.ipynb` is JSON on disk and a document on screen.
   *
   *  Branched here rather than in the playground so a notebook keeps the tab
   *  strip, the breadcrumb and the write queue every other file has -- the
   *  only thing that differs is what fills the pane. The Monaco effects above
   *  all bail on a null `monacoRef`, and nothing mounts Monaco on this path,
   *  so no model is created for a file it would render as raw JSON.
   *
   *  Diff and review are Monaco's, so they stay with it: a notebook diffed as
   *  its own JSON is exactly the unreadable thing this component exists to
   *  avoid. plan.md §12.3 -- and the honest note is that "review a proposal
   *  against a notebook" is therefore not available, rather than broken.
   */
  const isNotebook = isNotebookPath(activeTab.relPath);

  // `collabTick` is what makes this re-read after a sync; the value lives
  // outside React so nothing else would.
  void collabTick;
  const others = Math.max(0, peerCount(activeTab.relPath) - 1);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: "var(--rc-editor-bg)",
        // Only marked when there is a second pane to tell it apart from.
        boxShadow:
          splitOpen && focusedPane === pane
            ? "inset 0 2px 0 0 var(--rc-accent)"
            : undefined,
      }}
    >
      {/* Breadcrumb: the active file's path, so a deeply nested file is
          identifiable without hunting for it in the tree. */}
      <div className="rc-breadcrumb">
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          return (
            <span key={index} style={{ display: "contents" }}>
              {index > 0 && <span className="rc-breadcrumb-sep">›</span>}
              <span data-current={isLast}>
                {isLast && (
                  <FileIcon extension={activeTab.extension} name={activeTab.name} />
                )}
                {segment}
              </span>
            </span>
          );
        })}

        {others > 0 && (
          <Tooltip
            title={`${String(others)} other ${others === 1 ? "person is" : "people are"} editing this file`}
          >
            <span
              style={{
                marginLeft: "auto",
                marginRight: 8,
                fontSize: 11,
                fontFamily: "var(--rc-mono)",
                color: "var(--rc-green)",
              }}
            >
              +{others}
            </span>
          </Tooltip>
        )}

        {/* Compares the buffer against what is on disk. Monaco ships the diff
            editor; nothing surfaced it, so there was no way to see what a save
            would actually change. */}
        <Tooltip
          title={
            activeTab.isDirty
              ? showDiff
                ? "Back to the editor"
                : "Show unsaved changes"
              : "No unsaved changes to compare"
          }
        >
          <button
            className="rc-icon-button"
            style={{ marginLeft: others > 0 ? 0 : "auto", marginRight: 8 }}
            data-on={showDiff}
            disabled={!activeTab.isDirty && !showDiff}
            aria-label="Show unsaved changes"
            aria-pressed={showDiff}
            onClick={() => {
              if (!showDiff) setDiffCurrent(editorRef.current?.getValue() ?? "");
              setShowDiff((value) => !value);
            }}
          >
            <VscDiff size={14} />
          </button>
        </Tooltip>
      </div>

      {/* A change the assistant has offered. Nothing has been written: this is
          the diff, and the two buttons are the only way anything reaches the
          file. */}
      {reviewing && (
        <div className="rc-review-bar">
          <VscSparkle size={13} style={{ flex: "none" }} />
          <span className="rc-review-summary" title={reviewing.summary}>
            {reviewing.summary}
          </span>
          <span style={{ display: "flex", gap: 6, flex: "none" }}>
            <button
              className="rc-review-button"
              onClick={discardReview}
              aria-label="Discard the proposed change"
            >
              Discard
            </button>
            <button
              className="rc-review-button"
              data-primary
              onClick={acceptReview}
              disabled={!canEdit}
              title={
                canEdit
                  ? "Apply this change to the buffer — Ctrl+Z undoes it"
                  : "You have read-only access to this project"
              }
              aria-label="Apply the proposed change"
            >
              Apply
            </button>
          </span>
        </div>
      )}

      {isNotebook ? (
        <NotebookEditor
          projectId={notebookProjectId ?? ""}
          value={activeTab.value}
          canEdit={canEdit}
          onChange={(text) => {
            // The same two steps a Monaco change takes, so a notebook is
            // dirty-marked, size-checked, debounced and flushed on blur by
            // the machinery that already does it for every other file.
            markDirty(activeTab.relPath, true);
            queueIfAllowed(activeTab.relPath, text, WRITE_DEBOUNCE_MS);
          }}
        />
      ) : (
        <>
      <div style={{ flex: 1, minHeight: 0, display: reviewing ? "block" : "none" }}>
        <DiffEditor
          height="100%"
          width="100%"
          theme={monacoTheme}
          language={language}
          // Left is the buffer as it stands; right is what the assistant would
          // have instead.
          original={reviewBase}
          modified={reviewing?.contents ?? ""}
          options={buildDiffOptions(settings)}
        />
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: showDiff && !reviewing ? "block" : "none",
        }}
      >
        <DiffEditor
          height="100%"
          width="100%"
          theme={monacoTheme}
          language={language}
          // Left is the file as saved; right is what is in the buffer now.
          original={activeTab.value}
          modified={diffCurrent}
          options={buildDiffOptions(settings)}
        />
      </div>

      {/* Hidden rather than unmounted while diffing, so the models, undo
          history and scroll position all survive the round trip. Which matters
          twice over for a review: the undo stack it is hidden behind is what
          takes an applied proposal back out. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: showDiff || reviewing ? "none" : "block",
        }}
      >
        {conflicts.length > 0 && canEdit && (
          <div className="rc-conflict-bar" role="group" aria-label="Merge conflicts">
            <span className="rc-conflict-count">
              {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}
            </span>
            {/* Acting on the first unresolved block rather than one bar per
                block floating over the text: the buttons stay reachable
                however the file is scrolled, and resolving walks forward. */}
            <button type="button" onClick={() => resolve(conflicts[0]!, "current")}>
              Accept {conflicts[0]?.currentLabel}
            </button>
            <button type="button" onClick={() => resolve(conflicts[0]!, "incoming")}>
              Accept {conflicts[0]?.incomingLabel}
            </button>
            <button type="button" onClick={() => resolve(conflicts[0]!, "both")}>
              Accept both
            </button>
            <button
              type="button"
              onClick={() => {
                const block = conflicts[0];
                if (block) {
                  editorRef.current?.revealLineInCenter(block.startLine);
                  editorRef.current?.setPosition({
                    lineNumber: block.startLine,
                    column: 1,
                  });
                }
              }}
            >
              Go to it
            </button>
          </div>
        )}

        <Editor
          height="100%"
          width="100%"
          theme={monacoTheme}
          options={buildEditorOptions(settings, { canEdit, reducedMotion })}
          onChange={handleChange}
          onMount={handleMount}
        />
      </div>
        </>
      )}
    </div>
  );
};
