import React, { useEffect, useMemo, useRef, useState } from "react";
import { attach } from "@adobe/uix-guest";
import {
  Provider,
  lightTheme,
  TextField,
  View,
  Flex,
  Text,
  ProgressCircle,
} from "@adobe/react-spectrum";

import { extensionId } from "./constants";

function normalizeProp(prop) {
  if (!prop) return "";
  return String(prop).replace(/^\//, "");
}

function pickAemConnection(connections = {}) {
  // connections example from docs: { "aemconnection": "aem:https://author.example.com" }
  const values = Object.values(connections)
    .filter(Boolean)
    .map((v) => String(v).trim())
    .filter(Boolean);
  // UE/EDS can use different connection schemes (e.g. aem:, xwalk:), but the value after the first ":" is typically a URL.
  const schemePrefixed = values.find((v) => /^[a-z][a-z0-9+.-]*:https?:\/\//i.test(v));
  if (schemePrefixed) return schemePrefixed.slice(schemePrefixed.indexOf(":") + 1);

  // Fallback: sometimes the value may already be a URL.
  const urlLike = values.find((v) => /^https?:\/\//i.test(v));
  if (urlLike) return urlLike;

  return null;
}

function parseResourceUrn(resource) {
  // Example: "urn:aemconnection:/content/xwalk-april/index/jcr:content/root/..."
  if (!resource || typeof resource !== "string") return null;
  if (!resource.startsWith("urn:")) return null;

  const parts = resource.split(":");
  if (parts.length < 3) return null;
  return {
    connectionName: parts[1] || "",
    path: parts.slice(2).join(":") || "",
  };
}

function extractResourceFromSelector(selector) {
  // Example selector snippet:
  // [data-aue-resource="urn:aemconnection:/content/..."] img[data-aue-type="media"]...
  if (!selector || typeof selector !== "string") return "";
  const m = selector.match(/data-aue-resource\s*=\s*"([^"]+)"/i);
  // Avoid optional-chaining-with-brackets to keep parsing compatible with older toolchains.
  const v = ((m && m[1]) || "").trim();
  return v.startsWith("urn:") ? v : "";
}

async function fetchComponentProp({ aemHost, resourcePath, propName, authScheme, token }) {
  if (!aemHost || !resourcePath || !propName) return "";
  const url = `${aemHost}${resourcePath}.json`;
  const headers = {};
  if (token) headers.Authorization = `${authScheme || "Bearer"} ${token}`;
  let res;
  try {
    res = await fetch(url, { headers, credentials: "include" });
  } catch (e) {
    // Most common cause here is CORS when running from https://localhost:9080
    throw new Error(
      `CORS/Network blocked while fetching component JSON from Author. ` +
        `Allow Origin https://localhost:9080 on ${aemHost} for ${resourcePath}.json`
    );
  }
  if (!res.ok) throw new Error(`Component fetch failed (${res.status}) for ${resourcePath}`);
  const json = await res.json();
  const v = json?.[propName];
  if (typeof v === "string") return v.trim();
  if (v == null) return "";
  return String(v);
}

function tryExtractDamPath(value) {
  const s = String(value || "");
  const idx = s.indexOf("/content/dam/");
  if (idx >= 0) {
    const tail = s.slice(idx).trim();
    // strip query string if any
    return tail.split("?")[0];
  }
  return "";
}

function normalizeAssetSignature(assetValue) {
  const s = String(assetValue || "").trim();
  if (!s) return "";
  // DM delivery URLs tend to have noisy query params; ignore them for cache purposes.
  if (s.startsWith("/adobe/dynamicmedia/deliver/")) return s.split("?")[0];
  return s;
}

function findSelectedEditable(editorState) {
  const selected = editorState?.selected || {};
  const selectedIds = Object.keys(selected).filter((k) => selected[k]);
  if (selectedIds.length === 0) return null;

  const id = selectedIds[0];
  return (editorState?.editables || []).find((e) => e.id === id) || null;
}

function resolveResource(editableById, editable) {
  if (!editable) return "";
  if (editable.resource) return editable.resource;
  const parent = editable.parentid ? editableById.get(editable.parentid) : null;
  return (parent && parent.resource) || extractResourceFromSelector(editable && editable.selector) || "";
}

function resolveProp(editable) {
  if (!editable) return "";
  return editable.prop || "";
}

function findNeighborEditable(editorState, selectedEditable, neighborFieldName) {
  const editables = editorState?.editables || [];
  const editableById = new Map(editables.map((e) => [e.id, e]));

  const selectedParentId = selectedEditable?.parentid || selectedEditable?.id || "";
  const want = normalizeProp(neighborFieldName);

  const candidates = editables
    .filter((e) => (e?.parentid || e?.id) && (e.parentid || e.id) && (e.parentid || e.id))
    .filter((e) => {
      const pid = e.parentid || "";
      return pid === selectedParentId;
    });

  // First, try same parent group.
  const inSameParent =
    candidates.find((e) => normalizeProp(resolveProp(e)) === want) ||
    candidates.find((e) => normalizeProp(resolveProp(e)).endsWith(`/${want}`));

  if (inSameParent) return inSameParent;

  // Fallback: try matching by resolved resource.
  const selectedResource = resolveResource(editableById, selectedEditable);
  if (!selectedResource) return null;

  return (
    editables.find(
      (e) =>
        resolveResource(editableById, e) === selectedResource &&
        normalizeProp(resolveProp(e)) === want
    ) ||
    editables.find(
      (e) =>
        resolveResource(editableById, e) === selectedResource &&
        normalizeProp(resolveProp(e)).endsWith(`/${want}`)
    ) ||
    null
  );
}

function getEditableValue(editable) {
  // UE examples show `content` for richtext; other types may differ.
  return (
    editable?.content ??
    editable?.value ??
    editable?.href ??
    editable?.src ??
    ""
  );
}

function resolveMetadataValue(metadataJson, requestedKey) {
  if (!metadataJson || typeof metadataJson !== "object") return { value: "", resolvedKey: "" };
  if (!requestedKey) return { value: "", resolvedKey: "" };

  const keys = Object.keys(metadataJson);
  const direct = metadataJson[requestedKey];
  if (direct !== undefined) return { value: direct, resolvedKey: requestedKey };

  const wantedLower = String(requestedKey).toLowerCase();
  const ciKey = keys.find((k) => String(k).toLowerCase() === wantedLower);
  if (ciKey) return { value: metadataJson[ciKey], resolvedKey: ciKey };

  // Some serializers/tooling may replace ":" in keys; try a conservative fallback.
  const colonToUnderscore = String(requestedKey).replace(/:/g, "_");
  const underscoreKey = keys.find((k) => String(k).toLowerCase() === colonToUnderscore.toLowerCase());
  if (underscoreKey) return { value: metadataJson[underscoreKey], resolvedKey: underscoreKey };

  return { value: "", resolvedKey: "" };
}

function stringifyMetadataValue(v) {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.filter(Boolean).join(", ");
  if (v == null) return "";
  return String(v);
}

async function fetchDamMetadataJson({ aemHost, assetPath, authScheme, token }) {
  if (!aemHost || !assetPath) return null;

  const url = `${aemHost}${assetPath}/jcr:content/metadata.json`;
  const headers = {};
  if (token) headers.Authorization = `${authScheme || "Bearer"} ${token}`;

  let res;
  try {
    res = await fetch(url, { headers, credentials: "include" });
  } catch (e) {
    throw new Error(
      `CORS/Network blocked while fetching DAM metadata from Author. ` +
        `Allow Origin https://localhost:9080 on ${aemHost} for ${assetPath}/jcr:content/metadata.json`
    );
  }
  if (!res.ok) {
    throw new Error(`Metadata fetch failed (${res.status}) for ${assetPath}`);
  }

  return await res.json();
}

export default function AssetMetadataDefaultField() {
  const isEmbedded = useMemo(() => window.self !== window.top, []);
  const [connection, setConnection] = useState(null);
  const [model, setModel] = useState(null);
  const [value, setValue] = useState("");
  const [status, setStatus] = useState({ state: "idle", message: "" });
  const [debug, setDebug] = useState({
    aemHost: "",
    selectedResource: "",
    connectionName: "",
    connectionsKeys: "",
    connectionValue: "",
    customTokensKeys: "",
    customTokenValue: "",
    parsedHostFromConnectionValue: "",
    neighborProp: "",
    assetPath: "",
    resolvedDamPath: "",
    metadataKeysSample: "",
    metadataKeyResolved: "",
    siblingProps: "",
    lastError: "",
  });

  const lastSeenAssetRef = useRef(null);
  const lastAppliedAssetRef = useRef(null);
  const valueRef = useRef("");
  const cooldownUntilRef = useRef(0);
  const persistedDamCacheRef = useRef(new Map());
  const tickCounterRef = useRef(0);
  const lastTraceKeyRef = useRef("");
  const lastTraceResolvedDamPathRef = useRef("");

  const config = useMemo(() => {
    return {
      assetField: model?.assetField || "image",
      metadataKey: model?.metadataKey || "dc:title",
    };
  }, [model]);

  const trace = (...args) => {
    // eslint-disable-next-line no-console
    console.log("[ue-metadata-default]", ...args);
  };

  useEffect(() => {
    if (!isEmbedded) {
      return;
    }

    (async () => {
      const c = await attach({ id: extensionId });
      setConnection(c);

      const m = await c.host.field.getModel();
      setModel(m);

      const v = await c.host.field.getValue();
      const next = v || "";
      setValue(next);
      valueRef.current = next;

      // Try to reduce iframe jitter in the rail.
      await c.host.field.setHeight?.(110);
    })().catch((e) => {
      console.error(e);
      setStatus({ state: "error", message: String(e?.message || e) });
      setDebug((d) => ({ ...d, lastError: String(e?.message || e) }));
    });
  }, [isEmbedded]);

  // Keep local state in sync when user edits.
  const onChange = (v) => {
    setValue(v);
    valueRef.current = v;
    connection?.host?.field?.onChange(v);
  };

  useEffect(() => {
    if (!connection) return;

    let cancelled = false;
    const tickMs = 800;

    const interval = setInterval(() => {
      (async () => {
        const tick = (tickCounterRef.current += 1);
        const now = Date.now();
        if (cooldownUntilRef.current && now < cooldownUntilRef.current) {
          return;
        }

        const editorState = await connection.host.editorState.get();
        const editables = editorState?.editables || [];
        const editableById = new Map(editables.map((e) => [e.id, e]));

        const selectedEditable = findSelectedEditable(editorState);
        if (!selectedEditable) return;

        const connections = editorState?.connections || {};
        const connectionsKeys = Object.keys(connections).join(", ");
        const customTokens = editorState?.customTokens || {};
        const customTokensKeys = Object.keys(customTokens).join(", ");

        // NOTE: field editables often have `resource: ""` while the parent component editable
        // carries the actual URN resource. Always resolve via parentid when needed.
        const selectedResource = resolveResource(editableById, selectedEditable) || "";
        const urn = parseResourceUrn(selectedResource);
        const connectionName = urn?.connectionName || "";
        const connectionValue = connectionName ? String(connections?.[connectionName] || "") : "";
        const customTokenValue = connectionName ? String(customTokens?.[connectionName] || "") : "";

        const parsedHostFromConnectionValue = pickAemConnection({ tmp: connectionValue }) || "";

        const aemHost =
          (connectionName && pickAemConnection({ [connectionName]: connectionValue })) ||
          (connectionName && pickAemConnection({ [connectionName]: customTokenValue })) ||
          pickAemConnection(connections) ||
          pickAemConnection(customTokens) ||
          null;

        const neighbor = findNeighborEditable(editorState, selectedEditable, config.assetField);
        const neighborProp = neighbor?.prop || "";
        const assetRawValue = String(getEditableValue(neighbor) || "").trim();
        const assetPath = assetRawValue;
        const assetSignature = normalizeAssetSignature(assetRawValue);

        const token = connection.sharedContext?.get("token");
        const authScheme = connection.sharedContext?.get("authScheme") || "Bearer";

        // Resolve a DAM path in Author-first mode.
        let resolvedDamPath = "";
        if (assetPath.startsWith("/content/dam/")) {
          resolvedDamPath = assetPath.split("?")[0];
        } else {
          resolvedDamPath = tryExtractDamPath(assetPath);
        }
        // If UE gives us a delivery URL (e.g. DM deliver), fall back to reading the persisted component JSON.
        if (!resolvedDamPath && urn?.path && aemHost) {
          // Cache must be invalidated when the selected asset changes; include the current asset field value.
          const cacheKey = `${aemHost}|${urn.path}|${config.assetField}|${assetSignature}`;
          const cached = persistedDamCacheRef.current.get(cacheKey);
          if (cached) {
            resolvedDamPath = cached;
          } else {
            const persisted = await fetchComponentProp({
              aemHost,
              resourcePath: urn.path,
              propName: config.assetField,
              authScheme,
              token,
            });
            const nextResolved = persisted.startsWith("/content/dam/") ? persisted : tryExtractDamPath(persisted);
            if (nextResolved) {
              persistedDamCacheRef.current.set(cacheKey, nextResolved);
            }
            resolvedDamPath = nextResolved;
          }
        }

        const siblingProps = (editorState?.editables || [])
          .filter((e) => (e?.parentid || "") === (selectedEditable.parentid || selectedEditable.id || ""))
          .map((e) => normalizeProp(e?.prop || ""))
          .filter(Boolean)
          .slice(0, 10)
          .join(", ");

        setDebug({
          aemHost: aemHost || "",
          selectedResource: selectedResource || "",
          connectionName,
          connectionsKeys,
          connectionValue,
          customTokensKeys,
          customTokenValue,
          parsedHostFromConnectionValue,
          neighborProp: String(neighborProp || ""),
          assetPath,
          resolvedDamPath,
          metadataKeysSample: "",
          metadataKeyResolved: "",
          siblingProps,
          lastError: "",
        });

        // Trace key changes (selection/asset/DAM changes) at high signal only.
        const traceKey = [
          selectedResource || "",
          neighborProp || "",
          assetSignature || "",
          resolvedDamPath || "",
        ].join("|");
        if (traceKey && traceKey !== lastTraceKeyRef.current) {
          lastTraceKeyRef.current = traceKey;
          trace(
            `tick=${tick}`,
            `selectedResource=${selectedResource ? String(selectedResource).slice(0, 96) + "…" : "(none)"}`,
            `assetField=${config.assetField}`,
            `neighborProp=${neighborProp || "(none)"}`,
            `assetSignature=${assetSignature || "(none)"}`,
            `resolvedDamPath=${resolvedDamPath || "(none)"}`,
            `currentAlt="${valueRef.current || ""}"`
          );
        }

        if (!resolvedDamPath || !resolvedDamPath.startsWith("/content/dam/")) return;

        const assetChanged = lastSeenAssetRef.current && lastSeenAssetRef.current !== resolvedDamPath;
        const shouldApply =
          assetChanged || (!valueRef.current && lastAppliedAssetRef.current !== resolvedDamPath);

        if (resolvedDamPath !== lastTraceResolvedDamPathRef.current) {
          lastTraceResolvedDamPathRef.current = resolvedDamPath;
          trace(
            `tick=${tick}`,
            `decision assetChanged=${Boolean(assetChanged)}`,
            `valueEmpty=${!valueRef.current}`,
            `lastSeen=${lastSeenAssetRef.current || "(none)"}`,
            `lastApplied=${lastAppliedAssetRef.current || "(none)"}`,
            `shouldApply=${Boolean(shouldApply)}`
          );
        }

        lastSeenAssetRef.current = resolvedDamPath;

        if (!shouldApply) return;

        trace(
          `tick=${tick}`,
          `APPLY start`,
          `resolvedDamPath=${resolvedDamPath}`,
          `metadataKey=${config.metadataKey}`
        );
        setStatus({ state: "loading", message: `Fetching ${config.metadataKey}…` });

        const metadataJson = await fetchDamMetadataJson({
          aemHost,
          assetPath: resolvedDamPath,
          authScheme,
          token,
        });
        const keysSample = metadataJson ? Object.keys(metadataJson).slice(0, 18).join(", ") : "";
        const resolved = resolveMetadataValue(metadataJson, config.metadataKey);
        const metadataValue = stringifyMetadataValue(resolved.value);

        if (cancelled) return;

        lastAppliedAssetRef.current = resolvedDamPath;
        trace(
          `tick=${tick}`,
          `APPLY fetched`,
          `metadataKeyResolved=${resolved.resolvedKey || "(none)"}`,
          `metadataValue="${metadataValue}"`,
          `metadataKeysSample=${keysSample || "(none)"}`
        );

        try {
          connection.host.field.onChange(metadataValue);
        } catch (e) {
          trace(`tick=${tick}`, `APPLY onChange threw`, e);
          throw e;
        }
        setValue(metadataValue);
        valueRef.current = metadataValue;
        setDebug((d) => ({
          ...d,
          metadataKeysSample: keysSample,
          metadataKeyResolved: resolved.resolvedKey || "",
        }));
        setStatus({
          state: "done",
          message: metadataValue
            ? `Auto-filled from ${resolved.resolvedKey || config.metadataKey}`
            : `No value found for ${config.metadataKey}`,
        });
        trace(`tick=${tick}`, `APPLY done`, `newAlt="${metadataValue}"`);
      })().catch((e) => {
        if (cancelled) return;
        console.error(e);
        const msg = String(e?.message || e);
        setStatus({ state: "error", message: msg });
        setDebug((d) => ({ ...d, lastError: msg }));
        // Avoid spamming the author with repeated failing requests.
        cooldownUntilRef.current = Date.now() + 8000;
        trace(`tick=${tickCounterRef.current}`, `ERROR`, msg);
      });
    }, tickMs);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // Intentionally not depending on `value` to avoid resetting the interval;
    // we read the latest `value` from state closure (good enough for v1).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, config.assetField, config.metadataKey]);

  if (!isEmbedded) {
    return (
      <Provider theme={lightTheme} colorScheme="light">
        <View padding="size-100">
          <Text>
            This renderer must be loaded inside Universal Editor. Open UE with
            `ext=https://localhost:9080`.
          </Text>
        </View>
      </Provider>
    );
  }

  return (
    <Provider theme={lightTheme} colorScheme="light">
      <View padding="size-100">
        <Flex direction="column" gap="size-75">
          <TextField
            label={model?.label || model?.name || "Value"}
            aria-label={model?.label || model?.name || "Value"}
            value={value}
            onChange={onChange}
            width="100%"
          />

          <Flex direction="row" alignItems="center" gap="size-65">
            {status.state === "loading" && <ProgressCircle size="S" aria-label="Loading" isIndeterminate />}
            <Text>
              {status.message ||
                `Defaults: ${config.metadataKey} ← ${config.assetField}`}
            </Text>
          </Flex>

          <View paddingTop="size-50">
            <Text>
              Debug: asset={debug.assetPath || "(none)"} | aemHost={debug.aemHost || "(none)"}
            </Text>
            <Text>
              Debug: selectedResource={debug.selectedResource ? String(debug.selectedResource).slice(0, 48) + "…" : "(none)"} | neighborProp={debug.neighborProp || "(none)"}
            </Text>
            <Text>
              Debug: connectionName={debug.connectionName || "(none)"} | connections={debug.connectionsKeys || "(none)"}
            </Text>
            <Text>
              Debug: connectionValue={debug.connectionValue || "(none)"} | customTokens={debug.customTokensKeys || "(none)"}
            </Text>
            <Text>
              Debug: customTokenValue={debug.customTokenValue || "(none)"} | resolvedDamPath={debug.resolvedDamPath || "(none)"}
            </Text>
            <Text>
              Debug: parsedHostFromConnectionValue={debug.parsedHostFromConnectionValue || "(none)"}
            </Text>
            <Text>
              Debug: metadataKeyResolved={debug.metadataKeyResolved || "(none)"}
            </Text>
            <Text>
              Debug: metadataKeysSample={debug.metadataKeysSample || "(none)"}
            </Text>
            <Text>
              Debug: siblingProps={debug.siblingProps || "(none)"}
            </Text>
            {debug.lastError && (
              <Text UNSAFE_style={{ color: "#b40000" }}>
                Error: {debug.lastError}
              </Text>
            )}
          </View>
        </Flex>
      </View>
    </Provider>
  );
}


