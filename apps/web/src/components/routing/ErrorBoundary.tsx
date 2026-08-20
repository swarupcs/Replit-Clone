import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Button } from "antd";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Shown instead of the generic copy when this boundary wraps one pane
   *  rather than the whole app. */
  label?: string;
  /** Changing this resets the boundary — used to clear a crash when the user
   *  navigates to a different route. */
  resetKey?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Catches render-phase crashes.
 *
 *  Without one, any throw during render unmounts the whole tree and leaves a
 *  blank white page with no way back — React's default behaviour since 16.
 *
 *  Must be a class: there is still no hook equivalent of componentDidCatch.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    // A crash in one route should not persist into the next one.
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Render error:", error, info.componentStack);
  }

  private readonly handleRetry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    const { children, label } = this.props;

    if (!error) return children;

    return (
      <div
        className="rc-aurora"
        style={{
          display: "grid",
          placeItems: "center",
          height: "100%",
          minHeight: 240,
          padding: 32,
        }}
      >
        <div style={{ maxWidth: 460, textAlign: "center" }}>
          <div style={{ fontSize: 30, marginBottom: 12 }}>⚠️</div>

          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
            {label ? `${label} crashed` : "Something broke"}
          </h2>

          <p
            style={{
              color: "var(--rc-text-subtle)",
              fontSize: 13.5,
              lineHeight: 1.6,
              marginBottom: 18,
            }}
          >
            {label
              ? "The rest of the editor is still running."
              : "This is a bug — the details are in the browser console."}
          </p>

          {/* The message is developer-facing, but this is a dev tool: hiding it
              would just mean opening devtools to learn the same thing. */}
          <pre
            style={{
              textAlign: "left",
              fontFamily: "var(--rc-mono)",
              fontSize: 11.5,
              color: "var(--rc-red)",
              background: "var(--rc-surface-sunken)",
              border: "1px solid var(--rc-border)",
              borderRadius: "var(--rc-radius-sm)",
              padding: "10px 12px",
              marginBottom: 18,
              maxHeight: 140,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {error.message}
          </pre>

          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <Button onClick={this.handleRetry}>Try again</Button>
            <Button type="primary" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
