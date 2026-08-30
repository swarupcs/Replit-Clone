import { useState } from "react";
import { Button, Input, Tooltip, message } from "antd";
import { VscCheck, VscCopy, VscTrash } from "react-icons/vsc";
import type { CustomDomain as CustomDomainRow } from "@replit-clone/shared";
import {
  claimDomainApi,
  releaseDomainApi,
  verifyDomainApi,
} from "../../../apis/deployments.ts";

/** Pointing a domain you own at a published project.
 *
 *  Three states, and the middle one is the whole design. A domain is claimed
 *  before it is proved, because the TXT record somebody has to publish cannot
 *  be shown to them until the server has generated it — so there is
 *  necessarily a window where the row exists and the address does not work.
 *  This panel's job is to make that window legible rather than to hide it: an
 *  unverified domain says exactly what it is waiting for, and never renders as
 *  though the site were live at that name.
 *
 *  The record itself is shown in full and is copyable, because a verification
 *  step people cannot read is one they satisfy by guessing and then blame on
 *  the platform when it does not work.
 */
interface CustomDomainProps {
  projectId: string;
  domain: CustomDomainRow | null;
  /** Called after any change, so the panel above can refetch rather than this
   *  component keeping a second copy of the deployment. */
  onChange: () => void | Promise<void>;
}

export const CustomDomain = ({
  projectId,
  domain,
  onChange,
}: CustomDomainProps) => {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      message.success(done);
      await onChange();
    } catch (error) {
      // The server's message, not a generic one. Every refusal here is
      // actionable — the name is taken, the record is not there yet, it is
      // not a hostname — and replacing them with "something went wrong" would
      // throw away the only part the user can act on.
      const reason =
        error instanceof Error ? error.message : "That did not work";
      message.error(reason);
    } finally {
      setBusy(false);
    }
  };

  if (!domain) {
    return (
      <div className="rc-domain">
        <div className="rc-domain-title">Custom domain</div>
        <p className="rc-deploy-blurb">
          Serve this project at a domain you own. You will need to add one DNS
          record to prove it is yours, and a CNAME pointing at the address
          above.
        </p>
        <div style={{ display: "flex", gap: 6 }}>
          <Input
            size="small"
            placeholder="www.example.com"
            value={draft}
            disabled={busy}
            aria-label="Custom domain"
            onChange={(event) => setDraft(event.target.value)}
            onPressEnter={() => {
              if (draft.trim())
                void run(
                  () => claimDomainApi(projectId, draft.trim()),
                  "Domain claimed",
                );
            }}
          />
          <Button
            size="small"
            type="primary"
            loading={busy}
            disabled={!draft.trim()}
            onClick={() =>
              void run(
                () => claimDomainApi(projectId, draft.trim()),
                "Domain claimed",
              )
            }
          >
            Add
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rc-domain">
      <div className="rc-domain-title">
        Custom domain
        <span
          className={
            domain.verified ? "rc-domain-badge is-live" : "rc-domain-badge"
          }
        >
          {domain.verified ? "verified" : "awaiting DNS"}
        </span>
      </div>

      <div className="rc-domain-name">
        {domain.verified ? (
          <a
            href={`https://${domain.domain}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            {domain.domain}
          </a>
        ) : (
          domain.domain
        )}
      </div>

      {!domain.verified && (
        <>
          <p className="rc-deploy-blurb">
            Add this TXT record in your DNS, then verify. Nothing is served at
            this name until the record is found.
          </p>
          <RecordRow label="Type" value="TXT" />
          <RecordRow label="Name" value={domain.txtName} copyable />
          <RecordRow label="Value" value={domain.txtValue} copyable />
        </>
      )}

      <div style={{ display: "flex", gap: 6, paddingTop: 8 }}>
        {!domain.verified && (
          <Button
            size="small"
            type="primary"
            loading={busy}
            icon={<VscCheck size={12} />}
            onClick={() =>
              void run(() => verifyDomainApi(projectId), "Domain verified")
            }
          >
            Verify
          </Button>
        )}
        <Tooltip title="Stop serving this project at that name">
          <Button
            size="small"
            danger
            disabled={busy}
            aria-label="Remove domain"
            icon={<VscTrash size={12} />}
            onClick={() =>
              void run(() => releaseDomainApi(projectId), "Domain removed")
            }
          />
        </Tooltip>
      </div>
    </div>
  );
};

/** One line of the record to publish.
 *
 *  Copyable rather than only readable: a verification token is 32 characters
 *  of base64 and re-typing it is how this step fails for reasons that have
 *  nothing to do with DNS.
 */
const RecordRow = ({
  label,
  value,
  copyable = false,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) => (
  <div className="rc-domain-record">
    <span className="rc-domain-record-label">{label}</span>
    <code title={value}>{value}</code>
    {copyable && (
      <Button
        size="small"
        type="text"
        aria-label={`Copy ${label.toLowerCase()}`}
        icon={<VscCopy size={12} />}
        onClick={() => {
          void navigator.clipboard
            .writeText(value)
            .then(() => message.success("Copied"))
            // Clipboard access can be refused outright, and a silent copy
            // button is worse than one that admits it did nothing.
            .catch(() => message.error("Could not copy"));
        }}
      />
    )}
  </div>
);
