import { useQuery } from "@tanstack/react-query";
import { Alert, Empty, Progress, Typography } from "antd";
import type { MachineStatus } from "@replit-clone/shared";
import { getMachineStatusApi } from "../../../apis/projects.ts";

/** Is this machine full?
 *
 *  The question a three-container cap makes an operator ask most often, and
 *  the one no screen could answer: `/metrics` is the only endpoint in the
 *  product with no client, which is defensible for a scrape target and left
 *  the counters visible only to somebody who curls the port.
 */
function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function duration(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

export const MachinePanel = () => {
  const { data, isLoading, error } = useQuery<MachineStatus>({
    queryKey: ["machine"],
    queryFn: getMachineStatusApi,
    // A number that is stale by a minute answers "is this machine full" with
    // last minute's answer, which is the wrong one at exactly the moment the
    // question is being asked.
    refetchInterval: 15_000,
    retry: false,
  });

  if (error) {
    return <Empty description="Could not load the machine's status." />;
  }

  if (isLoading || !data) {
    return (
      <div aria-label="Loading machine status" style={{ display: "grid", gap: 10 }}>
        <span className="rc-skeleton" style={{ height: 40 }} aria-hidden="true" />
      </div>
    );
  }

  const full = data.containersRunning >= data.containerLimit;
  const counters = Object.entries(data.counters).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return (
    <>
      <div className="rc-card" style={{ padding: 12, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <Typography.Text strong>Containers</Typography.Text>
          <Typography.Text style={{ color: "var(--rc-text-subtle)" }}>
            {data.containersRunning} of {data.containerLimit}
          </Typography.Text>
        </div>
        <Progress
          percent={Math.round(
            (data.containersRunning / Math.max(1, data.containerLimit)) * 100,
          )}
          status={full ? "exception" : "active"}
          showInfo={false}
          aria-label="Containers"
        />
        <Typography.Text style={{ color: "var(--rc-text-subtle)", fontSize: 12 }}>
          {full
            ? "At capacity. The next project to start will be refused."
            : "Room to start another."}{" "}
          Up {duration(data.uptimeSeconds)}, {mb(data.memoryBytes)} resident.
        </Typography.Text>
      </div>

      {/* This one is not a gauge but a defect report. A scheduled run should
          leave RUNNING; a count that only climbs is the signature of a
          restart that stranded one, which nothing else in the product shows —
          the job then reports SKIPPED forever and says nothing, on purpose. */}
      {data.runningJobRuns > 0 && (
        <Alert
          type={data.runningJobRuns > 2 ? "warning" : "info"}
          showIcon
          style={{ marginBottom: 12 }}
          message={`${String(data.runningJobRuns)} scheduled ${
            data.runningJobRuns === 1 ? "run is" : "runs are"
          } in progress`}
          description="If this number does not come back down, a restart stranded a run: the job will report SKIPPED from then on and nobody will be told."
        />
      )}

      <Typography.Title level={5}>Counters</Typography.Title>
      {counters.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Nothing has happened since this server started."
        />
      ) : (
        <ul
          aria-label="Counters"
          style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}
        >
          {counters.map(([name, value]) => (
            <li
              key={name}
              style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}
            >
              <Typography.Text code>{name}</Typography.Text>
              <Typography.Text style={{ color: "var(--rc-text-subtle)" }}>
                {value}
              </Typography.Text>
            </li>
          ))}
        </ul>
      )}

      <Typography.Paragraph
        style={{ color: "var(--rc-text-subtle)", fontSize: 12, marginTop: 10 }}
      >
        Counters are held in memory and reset when the server restarts. They
        describe this process, not this deployment&apos;s history.
      </Typography.Paragraph>
    </>
  );
};

export default MachinePanel;
