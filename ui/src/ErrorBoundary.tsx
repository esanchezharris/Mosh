import React from "react";

// Resilience: a single component throwing during render must NOT blank the whole app
// (React unmounts the entire tree on an uncaught render error). This boundary keeps the
// window alive and offers two ways back. The WebView is only a CLIENT of the engine — the
// session lives in MoshOps/Tracktion — so neither way out can lose work:
//   · Try again   re-mounts the tree in place (zero risk; the primary action).
//   · Reload interface   reloads the WebView, which re-fetches the snapshot.
// The stack stays available for diagnosis, but collapsed: a raw trace on a shared screen
// reads as a crash, and the session is not what broke.
//
// Styles are inline on purpose: this renders at the root, where no shell stylesheet is
// guaranteed to have applied (the thing that threw may be the shell itself).

type Props = { children?: React.ReactNode; onReload?: () => void };
type State = { error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[mosh] interface render error", error, info.componentStack);
  }

  private readonly tryAgain = () => this.setState({ error: null });

  private readonly reload = () => {
    if (this.props.onReload) this.props.onReload();
    else window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" data-testid="ui-error-boundary"
        style={{ padding: 32, maxWidth: 640, fontFamily: "system-ui, sans-serif", color: "#eaeaea", lineHeight: 1.45 }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 17, fontWeight: 600 }}>
          Something in the interface broke — your session is safe; the engine keeps it.
        </h3>
        <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
          <button type="button" onClick={this.tryAgain} autoFocus
            style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#eaeaea", color: "#111", fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
          <button type="button" onClick={this.reload}
            style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #666", background: "transparent", color: "#eaeaea", cursor: "pointer" }}>
            Reload interface
          </button>
        </div>
        <details style={{ fontSize: 12, color: "#9a9a9a" }}>
          <summary style={{ cursor: "pointer" }}>Technical details</summary>
          <pre style={{ whiteSpace: "pre-wrap", color: "#ff8a8a", fontSize: 12, marginTop: 8 }}>
            {String(error.stack || error)}
          </pre>
        </details>
      </div>
    );
  }
}
