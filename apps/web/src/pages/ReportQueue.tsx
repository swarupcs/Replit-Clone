import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Empty, Segmented, Typography, message } from "antd";
import type { ProjectReport, ReportStatus } from "@replit-clone/shared";
import { listReportsApi, reviewReportApi } from "../apis/projects.ts";

/** The operator's queue.
 *
 *  Two decisions and no others. Dismissing says the complaint was not one;
 *  actioning makes the project private. An operator here cannot delete a
 *  project, cannot edit it, and cannot touch the owner's account — the
 *  smallest power that resolves a complaint, and the only one whose mistakes
 *  the person they were made against can undo by themselves.
 *
 *  Reachable by anybody who types the URL. That is fine and deliberate: the
 *  server checks the allowlist on every request, so a stranger who guesses the
 *  path gets a page that says it could not load the queue.
 */
const REASON_LABELS: Record<ProjectReport["reason"], string> = {
  SECRETS: "Exposed secrets",
  ABUSE: "Abusive or harmful",
  MALWARE: "Malware",
  INFRINGEMENT: "Someone else's work",
  OTHER: "Something else",
};

type Filter = ReportStatus | "ALL";

export const ReportQueue = () => {
  const [filter, setFilter] = useState<Filter>("OPEN");
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();

  const { data: reports, isLoading, error } = useQuery({
    queryKey: ["reports", filter],
    queryFn: () => listReportsApi(filter),
    // A 403 is the answer for everybody not on the allowlist, and retrying it
    // three times changes nothing except how long the page takes to say so.
    retry: false,
  });

  const review = useMutation({
    mutationFn: (input: { id: string; decision: "DISMISSED" | "ACTIONED" }) =>
      reviewReportApi(input.id, input.decision),
    onSuccess: (_report, input) => {
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
      // The gallery has changed if a project just left it.
      void queryClient.invalidateQueries({ queryKey: ["public-projects"] });
      void messageApi.success(
        input.decision === "ACTIONED"
          ? "Project made private."
          : "Report dismissed.",
      );
    },
    onError: (mutationError) => {
      void messageApi.error(
        (mutationError as { response?: { data?: { message?: string } } })
          .response?.data?.message ?? "Could not review that report.",
      );
    },
  });

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "32px 20px" }}>
      {contextHolder}

      <div style={{ marginBottom: 20 }}>
        <Link to="/" style={{ fontSize: 13 }}>
          ← Back to projects
        </Link>
        <Typography.Title level={3} style={{ margin: "10px 0 4px" }}>
          Reports
        </Typography.Title>
        <Typography.Text style={{ color: "var(--rc-text-subtle)", fontSize: 13 }}>
          Making a project private is the only action here. Its owner can
          publish it again, so nothing decided on this page is final.
        </Typography.Text>
      </div>

      <Segmented<Filter>
        value={filter}
        onChange={setFilter}
        style={{ marginBottom: 16 }}
        options={[
          { label: "Open", value: "OPEN" },
          { label: "Actioned", value: "ACTIONED" },
          { label: "Dismissed", value: "DISMISSED" },
          { label: "All", value: "ALL" },
        ]}
      />

      {error ? (
        <Empty
          description="Could not load the queue. This account may not be able to review reports."
        />
      ) : isLoading ? (
        <div aria-label="Loading reports" style={{ display: "grid", gap: 10 }}>
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="rc-skeleton-card" aria-hidden="true">
              <span className="rc-skeleton" style={{ width: "40%", height: 15 }} />
              <span className="rc-skeleton" style={{ width: "70%", height: 11 }} />
            </div>
          ))}
        </div>
      ) : reports?.length === 0 ? (
        <Empty
          description={
            filter === "OPEN" ? "Nothing to review." : "Nothing here."
          }
        />
      ) : (
        <ul
          aria-label="Reports"
          style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}
        >
          {reports?.map((report) => (
            <li key={report.id} className="rc-card">
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <Typography.Text strong style={{ fontSize: 14 }}>
                  {report.projectName}
                </Typography.Text>
                <span className="rc-badge">{REASON_LABELS[report.reason]}</span>
                {report.status !== "OPEN" && (
                  <span className="rc-badge">{report.status.toLowerCase()}</span>
                )}
              </div>

              <Typography.Text
                style={{ color: "var(--rc-text-subtle)", fontSize: 12 }}
              >
                owned by {report.ownerEmail} · reported by{" "}
                {/* Null once the reporter deleted their account. The report
                    outlives them and stops naming them, which is worth
                    showing rather than rendering as an empty gap. */}
                {report.reporterEmail ?? "a deleted account"} ·{" "}
                {new Date(report.createdAt).toLocaleString()}
              </Typography.Text>

              {report.details && (
                <Typography.Paragraph
                  style={{ margin: "8px 0 0", fontSize: 13, whiteSpace: "pre-wrap" }}
                >
                  {report.details}
                </Typography.Paragraph>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                {report.status === "OPEN" ? (
                  <>
                    <Button
                      size="small"
                      danger
                      loading={
                        review.isPending && review.variables?.id === report.id
                      }
                      onClick={() => {
                        review.mutate({ id: report.id, decision: "ACTIONED" });
                      }}
                    >
                      Make private
                    </Button>
                    <Button
                      size="small"
                      loading={
                        review.isPending && review.variables?.id === report.id
                      }
                      onClick={() => {
                        review.mutate({ id: report.id, decision: "DISMISSED" });
                      }}
                    >
                      Dismiss
                    </Button>
                  </>
                ) : (
                  <Typography.Text
                    style={{ color: "var(--rc-text-subtle)", fontSize: 12 }}
                  >
                    Reviewed by {report.reviewedBy ?? "an operator"}
                    {report.reviewedAt &&
                      ` on ${new Date(report.reviewedAt).toLocaleDateString()}`}
                  </Typography.Text>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
};

export default ReportQueue;
