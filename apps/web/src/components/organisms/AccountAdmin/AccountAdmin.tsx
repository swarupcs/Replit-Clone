import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Empty,
  Input,
  Select,
  Tag,
  Typography,
  message,
} from "antd";
import {
  MAX_ACCOUNT_REASON,
  type AccountDetail,
  type AccountRow,
} from "@replit-clone/shared";
import {
  getAdminAccountApi,
  searchAccountsApi,
  setAccountOverrideApi,
  setAccountPlanApi,
} from "../../../apis/projects.ts";

/** Looking up an account, and changing what it is allowed.
 *
 *  This is the first authority in this product that acts on a **person**
 *  rather than on a project, and §6 decision 11 says the moderation power is
 *  small precisely because nothing reviews it. So every write here demands a
 *  reason before its button is live, the server requires one too, the change
 *  and the record commit together, and the account holder is told.
 *
 *  What is deliberately not here is suspension. Locking somebody out of their
 *  own work is a far larger power than making one project private, and if an
 *  account has to be stopped that is a decision for whoever owns the
 *  deployment — taken deliberately, not from a button on a console.
 */
const VERB = {
  PLAN_CHANGED: "Plan changed",
  OVERRIDE_SET: "Limits set by hand",
  OVERRIDE_CLEARED: "Limits back to the plan",
};

