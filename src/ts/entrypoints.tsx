import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { entrypoints } from "uxp";
import { app } from "photoshop";
import { App } from "./ui/App";
import { refreshForActiveDocument } from "./core/controller";

const POLL_MS = 2000;

let pollTimer: number | null = null;
let lastDocPath: string | null = null;
let root: Root | null = null;

entrypoints.setup({
  panels: {
    timelapsePanel: {
      show() {
        const container = document.getElementById("root");
        if (container && !root) {
          root = createRoot(container);
          root.render(<App />);
        }
        startPolling();
      },
      hide() {
        stopPolling();
      },
    },
  },
});

// UXP has no reliably-documented "active document changed" notification, so
// polling the active document's path is the simple, robust way to detect a
// document switch and re-sync the panel while it's visible.
function startPolling(): void {
  if (pollTimer != null) return;
  pollTimer = window.setInterval(() => {
    const doc = app.activeDocument;
    let path: string | null = null;
    try {
      path = doc ? doc.path : null;
    } catch (e) {
      path = null;
    }
    if (path !== lastDocPath) {
      lastDocPath = path;
      void refreshForActiveDocument();
    }
  }, POLL_MS);
}

function stopPolling(): void {
  if (pollTimer != null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}
