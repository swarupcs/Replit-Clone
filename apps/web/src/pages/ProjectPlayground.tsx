import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import { loader } from "@monaco-editor/react";
import { Button, Flex, Tooltip, Typography, message } from "antd";
import {
  VscFiles,
  VscLayoutPanel,
  VscLayoutSidebarLeft,
  VscKey,
  VscSearch,
  VscSourceControl,
  VscPackage,
  VscDatabase,
  VscSymbolClass,
  VscCloudUpload,
  VscSettingsGear,
  VscSparkle,
} from "react-icons/vsc";
import {
  ArrowLeftOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
} from "@ant-design/icons";
import { SplitPane } from "../components/layout/SplitPane.tsx";
import { EditorComponent } from "../components/molecules/EditorComponent/EditorComponent.tsx";
import { EditorTabs } from "../components/molecules/EditorTabs/EditorTabs.tsx";
import { StatusBar } from "../components/molecules/StatusBar/StatusBar.tsx";
import { BottomPanel } from "../components/organisms/BottomPanel/BottomPanel.tsx";
import { TreeStructure } from "../components/organisms/TreeStructure/TreeStructure.tsx";
import { Browser } from "../components/organisms/Browser/Browser.tsx";
import { useTreeStructureStore } from "../store/treeStructureStore.ts";
import {
  selectCanEdit,
  useEditorSocketStore,
} from "../store/editorSocketStore.ts";
import {
  useOpenTabsStore,
  selectActiveTab,
  selectNextMruTab,
} from "../store/openTabsStore.ts";
import { useAuthStore } from "../store/authStore.ts";
import { useRunStore } from "../store/runStore.ts";
import { useWorkspaceStore } from "../store/workspaceStore.ts";
import { RunControl } from "../components/molecules/RunControl/RunControl.tsx";
import { ErrorBoundary } from "../components/routing/ErrorBoundary.tsx";
import { QuickOpen } from "../components/organisms/QuickOpen/QuickOpen.tsx";
import { CommandPalette } from "../components/organisms/CommandPalette/CommandPalette.tsx";
import type { Command } from "../lib/commands.ts";
import { EnvVarsDialog } from "../components/organisms/EnvVarsDialog/EnvVarsDialog.tsx";
import { EditorSettingsDialog } from "../components/organisms/EditorSettingsDialog/EditorSettingsDialog.tsx";
import { SearchPanel } from "../components/organisms/SearchPanel/SearchPanel.tsx";
import { SourceControlPanel } from "../components/organisms/SourceControlPanel/SourceControlPanel.tsx";
import { PackagesPanel } from "../components/organisms/PackagesPanel/PackagesPanel.tsx";
import { DeployPanel } from "../components/organisms/DeployPanel/DeployPanel.tsx";
import { AiPanel } from "../components/organisms/AiPanel/AiPanel.tsx";
import { getAiStatusApi } from "../apis/ai.ts";
import { useHotkeys } from "../hooks/useHotkeys.ts";
import { useGitGutterStore } from "../store/gitGutterStore.ts";
import {
  selectOverrides,
  useKeybindingStore,
} from "../store/keybindingStore.ts";
import { formatChord, resolveBindings } from "../lib/keybindings.ts";
import { DatabasePanel } from "../components/organisms/DatabasePanel/DatabasePanel.tsx";
import { Breadcrumbs } from "../components/molecules/Breadcrumbs/Breadcrumbs.tsx";
import { SymbolSearch } from "../components/organisms/SymbolSearch/SymbolSearch.tsx";
import { OutlinePanel } from "../components/organisms/OutlinePanel/OutlinePanel.tsx";
import { useMediaQuery } from "../hooks/useMediaQuery.ts";
import { useThemeStore } from "../store/themeStore.ts";
import { useUnsavedWorkGuard } from "../hooks/useUnsavedWorkGuard.ts";
import { useWorkspaceSession } from "../hooks/useWorkspaceSession.ts";
import { installCollab, peers, subscribeCollab } from "../lib/collab.ts";
import { usePresenceStore } from "../store/presenceStore.ts";
import {
  clearProjectSources,
  installProjectSources,
} from "../lib/projectSources.ts";
import { installProblems } from "../lib/problems.ts";
import { useProblemsStore } from "../store/problemsStore.ts";
import type { EditorSocket } from "../store/editorSocketStore.ts";

