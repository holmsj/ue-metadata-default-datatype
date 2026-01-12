import "core-js/stable";
import "regenerator-runtime/runtime";

// eslint-disable-next-line unicorn/prefer-module
window.React = require("react");
import React from "react";
import ReactDOM from "react-dom";

import ExtensionRegistration from "./components/ExtensionRegistration";
import AssetMetadataDefaultField from "./components/AssetMetadataDefaultField";

// De-SPA: avoid React Router and the Experience Cloud Shell runtime bootstrap in the renderer iframe.
// UE loads this page in iframes and may mount/unmount quickly during startup; keep the entrypoint minimal and idempotent.

function pickViewFromLocation() {
  // We keep compatibility with existing renderer URLs like: /index.html#/asset-metadata-default
  const hash = String(window.location.hash || "");
  if (hash.includes("asset-metadata-default")) return "asset-metadata-default";
  return "registration";
}

function mountOnce() {
  const root = document.getElementById("root");
  if (!root) return;

  const view = pickViewFromLocation();

  // Guard against double-boot (observed as multiple tick=1 logs).
  const guardKey = `__UE_METADATA_DEFAULT_BOOTED__${view}`;
  if (window[guardKey]) return;
  window[guardKey] = true;

  if (view === "asset-metadata-default") {
    ReactDOM.render(<AssetMetadataDefaultField />, root);
  } else {
    ReactDOM.render(<ExtensionRegistration />, root);
  }
}

mountOnce();


