import React, { useEffect, useMemo } from "react";
import { Text } from "@adobe/react-spectrum";
import { register } from "@adobe/uix-guest";
import { extensionId, rendererDataType } from "./constants";
import metadata from "../../../../app-metadata.json";
import { isTraceEnabled, summarize, trace } from "./trace";

const LAST_UE_EVENT_KEY = "ue.assetMetadataDefaults.lastUeEvent";

export default function ExtensionRegistration() {
  const isEmbedded = useMemo(() => window.self !== window.top, []);

  useEffect(() => {
    if (!isEmbedded) {
      return;
    }

    const init = async () => {
      await register({
        id: extensionId,
        metadata,
        debug: false,
        methods: {
          // Minimal event bridge (no console logging): forward host events to our renderer iframe
          // via localStorage so the renderer can react without polling.
          events: {
            listen(eventName, data) {
              try {
                const payload = {
                  ts: Date.now(),
                  eventName: String(eventName || ""),
                  data,
                };
                window.localStorage?.setItem(LAST_UE_EVENT_KEY, JSON.stringify(payload));
              } catch {
                // ignore
              }
              // Only log when debug is enabled.
              if (isTraceEnabled("tick")) {
                trace("tick", "[events.listen]", {
                  eventName: String(eventName || ""),
                  data: summarize(data),
                });
              }
            },
          },
          canvas: {
            getRenderers() {
              return [
                {
                  extension: extensionId,
                  dataType: rendererDataType,
                  url: "/index.html#/asset-metadata-default",
                },
              ];
            },
          },
        },
      });
    };

    init().catch(console.error);
  }, [isEmbedded]);

  if (!isEmbedded) {
    return (
      <Text>
        Local dev server is running. This page must be loaded inside Universal Editor (iframe) via the
        `ext=https://localhost:9080` local-dev URL parameter.
      </Text>
    );
  }

  return <Text>IFrame for integration with Host (Universal Editor)...</Text>;
}