export const ProjectPlayground = () => {
  const { projectId: projectIdFromUrl } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  /** Whether a session exists — NOT the token itself. It rotates roughly every
   *  fifteen minutes, and depending on its value tore down the editor socket
   *  (and, through the panel, every terminal) each time it did. */
  const hasSession = useAuthStore((state) => state.accessToken !== null);
  // One value per subscription. Reading a whole store here re-rendered the
  // ENTIRE playground — editor, terminal, preview and all — every time
  // anything in it moved: a tree refetch, an externally-changed file, a
  // change of access level.
  const setProjectId = useTreeStructureStore((state) => state.setProjectId);
  const setEditorSocket = useEditorSocketStore((state) => state.setEditorSocket);
  const lastError = useEditorSocketStore((state) => state.lastError);
  const clearError = useEditorSocketStore((state) => state.clearError);
  const [messageApi, messageHolder] = message.useMessage();
  const activeTab = useOpenTabsStore(selectActiveTab);
  const closeAllTabs = useOpenTabsStore((state) => state.closeAll);
  const splitOpen = useOpenTabsStore((state) => state.splitOpen);

  const editorSocket = useEditorSocketStore((state) => state.editorSocket);
  // A viewer may read history but not stage or commit.
  const canEdit = useEditorSocketStore(selectCanEdit);
  /** Owner rather than merely editor: pushing spends the owner's credential,
   *  so the panel offers it to nobody else. */
  const accessLevel = useEditorSocketStore((state) => state.accessLevel);
  const { restored, remember } = useWorkspaceSession(projectIdFromUrl, editorSocket);

  // Seeded from the remembered arrangement, so a reload comes back to the
  // layout the user left rather than the defaults.
  //
  // One piece of state rather than three, because on a narrow screen a toggle
  // reads all three to decide what to close, and three separate updaters
  // cannot do that without one of them reaching into another -- which an
  // updater, being required to be pure, must not.
  const [views, setViews] = useState({
    preview: restored?.showPreview ?? false,
    sidebar: restored?.showSidebar ?? true,
    panel: restored?.showPanel ?? true,
  });
  const {
    preview: showPreview,
    sidebar: showSidebar,
    panel: showPanel,
  } = views;
  const [quickOpen, setQuickOpen] = useState(false);
  /** Go-to-symbol, and zen mode. Both are pure layout over what exists. */
  const [symbolSearchOpen, setSymbolSearchOpen] = useState(false);
  const [zen, setZen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Which sidebar view is showing. */
  const [sidebarView, setSidebarView] = useState<
    | "files"
    | "search"
    | "git"
    | "packages"
    | "deploy"
    | "database"
    | "outline"
    | "ai"
  >(
    "files",
  );

  /** Null until the status call answers, so the rail does not flash a button
   *  that a deployment without a key would then take away. */
  const [aiModel, setAiModel] = useState<string | null>(null);

  const closeActiveTab = useOpenTabsStore((state) => state.closeTab);
  /** The project whose tabs are currently loaded, so re-running the effect for
   *  the same project does not discard them. */
  const openedProjectRef = useRef<string | undefined>(undefined);

  useUnsavedWorkGuard();

  // Who else is here. The awareness transport has been running all along; the
  // registry is read in one place and published to a store, so the tree and the
  // tab strip can each ask about their own file without every row subscribing
  // to every collaboration event.
  useEffect(() => {
    const publish = () => {
      usePresenceStore.getState().setPresence(peers());
    };

    publish();
    return subscribeCollab(publish);
  }, []);

  // A failed operation is transient news: it happened, it is over, and it does
  // not describe the project's current state. It used to be a banner at the
  // top of the page, which pushed every pane down and made Monaco and xterm
  // re-measure mid-keystroke -- a worse interruption than the thing it was
  // reporting. Persistent state goes to the status bar instead; see the
  // externally-changed chip there.
  useEffect(() => {
    if (!lastError) return;
    void messageApi.error(lastError);
    clearError();
  }, [lastError, messageApi, clearError]);

  // Monaco has been computing diagnostics all along and nothing looked at
  // them. Installed once for the page rather than per editor pane: markers are
  // global to Monaco, and two panes would report the same problem twice.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;

    void loader.init().then((monaco) => {
      if (cancelled) return;
      dispose = installProblems(monaco, useProblemsStore.getState().setProblems);
    });

    return () => {
      cancelled = true;
      dispose?.();
      // Leaving a project must not leave its problems on screen in the next.
      useProblemsStore.getState().setProblems([]);
    };
  }, []);

  // Asked once per session. A deployment with no API key configured gets no
  // assistant button at all, rather than one that fails on the first question.
  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;

    void getAiStatusApi()
      .then((status) => {
        if (!cancelled && status.configured) setAiModel(status.model);
      })
      .catch(() => {
        // An older server has no such route. Not having an assistant is a
        // perfectly good outcome and not worth telling the user about.
      });

    return () => {
      cancelled = true;
    };
  }, [hasSession]);

  // Each toggle records its new state, so the arrangement survives a reload.
  /** Below this the panes stop being split children and become drawers over
   *  the editor. A layout branch, not a device test: four panes with pixel
   *  floors do not fit, whatever is holding the screen. */
  const narrow = useMediaQuery("(max-width: 900px)");

  /** On a narrow screen the drawers cover each other, so opening one closes
   *  the rest — two stacked drawers would leave the one underneath unreachable
   *  with its toggle still lit. On a wide screen the panes sit side by side
   *  and there is nothing to close. */
  const toggleView = useCallback(
    (which: "sidebar" | "panel" | "preview") => {
      setViews((current) => {
        const next = { ...current, [which]: !current[which] };
        if (!narrow || !next[which]) return next;

        return {
          sidebar: which === "sidebar",
          panel: which === "panel",
          preview: which === "preview",
        };
      });
    },
    [narrow],
  );

  /** Shows one, without hiding it if it is already up — what a command like
   *  "Search across the project" means, as against toggling. */
  const openView = useCallback(
    (which: "sidebar" | "panel" | "preview") => {
      setViews((current) =>
        narrow
          ? {
              sidebar: which === "sidebar",
              panel: which === "panel",
              preview: which === "preview",
            }
          : { ...current, [which]: true },
      );
    },
    [narrow],
  );

  /** Persists the arrangement whenever it changes.
   *
   *  An effect rather than a call inside each toggle, because the toggles are
   *  pure updaters now and writing to storage from one is exactly the kind of
   *  side effect that makes an updater unsafe to run twice.
   *
   *  Skips the first run: `views` is seeded from what was restored, and the
   *  session may not have arrived yet — writing on mount would overwrite a
   *  stored arrangement with the defaults. */
  const persistedOnce = useRef(false);
  useEffect(() => {
    if (!persistedOnce.current) {
      persistedOnce.current = true;
      return;
    }

    remember({
      showSidebar: views.sidebar,
      showPanel: views.panel,
      showPreview: views.preview,
    });
  }, [views, remember]);

  const toggleSidebar = useCallback(() => {
    toggleView("sidebar");
  }, [toggleView]);

  const togglePanel = useCallback(() => {
    toggleView("panel");
  }, [toggleView]);

  const togglePreview = useCallback(() => {
    toggleView("preview");
  }, [toggleView]);

  /** Show the preview the moment the dev server answers.
   *
   *  The server now starts the project on open, so the last step of "open a
   *  project and see it running" is revealing the pane it runs in. `readyNonce`
   *  is bumped by `previewReady`, which the server sends only once the dev port
   *  is actually accepting connections — so this opens onto a live app rather
   *  than onto the "nothing running yet" placeholder.
   *
   *  A user who has hidden the preview for this project keeps it hidden. That
   *  is read live from the session rather than from `restored`, for two
   *  reasons: hiding the pane during this session has to stick too, and this
   *  route is reused when navigating straight from one project to another, so
   *  anything captured at mount would belong to the previous project.
   *
   *  Revealing deliberately does not call `remember`: the pane opening by
   *  itself is not the user choosing to have it open, and recording it would
   *  make this a one-time event for the life of the browser profile.
   */
  /** Subscribed rather than read on demand, so the palette's Run entries say
   *  what the dev server is actually doing when it opens. */
  const runStatus = useRunStore((store) => store.state.status);

  const readyNonce = useRunStore((store) => store.readyNonce);
  useEffect(() => {
    if (readyNonce === 0 || !projectIdFromUrl) return;

    const remembered = useWorkspaceStore.getState().get(projectIdFromUrl)
      ?.showPreview;
    if (remembered !== undefined) return;

    openView("preview");
  }, [readyNonce, projectIdFromUrl, openView]);

  /** What the command palette offers.
   *
   *  Every entry drives the same handler the button or shortcut does, rather
   *  than a second copy of the behaviour -- the palette is another way in, not
   *  another implementation.
   *
   *  The shortcut shown against each entry is looked up from the binding
   *  registry by command id rather than typed here. It used to be free text,
   *  which meant the palette could say Ctrl+K while the handler listened for
   *  Ctrl+L and nothing would notice.
   */
  // Derived rather than selected: a selector that builds the resolved object
  // returns a new one every call, which renders forever.
  const bindingOverrides = useKeybindingStore(selectOverrides);
  const bindings = useMemo(
    () => resolveBindings(bindingOverrides),
    [bindingOverrides],
  );

  const commands = useMemo<Command[]>(() => {
    const isLive = runStatus === "running" || runStatus === "starting";
    const viewerReason = "Needs edit access";

    return [
      {
        id: "run.toggle",
        category: "Run",
        title: isLive ? "Stop the dev server" : "Start the dev server",
        enabled: canEdit && Boolean(editorSocket),
        disabledReason: canEdit ? "Not connected" : viewerReason,
        run: () => editorSocket?.emit(isLive ? "runStop" : "runStart"),
      },
      {
        id: "run.restart",
        category: "Run",
        title: "Restart the dev server",
        enabled: canEdit && Boolean(editorSocket) && runStatus !== "idle",
        disabledReason: canEdit ? "Nothing is running" : viewerReason,
        run: () => editorSocket?.emit("runRestart"),
      },
      {
        id: "go.file",
        category: "Go",
        title: "Go to file…",
        run: () => setQuickOpen(true),
      },
      {
        id: "view.search",
        category: "View",
        title: "Search across the project",
        run: () => {
          setSidebarView("search");
          openView("sidebar");
        },
      },
      {
        id: "view.files",
        category: "View",
        title: "Show the file tree",
        run: () => {
          setSidebarView("files");
          openView("sidebar");
        },
      },
      {
        id: "view.git",
        category: "Source control",
        title: "Show source control",
        run: () => {
          setSidebarView("git");
          openView("sidebar");
        },
      },
      {
        id: "view.packages",
        category: "Packages",
        title: "Show dependencies",
        run: () => {
          setSidebarView("packages");
          openView("sidebar");
        },
      },
      {
        id: "view.theme",
        category: "View",
        title: "Switch between the light and dark theme",
        run: () => {
          // From what is on screen, not from the stored choice: with "system"
          // selected, the useful thing to do is leave it — which means picking
          // the opposite of what the OS is currently giving.
          const current =
            document.documentElement.dataset["theme"] === "light"
              ? "light"
              : "dark";
          useThemeStore
            .getState()
            .setChoice(current === "light" ? "dark" : "light");
        },
      },
      {
        id: "view.sidebar",
        category: "View",
        title: "Toggle the sidebar",
        run: toggleSidebar,
      },
      {
        id: "view.panel",
        category: "View",
        title: "Toggle the terminal panel",
        run: togglePanel,
      },
      {
        id: "view.preview",
        category: "View",
        title: "Toggle the preview",
        run: togglePreview,
      },
      {
        id: "file.closeTab",
        category: "File",
        title: "Close the active editor tab",
        run: () => {
          const active = useOpenTabsStore.getState().activeRelPath;
          if (active) closeActiveTab(active);
        },
      },
      {
        id: "project.env",
        category: "Project",
        title: "Project settings — run command and variables…",
        run: () => setEnvOpen(true),
      },
      {
        id: "editor.settings",
        category: "Editor",
        title: "Editor settings…",
        run: () => setSettingsOpen(true),
      },
    ].map((command) => {
      const chord = bindings[command.id];
      return chord ? { ...command, keys: formatChord(chord) } : command;
    });
  }, [
    bindings,
    canEdit,
    closeActiveTab,
    editorSocket,
    runStatus,
    togglePanel,
    togglePreview,
    toggleSidebar,
  ]);

  /** What each command's chord does.
   *
   *  The chord itself lives in `lib/keybindings.ts`, beside the command it
   *  belongs to. This is only the handler half, so adding a chord is one
   *  edit in one place rather than two edits nothing checks are in step.
   */
  const handlers = useMemo<Record<string, () => void>>(
    () => ({
      "go.file": () => setQuickOpen(true),
      "go.command": () => setPaletteOpen(true),
      "go.symbol": () => setSymbolSearchOpen(true),
      "view.search": () => {
        setSidebarView("search");
        openView("sidebar");
      },
      "view.files": () => {
        setSidebarView("files");
        openView("sidebar");
      },
      "view.git": () => {
        setSidebarView("git");
        openView("sidebar");
      },
      "view.packages": () => {
        setSidebarView("packages");
        openView("sidebar");
      },
      "view.sidebar": () => toggleSidebar(),
      "view.panel": () => togglePanel(),
      "view.preview": () => togglePreview(),
      "view.zen": () => setZen((value) => !value),
      "file.closeTab": () => {
        const active = useOpenTabsStore.getState().activeRelPath;
        if (active) closeActiveTab(active);
      },
      "file.reopenTab": () => {
        const relPath = useOpenTabsStore.getState().takeClosed();
        if (relPath) editorSocket?.emit("readFile", { relPath });
      },
      "file.nextTab": () => {
        const next = selectNextMruTab(useOpenTabsStore.getState());
        if (next) useOpenTabsStore.getState().setActive(next.relPath);
      },
    }),
    [closeActiveTab, editorSocket, openView, toggleSidebar, togglePanel, togglePreview],
  );

  useHotkeys(
    useMemo(
      () =>
        Object.entries(bindings)
          .map(([commandId, chord]) => {
            const handler = handlers[commandId];
            return handler ? { ...chord, handler } : null;
          })
          // A binding with no handler is a chord for a command this page does
          // not own. Dropping it is right; silently binding it to nothing
          // would look like a broken feature.
          .filter((hotkey): hotkey is NonNullable<typeof hotkey> => hotkey !== null),
      [bindings, handlers],
    ),
  );

  useEffect(() => {
    if (!projectIdFromUrl || !hasSession) return;

    // Cleared on the way IN rather than on the way out. Doing it in the
    // cleanup emptied the tab list while the workspace subscription was still
    // listening, which wrote "nothing open" over the session that reload was
    // about to restore.
    if (openedProjectRef.current !== projectIdFromUrl) {
      openedProjectRef.current = projectIdFromUrl;
      closeAllTabs();
    }

    setProjectId(projectIdFromUrl);
    // The editor draws the git bars but has no idea which project it is in,
    // and threading it down as a prop would touch four components to reach
    // the one that needs it.
    useGitGutterStore.getState().setProject(projectIdFromUrl);

    const editorSocketConn: EditorSocket = io(
      `${import.meta.env.VITE_BACKEND_URL}/editor`,
      {
        query: { projectId: projectIdFromUrl },
        // Resolved per connection attempt rather than captured, so a reconnect
        // after the token rotated presents the current one. The handshake is
        // rejected without it; the server also verifies the caller owns this
        // project before registering any handler.
        auth: (cb: (data: Record<string, unknown>) => void) => {
          cb({ token: useAuthStore.getState().accessToken });
        },
      },
    );
    setEditorSocket(editorSocketConn);

    // Shared editing rides this same socket rather than opening a second one,
    // so there is one connection, one auth surface, and one reconnect path.
    const teardownCollab = installCollab(editorSocketConn);

    // Dev server state lives on the server and survives a page reload, so ask
    // for it rather than assuming "idle" on every mount.
    const run = useRunStore.getState();
    editorSocketConn.on("runState", run.setState);
    editorSocketConn.on("runOutput", ({ chunk }) => {
      useRunStore.getState().appendOutput(chunk);
    });
    editorSocketConn.on("runHistory", ({ chunks }) => {
      useRunStore.getState().replaceOutput(chunks);
    });
    editorSocketConn.on("previewReady", () => {
      useRunStore.getState().markPreviewReady();
    });
    editorSocketConn.on("previewChanged", () => {
      useRunStore.getState().markPreviewContentChanged();
    });
    editorSocketConn.on("previewError", ({ status }) => {
      useRunStore.getState().setPreviewError(status);
    });
    editorSocketConn.on("previewRecovered", () => {
      useRunStore.getState().setPreviewError(null);
    });
    editorSocketConn.on("containerStats", (stats) => {
      useRunStore.getState().setStats(stats);
    });
    // Gives Monaco's language service the project's other source files, so
    // go-to-definition can reach a symbol defined in a file that has never been
    // opened -- until now it only knew about files with a tab.
    editorSocketConn.on("projectSources", ({ files }) => {
      void loader.init().then((monaco) => {
        installProjectSources(monaco, files);
      });
    });
    editorSocketConn.emit("projectSources");

    editorSocketConn.emit("runSubscribe");

    // One sample a few seconds apart. Docker computes CPU from the delta since
    // the previous reading, so the first is always zero; polling is what makes
    // the number mean anything.
    const statsTimer = setInterval(() => {
      editorSocketConn.emit("statsRequest");
    }, 5000);
    editorSocketConn.emit("statsRequest");

    return () => {
      clearInterval(statsTimer);
      // The next project's files are different ones; keeping these would let a
      // lookup land in a file that is no longer there.
      clearProjectSources();
      teardownCollab();
      editorSocketConn.disconnect();
      setEditorSocket(null);
      useRunStore.getState().reset();
    };
  }, [
    projectIdFromUrl,
    hasSession,
    setProjectId,
    setEditorSocket,
    closeAllTabs,
  ]);

  return (
    <Flex
      vertical
      // Zen mode is a data attribute over the layout that already exists
      // rather than a second layout: the panes keep their state, so leaving
      // zen puts everything back exactly as it was — and, more importantly,
      // the terminal is never unmounted and its PTY never dies. Ctrl+Alt+K.
      data-zen={zen || undefined}
      className="rc-playground"
      style={{ height: "100vh", backgroundColor: "var(--rc-surface)" }}
    >
      <Flex
        align="center"
        justify="space-between"
        style={{
          padding: "8px 14px",
          backgroundColor: "var(--rc-surface-raised)",
          borderBottom: "1px solid var(--rc-border)",
          gap: 12,
        }}
      >
        <Flex align="center" gap={10} style={{ minWidth: 0 }}>
          <Button
            size="small"
            type="text"
            icon={<ArrowLeftOutlined />}
            style={{ color: "var(--rc-text-muted)" }}
            onClick={() => void navigate("/")}
          />
          <span
            aria-hidden
            style={{
              width: 1,
              height: 18,
              background: "var(--rc-border)",
              flex: "none",
            }}
          />
          <Typography.Text
            ellipsis
            style={{
              color: "var(--rc-text-muted)",
              fontSize: 12.5,
              fontFamily: "var(--rc-mono)",
            }}
          >
            {activeTab?.relPath ?? "No file open"}
          </Typography.Text>
        </Flex>

        <Flex align="center" gap={12}>
          <RunControl />

          <Flex align="center" gap={2}>
            <Tooltip title="Editor settings">
              <button
                className="rc-icon-button"
                aria-label="Editor settings"
                onClick={() => setSettingsOpen(true)}
              >
                <VscSettingsGear size={15} />
              </button>
            </Tooltip>
            <Tooltip title="Project settings">
              <button
                className="rc-icon-button"
                aria-label="Project settings"
                onClick={() => setEnvOpen(true)}
              >
                <VscKey size={15} />
              </button>
            </Tooltip>
            <Tooltip title="Toggle file tree (Ctrl+B)">
              <button
                className="rc-icon-button"
                data-on={showSidebar}
                aria-label="Toggle file tree"
                onClick={toggleSidebar}
              >
                <VscLayoutSidebarLeft size={15} />
              </button>
            </Tooltip>
            <Tooltip title="Toggle panel (Ctrl+`)">
              <button
                className="rc-icon-button"
                data-on={showPanel}
                aria-label="Toggle panel"
                onClick={togglePanel}
              >
                <VscLayoutPanel size={15} />
              </button>
            </Tooltip>
            <Tooltip title="Toggle preview (Ctrl+J)">
              <button
                className="rc-icon-button"
                data-on={showPreview}
                aria-label="Toggle preview"
                onClick={togglePreview}
              >
                {showPreview ? (
                  <EyeInvisibleOutlined />
                ) : (
                  <EyeOutlined />
                )}
              </button>
            </Tooltip>
          </Flex>
        </Flex>
      </Flex>


      {/* The containing block for the drawers: everything between the topbar
          and the status bar, so a drawer covers the workspace and leaves the
          app's own chrome reachable. */}
      <div className="rc-playground-body" style={{ flex: 1, minHeight: 0 }}>
        {/* Only below the breakpoint, and only with something to dismiss. */}
        {narrow && (showSidebar || showPanel || showPreview) && (
          <button
            type="button"
            className="rc-scrim"
            aria-label="Close the open panel"
            onClick={() => {
              setViews({ sidebar: false, panel: false, preview: false });
            }}
          />
        )}

        <SplitPane
          direction="horizontal"
          defaultSize={restored?.sidebarWidth ?? 260}
          minSize={180}
          maxSize={520}
          showFirst={showSidebar}
          firstClassName="rc-drawer rc-drawer-left"
          onResizeEnd={(size) => remember({ sidebarWidth: size })}
          first={
            <div
              style={{
                height: "100%",
                display: "flex",
                backgroundColor: "var(--rc-surface-sunken)",
              }}
            >
              {/* Activity rail. Both views stay mounted: search holds a query
                  and its results, and losing them on every glance at the tree
                  would make it useless. */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  padding: "8px 4px",
                  borderRight: "1px solid var(--rc-border)",
                  flex: "none",
                }}
              >
                <Tooltip title="Explorer" placement="right">
                  <button
                    className="rc-icon-button"
                    data-on={sidebarView === "files"}
                    aria-label="Explorer"
                    onClick={() => setSidebarView("files")}
                  >
                    <VscFiles size={16} />
                  </button>
                </Tooltip>
                <Tooltip title="Search (Ctrl+Shift+F)" placement="right">
                  <button
                    className="rc-icon-button"
                    data-on={sidebarView === "search"}
                    aria-label="Search"
                    onClick={() => setSidebarView("search")}
                  >
                    <VscSearch size={16} />
                  </button>
                </Tooltip>
                <Tooltip title="Source control" placement="right">
                  <button
                    className="rc-icon-button"
                    data-on={sidebarView === "git"}
                    aria-label="Source control"
                    onClick={() => setSidebarView("git")}
                  >
                    <VscSourceControl size={16} />
                  </button>
                </Tooltip>
                <Tooltip title="Packages" placement="right">
                  <button
                    className="rc-icon-button"
                    data-on={sidebarView === "packages"}
                    aria-label="Packages"
                    onClick={() => setSidebarView("packages")}
                  >
                    <VscPackage size={16} />
                  </button>
                </Tooltip>
                <Tooltip title="Deploy" placement="right">
                  <button
                    className="rc-icon-button"
                    data-on={sidebarView === "deploy"}
                    aria-label="Deploy"
                    onClick={() => setSidebarView("deploy")}
                  >
                    <VscCloudUpload size={16} />
                  </button>
                </Tooltip>
                <Tooltip title="Outline" placement="right">
                  <button
                    className="rc-icon-button"
                    data-on={sidebarView === "outline"}
                    aria-label="Outline"
                    onClick={() => setSidebarView("outline")}
                  >
                    <VscSymbolClass size={16} />
                  </button>
                </Tooltip>
                <Tooltip title="Database" placement="right">
                  <button
                    className="rc-icon-button"
                    data-on={sidebarView === "database"}
                    aria-label="Database"
                    onClick={() => setSidebarView("database")}
                  >
                    <VscDatabase size={16} />
                  </button>
                </Tooltip>
                {aiModel && (
                  <Tooltip title="Assistant" placement="right">
                    <button
                      className="rc-icon-button"
                      data-on={sidebarView === "ai"}
                      aria-label="Assistant"
                      onClick={() => setSidebarView("ai")}
                    >
                      <VscSparkle size={16} />
                    </button>
                  </Tooltip>
                )}
              </div>

              <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    display: sidebarView === "files" ? "block" : "none",
                    overflow: "auto",
                  }}
                >
                  <ErrorBoundary label="The file tree">
                    <TreeStructure />
                  </ErrorBoundary>
                </div>

                <div
                  style={{
                    height: "100%",
                    display: sidebarView === "search" ? "block" : "none",
                  }}
                >
                  <ErrorBoundary label="Search">
                    <SearchPanel />
                  </ErrorBoundary>
                </div>

                <div
                  style={{
                    height: "100%",
                    display: sidebarView === "git" ? "block" : "none",
                  }}
                >
                  <ErrorBoundary label="Source control">
                    {projectIdFromUrl && (
                      <SourceControlPanel
                        projectId={projectIdFromUrl}
                        canWrite={canEdit}
                        isOwner={accessLevel === "owner"}
                      />
                    )}
                  </ErrorBoundary>
                </div>