function mb(bytes: number): string {
  const megabytes = bytes / 1024 / 1024;
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1)} GB`;
  return `${megabytes.toFixed(0)} MB`;
}

const Detail = ({ userId, onDone }: { userId: string; onDone: () => void }) => {
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const [planId, setPlanId] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const { data, isLoading, error } = useQuery<AccountDetail>({
    queryKey: ["admin-account", userId],
    queryFn: () => getAdminAccountApi(userId),
    retry: false,
  });

  const done = () => {
    setPlanId(null);
    setReason("");
    void queryClient.invalidateQueries({ queryKey: ["admin-account", userId] });
    void queryClient.invalidateQueries({ queryKey: ["admin-accounts"] });
  };

  const changePlan = useMutation({
    mutationFn: () => setAccountPlanApi(userId, planId ?? "", reason.trim()),
    onSuccess: () => {
      done();
      void messageApi.success("Plan changed. They have been told.");
    },
    onError: (mutationError) => {
      void messageApi.error(
        (mutationError as { response?: { data?: { message?: string } } })
          .response?.data?.message ?? "Could not change that plan.",
      );
    },
  });

  const clearOverride = useMutation({
    mutationFn: () =>
      setAccountOverrideApi({ userId, override: null, reason: reason.trim() }),
    onSuccess: () => {
      done();
      void messageApi.success("Limits are back to the plan's.");
    },
    onError: () => {
      void messageApi.error("Could not clear those limits.");
    },
  });

  if (error) return <Empty description="Could not load that account." />;
  if (isLoading || !data) {
    return (
      <div aria-label="Loading account" style={{ display: "grid", gap: 8 }}>
        <span className="rc-skeleton" style={{ height: 30 }} aria-hidden="true" />
      </div>
    );
  }

  const hasReason = reason.trim().length > 0;

  return (
    <>
      {contextHolder}

      <Button size="small" onClick={onDone} style={{ marginBottom: 12 }}>
        Back to search
      </Button>

      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {data.email}
      </Typography.Title>
      <Typography.Paragraph style={{ fontSize: 12.5, color: "var(--rc-text-subtle)" }}>
        On {data.entitlements.planLabel} · {data.projects} of{" "}
        {data.entitlements.maxProjects} projects · {mb(data.diskBytes)} of{" "}
        {data.entitlements.userDiskQuotaMb} MB · joined{" "}
        {new Date(data.createdAt).toLocaleDateString()}
      </Typography.Paragraph>

      {data.entitlements.overridden && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="This account's limits were set by hand"
          description={
            data.entitlements.overrideUntil
              ? `They go back to the plan's on ${new Date(data.entitlements.overrideUntil).toLocaleDateString()}.`
              : "They do not expire."
          }
        />
      )}

      {/* One reason box for both actions on this screen, because it is the
          same requirement and two would invite leaving one of them empty. */}
      <Input.TextArea
        aria-label="Why"
        rows={2}
        maxLength={MAX_ACCOUNT_REASON}
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
        }}
        placeholder="Why is this account being changed?"
      />
      <Typography.Paragraph
        style={{ color: "var(--rc-text-subtle)", fontSize: 12, margin: "6px 0 12px" }}
      >
        Required, and written into the record with your address. The account
        holder is told what changed and reads this.
      </Typography.Paragraph>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Select
          aria-label="Plan"
          placeholder="Move to plan"
          style={{ minWidth: 160 }}
          value={planId}
          onChange={setPlanId}
          // The catalogue, minus the plan they are already on: moving somebody
          // to the plan they are on is refused by the server, so offering it
          // would be offering a refusal.
          options={data.plans
            .filter((plan) => plan.id !== data.entitlements.planId)
            .map((plan) => ({ label: plan.label, value: plan.id }))}
        />
        <Button
          size="small"
          type="primary"
          loading={changePlan.isPending}
          disabled={!hasReason || planId === null}
          onClick={() => {
            changePlan.mutate();
          }}
        >
          Change plan
        </Button>
        {data.entitlements.overridden && (
          <Button
            size="small"
            loading={clearOverride.isPending}
            disabled={!hasReason}
            onClick={() => {
              clearOverride.mutate();
            }}
          >
            Clear hand-set limits
          </Button>
        )}
      </div>

      <Typography.Title level={5}>What has been done to it</Typography.Title>
      {data.actions.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Nobody has changed this account."
        />
      ) : (
        <ul
          aria-label="Account history"
          style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}
        >
          {data.actions.map((entry) => (
            <li key={entry.id} className="rc-card" style={{ padding: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <Typography.Text strong style={{ fontSize: 13 }}>
                  {VERB[entry.action]}
                </Typography.Text>
                {entry.detail && <Tag>{entry.detail}</Tag>}
                <Typography.Text style={{ color: "var(--rc-text-subtle)", fontSize: 12 }}>
                  {entry.actor} · {new Date(entry.createdAt).toLocaleString()}
                </Typography.Text>
              </div>
              <Typography.Paragraph style={{ margin: "6px 0 0", fontSize: 12.5 }}>
                {entry.reason}
              </Typography.Paragraph>
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

export const AccountAdmin = () => {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [opened, setOpened] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<AccountRow[]>({
    queryKey: ["admin-accounts", submitted],
    queryFn: () => searchAccountsApi(submitted),
    retry: false,
  });

  if (opened) {
    return <Detail userId={opened} onDone={() => setOpened(null)} />;
  }

  return (
    <>
      <Input.Search
        aria-label="Find an account"
        placeholder="Part of an email address"
        allowClear
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        onSearch={setSubmitted}
        style={{ marginBottom: 12 }}
      />

      {error ? (
        <Empty description="Could not search accounts." />
      ) : isLoading ? (
        <div aria-label="Loading accounts" style={{ display: "grid", gap: 8 }}>
          <span className="rc-skeleton" style={{ height: 30 }} aria-hidden="true" />
        </div>
      ) : (data ?? []).length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No accounts match that."
        />
      ) : (
        <ul
          aria-label="Accounts"
          style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}
        >
          {data?.map((row) => (
            <li key={row.userId} className="rc-card" style={{ padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    {row.email}
                  </Typography.Text>
                  <Tag>{row.planLabel}</Tag>
                  {row.overridden && <Tag color="gold">hand-set limits</Tag>}
                  <Typography.Text style={{ color: "var(--rc-text-subtle)", fontSize: 12 }}>
                    {row.projects} project{row.projects === 1 ? "" : "s"}
                  </Typography.Text>
                </div>
                <Button size="small" onClick={() => setOpened(row.userId)}>
                  Open
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

export default AccountAdmin;
