import React, { useEffect, useMemo } from "react";
import { Text } from "@adobe/react-spectrum";
import { register } from "@adobe/uix-guest";
import { extensionId, rendererDataType } from "./constants";
import metadata from "../../../../app-metadata.json";

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
        debug: true,
        methods: {
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


