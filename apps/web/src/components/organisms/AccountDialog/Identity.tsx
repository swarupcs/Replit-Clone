import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Form,
  Input,
  Switch,
  Typography,
  message,
} from "antd";
import {
  getPersonalizationApi,
  updatePersonalizationApi,
} from "../../../apis/projects.ts";

/** Your identity, in a container that is not your machine. plan.md §11.9.
 *
 *  Two halves of one idea, which is why they share a panel. Dotfiles make the
 *  SHELL yours; the signing key makes the COMMITS yours. Both are properties
 *  of the person rather than of any project -- they follow you into a project
 *  somebody else owns and shared with you, and into one you make tomorrow --
 *  which is why this lives on the account dialog and not in project settings.
 *
 *  The dotfiles half is deliberately the same three fields VS Code exposes, so
 *  a dotfiles repository that works there works here unchanged.
 */
export function Identity() {
  const queryClient = useQueryClient();
  const [form] = Form.useForm();
  const [dirty, setDirty] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const primed = useRef(false);

  /** Held outside the form, because it is the one field that is never read
   *  back: the form is primed from the server's answer, and the server's
   *  answer cannot contain a private key. */
  const [key, setKey] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["personalization"],
    queryFn: getPersonalizationApi,
    retry: false,
  });

  // Set once the values arrive rather than through `initialValues`, which antd
  // reads only on the first render -- by which time the request has not
  // answered and the form would stay empty for ever.
  //
  // Once, and never over something already typed. Both guards earn their
  // place: the ref stops a refetch resetting a half-filled form, and the
  // `dirty` check stops the FIRST response doing it -- somebody who starts
  // typing before the request answers would otherwise watch their URL vanish,
  // which is what a fast typist does and what a test caught here.
  useEffect(() => {
    if (!data || primed.current || dirty) return;
    primed.current = true;
    form.setFieldsValue(data);
  }, [data, dirty, form]);

  const save = useMutation({
    mutationFn: updatePersonalizationApi,
    onSuccess: (saved) => {
      queryClient.setQueryData(["personalization"], saved);
      setDirty(false);
      setRefusal(null);
      setKey("");
      void message.success(
        saved.dotfilesRepo
          ? "Saved. The next container you open will have them."
          : "Saved.",
      );
    },
    // Inline rather than a toast. The refusals here are the useful part of
    // this feature -- "an ssh:// URL would authenticate as the server" is a
    // sentence somebody can act on -- and a message that fades after three
    // seconds is the wrong place for a sentence anybody needs to read twice.
    onError: (error: { response?: { data?: { message?: string } } }) => {
      setRefusal(
        error.response?.data?.message ?? "Could not save those settings.",
      );
    },
  });

  return (
    <div>
      <Typography.Paragraph
        style={{ color: "var(--rc-text-subtle)", fontSize: 12.5 }}
      >
        A repository of dotfiles, cloned into every container you open. It has
        to be publicly clonable over https — nothing here sends a token with the
        clone, so a private repository will fail rather than quietly working.
      </Typography.Paragraph>

      {refusal && (
        <Alert
          type="error"
          showIcon
          closable
          style={{ marginBottom: 12 }}
          message={refusal}
          onClose={() => {
            setRefusal(null);
          }}
        />
      )}

      <Form
        form={form}
        layout="vertical"
        disabled={isLoading}
        onValuesChange={() => {
          setDirty(true);
        }}
        onFinish={(values: Record<string, string>) => {
          save.mutate({
            dotfilesRepo: values.dotfilesRepo ?? "",
            dotfilesTarget: values.dotfilesTarget ?? "",
            dotfilesInstall: values.dotfilesInstall ?? "",
          });
        }}
      >
        <Form.Item label="Repository" name="dotfilesRepo">
          <Input
            placeholder="https://github.com/you/dotfiles"
            autoComplete="off"
          />
        </Form.Item>

        <Form.Item
          label="Clone into"
          name="dotfilesTarget"
          // Named rather than validated here: the rule that refuses the
          // project directory lives on the server, next to the clone it
          // protects, and a second copy of it in this file could disagree
          // with it.
          extra="Defaults to ~/dotfiles. Anywhere under your home directory, except the project itself."
        >
          <Input placeholder="~/dotfiles" autoComplete="off" />
        </Form.Item>

        <Form.Item
          label="Install command"
          name="dotfilesInstall"
          extra="Left empty: run install.sh, setup.sh or bootstrap.sh if the repository has one, and otherwise symlink its top-level dotfiles into your home directory."
        >
          <Input placeholder="./install.sh" autoComplete="off" />
        </Form.Item>

        <Button
          type="primary"
          htmlType="submit"
          loading={save.isPending}
          disabled={!dirty || isLoading}
        >
          Save
        </Button>
      </Form>

      <Typography.Title level={5} style={{ marginTop: 28 }}>
        Commit signing
      </Typography.Title>
      <Typography.Paragraph
        style={{ color: "var(--rc-text-subtle)", fontSize: 12.5 }}
      >
        An SSH key, used to sign the commits you make here. It has to be an
        OpenSSH key with no passphrase — nothing can be asked for one at the
        moment a commit is made.
      </Typography.Paragraph>

      {data?.signingKeyPublic && (
        <div style={{ marginBottom: 12 }}>
          {/* Shown so it can be pasted into GitHub's signing-keys page, which
              is the step without which a correctly signed commit still shows
              as "Unverified" and reads as a failure of this feature. */}
          <label htmlFor="rc-signing-public">Public key</label>
          <Input.TextArea
            id="rc-signing-public"
            readOnly
            autoSize
            value={data.signingKeyPublic}
            style={{ marginTop: 4 }}
          />
          <Typography.Paragraph
            style={{
              color: "var(--rc-text-subtle)",
              fontSize: 12,
              marginTop: 4,
            }}
          >
            Add this to GitHub under SSH and GPG keys, as a <b>signing</b> key,
            or your signed commits will still show as unverified there.
          </Typography.Paragraph>
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="rc-signing-key">
          {data?.hasSigningKey ? "Replace the key" : "Private key"}
        </label>
        <Input.TextArea
          id="rc-signing-key"
          rows={4}
          value={key}
          autoComplete="off"
          spellCheck={false}
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          style={{ marginTop: 4 }}
          onChange={(event) => {
            setKey(event.target.value);
          }}
        />
        <Typography.Paragraph
          style={{ color: "var(--rc-text-subtle)", fontSize: 12, marginTop: 4 }}
        >
          Make one with <code>ssh-keygen -t ed25519</code> and paste the file
          without the <code>.pub</code>. It is encrypted before it is stored,
          and never shown again.
        </Typography.Paragraph>
      </div>

      <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
        <Button
          type="primary"
          loading={save.isPending}
          disabled={!key.trim()}
          onClick={() => {
            save.mutate({ signingKey: key });
          }}
        >
          {data?.hasSigningKey ? "Replace key" : "Add key"}
        </Button>

        {data?.hasSigningKey && (
          <>
            {/* Off is not the same as gone: somebody pausing signing should not
                have to paste their key again to resume. */}
            <label
              htmlFor="rc-sign-commits"
              style={{ display: "flex", gap: 8, alignItems: "center" }}
            >
              <Switch
                id="rc-sign-commits"
                checked={data.signCommits}
                onChange={(checked) => {
                  save.mutate({ signCommits: checked });
                }}
              />
              Sign my commits
            </label>

            <Button
              danger
              type="text"
              onClick={() => {
                save.mutate({ signingKey: null });
              }}
            >
              Remove key
            </Button>
          </>
        )}
      </div>

      {/* Said here rather than discovered later. A container is only rebuilt
          when something about it changes, so a project already open keeps the
          shell it started with, and somebody who saw no change would otherwise
          conclude this does not work. */}
      <Alert
        type="info"
        showIcon
        style={{ marginTop: 16 }}
        message="Applied when a container is created"
        description="Projects that are already running keep the shell they started with until they are next rebuilt."
      />
    </div>
  );
}
