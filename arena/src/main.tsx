import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./kit/fonts.css";
import "./arena.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
