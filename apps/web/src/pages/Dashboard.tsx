import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dropdown,
  Empty,
  Input,
  Modal,
  Segmented,
  Select,
  Tooltip,
  Typography,
  message,
} from "antd";
import {
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  MoreOutlined,
  ShareAltOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  PlusOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import {
  VscFolder,
  VscGithub,
  VscListFlat,
  VscTerminal,
  VscGrabber,
} from "react-icons/vsc";
import type { Project } from "@replit-clone/shared";
import {
  createProjectApi,
  deleteProjectApi,
  duplicateProjectApi,
  listProjectsApi,
  listTemplatesApi,
  projectExportUrl,
  renameProjectApi,
} from "../apis/projects.ts";
import { TemplatePicker } from "../components/molecules/TemplatePicker/TemplatePicker.tsx";
import { NotificationBell } from "../components/molecules/NotificationBell/NotificationBell.tsx";
import { AccountDialog } from "../components/organisms/AccountDialog/AccountDialog.tsx";
import { useAuth } from "../hooks/useAuth.ts";
import { ShareDialog } from "../components/organisms/ShareDialog/ShareDialog.tsx";
import { ModerationDialog } from "../components/organisms/ModerationDialog/ModerationDialog.tsx";
import { GithubConnectionCard } from "../components/organisms/GithubConnectionCard/GithubConnectionCard.tsx";
import { ImportRepoDialog } from "../components/organisms/ImportRepoDialog/ImportRepoDialog.tsx";
import { ExploreSection } from "../components/organisms/ExploreSection/ExploreSection.tsx";

/** Relative time for the card footer -- "3 days ago" reads better than a date
 *  when you're scanning a list of things you made recently. */
function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, secondsPerUnit] of units) {
    if (seconds >= secondsPerUnit) {
      return formatter.format(-Math.floor(seconds / secondsPerUnit), unit);
    }
  }
  return "just now";
}

type SortKey = "recent" | "created" | "name";

/** Everything a project row offers, in both layouts.
 *
 *  Extracted when the list view arrived, not before: two copies of a menu
 *  whose entries depend on ownership is exactly the pair that drifts, and the
 *  half that drifts silently is the one nobody is looking at.
 */
function ProjectActions({
  project,
  isOwner,
  onShare,
  onRename,
  onDuplicate,
  onDelete,
  onModeration,
}: {
  project: Project;
  isOwner: boolean;
  onShare: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onModeration: () => void;
}) {
  return (
    // Stop propagation so a menu click doesn't also open the project behind
    // it. True of a card and of a row alike.
    <div
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Dropdown
        trigger={["click"]}
        menu={{
          items: [
            // A project shared with you is not yours to rename, share on, or
            // delete -- the menu says so by omission rather than by offering
            // something that will fail.
            ...(isOwner
              ? [
                  {
                    key: "share",
                    icon: <ShareAltOutlined />,
                    label: "Share",
                    onClick: onShare,
                  },
                  {
                    key: "rename",
                    icon: <EditOutlined />,
                    label: "Rename",
                    onClick: onRename,
                  },
                ]
              : []),
            // Refused by the server once a project is taken down, because a
            // copy would hold the same files with none of the takedown. The
            // menu says so by omission rather than offering something that
            // will fail.
            ...(project.takenDownAt
              ? []
              : [
                  {
                    key: "duplicate",
                    icon: <CopyOutlined />,
                    label: "Duplicate",
                    onClick: onDuplicate,
                  },
                ]),
            {
              key: "export",
              icon: <DownloadOutlined />,
              label: "Download as zip",
              // A real navigation, so the browser honours the
              // Content-Disposition filename.
              onClick: () => {
                window.location.assign(projectExportUrl(project.id));
              },
            },
            // Offered whether or not anything was taken down. The trail holds
            // dismissals as well, and "reported and cleared" is a fact about
            // the project its owner is entitled to read.
            ...(isOwner
              ? [
                  {
                    key: "moderation",
                    icon: <SafetyCertificateOutlined />,
                    label: project.takenDownAt ? "Taken down" : "Moderation",
                    danger: project.takenDownAt !== null,
                    onClick: onModeration,
                  },
                  { type: "divider" as const },
                  {
                    key: "delete",
                    icon: <DeleteOutlined />,
                    label: "Delete",
                    danger: true,
                    onClick: onDelete,
                  },
                ]
              : []),
          ],
        }}
      >
        <Button
          type="text"
          size="small"
          icon={<MoreOutlined />}
          aria-label={`Actions for ${project.name}`}
        />
      </Dropdown>
    </div>
  );
}