{/* Mounted only while it is showing, unlike search and the
                    assistant: it holds nothing worth keeping across a glance
                    at another view, and mounting it re-reads the manifest. */}
                {sidebarView === "packages" && projectIdFromUrl && (
                  <div style={{ height: "100%" }}>
                    <ErrorBoundary label="Packages">
                      <PackagesPanel
                        projectId={projectIdFromUrl}
                        canWrite={canEdit}
                      />
                    </ErrorBoundary>
                  </div>
                )}

                {/* Mounted only while it is showing, for the same reason the
                    packages pane is: opening it re-reads the deployment, and
                    that is the whole point of opening it. */}
                {sidebarView === "deploy" && projectIdFromUrl && (
                  <div style={{ height: "100%" }}>
                    <ErrorBoundary label="Deploy">
                      <DeployPanel
                        projectId={projectIdFromUrl}
                        isOwner={accessLevel === "owner"}
                      />
                    </ErrorBoundary>
                  </div>
                )}

                {sidebarView === "outline" && (
                  <div style={{ height: "100%" }}>
                    <ErrorBoundary label="Outline">
                      <OutlinePanel />
                    </ErrorBoundary>
                  </div>
                )}

                {sidebarView === "database" && projectIdFromUrl && (
                  <div style={{ height: "100%" }}>
                    <ErrorBoundary label="Database">
                      <DatabasePanel
                        projectId={projectIdFromUrl}
                        isOwner={accessLevel === "owner"}
                      />
                    </ErrorBoundary>
                  </div>
                )}

                                {/* Kept mounted alongside the others so a glance at the file
                    tree does not throw away the conversation. */}
                <div
                  style={{
                    height: "100%",
                    display: sidebarView === "ai" ? "block" : "none",
                  }}
                >
                  <ErrorBoundary label="The assistant">
                    {projectIdFromUrl && aiModel && (
                      <AiPanel projectId={projectIdFromUrl} model={aiModel} />
                    )}
                  </ErrorBoundary>
                </div>
              </div>
            </div>
          }
          second={
            <SplitPane
              direction="horizontal"
              defaultSize={restored?.previewWidth ?? 700}
              minSize={320}
              showSecond={showPreview}
              secondClassName="rc-drawer rc-drawer-full"
              onResizeEnd={(size) => remember({ previewWidth: size })}
              first={
                <SplitPane
                  direction="vertical"
                  defaultSize={restored?.panelHeight ?? 420}
                  minSize={120}
                  showSecond={showPanel}
                  secondClassName="rc-drawer rc-drawer-bottom"
                  onResizeEnd={(size) => remember({ panelHeight: size })}
                  first={
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        height: "100%",
                      }}
                    >
                      <EditorTabs />
                      <Breadcrumbs />
                      <div style={{ flex: 1, minHeight: 0 }}>
                        {/* Two panes over one tab list and one write queue, so
                            the same file open in both stays in step. */}
                        <SplitPane
                          direction="horizontal"
                          defaultSize={restored?.editorSplitWidth ?? 480}
                          minSize={240}
                          showSecond={splitOpen}
                          onResizeEnd={(size) =>
                            remember({ editorSplitWidth: size })
                          }
                          first={
                            <ErrorBoundary label="The editor">
                              <EditorComponent pane="primary" />
                            </ErrorBoundary>
                          }
                          second={
                            <ErrorBoundary label="The second editor pane">
                              <EditorComponent pane="secondary" />
                            </ErrorBoundary>
                          }
                        />
                      </div>
                    </div>
                  }
                  second={
                    projectIdFromUrl ? (
                      <ErrorBoundary label="The terminal panel">
                        <BottomPanel projectId={projectIdFromUrl} />
                      </ErrorBoundary>
                    ) : null
                  }
                />
              }
              second={
                projectIdFromUrl ? (
                  <ErrorBoundary label="The preview">
                    <Browser projectId={projectIdFromUrl} />
                  </ErrorBoundary>
                ) : null
              }
            />
          }
        />
      </div>

      {messageHolder}

      {/* One bar, spanning the app, below every pane. It used to be rendered
          inside the editor, which gave a split two of them and left a project
          with no open file with none. */}
      <StatusBar />

      <QuickOpen open={quickOpen} onClose={() => setQuickOpen(false)} />
      <SymbolSearch
        open={symbolSearchOpen}
        onClose={() => setSymbolSearchOpen(false)}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />

      <EditorSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

      {projectIdFromUrl && (
        <EnvVarsDialog
          projectId={projectIdFromUrl}
          open={envOpen}
          onClose={() => setEnvOpen(false)}
        />
      )}
    </Flex>
  );
};
