import "core-js/stable";
import "regenerator-runtime/runtime";

// eslint-disable-next-line unicorn/prefer-module
window.React = require("react");
import ReactDOM from "react-dom";

import Runtime, { init } from "@adobe/exc-app";

import App from "./components/App";

try {
  // attempt to load the Experience Cloud Runtime
  // eslint-disable-next-line unicorn/prefer-module
  require("./exc-runtime");
  // if there are no errors, bootstrap the app in the Experience Cloud Shell
  init(bootstrapInExcShell);
} catch (e) {
  // fallback mode, run the application without the Experience Cloud Runtime
  // eslint-disable-next-line no-console
  console.log("application not running in Adobe Experience Cloud Shell");
  bootstrapRaw();
}

function bootstrapRaw() {
  const mockRuntime = { on: () => {} };
  const mockIms = {};

  ReactDOM.render(<App runtime={mockRuntime} ims={mockIms} />, document.getElementById("root"));
}

function bootstrapInExcShell() {
  const runtime = Runtime();

  runtime.on("ready", ({ imsOrg, imsToken, imsProfile }) => {
    runtime.done();
    const ims = {
      profile: imsProfile,
      org: imsOrg,
      token: imsToken,
    };

    ReactDOM.render(<App runtime={runtime} ims={ims} />, document.getElementById("root"));
  });

  runtime.solution = {
    icon: "AdobeExperienceCloud",
    title: "asset-metadata-defaults",
    shortTitle: "asset-metadata-defaults",
  };
  runtime.title = "asset-metadata-defaults";
}


