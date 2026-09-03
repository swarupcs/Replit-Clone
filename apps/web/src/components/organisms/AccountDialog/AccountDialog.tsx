import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Empty, Modal, Progress, Segmented, Tag, Typography } from "antd";
import {
  isUnlimited,
  QUOTA_WARN_FRACTION,
  type AccountSummary,
  type Plan,
  type SubscriptionState,
} from "@replit-clone/shared";
import { getAccountApi } from "../../../apis/projects.ts";
import { ApiKeys } from "./ApiKeys.tsx";
import { TrashPanel } from "../TrashPanel/TrashPanel.tsx";

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
  // Zero means no limit, not a limit of nothing. A bar is a picture of how
  // close you are to a wall, so where there is no wall there is no bar --
  // drawing a full red one, which is what `limit <= 0` used to produce, says
  // the exact opposite of what is true.
  const unlimited = isUnlimited(limit);
  const percent = unlimited ? 0 : Math.min(100, (used / limit) * 100);

  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}
      >
        <Typography.Text strong>{label}</Typography.Text>
        <Typography.Text style={{ color: "var(--rc-text-subtle)" }}>
          {unlimited ? `${render(used)} used` : `${render(used)} of ${render(limit)}`}
        </Typography.Text>
      </div>
      {!unlimited && (
        <Progress
          percent={Math.round(percent)}
          status={tone(used, limit)}
          showInfo={false}
          aria-label={label}
        />
      )}
    </div>
  );
}

/** One of a plan's allowances, in words.
 *
 *  "Unlimited projects" rather than "0 projects", which is what the personal
 *  plan's rows would otherwise read as -- and which would look like a plan that
 *  permits nothing rather than one that permits everything. */
function allowance(limit: number, noun: string): string {
  return isUnlimited(limit) ? `Unlimited ${noun}` : `${String(limit)} ${noun}`;
}

function date(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "";
}

/** What the subscription is doing, said once and only when it is news.
 *
 *  Nothing at all for an account with no subscription, which is every account
 *  on a deployment with no processor — and for a renewal that simply worked,
 *  which is §6 decision 14 on a screen rather than in a notification.
 *
 *  The two states that get a banner are the two a person can act on, and the
 *  wording of both is load-bearing. A failed payment has to say that nothing
 *  has happened yet and by when it will; an ended subscription has to say
 *  that nothing was taken away, because the thing people reasonably fear at
 *  that moment is that their work is gone.
 */
function SubscriptionNotice({ subscription }: { subscription: SubscriptionState }) {
  if (subscription.status === "PAST_DUE" && subscription.entitled) {
    return (
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="A payment did not go through"
        description={
          <>
            Nothing has changed yet — your projects keep running and this
            account stays on {subscription.planLabel} until{" "}
            {date(subscription.graceUntil)}. After that it moves to the free
            plan: nothing is deleted, but it stops being able to grow.
          </>
        }
      />
    );
  }

  if (!subscription.entitled) {
    return (
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={`Your ${subscription.planLabel} subscription has ended`}
        description={
          <>
            Everything you have is still here, still running and still
            exportable. What changed is the limits on making more.
          </>
        }
      />
    );
  }

  // Paid and current: a line, not a banner. A renewal that works is not news.
  return (
    <Typography.Paragraph
      style={{ color: "var(--rc-text-subtle)", fontSize: 12.5, marginBottom: 16 }}
    >
      {subscription.status === "TRIALING" ? "Trial of " : ""}
      {subscription.planLabel}
      {subscription.currentPeriodEnd
        ? `${subscription.status === "TRIALING" ? ", ends " : ", renews "}${date(
            subscription.currentPeriodEnd,
          )}`
        : ""}
      . Billing is handled by the payment processor; this screen only reports
      what it last said.
    </Typography.Paragraph>
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
        {allowance(plan.maxProjects, "projects")} ·{" "}
        {allowance(plan.userDiskQuotaMb, "MB")} ·{" "}
        {allowance(plan.aiRequestsPerHour, "assistant requests an hour")} ·{" "}
        {allowance(plan.maxContainersPerUser, "running at once")}
      </Typography.Paragraph>
    </li>
  );
}

/** Container-hours, read by a person.
 *
 *  Minutes below an hour, because "0.1 hours" is a number nobody pictures and
 *  the first month of a free tier is all minutes. */
function hours(seconds: number): string {
  if (seconds < 60) return "none yet";
  if (seconds < 3600) return `${String(Math.round(seconds / 60))} minutes`;

  const value = seconds / 3600;
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} hours`;
}

export const AccountDialog = ({ open, onClose }: AccountDialogProps) => {
  const [tab, setTab] = useState<"usage" | "keys" | "trash">("usage");

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
          // Here rather than on the dashboard: the trash is about the account
          // -- what it is holding and what that costs -- and putting deleted
          // projects back among the live ones is how somebody opens the wrong
          // thing.
          { label: "Trash", value: "trash" },
        ]}
        value={tab}
        onChange={(value) => setTab(value as "usage" | "keys" | "trash")}
        style={{ marginBottom: 16 }}
      />

      {tab === "keys" ? (
        <ApiKeys />
      ) : tab === "trash" ? (
        <TrashPanel />
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

          {data.subscription && (
            <SubscriptionNotice subscription={data.subscription} />
          )}

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

          {/* Not a Meter, on purpose: a bar needs a limit, and there is no
              limit on this. Compute is the thing this platform actually
              spends and nothing has ever counted it, so the number exists to
              be looked at while the question of whether it is ever priced
              stays open. A progress bar would answer that question by
              accident. */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              fontSize: 13,
              margin: "4px 0 16px",
            }}
          >
            <span>Compute this month</span>
            <span style={{ color: "var(--rc-text-subtle)" }}>
              {hours(data.computeSecondsThisMonth)} · not charged for
            </span>
          </div>

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
                There is no way to change plan from here yet. This deployment
                can read what a payment processor tells it, but it cannot start
                a checkout — so a button that appeared to would be lying about
                what happens next.
              </Typography.Paragraph>
            </>
          )}
        </>
      )}
    </Modal>
  );
};

export default AccountDialog;
