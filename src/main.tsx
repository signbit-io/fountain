import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyMotion, readMotion } from "./lib/activity";

// Before the first paint, so a user who turned animations off never sees one on launch.
applyMotion(readMotion());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
