import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, InputNumber, Typography } from "antd";
import {
  getWorkspaceSizeApi,
  setWorkspaceSizeApi,
  type WorkspaceSize,
} from "../../../apis/projects.ts";

/** How much of the machine this one workspace gets.
 *
 *  plan.md §12.1. Every container was sized from one deployment-wide pair of
 *  numbers, so the Rust workspace that wants 8 GB and the eleven that idle at
 *  512 MB were all the same size — which is most of the reason to keep a
 *  workspace on a server rather than on the laptop in front of you.
 *
 *  **The budget is shown, not just the size.** A field containing "2048" is
 *  not something anybody can act on; the question this is opened to answer is
 *  "can I give it more", and that needs what the host has and what the other
 *  running workspaces already hold. Showing only the refusal, after the fact,
 *  is the mistake §2.22 is about — a limit somebody discovers by hitting it.
 */
export function WorkspaceSizeSection({
  projectId,
  enabled,
}: {
  projectId: string;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const [memory, setMemory] = useState<number | null>(null);
  const [cpus, setCpus] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const { data, isLoading } = useQuery<WorkspaceSize>({
    queryKey: ["workspaceSize", projectId],
    queryFn: () => getWorkspaceSizeApi(projectId),
    enabled,
    retry: false,
  });

  useEffect(() => {
    if (!data) return;
    // Empty rather than pre-filled with the default, so the boxes say "using
    // the default" by being empty and clearing one is how you go back.
    setMemory(data.custom ? data.memoryMb : null);
    setCpus(data.custom ? data.cpus : null);
  }, [data]);

  const save = useMutation({
    mutationFn: () => setWorkspaceSizeApi(projectId, { memoryMb: memory, cpus }),
    onSuccess: () => {
      setProblem(null);
      void queryClient.invalidateQueries({ queryKey: ["workspaceSize", projectId] });
    },
    onError: (error: unknown) => {
      // The server's message names both numbers — what the host has and what
      // is already committed — and that is the whole value of it, so it is
      // shown rather than replaced with something generic.
      const message =
        (error as { response?: { data?: { message?: string } } }).response?.data
          ?.message ?? "Could not save that size.";
      setProblem(message);
    },
  });

  if (isLoading || !data) return null;

  const free = Math.max(0, data.budgetMb - data.committedMb);

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, marginBottom: 6 }}>Workspace size</div>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <InputNumber
          aria-label="Memory in MB"
          placeholder={String(data.defaultMemoryMb)}
          value={memory}
          min={data.minMemoryMb}
          step={512}
          style={{ width: 150 }}
          onChange={setMemory}
        />
        <span style={{ fontSize: 12, color: "var(--rc-text-subtle)" }}>MB</span>
        <InputNumber
          aria-label="CPUs"
          placeholder={String(data.defaultCpus)}
          value={cpus}
          min={0.25}
          step={0.5}
          style={{ width: 150 }}
          onChange={setCpus}
        />
        <span style={{ fontSize: 12, color: "var(--rc-text-subtle)" }}>CPUs</span>
        <Button
          onClick={() => {
            save.mutate();
          }}
          loading={save.isPending}
        >
          Save size
        </Button>
      </div>

      <div style={{ marginTop: 6, fontSize: 12, color: "var(--rc-text-subtle)" }}>
        {data.custom
          ? `This workspace: ${String(data.memoryMb)} MB, ${String(data.cpus)} CPUs.`
          : `Using the deployment's default: ${String(data.defaultMemoryMb)} MB, ` +
            `${String(data.defaultCpus)} CPUs.`}{" "}
        {/* What somebody needs to decide a number, rather than to discover
            afterwards that theirs was too big. */}
        {`This host has ${String(data.budgetMb)} MB for workspaces and ` +
          `${String(free)} MB of it is free right now.`}{" "}
        Clear a box to go back to the default.
      </div>

      {problem && (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 8 }}
          message={problem}
        />
      )}

      {/* Said once, here, rather than discovered when the numbers do not
          change: Docker will move a running container's cgroup, but the
          process inside has already read /proc/meminfo and sized its heap. */}
      <Typography.Paragraph
        style={{ marginTop: 6, marginBottom: 0, fontSize: 12, color: "var(--rc-text-subtle)" }}
      >
        A new size takes effect the next time this workspace starts.
      </Typography.Paragraph>
    </div>
  );
}

export default WorkspaceSizeSection;