/** When a project was last touched, phrased as the thing worth knowing.
 *
 *  `lastActiveAt` is written on every connect; "created" is the least useful
 *  fact about a project you are trying to find again. */
function lastTouched(project: Project): string {
  return project.lastActiveAt
    ? `Opened ${relativeTime(project.lastActiveAt)}`
    : `Created ${relativeTime(project.createdAt)}`;
}


type ViewMode = "grid" | "list";

/** Where the chosen layout is remembered.
 *
 *  A per-viewer convenience and nothing more: it belongs to this browser, it
 *  is worth nothing to anybody else, and it must never be the reason the page
 *  fails to render. Hence the try/catch on both sides -- a private window, a
 *  browser set to block site data, or a thumbnail capture can each make the
 *  accessor itself throw rather than merely return null. */
const VIEW_STORAGE_KEY = "rc.dashboard.view";

function storedView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

function rememberView(view: ViewMode): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Nothing is lost but the preference, and only until the next choice.
  }
}

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Last opened" },
  { value: "created", label: "Newest" },
  { value: "name", label: "Name" },
];

/** Most recent activity first, falling back to creation for a project that has
 *  never been opened. */
function sortProjects(projects: Project[], by: SortKey): Project[] {
  const sorted = [...projects];

  if (by === "name") {
    sorted.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  } else if (by === "created") {
    sorted.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  } else {
    const activity = (project: Project) =>
      new Date(project.lastActiveAt ?? project.createdAt).getTime();
    sorted.sort((a, b) => activity(b) - activity(a));
  }

  return sorted;
}

