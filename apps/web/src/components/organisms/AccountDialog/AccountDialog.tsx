import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Empty, Modal, Progress, Segmented, Tag, Typography } from "antd";
import {
  QUOTA_WARN_FRACTION,
  type AccountSummary,
  type Plan,
} from "@replit-clone/shared";
import { getAccountApi } from "../../../apis/projects.ts";
import { ApiKeys } from "./ApiKeys.tsx";

/** What this account is using, and what it is allowed.
 *
 *  Both halves existed on the server and neither was reachable: the quota was
 *  computed, refused on, and never shown. The only way to learn where you
 *  stood was to be refused — the worst possible moment to find out, from a
 *  message that named a limit without saying how close you had been to it or
 *  which project was eating it.
 *
 *  The breakdown is the half that makes it actionable. "You are out of space"
 *  is not something anybody can act on; "this project is most of it" is.
 */
interface AccountDialogProps {
  open: boolean;
  onClose: () => void;
}

function mb(bytes: number): string {
  const megabytes = bytes / 1024 / 1024;
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1)} GB`;
  return `${megabytes.toFixed(megabytes < 10 ? 1 : 0)} MB`;
}

/** Red at the wall, amber approaching it, and neutral otherwise. The amber
 *  band is `QUOTA_WARN_FRACTION`, the same threshold the server notifies on,
 *  so the bar and the message cannot disagree about what "nearly full" means. */
function tone(used: number, limit: number): "exception" | "normal" | "active" {
  if (limit <= 0 || used >= limit) return "exception";
  return used / limit >= QUOTA_WARN_FRACTION ? "normal" : "active";
}

function Meter({
  label,
  used,
  limit,
  render,
}: {
  label: string;
  used: number;
  limit: number;
  render: (value: number) => string;
}) {
  const percent = limit <= 0 ? 100 : Math.min(100, (used / limit) * 100);

  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}
      >
        <Typography.Text strong>{label}</Typography.Text>
        <Typography.Text style={{ color: "var(--rc-text-subtle)" }}>
          {render(used)} of {render(limit)}
        </Typography.Text>
      </div>
      <Progress
        percent={Math.round(percent)}
        status={tone(used, limit)}
        showInfo={false}
        aria-label={label}
      />
    </div>
  );
}

function PlanCard({ plan, current }: { plan: Plan; current: boolean }) {
  return (
    <li className="rc-card" style={{ padding: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <Typography.Text strong>{plan.label}</Typography.Text>
        {current && <Tag color="blue">Current</Tag>}
        <Typography.Text
          style={{ color: "var(--rc-text-subtle)", fontSize: 12 }}
        >
          {plan.priceCents === 0
            ? "Free"
            : `${(plan.priceCents / 100).toFixed(2)} ${plan.currency.toUpperCase()} / month`}
        </Typography.Text>
      </div>
      <Typography.Paragraph
        style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--rc-text-subtle)" }}
      >
        {plan.maxProjects} projects · {plan.userDiskQuotaMb} MB ·{" "}
        {plan.aiRequestsPerHour} assistant requests an hour ·{" "}
        {plan.maxContainersPerUser} running at once
      </Typography.Paragraph>
    </li>
  );
}

export const AccountDialog = ({ open, onClose }: AccountDialogProps) => {
  const [tab, setTab] = useState<"usage" | "keys">("usage");

  const { data, isLoading, error } = useQuery<AccountSummary>({
    queryKey: ["account"],
    queryFn: getAccountApi,
    // Only when it is being looked at: the summary walks every project's tree
    // on the server, which is not a thing to do behind a closed dialog.
    enabled: open && tab === "usage",
    retry: false,
  });

  return (
    <Modal
      title="Plan and usage"
      open={open}
      onCancel={onClose}
      footer={null}
      width={620}
    >
      <Segmented
        options={[
          { label: "Usage", value: "usage" },
          { label: "API keys", value: "keys" },
        ]}
        value={tab}
        onChange={(value) => setTab(value as "usage" | "keys")}
        style={{ marginBottom: 16 }}
      />

      {tab === "keys" ? (
        <ApiKeys />
      ) : error ? (
        <Empty description="Could not load this account's usage." />
      ) : isLoading || !data ? (
        <div aria-label="Loading account usage" style={{ display: "grid", gap: 10 }}>
          {Array.from({ length: 3 }, (_, index) => (
            <span
              key={index}
              className="rc-skeleton"
              style={{ height: 34 }}
              aria-hidden="true"
            />
          ))}
        </div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "baseline",
              marginBottom: 16,
            }}
          >
            <Typography.Text strong style={{ fontSize: 15 }}>
              {data.entitlements.planLabel}
            </Typography.Text>
            <Typography.Text
              style={{ color: "var(--rc-text-subtle)", fontSize: 12.5 }}
            >
              {data.email}
            </Typography.Text>
            {/* A limit that appears on no pricing page should say why it is
                different rather than read as a bug. */}
            {data.entitlements.overridden && (
              <Tag color="gold">
                Adjusted for this account
                {data.entitlements.overrideUntil
                  ? ` until ${new Date(data.entitlements.overrideUntil).toLocaleDateString()}`
                  : ""}
              </Tag>
            )}
          </div>

          <Meter
            label="Projects"
            used={data.projects}
            limit={data.entitlements.maxProjects}
            render={(value) => String(value)}
          />
          <Meter
            label="Storage"
            used={data.diskBytes}
            limit={data.entitlements.userDiskQuotaMb * 1024 * 1024}
            render={mb}
          />

          <Typography.Title level={5}>Where the space is going</Typography.Title>
          {data.breakdown.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="Nothing here yet."
            />
          ) : (
            <ol
              aria-label="Storage by project"
              style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}
            >
              {data.breakdown.map((entry) => (
                <li
                  key={entry.projectId}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 13,
                  }}
                >
                  <span>{entry.name}</span>
                  <span style={{ color: "var(--rc-text-subtle)" }}>
                    {mb(entry.diskBytes)}
                  </span>
                </li>
              ))}
            </ol>
          )}

          {data.plans.length > 1 && (
            <>
              <Typography.Title level={5}>Plans</Typography.Title>
              <ul
                aria-label="Plans"
                style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}
              >
                {data.plans.map((plan) => (
                  <PlanCard
                    key={plan.id}
                    plan={plan}
                    current={plan.id === data.entitlements.planId}
                  />
                ))}
              </ul>
              <Typography.Paragraph
                style={{
                  color: "var(--rc-text-subtle)",
                  fontSize: 12,
                  marginTop: 10,
                }}
              >
                There is no way to change plan from here yet. Nothing on this
                deployment takes payment, so a button that appeared to would be
                lying about what happens next.
              </Typography.Paragraph>
            </>
          )}
        </>
      )}
    </Modal>
  );
};

export default AccountDialog;
