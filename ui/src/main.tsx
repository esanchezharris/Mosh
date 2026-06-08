import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Resilience: a single component throwing during render must NOT blank the whole
// app (React unmounts the entire tree on an uncaught render error). This boundary
// shows the error in-app instead of a black screen, so a localized UI bug stays
// localized and is diagnosable from the window itself.
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <div style={{ padding: 24, fontFamily: "system-ui", color: "#eaeaea" }}>
          <h3 style={{ margin: "0 0 8px" }}>Mosh UI error</h3>
          <pre style={{ whiteSpace: "pre-wrap", color: "#ff8a8a", fontSize: 12 }}>
            {String(this.state.error.stack || this.state.error)}
          </pre>
        </div>
      );
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
