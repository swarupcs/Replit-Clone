import type { ReactNode } from "react";
import { Typography } from "antd";

interface AuthShellProps {
  title: string;
  subtitle: string;
  children: ReactNode;
}

/** The panel every signed-out page sits in.
 *
 *  Extracted from AuthForm once sign-in stopped being the only page that needs
 *  it — reset, verification and joining a shared project all do.
 */
export const AuthShell = ({ title, subtitle, children }: AuthShellProps) => (
  <div
    className="rc-aurora"
    style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}
  >
    <div className="rc-panel" style={{ padding: 32, width: "100%", maxWidth: 420 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
        <span className="rc-logo">&lt;/&gt;</span>
        <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: -0.2 }}>
          Playground
        </span>
      </div>

      <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>
        {title}
      </Typography.Title>
      <Typography.Paragraph style={{ color: "var(--rc-text-subtle)", marginBottom: 24 }}>
        {subtitle}
      </Typography.Paragraph>

      {children}
    </div>
  </div>
);
