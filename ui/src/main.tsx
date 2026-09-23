if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  void import("react-grab");
  void import("react-scan").then(({ scan }) => scan());
}

import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { useSettings } from "./settings/store";
import "./ui/mosh.css";
import "./fonts/nanum.css";

// Load UI-local settings from localStorage and project skin/theme/scale onto <html>
// BEFORE first paint, so a non-default skin/theme renders correctly with no flash.
useSettings.getState().hydrate();

// Resilience: a single component throwing during render must NOT blank the whole app.
// See ErrorBoundary.tsx — friendly copy, Try again (primary) and Reload interface.
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