export const Dashboard = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, logout } = useAuth();
  // The quota warning links here. A notification that pointed at the dashboard
  // and left the reader to find the button would be telling them where to look
  // rather than showing them.
  const [searchParams, setSearchParams] = useSearchParams();
  const [accountOpen, setAccountOpen] = useState(
    () => searchParams.get("view") === "account",
  );
  const [messageApi, contextHolder] = message.useMessage();

  const [isCreating, setIsCreating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<string | null>(null);

  /** Filter and ordering. The list was created-descending with no way to find
   *  anything, which stops being usable at about a dozen projects. */
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("recent");
  /** Cards or a list. Remembered per browser: past roughly thirty projects a
   *  compact list beats scrolling a grid, and which side of that line somebody
   *  is on does not change between visits. */
  const [view, setView] = useState<ViewMode>(storedView);

  /** The project being renamed, and the name being typed for it. */
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [githubOpen, setGithubOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [sharing, setSharing] = useState<Project | null>(null);
  const [moderating, setModerating] = useState<Project | null>(null);

  const { data: projects, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: listProjectsApi,
  });

  const { data: templates } = useQuery({
    queryKey: ["templates"],
    queryFn: listTemplatesApi,
    staleTime: Infinity,
  });

  const refreshProjects = () =>
    queryClient.invalidateQueries({ queryKey: ["projects"] });

  const deleteMutation = useMutation({
    mutationFn: deleteProjectApi,
    onSuccess: refreshProjects,
    onError: () => {
      // Silence here used to mean a card that simply stayed put.
      void messageApi.error("Could not delete the project.");
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, next }: { id: string; next: string }) =>
      renameProjectApi(id, next),
    onSuccess: async () => {
      setRenaming(null);
      await refreshProjects();
    },
    onError: () => {
      void messageApi.error("Could not rename the project.");
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: (id: string) => duplicateProjectApi(id),
    onSuccess: async (project) => {
      await refreshProjects();
      void messageApi.success(`Created "${project.name}".`);
    },
    onError: () => {
      void messageApi.error("Could not duplicate the project.");
    },
  });

  const visibleProjects = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const matching = trimmed
      ? (projects ?? []).filter(
          (project) =>
            project.name.toLowerCase().includes(trimmed) ||
            project.template.toLowerCase().includes(trimmed),
        )
      : (projects ?? []);

    return sortProjects(matching, sortBy);
  }, [projects, query, sortBy]);

  const selectedTemplate = template ?? templates?.[0]?.id ?? "react-vite";
  const activeTemplate = templates?.find((t) => t.id === selectedTemplate);

  async function handleCreate() {
    setCreating(true);
    try {
      const project = await createProjectApi(name || undefined, selectedTemplate);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      void navigate(`/project/${project.id}`);
    } catch {
      void messageApi.error("Could not create the project. Check the server logs.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="rc-aurora" style={{ minHeight: "100vh" }}>
      {contextHolder}

      <header className="rc-topbar">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="rc-logo">&lt;/&gt;</span>
          <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: -0.2 }}>
            Playground
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Typography.Text
            style={{ color: "var(--rc-text-subtle)", fontSize: 13 }}
          >
            {user?.email}
          </Typography.Text>
          {/* Offered only to operators, and only as a convenience: the route
              itself is not hidden and the server checks the allowlist on every
              request. Hiding a link is not access control, and treating it as
              though it were is how a check ends up existing only here. */}
          {user?.isAdmin && (
            <Button onClick={() => void navigate("/admin/reports")}>
              Reports
            </Button>
          )}
          {/* The quota was enforced from the first release and shown from
              none of them: the only way to learn where you stood was to be
              refused. */}
          <Button onClick={() => setAccountOpen(true)}>Plan</Button>
          <NotificationBell />
          <Button
            icon={<VscGithub />}
            onClick={() => setGithubOpen(true)}
          >
            GitHub
          </Button>
          <Button onClick={() => void logout()}>Sign out</Button>
        </div>
      </header>

      <AccountDialog
        open={accountOpen}
        onClose={() => {
          setAccountOpen(false);
          // Otherwise the query outlives the dialog and reopens it on reload.
          if (searchParams.has("view")) {
            searchParams.delete("view");
            setSearchParams(searchParams, { replace: true });
          }
        }}
      />

      <main className="rc-page">
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 28,
          }}
        >
          <div>
            <h1
              style={{
                fontSize: 30,
                fontWeight: 700,
                letterSpacing: -0.8,
                marginBottom: 6,
              }}
            >
              Your projects
            </h1>
            <p style={{ color: "var(--rc-text-subtle)", fontSize: 14 }}>
              {projects?.length
                ? query.trim()
                  ? `${visibleProjects.length} of ${projects.length} shown`
                  : `${projects.length} playground${projects.length === 1 ? "" : "s"}`
                : "Nothing here yet — create your first playground."}
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Input
              allowClear
              placeholder="Search projects"
              prefix={<SearchOutlined style={{ color: "var(--rc-text-subtle)" }} />}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              style={{ width: 220 }}
            />

            <Select
              value={sortBy}
              onChange={setSortBy}
              options={SORT_OPTIONS}
              style={{ width: 150 }}
              aria-label="Sort projects"
            />

            <Segmented
              value={view}
              onChange={(value) => {
                const next = value as ViewMode;
                setView(next);
                rememberView(next);
              }}
              aria-label="Project layout"
              options={[
                {
                  value: "grid",
                  label: (
                    <Tooltip title="Cards">
                      <span
                        aria-label="Card view"
                        style={{ display: "flex", padding: "0 2px" }}
                      >
                        <VscGrabber size={14} />
                      </span>
                    </Tooltip>
                  ),
                },
                {
                  value: "list",
                  label: (
                    <Tooltip title="List">
                      <span
                        aria-label="List view"
                        style={{ display: "flex", padding: "0 2px" }}
                      >
                        <VscListFlat size={14} />
                      </span>
                    </Tooltip>
                  ),
                },
              ]}
            />

            <Button
              size="large"
              icon={<VscGithub />}
              onClick={() => setImportOpen(true)}
            >
              Import repo
            </Button>

            <Button
              type="primary"
              size="large"
              icon={<PlusOutlined />}
              onClick={() => setIsCreating(true)}
            >
              New playground
            </Button>
          </div>
        </div>

        {isLoading ? (
          // Card-shaped placeholders rather than a centred spinner: the grid
          // keeps the shape it is about to have, so the page does not jump
          // when the projects land. Six is a plausible first screen; fewer
          // would jump the other way.
          <div
            className={view === "grid" ? "rc-project-grid" : "rc-project-list"}
            aria-label="Loading projects"
          >
            {Array.from({ length: 6 }, (_, index) => (
              <div
                key={index}
                className={
                  view === "grid" ? "rc-skeleton-card" : "rc-skeleton-row"
                }
                aria-hidden="true"
              >
                <span className="rc-skeleton" style={{ width: "58%", height: 15 }} />
                <span className="rc-skeleton" style={{ width: "84%", height: 11 }} />
                <span className="rc-skeleton" style={{ width: "40%", height: 11 }} />
              </div>
            ))}
          </div>
        ) : visibleProjects.length > 0 ? (
          <div
            className={view === "grid" ? "rc-project-grid" : "rc-project-list"}
          >
            {visibleProjects.map((project) => {
              const isOwner = project.ownerId === user?.id;
              const open = () => void navigate(`/project/${project.id}`);
              const actions = (
                <ProjectActions
                  project={project}
                  isOwner={isOwner}
                  onShare={() => setSharing(project)}
                  onRename={() => {
                    setRenaming(project);
                    setRenameValue(project.name);
                  }}
                  onDuplicate={() => duplicateMutation.mutate(project.id)}
                  onDelete={() => setDeleting(project)}
                  onModeration={() => setModerating(project)}
                />
              );

              // Both layouts are the same row of facts at different widths, so
              // they share the click target, the keyboard handling and the
              // menu. Only the arrangement differs.
              const activate = (event: React.KeyboardEvent) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  open();
                }
              };

              if (view === "list") {
                return (
                  <div
                    key={project.id}
                    className="rc-project-row"
                    role="button"
                    tabIndex={0}
                    onClick={open}
                    onKeyDown={activate}
                  >
                    <span className="rc-project-row-name" title={project.name}>
                      {project.name}
                    </span>
                    <span className="rc-badge">{project.template}</span>
                    {project.takenDownAt && (
                      <span
                        className="rc-badge"
                        title="A moderator took this project down after a report"
                        style={{ color: "var(--rc-danger, #ff4d4f)" }}
                      >
                        Taken down
                      </span>
                    )}
                    {!isOwner && (
                      <span
                        className="rc-badge"
                        title="Shared with you"
                        style={{ display: "flex", alignItems: "center", gap: 4 }}
                      >
                        <TeamOutlined /> Shared
                      </span>
                    )}
                    <span className="rc-project-row-when">
                      {lastTouched(project)}
                    </span>
                    {actions}
                  </div>
                );
              }

              return (
                <div
                  key={project.id}
                  className="rc-card"
                  role="button"
                  tabIndex={0}
                  onClick={open}
                  onKeyDown={activate}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span className="rc-badge">{project.template}</span>
                      {project.takenDownAt && (
                        <span
                          className="rc-badge"
                          title="A moderator took this project down after a report"
                          style={{ color: "var(--rc-danger, #ff4d4f)" }}
                        >
                          Taken down
                        </span>
                      )}
                      {!isOwner && (
                        <span
                          className="rc-badge"
                          title="Shared with you"
                          style={{ display: "flex", alignItems: "center", gap: 4 }}
                        >
                          <TeamOutlined /> Shared
                        </span>
                      )}
                    </span>

                    {actions}
                  </div>

                  <div
                    style={{
                      fontSize: 16,
                      fontWeight: 600,
                      letterSpacing: -0.2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {project.name}
                  </div>

                  <div style={{ color: "var(--rc-text-subtle)", fontSize: 12.5 }}>
                    {lastTouched(project)}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rc-panel" style={{ padding: "64px 24px" }}>
            <Empty
              description={
                <span style={{ color: "var(--rc-text-subtle)" }}>
                  {query.trim()
                    ? `Nothing matches "${query.trim()}"`
                    : "No projects yet"}
                </span>
              }
            >
              {query.trim() ? (
                <Button onClick={() => setQuery("")}>Clear search</Button>
              ) : (
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => setIsCreating(true)}
                >
                  Create one
                </Button>
              )}
            </Empty>
          </div>
        )}

        {/* Other people's published work, and a Fork button. Below your own
            projects rather than beside them: this is somewhere to go when you
            have finished with what you came for. */}
        <ExploreSection />
      </main>

      <GithubConnectionCard
        open={githubOpen}
        onClose={() => setGithubOpen(false)}
      />

      <ImportRepoDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        // Straight into the imported project: importing is not something
        // anyone does in order to look at a dashboard.
        onImported={(project) => {
          setImportOpen(false);
          void navigate(`/project/${project.id}`);
        }}
        onConnect={() => {
          setImportOpen(false);
          setGithubOpen(true);
        }}
      />

      {sharing && (
        <ShareDialog
          projectId={sharing.id}
          projectName={sharing.name}
          isPublic={sharing.visibility === "PUBLIC"}
          // Kept locally as well as refetched, so the switch does not flick
          // back to its old position while the list query is in flight.
          onVisibilityChange={(isPublic) => {
            setSharing((current) =>
              current
                ? { ...current, visibility: isPublic ? "PUBLIC" : "PRIVATE" }
                : current,
            );
          }}
          open
          onClose={() => setSharing(null)}
        />
      )}

      {moderating && (
        <ModerationDialog
          projectId={moderating.id}
          projectName={moderating.name}
          takenDownAt={moderating.takenDownAt}
          open
          onClose={() => setModerating(null)}
        />
      )}

      <Modal
        open={renaming !== null}
        title="Rename project"
        okText="Rename"
        confirmLoading={renameMutation.isPending}
        okButtonProps={{ disabled: !renameValue.trim() }}
        onOk={() => {
          if (renaming) {
            renameMutation.mutate({ id: renaming.id, next: renameValue });
          }
        }}
        onCancel={() => setRenaming(null)}
        destroyOnHidden
      >
        <Input
          autoFocus
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onPressEnter={() => {
            if (renaming && renameValue.trim()) {
              renameMutation.mutate({ id: renaming.id, next: renameValue });
            }
          }}
        />
      </Modal>

      <Modal
        open={deleting !== null}
        title="Delete this project?"
        okText="Delete"
        okButtonProps={{ danger: true }}
        confirmLoading={deleteMutation.isPending}
        onOk={() => {
          if (deleting) deleteMutation.mutate(deleting.id);
          setDeleting(null);
        }}
        onCancel={() => setDeleting(null)}
        destroyOnHidden
      >
        <span style={{ color: "var(--rc-text-muted)" }}>
          <b>{deleting?.name}</b> and its files are removed from disk
          permanently. Download it first if you want to keep a copy.
        </span>
      </Modal>

      <Modal
        open={isCreating}
        // Two columns of cards need the room; at 520 they would wrap to one.
        width={680}
        centered
        title={
          <div className="rc-dialog-head">
            <span className="rc-logo">&lt;/&gt;</span>
            <span>
              <div className="rc-dialog-title">New playground</div>
              <div className="rc-dialog-subtitle">
                Pick a starting point — the toolchain is already installed.
              </div>
            </span>
          </div>
        }
        okText="Create"
        confirmLoading={creating}
        onOk={() => void handleCreate()}
        onCancel={() => setIsCreating(false)}
        destroyOnHidden
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            marginTop: 20,
          }}
        >
          <Input
            autoFocus
            size="large"
            prefix={
              <VscFolder
                size={15}
                style={{ color: "var(--rc-text-subtle)", marginRight: 4 }}
              />
            }
            placeholder="Project name (optional)"
            value={name}
            onChange={(event) => setName(event.target.value)}
            // Enter is the whole dialog's confirm, not just the field's.
            onPressEnter={() => void handleCreate()}
          />

          {templates && (
            <TemplatePicker
              templates={templates}
              value={selectedTemplate}
              onChange={setTemplate}
            />
          )}

          {activeTemplate && (
            <div className="rc-run-hint">
              <VscTerminal
                size={13}
                style={{ flex: "none", color: "var(--rc-accent)" }}
              />
              <span style={{ flex: "none" }}>Starts with</span>
              <code>{activeTemplate.startCommand}</code>
              <span
                style={{ marginLeft: "auto", flex: "none", whiteSpace: "nowrap" }}
              >
                port {activeTemplate.devPort}
              </span>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
};
