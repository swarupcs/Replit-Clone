import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button, Input, Modal, Select, Typography, message } from "antd";
import { VscReport } from "react-icons/vsc";
import type { ReportReason } from "@replit-clone/shared";
import { reportProjectApi } from "../../../apis/projects.ts";

/** Telling the operator that a published project should not be public.
 *
 *  Deliberately unglamorous and deliberately quiet: it says the report was
 *  filed and never says what happened next. There is no correspondence here —
 *  no appeal, no status page, no notification — because promising a reply is
 *  promising somebody's time, and this app has one operator reading a list.
 *  Saying so up front is kinder than implying a process that does not exist.
 */
const REASONS: { value: ReportReason; label: string; hint: string }[] = [
  {
    value: "SECRETS",
    label: "Exposed secrets",
    hint: "An API key, password, or token is visible in the files.",
  },
  {
    value: "ABUSE",
    label: "Abusive or harmful content",
    hint: "Harassment, threats, or content targeting somebody.",
  },
  {
    value: "MALWARE",
    label: "Malware",
    hint: "The code appears to be built to harm whoever runs it.",
  },
  {
    value: "INFRINGEMENT",
    label: "Someone else's work",
    hint: "Published without the right to publish it.",
  },
  { value: "OTHER", label: "Something else", hint: "Describe it below." },
];

export interface ReportProjectProps {
  projectId: string;
  projectName: string;
}

export const ReportProject = ({
  projectId,
  projectName,
}: ReportProjectProps) => {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason>("SECRETS");
  const [details, setDetails] = useState("");
  const [messageApi, contextHolder] = message.useMessage();

  const mutation = useMutation({
    mutationFn: () => reportProjectApi(projectId, reason, details.trim()),
    onSuccess: () => {
      setOpen(false);
      setDetails("");
      void messageApi.success(
        "Reported. An operator will look at it; you will not hear back " +
          "individually.",
      );
    },
    onError: (error) => {
      // The server's message is the useful one here -- "you have already
      // reported this", "that is your own project, make it private instead" --
      // and each of those tells the reporter something to do next.
      void messageApi.error(
        (error as { response?: { data?: { message?: string } } }).response?.data
          ?.message ?? "Could not file that report.",
      );
    },
  });

  const hint = REASONS.find((entry) => entry.value === reason)?.hint;

  return (
    <>
      {contextHolder}

      <Button
        size="small"
        type="text"
        aria-label={`Report ${projectName}`}
        icon={<VscReport size={13} />}
        onClick={() => {
          setOpen(true);
        }}
      />

      <Modal
        open={open}
        title={`Report ${projectName}`}
        okText="Report"
        okButtonProps={{ danger: true, loading: mutation.isPending }}
        onOk={() => {
          mutation.mutate();
        }}
        onCancel={() => {
          setOpen(false);
        }}
      >
        <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
          <Select
            value={reason}
            onChange={setReason}
            aria-label="Reason"
            options={REASONS.map((entry) => ({
              value: entry.value,
              label: entry.label,
            }))}
          />

          <Typography.Text
            style={{ color: "var(--rc-text-subtle)", fontSize: 12 }}
          >
            {hint}
          </Typography.Text>

          <Input.TextArea
            rows={4}
            value={details}
            maxLength={2000}
            showCount
            aria-label="What is wrong with it"
            placeholder="Anything that would help somebody find the problem — a file name, a line."
            onChange={(event) => {
              setDetails(event.target.value);
            }}
          />

          <Typography.Text
            style={{ color: "var(--rc-text-subtle)", fontSize: 12 }}
          >
            One report per project. You will not hear back individually.
          </Typography.Text>
        </div>
      </Modal>
    </>
  );
};
