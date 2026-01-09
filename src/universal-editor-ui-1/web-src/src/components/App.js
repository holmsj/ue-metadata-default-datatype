import React from "react";
import { HashRouter as Router, Routes, Route } from "react-router-dom";
import { ErrorBoundary } from "react-error-boundary";
import ExtensionRegistration from "./ExtensionRegistration";
import AssetMetadataDefaultField from "./AssetMetadataDefaultField";

function Fallback({ error }) {
  return (
    <div style={{ padding: 12 }}>
      <pre>{String(error?.stack || error)}</pre>
    </div>
  );
}

export default function App() {
  return (
    <Router>
      <ErrorBoundary FallbackComponent={Fallback}>
        <Routes>
          <Route index element={<ExtensionRegistration />} />
          <Route path="index.html" element={<ExtensionRegistration />} />
          <Route path="asset-metadata-default" element={<AssetMetadataDefaultField />} />
        </Routes>
      </ErrorBoundary>
    </Router>
  );
}


