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
import { getTraceLevel, trace, traceFn, summarize } from "./trace";

// TEMP: Stability test. When enabled, the renderer does *no* UE host attachment, no editorState reads,
// no event listening, and no network calls. It just renders placeholder UI.
const STATIC_PLACEHOLDER_MODE = false;

// Track last resolved DAM path for a given selected resource (per iframe session).
// This survives React unmount/remount (which can happen frequently in UE) and avoids relying on localStorage.
const lastDamPathBySelectionKey = new Map();

/**
 * Normalize a UE `prop` identifier to a stable comparison key.
 * @param {string} prop
 * @returns {string}
 */
const normalizeProp = traceFn("normalizeProp", "all", function normalizeProp(prop) {
  if (!prop) return "";
  return String(prop).replace(/^\//, "");
});

/**
 * Pick the AEM Author base URL from UE `editorState.connections` / `editorState.customTokens`.
 * Values often look like `aem:https://author.example.com` (scheme + URL).
 *
 * @param {Record<string, string>} connections
 * @returns {string|null}
 */
const pickAemConnection = traceFn("pickAemConnection", "all", function pickAemConnection(connections = {}) {
  const values = Object.values(connections)
    .filter(Boolean)
    .map((v) => String(v).trim())
    .filter(Boolean);
  const schemePrefixed = values.find((v) => /^[a-z][a-z0-9+.-]*:https?:\/\//i.test(v));
  if (schemePrefixed) return schemePrefixed.slice(schemePrefixed.indexOf(":") + 1);

  const urlLike = values.find((v) => /^https?:\/\//i.test(v));
  if (urlLike) return urlLike;

  return null;
});

/**
 * Parse UE resource URNs like: `urn:<connectionName>:<path...>`
 * @param {string} resource
 * @returns {{connectionName: string, path: string} | null}
 */
const parseResourceUrn = traceFn("parseResourceUrn", "all", function parseResourceUrn(resource) {
  if (!resource || typeof resource !== "string") return null;
  if (!resource.startsWith("urn:")) return null;

  const parts = resource.split(":");
  if (parts.length < 3) return null;
  return {
    connectionName: parts[1] || "",
    path: parts.slice(2).join(":") || "",
  };
});

/**
 * Extract the `data-aue-resource="urn:..."` value from an editable selector string.
 * @param {string} selector
 * @returns {string}
 */
const extractResourceFromSelector = traceFn(
  "extractResourceFromSelector",
  "all",
  function extractResourceFromSelector(selector) {
    if (!selector || typeof selector !== "string") return "";
    const m = selector.match(/data-aue-resource\s*=\s*"([^"]+)"/i);
    // Avoid optional-chaining-with-brackets to keep parsing compatible with older toolchains.
    const v = ((m && m[1]) || "").trim();
    return v.startsWith("urn:") ? v : "";
  }
);

/**
 * Fetch a component JSON model (`<resourcePath>.json`) and return a single property value.
 * Used when the asset field is a DM delivery URL and we need the persisted `/content/dam/...` reference.
 *
 * @param {{aemHost: string, resourcePath: string, propName: string, authScheme?: string, token?: string}} params
 * @returns {Promise<string>}
 */
const fetchComponentProp = traceFn(
  "fetchComponentProp",
  "all",
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
);

/**
 * Attempt to extract a `/content/dam/...` path from arbitrary strings/URLs.
 * @param {string} value
 * @returns {string}
 */
const tryExtractDamPath = traceFn("tryExtractDamPath", "all", function tryExtractDamPath(value) {
  const s = String(value || "");
  const idx = s.indexOf("/content/dam/");
  if (idx >= 0) {
    const tail = s.slice(idx).trim();
    return tail.split("?")[0];
  }
  return "";
});

/**
 * Return the last path segment ("basename") of a URL/path (query stripped).
 * Used to sanity-check that the persisted DAM path matches the selected DM URL.
 * @param {string} s
 * @returns {string}
 */
function basename(s) {
  const v = String(s || "").split("?")[0];
  const parts = v.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

/**
 * Normalize the neighbor asset value into a stable signature for caching decisions.
 * @param {string} assetValue
 * @returns {string}
 */
const normalizeAssetSignature = traceFn(
  "normalizeAssetSignature",
  "all",
  function normalizeAssetSignature(assetValue) {
    const s = String(assetValue || "").trim();
    if (!s) return "";
    if (s.startsWith("/adobe/dynamicmedia/deliver/")) return s.split("?")[0];
    return s;
  }
);

/**
 * Return the first selected editable from editorState.
 * @param {any} editorState
 * @returns {any|null}
 */
const findSelectedEditable = traceFn("findSelectedEditable", "all", function findSelectedEditable(editorState) {
  const selected = editorState?.selected || {};
  const selectedIds = Object.keys(selected).filter((k) => selected[k]);
  if (selectedIds.length === 0) return null;

  const id = selectedIds[0];
  return (editorState?.editables || []).find((e) => e.id === id) || null;
});

/**
 * Resolve a stable URN resource for a field editable by falling back to its parent or selector.
 * @param {Map<string, any>} editableById
 * @param {any} editable
 * @returns {string}
 */
const resolveResource = traceFn("resolveResource", "all", function resolveResource(editableById, editable) {
  if (!editable) return "";
  if (editable.resource) return editable.resource;
  const parent = editable.parentid ? editableById.get(editable.parentid) : null;
  return (parent && parent.resource) || extractResourceFromSelector(editable && editable.selector) || "";
});

/**
 * Get the `prop` identifier from an editable.
 * @param {any} editable
 * @returns {string}
 */
const resolveProp = traceFn("resolveProp", "all", function resolveProp(editable) {
  if (!editable) return "";
  return editable.prop || "";
});

/**
 * Find the neighbor editable for a given field name (e.g. `image`) relative to the selected editable.
 * @param {any} editorState
 * @param {any} selectedEditable
 * @param {string} neighborFieldName
 * @returns {any|null}
 */
const findNeighborEditable = traceFn(
  "findNeighborEditable",
  "all",
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

    const inSameParent =
      candidates.find((e) => normalizeProp(resolveProp(e)) === want) ||
      candidates.find((e) => normalizeProp(resolveProp(e)).endsWith(`/${want}`));

    if (inSameParent) return inSameParent;

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
);

/**
 * Extract a useful "value" from a UE editable, across different field types.
 * @param {any} editable
 * @returns {string}
 */
const getEditableValue = traceFn("getEditableValue", "all", function getEditableValue(editable) {
  return (
    editable?.content ??
    editable?.value ??
    editable?.href ??
    editable?.src ??
    ""
  );
});

/**
 * Resolve a metadata key from the fetched metadata JSON:
 * - exact match
 * - case-insensitive match
 * - `:` -> `_` fallback (some serializers normalize keys)
 *
 * @param {Record<string, any>|null} metadataJson
 * @param {string} requestedKey
 * @returns {{value: any, resolvedKey: string}}
 */
const resolveMetadataValue = traceFn(
  "resolveMetadataValue",
  "all",
  function resolveMetadataValue(metadataJson, requestedKey) {
    if (!metadataJson || typeof metadataJson !== "object") return { value: "", resolvedKey: "" };
    if (!requestedKey) return { value: "", resolvedKey: "" };

    const keys = Object.keys(metadataJson);
    const direct = metadataJson[requestedKey];
    if (direct !== undefined) return { value: direct, resolvedKey: requestedKey };

    const wantedLower = String(requestedKey).toLowerCase();
    const ciKey = keys.find((k) => String(k).toLowerCase() === wantedLower);
    if (ciKey) return { value: metadataJson[ciKey], resolvedKey: ciKey };

    const colonToUnderscore = String(requestedKey).replace(/:/g, "_");
    const underscoreKey = keys.find((k) => String(k).toLowerCase() === colonToUnderscore.toLowerCase());
    if (underscoreKey) return { value: metadataJson[underscoreKey], resolvedKey: underscoreKey };

    return { value: "", resolvedKey: "" };
  }
);

/**
 * Convert a metadata field value into a string suitable for writing into a text field.
 * @param {any} v
 * @returns {string}
 */
const stringifyMetadataValue = traceFn(
  "stringifyMetadataValue",
  "all",
  function stringifyMetadataValue(v) {
    if (typeof v === "string") return v.trim();
    if (Array.isArray(v)) return v.filter(Boolean).join(", ");
    if (v == null) return "";
    return String(v);
  }
);

/**
 * Fetch the AEM Author DAM metadata JSON for a selected asset.
 * @param {{aemHost: string, assetPath: string, authScheme?: string, token?: string}} params
 * @returns {Promise<Record<string, any> | null>}
 */
const fetchDamMetadataJson = traceFn(
  "fetchDamMetadataJson",
  "all",
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
);

function StaticPlaceholderField() {
  const isEmbedded = useMemo(() => window.self !== window.top, []);

  if (!isEmbedded) {
    return (
      <Provider theme={lightTheme} colorScheme="light">
        <View padding="size-100">
          <Text>
            Placeholder mode (not embedded). Load this inside Universal Editor.
          </Text>
        </View>
      </Provider>
    );
  }

  return (
    <Provider theme={lightTheme} colorScheme="light">
      <View padding="size-100">
        <Flex direction="column" gap="size-100">
          <Text>Placeholder mode: dynamic behavior disabled (stability test).</Text>

          <TextField
            label="Alt Text (placeholder)"
            aria-label="Alt Text (placeholder)"
            value="(static placeholder value)"
            isReadOnly
            width="100%"
          />

          <TextField
            label="Status (placeholder)"
            aria-label="Status (placeholder)"
            value="No attach/editorState/events/network in this mode."
            isReadOnly
            width="100%"
          />
        </Flex>
      </View>
    </Provider>
  );
}

function LiveAssetMetadataDefaultField() {
  /**
   * Component entrypoint for the `uix-asset-metadata-default` field renderer.
   * The UE host loads this as an iframe; we attach to the host field and poll editorState
   * to detect selection/asset changes.
   */
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
  const runSeqRef = useRef(0);
  const runScheduledRef = useRef(false);
  const lastRunReasonRef = useRef("");
  const lastUeEventTsRef = useRef(0);

  // Debug UI is controlled by the same single flag as console tracing.
  // Any non-off value shows debug UI.
  const showDebug = useMemo(() => getTraceLevel() !== "off", []);

  const config = useMemo(() => {
    // Field model comes from UE; keep config defaults stable for v1.
    return {
      assetField: model?.assetField || "image",
      metadataKey: model?.metadataKey || "dc:title",
    };
  }, [model]);

  useEffect(() => {
    if (!isEmbedded) {
      return;
    }

    (async () => {
      trace("tick", "AssetMetadataDefaultField:attach:start");
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
      trace("tick", "AssetMetadataDefaultField:attach:done", {
        model: summarize(m),
        initialValue: summarize(next),
      });
    })().catch((e) => {
      console.error(e);
      setStatus({ state: "error", message: String(e?.message || e) });
      if (showDebug) setDebug((d) => ({ ...d, lastError: String(e?.message || e) }));
      trace("tick", "AssetMetadataDefaultField:attach:error", { message: String(e?.message || e) });
    });
  }, [isEmbedded, showDebug]);

  /**
   * Run one evaluation cycle: read editorState, resolve asset, decide whether to fetch/apply metadata.
   * This replaces polling when host events are available.
   *
   * @param {string} reason
   */
  const runOnce = async (reason) => {
    if (!connection) return;
    const seq = (runSeqRef.current += 1);
    lastRunReasonRef.current = reason;
    trace("tick", "AssetMetadataDefaultField:runOnce:start", { seq, reason });

    const now = Date.now();
    if (cooldownUntilRef.current && now < cooldownUntilRef.current) {
      trace("tick", "AssetMetadataDefaultField:runOnce:cooldown", { seq, reason });
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

    let resolvedDamPath = "";
    if (assetPath.startsWith("/content/dam/")) {
      resolvedDamPath = assetPath.split("?")[0];
    } else {
      resolvedDamPath = tryExtractDamPath(assetPath);
    }

    if (!resolvedDamPath && urn?.path && aemHost) {
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
        // IMPORTANT: `aue:content-patch` can fire before the new asset selection is persisted.
        // In that case, `hero.json` can still return the previously persisted DAM path.
        // If we cache that stale value under the *new* DM URL signature, retries will keep seeing
        // the old DAM path (off-by-one / "lags 1").
        //
        // Sanity-check convergence by comparing filenames:
        // - DM delivery URL ends with `<fileName>`
        // - persisted DAM path ends with `<fileName>`
        // If they don't match, treat as "not converged yet" and wait for the next retry.
        const dmName = basename(assetSignature);
        const damName = basename(nextResolved);
        const looksStale = Boolean(dmName && damName && dmName !== damName);
        if (looksStale) {
          trace("tick", `run=${seq}:persistedDam:notConverged`, {
            reason,
            dmName,
            damName,
            assetSignature,
            persisted,
            nextResolved,
          });
          resolvedDamPath = "";
        } else {
          if (nextResolved) {
            persistedDamCacheRef.current.set(cacheKey, nextResolved);
          }
          resolvedDamPath = nextResolved;
        }
      }
    }

    const siblingProps = (editorState?.editables || [])
      .filter((e) => (e?.parentid || "") === (selectedEditable.parentid || selectedEditable.id || ""))
      .map((e) => normalizeProp(e?.prop || ""))
      .filter(Boolean)
      .slice(0, 10)
      .join(", ");

    if (showDebug) {
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
    }

    const traceKey = [selectedResource || "", neighborProp || "", assetSignature || "", resolvedDamPath || ""].join("|");
    if (traceKey && traceKey !== lastTraceKeyRef.current) {
      lastTraceKeyRef.current = traceKey;
      trace("tick", `run=${seq}:stateChanged`, {
        reason,
        selectedResource: selectedResource ? String(selectedResource).slice(0, 96) + "…" : "(none)",
        assetField: config.assetField,
        neighborProp: neighborProp || "(none)",
        assetSignature: assetSignature || "(none)",
        resolvedDamPath: resolvedDamPath || "(none)",
        currentAlt: valueRef.current || "",
      });
    }

    if (!resolvedDamPath || !resolvedDamPath.startsWith("/content/dam/")) return;

    // Determine whether the asset actually changed (vs an event firing before persisted state converges).
    // We key by selected resource + assetField to survive UI remounts without using localStorage.
    const selectionKey = `${selectedResource || ""}|${config.assetField}`;
    const prevDamPath = lastDamPathBySelectionKey.get(selectionKey) || "";
    const assetChanged = Boolean(prevDamPath) && prevDamPath !== resolvedDamPath;
    if (!prevDamPath || assetChanged) {
      lastDamPathBySelectionKey.set(selectionKey, resolvedDamPath);
    }

    // Overwrite policy (Option B):
    // - Only auto-fill when a NEW asset is selected (i.e. the neighbor asset field changes).
    // - Do NOT auto-fill merely because the field is empty. Empty may be intentional.
    //
    // Event nuance:
    // - The first time an author selects an asset, `prevDamPath` may be empty.
    //   We treat that as a "selection" only when triggered by an actual content-patch event.
    const isContentPatchEvent =
      typeof reason === "string" &&
      (reason.startsWith("ueEvent:aue:content-patch") || reason.startsWith("ueEvent:aue:content-details"));
    const isFirstAssetSelection = !prevDamPath && Boolean(resolvedDamPath) && isContentPatchEvent;

    // Only apply for a new (or first) selection, and only once per resolvedDamPath.
    const shouldApply =
      (assetChanged || isFirstAssetSelection) &&
      lastAppliedAssetRef.current !== resolvedDamPath;

    if (resolvedDamPath !== lastTraceResolvedDamPathRef.current) {
      lastTraceResolvedDamPathRef.current = resolvedDamPath;
      trace("tick", `run=${seq}:decision`, {
        reason,
        assetChanged,
        isFirstAssetSelection,
        valueEmpty: !valueRef.current,
        prevDamPath: prevDamPath || "(none)",
        lastApplied: lastAppliedAssetRef.current || "(none)",
        shouldApply: Boolean(shouldApply),
      });
    }

    // Track what we're currently seeing for debugging only (not used for apply decisions).
    lastSeenAssetRef.current = resolvedDamPath;
    if (!shouldApply) return;

    trace("tick", `run=${seq}:apply:start`, {
      reason,
      resolvedDamPath,
      metadataKey: config.metadataKey,
    });
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

    lastAppliedAssetRef.current = resolvedDamPath;
    trace("tick", `run=${seq}:apply:fetched`, {
      reason,
      metadataKeyResolved: resolved.resolvedKey || "(none)",
      metadataValue,
    });

    connection.host.field.onChange(metadataValue);
    setValue(metadataValue);
    valueRef.current = metadataValue;
    if (showDebug) {
      setDebug((d) => ({
        ...d,
        metadataKeysSample: keysSample,
        metadataKeyResolved: resolved.resolvedKey || "",
      }));
    }
    setStatus({
      state: "done",
      message: metadataValue
        ? `Auto-filled from ${resolved.resolvedKey || config.metadataKey}`
        : `No value found for ${config.metadataKey}`,
    });
    trace("tick", `run=${seq}:apply:done`, { reason, newAlt: metadataValue });
  };

  // Schedule a runOnce (debounced) for bursty event streams.
  const scheduleRun = (reason) => {
    if (!connection) return;
    if (runScheduledRef.current) return;
    runScheduledRef.current = true;
    setTimeout(() => {
      runScheduledRef.current = false;
      runOnce(reason).catch((e) => {
        const msg = String(e?.message || e);
        setStatus({ state: "error", message: msg });
        if (showDebug) setDebug((d) => ({ ...d, lastError: msg }));
        cooldownUntilRef.current = Date.now() + 8000;
        // eslint-disable-next-line no-console
        console.error(e);
      });
    }, 25);
  };

  /**
   * Re-check shortly after an event. In practice, `aue:content-patch` can arrive before
   * `host.editorState.get()` reflects the new values. A couple delayed runs makes this
   * robust without reverting to constant polling.
   *
   * @param {number} ms
   * @param {string} reason
   */
  const scheduleRunAfter = (ms, reason) => {
    if (!connection) return;
    setTimeout(() => scheduleRun(reason), ms);
  };

  // Keep local state in sync when user edits.
  const onChange = (v) => {
    trace("tick", "AssetMetadataDefaultField:onChange", { value: summarize(v) });
    setValue(v);
    valueRef.current = v;
    connection?.host?.field?.onChange(v);
  };

  useEffect(() => {
    if (!connection) return;
    // Initial evaluation once the connection exists.
    scheduleRun("initial");

    const onStorage = (e) => {
      if (!e || e.key !== "ue.assetMetadataDefaults.lastUeEvent") return;
      try {
        const parsed = JSON.parse(String(e.newValue || "{}"));
        const name = String(parsed?.eventName || "");
        const ts = Number(parsed?.ts || 0);
        if (ts && ts === lastUeEventTsRef.current) return;
        if (ts) lastUeEventTsRef.current = ts;
        // Only react to events likely to impact authored values / selection.
        if (!name) return;
        if (
          name === "aue:content-patch" ||
          name === "aue:content-details" ||
          name === "aue:ui-select" ||
          name.startsWith("aue:")
        ) {
          scheduleRun(`ueEvent:${name}`);
          // For content patches, re-check after a short delay in case editorState is not yet updated.
          if (name === "aue:content-patch") {
            scheduleRunAfter(250, `ueEvent:${name}:retry250`);
            scheduleRunAfter(1000, `ueEvent:${name}:retry1000`);
          }
        }
      } catch {
        // ignore
      }
    };

    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
    };
  }, [connection, config.assetField, config.metadataKey, showDebug]);

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
                `Defaults: ${config.assetField} → ${config.metadataKey}`}
            </Text>
          </Flex>

          {showDebug && (
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
          )}
        </Flex>
      </View>
    </Provider>
  );
}

export default function AssetMetadataDefaultField() {
  if (STATIC_PLACEHOLDER_MODE) return <StaticPlaceholderField />;
  return <LiveAssetMetadataDefaultField />;
}


