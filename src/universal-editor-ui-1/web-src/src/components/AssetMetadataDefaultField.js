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

/**
 * Module-singleton state for the iframe JS context.
 *
 * UE may unmount/remount the React tree frequently while keeping the same iframe JS context alive.
 * Using a module-scope Map lets us preserve “previous asset” knowledge across those remounts without
 * relying on localStorage (which is shared and can introduce cross-tab/session coupling).
 *
 * Key: `${selectedResource}|${assetField}`
 * Value: last resolved DAM path for that selection.
 */
const lastDamPathBySelectionKey = new Map();

/**
 * Cross-iframe coordination.
 *
 * When a block has multiple instances of this renderer (e.g. Alt + Mime Type), each renderer may
 * attempt to write shortly after the same asset selection. Some canvas renderers / block scripts
 * are sensitive to rapid consecutive content patches (can manifest as temporary DOM duplication).
 *
 * We coordinate *within a single authored component instance* (block) by keying on:
 * `${aemHost}|${resourcePath}|${assetField}`
 *
 * We use BroadcastChannel (modern browsers) to serialize writes and add a small delay between them.
 * This does not change business logic—each field still applies defaults independently when the
 * asset changes—but it avoids patch "bursts".
 */
const BC_NAME = "ue.assetmetadatadefaults.v1";
// Delay between successive writes within the same block.
// This mitigates “patch bursts” that can trigger canvas rendering glitches in some environments.
const INTER_WRITE_DELAY_MS = 700;

// Author-facing status copy (avoid UE jargon).
const MSG_UPDATING_ASSET_DETAILS = "Updating image details…";
const MSG_FAILED_ASSET_DETAILS = "Failed to read the asset details. Please try again.";

/**
 * Normalize a UE `prop` identifier to a stable comparison key.
 * @param {string} prop
 * @returns {string}
 */
const normalizeProp = traceFn("normalizeProp", "all", function normalizeProp(prop) {
  if (!prop) return "";
  const s = String(prop).trim();
  // UE props can vary by field type / serializer:
  // - "image"
  // - "/image"
  // - "./image"
  // Normalize these to a stable key.
  if (s.startsWith("./")) return s.slice(2);
  if (s.startsWith("/")) return s.slice(1);
  return s;
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
 * Attempt to extract an AEM asset URN from an OpenAPI delivery URL/string.
 * Example: `urn:aaid:aem:<uuid>`
 *
 * @param {string} s
 * @returns {string}
 */
function tryExtractAssetUrn(s) {
  const v = String(s || "");
  const m = v.match(/urn:aaid:aem:[0-9a-f-]+/i);
  return (m && m[0]) || "";
}

/**
 * If `s` is an absolute URL, return its origin; otherwise empty.
 * @param {string} s
 * @returns {string}
 */
function tryExtractOrigin(s) {
  try {
    const u = new URL(String(s || ""));
    return u.origin || "";
  } catch {
    return "";
  }
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
 * Return editables that share the same parent container as the selected editable.
 * (This corresponds to “neighbor fields” within the same authored component instance.)
 *
 * @param {any[]} editables
 * @param {any} selectedEditable
 * @returns {any[]}
 */
function getSiblingEditables(editables, selectedEditable) {
  const selectedParentId = selectedEditable?.parentid || selectedEditable?.id || "";
  if (!selectedParentId) return [];
  return (editables || []).filter((e) => (e?.parentid || "") === selectedParentId);
}

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

    const want = normalizeProp(neighborFieldName);

    const candidates = getSiblingEditables(editables, selectedEditable);

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

    // Many metadata sources:
    // - AEM Author DAM metadata.json: keys at root (e.g. "dc:title")
    // - Delivery OpenAPI /metadata: keys often under `assetMetadata` and `repositoryMetadata`
    const sources = [metadataJson, metadataJson.assetMetadata, metadataJson.repositoryMetadata].filter(
      (v) => v && typeof v === "object"
    );

    // Search each source in order.
    for (const src of sources) {
      const keys = Object.keys(src);
      const direct = src[requestedKey];
      if (direct !== undefined) return { value: direct, resolvedKey: requestedKey };

      const wantedLower = String(requestedKey).toLowerCase();
      const ciKey = keys.find((k) => String(k).toLowerCase() === wantedLower);
      if (ciKey) return { value: src[ciKey], resolvedKey: ciKey };

      const colonToUnderscore = String(requestedKey).replace(/:/g, "_");
      const underscoreKey = keys.find((k) => String(k).toLowerCase() === colonToUnderscore.toLowerCase());
      if (underscoreKey) return { value: src[underscoreKey], resolvedKey: underscoreKey };
    }

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

/**
 * Fetch metadata for an AEM asset delivered via Dynamic Media OpenAPI.
 *
 * @param {{deliveryOrigin: string, assetUrn: string}} params
 * @returns {Promise<Record<string, any> | null>}
 */
const fetchDeliveryMetadataJson = traceFn(
  "fetchDeliveryMetadataJson",
  "all",
  async function fetchDeliveryMetadataJson({ deliveryOrigin, assetUrn }) {
    if (!deliveryOrigin || !assetUrn) return null;
    const url = `${deliveryOrigin}/adobe/assets/${assetUrn}/metadata`;
    // Delivery metadata is typically publicly readable (or authenticated via other means).
    // Critically: many delivery responses use `Access-Control-Allow-Origin: *`, which is
    // incompatible with `credentials: "include"` and will be blocked by the browser.
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) throw new Error(`Delivery metadata fetch failed (${res.status}) for ${assetUrn}`);
    return await res.json();
  }
);

function LiveAssetMetadataDefaultField() {
  /**
   * Component entrypoint for the `asset-metadata-default` field renderer.
   *
   * Data flow (production-hardened, but readable):
   * - Attach to the UE host.
   * - Read `editorState` on demand (not constant polling).
   * - Find the selected component + the configured neighbor asset field (e.g. `image`).
   * - Resolve the actual DAM path (often requires reading `<component>.json` because the field value
   *   can be a Dynamic Media delivery URL even when the author selected `/content/dam/...`).
   * - Decide whether to apply defaults (only when the asset changes / first selection), then fetch
   *   DAM metadata and write the current field value.
   *
   * Robustness notes:
   * - Host events can arrive before the new selection is persisted; we do short delayed retries.
   * - We avoid “lags 1” by refusing to cache persisted DAM values that don’t match the new DM URL filename.
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
  // Cache for the persisted asset value read from `<component>.json`.
  // Keyed by selection + assetSignature when available (see runOnce).
  const persistedAssetCacheRef = useRef(new Map());
  const tickCounterRef = useRef(0);
  const lastTraceKeyRef = useRef("");
  const lastTraceResolvedDamPathRef = useRef("");
  const runSeqRef = useRef(0);
  const runScheduledRef = useRef(false);
  const lastRunReasonRef = useRef("");
  const lastUeEventTsRef = useRef(0);
  const applyTokenRef = useRef("");
  const lastContextRef = useRef({
    selectedResource: "",
    connectionName: "",
    resourcePath: "",
    aemHost: "",
  });

  // Cross-iframe write coordination state.
  const instanceIdRef = useRef(
    `inst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  );
  const bcRef = useRef(null);
  const lockStateRef = useRef(new Map()); // blockKey -> { ownerId, token, expiresAt }
  const proposalsRef = useRef(new Map()); // blockKey -> Map(token -> { ts, instanceId, token, seenAt })

  // Best-effort BroadcastChannel setup (modern browsers).
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    try {
      const bc = new BroadcastChannel(BC_NAME);
      bcRef.current = bc;
      trace("tick", "AssetMetadataDefaultField:bc:ready", { name: BC_NAME });
      bc.onmessage = (evt) => {
        const msg = evt?.data || {};
        const type = String(msg?.type || "");
        const blockKey = String(msg?.blockKey || "");
        if (!type || !blockKey) return;

        const now = Date.now();

        // Helper: expire a lock if needed.
        const expireLockIfNeeded = () => {
          const st = lockStateRef.current.get(blockKey);
          if (st && st.expiresAt && st.expiresAt <= now) {
            lockStateRef.current.delete(blockKey);
          }
        };
        expireLockIfNeeded();

        if (type === "proposal") {
          const ts = Number(msg?.ts || 0);
          const instanceId = String(msg?.instanceId || "");
          if (!ts || !instanceId) return;
          const token = `${ts}|${instanceId}`;

          let m = proposalsRef.current.get(blockKey);
          if (!m) {
            m = new Map();
            proposalsRef.current.set(blockKey, m);
          }
          m.set(token, { ts, instanceId, token, seenAt: now });

          // Trim stale proposals (keep this lightweight).
          for (const [k, v] of m.entries()) {
            if (!v?.seenAt || now - v.seenAt > 1500) m.delete(k);
          }
          return;
        }

        if (type === "commit") {
          const ts = Number(msg?.ts || 0);
          const instanceId = String(msg?.instanceId || "");
          const expiresAt = Number(msg?.expiresAt || 0);
          if (!ts || !instanceId || !expiresAt) return;
          const token = `${ts}|${instanceId}`;
          lockStateRef.current.set(blockKey, { ownerId: instanceId, token, expiresAt });
          proposalsRef.current.delete(blockKey);
          return;
        }

        if (type === "release") {
          const instanceId = String(msg?.instanceId || "");
          const st = lockStateRef.current.get(blockKey);
          if (st && st.ownerId === instanceId) {
            lockStateRef.current.delete(blockKey);
          }
        }
      };
      return () => {
        try {
          bc.close();
        } catch {
          // ignore
        }
        if (bcRef.current === bc) bcRef.current = null;
      };
    } catch {
      // ignore (some environments may throw)
      trace("tick", "AssetMetadataDefaultField:bc:unavailable");
      return;
    }
  }, []);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const getLockState = (blockKey) => {
    const now = Date.now();
    const st = lockStateRef.current.get(blockKey);
    if (st && st.expiresAt && st.expiresAt <= now) {
      lockStateRef.current.delete(blockKey);
      return null;
    }
    return st || null;
  };

  const post = (msg) => {
    try {
      bcRef.current?.postMessage(msg);
    } catch {
      // ignore
    }
  };

  /**
   * Acquire a per-block lock (BroadcastChannel) to serialize writes across multiple renderer iframes.
   * @param {string} blockKey
   * @returns {Promise<null | (() => Promise<void>)>} release function or null if BC unavailable
   */
  const acquireBlockLockBC = async (blockKey) => {
    const bc = bcRef.current;
    if (!bc || !blockKey) return null;

    const selfId = instanceIdRef.current;
    const startedAt = Date.now();
    const timeoutMs = 6500;
    const ttlMs = 5000;
    const settleMs = 140;
    const postCommitSettleMs = 60;

    while (Date.now() - startedAt < timeoutMs) {
      const st = getLockState(blockKey);
      if (st && st.ownerId && st.ownerId !== selfId) {
        // Wait until released/expired.
        await sleep(180);
        continue;
      }
      if (st && st.ownerId === selfId) {
        // We already hold it.
        return async () => {};
      }

      // Propose ourselves as leader for this blockKey.
      const ts = Date.now();
      const token = `${ts}|${selfId}`;

      // Record our own proposal locally and broadcast it.
      let m = proposalsRef.current.get(blockKey);
      if (!m) {
        m = new Map();
        proposalsRef.current.set(blockKey, m);
      }
      m.set(token, { ts, instanceId: selfId, token, seenAt: ts });
      post({ type: "proposal", blockKey, ts, instanceId: selfId });

      // Collect proposals for a short settle window.
      await sleep(settleMs);

      const proposalsMap = proposalsRef.current.get(blockKey) || new Map();
      const proposals = Array.from(proposalsMap.values())
        .filter((p) => p && p.ts && p.instanceId)
        // Trim stale items (defensive).
        .filter((p) => Date.now() - (p.seenAt || 0) <= 1500);

      // Always include our own token in case it was trimmed.
      if (!proposals.find((p) => p.token === token)) proposals.push({ ts, instanceId: selfId, token, seenAt: ts });

      // Pick deterministic winner: lowest ts, then lowest instanceId.
      proposals.sort((a, b) => {
        if (a.ts !== b.ts) return a.ts - b.ts;
        return String(a.instanceId).localeCompare(String(b.instanceId));
      });
      const winner = proposals[0];

      if (winner && winner.instanceId === selfId) {
        const expiresAt = Date.now() + ttlMs;
        lockStateRef.current.set(blockKey, { ownerId: selfId, token, expiresAt });
        post({ type: "commit", blockKey, ts, instanceId: selfId, expiresAt });

        // Briefly yield to allow another commit to be observed (rare race).
        await sleep(postCommitSettleMs);
        const st2 = getLockState(blockKey);
        if (st2 && st2.ownerId === selfId && st2.token === token) {
          trace("tick", "AssetMetadataDefaultField:lock:acquired", {
            blockKey: summarize(blockKey),
            waitedMs: Date.now() - startedAt,
          });
          return async () => {
            // Space out patch bursts by delaying release slightly.
            await sleep(INTER_WRITE_DELAY_MS);
            // Only release if we're still the owner.
            const cur = getLockState(blockKey);
            if (cur && cur.ownerId === selfId) {
              lockStateRef.current.delete(blockKey);
              post({ type: "release", blockKey, instanceId: selfId });
              trace("tick", "AssetMetadataDefaultField:lock:released", { blockKey: summarize(blockKey) });
            }
          };
        }
      }

      // Lost or conflicted: wait a bit before retrying.
      await sleep(220);
    }

    trace("tick", "AssetMetadataDefaultField:lock:timeout", { blockKey });
    return null;
  };

  /**
   * Serialize writes within a single block.
   *
   * Prefer Web Locks API when available (atomic, no election needed). Fall back to BroadcastChannel.
   *
   * @template T
   * @param {string} blockKey
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const withBlockWriteLock = async (blockKey, fn) => {
    if (!blockKey) return await fn();

    // Web Locks API (Chrome/Edge; increasingly available elsewhere). This works across iframes for the same origin.
    const lockName = `ue.assetmetadatadefaults:block:${blockKey}`;
    const locks = typeof navigator !== "undefined" ? navigator.locks : null;
    if (locks && typeof locks.request === "function") {
      trace("tick", "AssetMetadataDefaultField:lock:usingWebLocks", { lockName: summarize(lockName) });
      // Ensure only one writer at a time for this blockKey.
      // Note: we intentionally add a delay while still holding the lock to avoid immediate back-to-back patches.
      // eslint-disable-next-line no-return-await
      return await locks.request(lockName, { mode: "exclusive" }, async () => {
        const v = await fn();
        await sleep(INTER_WRITE_DELAY_MS);
        return v;
      });
    }

    const release = await acquireBlockLockBC(blockKey);
    if (!release) return await fn();
    try {
      return await fn();
    } finally {
      await release();
    }
  };

  // Debug UI is controlled by the same single flag as console tracing.
  // Any non-off value shows debug UI.
  const showDebug = useMemo(() => getTraceLevel() !== "off", []);

  // UE field model supports `readOnly` (documented).
  const isReadOnly = Boolean(model?.readOnly);

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

    const connections = editorState?.connections || {};
    const connectionsKeys = Object.keys(connections).join(", ");
    const customTokens = editorState?.customTokens || {};
    const customTokensKeys = Object.keys(customTokens).join(", ");

    // Selection can be temporarily empty/unstable during UE transitions. When that happens, fall back
    // to the last stable block context we saw while this renderer remained mounted.
    //
    // This avoids "dead zones" where we never run because `editorState.selected` is empty.
    const selectedEditable = findSelectedEditable(editorState);

    let selectedResource = "";
    let urn = null;
    let connectionName = "";
    let connectionValue = "";
    let customTokenValue = "";
    let parsedHostFromConnectionValue = "";
    let aemHost = null;
    let neighbor = null;
    let neighborProp = "";
    let assetRawValue = "";
    let assetPath = "";
    let assetSignature = "";

    if (selectedEditable) {
      selectedResource = resolveResource(editableById, selectedEditable) || "";
      urn = parseResourceUrn(selectedResource);
      connectionName = urn?.connectionName || "";
      connectionValue = connectionName ? String(connections?.[connectionName] || "") : "";
      customTokenValue = connectionName ? String(customTokens?.[connectionName] || "") : "";

      parsedHostFromConnectionValue = pickAemConnection({ tmp: connectionValue }) || "";

      aemHost =
        (connectionName && pickAemConnection({ [connectionName]: connectionValue })) ||
        (connectionName && pickAemConnection({ [connectionName]: customTokenValue })) ||
        pickAemConnection(connections) ||
        pickAemConnection(customTokens) ||
        null;

      neighbor = findNeighborEditable(editorState, selectedEditable, config.assetField);
      neighborProp = neighbor?.prop || "";
      assetRawValue = String(getEditableValue(neighbor) || "").trim();
      assetPath = assetRawValue;
      assetSignature = normalizeAssetSignature(assetRawValue);

      // Persist last stable context for future runs in case selection becomes temporarily empty.
      lastContextRef.current = {
        selectedResource,
        connectionName,
        resourcePath: urn?.path || "",
        aemHost: aemHost || "",
      };
    } else {
      const isSelectionRelated =
        typeof reason === "string" &&
        (reason.startsWith("ueEvent:aue:content-patch") ||
          reason.startsWith("ueEvent:aue:content-details") ||
          reason.startsWith("ueEvent:aue:ui-select"));

      // No selection and no context: we can't do anything meaningful yet.
      if (!lastContextRef.current?.resourcePath) {
        if (isSelectionRelated) {
          setStatus({ state: "loading", message: MSG_UPDATING_ASSET_DETAILS });
          trace("tick", `run=${seq}:waitingForSelection`, { reason });
        }
        return;
      }

      // Fall back to last stable context.
      selectedResource = lastContextRef.current.selectedResource || "";
      connectionName = lastContextRef.current.connectionName || "";
      urn = {
        connectionName,
        path: lastContextRef.current.resourcePath || "",
      };
      connectionValue = connectionName ? String(connections?.[connectionName] || "") : "";
      customTokenValue = connectionName ? String(customTokens?.[connectionName] || "") : "";
      parsedHostFromConnectionValue = pickAemConnection({ tmp: connectionValue }) || "";

      aemHost =
        (connectionName && pickAemConnection({ [connectionName]: connectionValue })) ||
        (connectionName && pickAemConnection({ [connectionName]: customTokenValue })) ||
        pickAemConnection(connections) ||
        pickAemConnection(customTokens) ||
        lastContextRef.current.aemHost ||
        null;

      // Without a selected editable we may not have a neighbor editable; we rely on persisted
      // component JSON as the source of truth.
      neighbor = null;
      neighborProp = "";
      assetRawValue = "";
      assetPath = "";
      assetSignature = "";
    }

    const token = connection.sharedContext?.get("token");
    const authScheme = connection.sharedContext?.get("authScheme") || "Bearer";
    // Per-block coordination key.
    //
    // Prefer stable identifiers from the selected resource URN so coordination remains effective
    // even if the AEM host cannot be derived for a moment (transient editorState inconsistencies).
    //
    // We intentionally do NOT include metadataKey or the current field name here: we want all
    // instances within the same block+assetField to serialize writes.
    const blockKey = urn?.path
      ? `${connectionName || "aem"}|${urn.path}|${config.assetField}`
      : selectedResource
        ? `${connectionName || "aem"}|${selectedResource}|${config.assetField}`
        : "";

    // Source of truth: persisted component property from `<component>.json` when available.
    // (The editable value we see in editorState is sometimes a transformed delivery URL.)
    let persistedAssetValue = "";
    if (urn?.path && aemHost) {
      // Cache the persisted value only when we have a stable signature for the selection.
      // If `assetSignature` is empty, caching would “stick” forever under a constant key.
      const canUsePersistedCache = Boolean(assetSignature);
      const cacheKey = canUsePersistedCache
        ? `${aemHost}|${urn.path}|${config.assetField}|${assetSignature}`
        : "";

      const cached = canUsePersistedCache ? persistedAssetCacheRef.current.get(cacheKey) : null;
      if (cached) {
        persistedAssetValue = cached;
      } else {
        const persisted = await fetchComponentProp({
          aemHost,
          resourcePath: urn.path,
          propName: config.assetField,
          authScheme,
          token,
        });

        // Same “lags 1” / eventual consistency issue applies: we may briefly read the previous value.
        // Use filename convergence when we can (requires a non-empty assetSignature).
        const dmName = basename(assetSignature);
        const persistedName = basename(persisted);
        const looksStale = Boolean(dmName && persistedName && dmName !== persistedName);
        if (looksStale) {
          trace("tick", `run=${seq}:persistedAsset:notConverged`, {
            reason,
            dmName,
            persistedName,
            assetSignature,
            persisted,
          });
          persistedAssetValue = "";
        } else {
          if (canUsePersistedCache && persisted) {
            persistedAssetCacheRef.current.set(cacheKey, persisted);
          }
          persistedAssetValue = persisted;
        }
      }
    }

    // Resolve from persisted value first, then fall back to what editorState exposed.
    const assetValue = String((persistedAssetValue || assetPath) || "").trim();

    const deliveryOrigin = tryExtractOrigin(assetValue);
    const assetUrn = tryExtractAssetUrn(assetValue);

    let resolvedDamPath = "";
    if (assetValue.startsWith("/content/dam/")) {
      resolvedDamPath = assetValue.split("?")[0];
    } else {
      resolvedDamPath = tryExtractDamPath(assetValue);
    }
    const resolvedAssetRef = resolvedDamPath || assetUrn || "";

    // Determine whether this run is driven by a selection/persist event stream.
    const isSelectionRelatedEvent =
      typeof reason === "string" &&
      (reason.startsWith("ueEvent:aue:content-patch") ||
        reason.startsWith("ueEvent:aue:content-details") ||
        reason.startsWith("ueEvent:aue:ui-select"));

    // For convergence retries, we tag the reason as `...:retry{ms}`.
    // Clearing on removal is best-effort, but we gate it to later retries to avoid false clears
    // during eventual consistency windows (e.g. stale component JSON right after selection).
    const isLateConvergenceRetry =
      typeof reason === "string" &&
      (reason.endsWith(":retry2000") || reason.endsWith(":retry5000"));
    const isFinalConvergenceRetry =
      typeof reason === "string" && reason.endsWith(":retry5000");

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

    const traceKey = [selectedResource || "", neighborProp || "", assetSignature || "", resolvedAssetRef || ""].join("|");
    if (traceKey && traceKey !== lastTraceKeyRef.current) {
      lastTraceKeyRef.current = traceKey;
      trace("tick", `run=${seq}:stateChanged`, {
        reason,
        selectedResource: selectedResource ? String(selectedResource).slice(0, 96) + "…" : "(none)",
        assetField: config.assetField,
        neighborProp: neighborProp || "(none)",
        assetSignature: assetSignature || "(none)",
        resolvedDamPath: resolvedDamPath || "(none)",
        resolvedAssetRef: resolvedAssetRef || "(none)",
        currentAlt: valueRef.current || "",
      });
    }

    // If the asset reference is missing, this may be either:
    // - a transient convergence gap right after selection/persist, or
    // - a real removal (author clicked the "clear" button).
    //
    // UX choice: when the reference is actually removed, auto-clear this metadata field to avoid
    // stale values. We do this conservatively on later retries to reduce false clears.
    if (!resolvedAssetRef) {
      const selectionKey = `${selectedResource || ""}|${config.assetField}`;
      const prevAssetRef = lastDamPathBySelectionKey.get(selectionKey) || "";
      const hadPreviousAsset = Boolean(prevAssetRef);
      const alreadyClearedState =
        !hadPreviousAsset &&
        valueRef.current === "" &&
        lastAppliedAssetRef.current === "" &&
        lastSeenAssetRef.current === "";

      // If the reference is truly empty and we've already processed the removal (or the page loaded
      // with no asset selected), don't show a perpetual "waiting" message. Instead, show a stable
      // state that explains what's happening.
      if (isSelectionRelatedEvent && alreadyClearedState) {
        setStatus({ state: "done", message: "No asset selected" });
        trace("tick", `run=${seq}:noAssetSelected`, { reason });
        return;
      }

      if (isSelectionRelatedEvent) {
        if (isFinalConvergenceRetry) {
          setStatus({ state: "error", message: MSG_FAILED_ASSET_DETAILS });
          trace("tick", `run=${seq}:assetRef:timeout`, { reason });
        } else {
          setStatus({ state: "loading", message: MSG_UPDATING_ASSET_DETAILS });
          trace("tick", `run=${seq}:waitingForAssetRef`, { reason });
        }
      }

      // Only clear if we previously had an asset for this block+field, and we are on a later
      // convergence retry (meaning we've waited long enough for persisted JSON to catch up).
      if (hadPreviousAsset && isLateConvergenceRetry) {
        trace("tick", `run=${seq}:assetRemoved:clearing`, { reason, prevAssetRef });

        // Serialize within block (same mechanism as apply) to avoid patch bursts.
        await withBlockWriteLock(blockKey, async () => {
          // If user typed something manually after removal, they can re-enter later; we treat
          // metadata-derived values as stale once the asset is removed.
          if (valueRef.current !== "") {
            connection.host.field.onChange("");
            setValue("");
            valueRef.current = "";
          }
          lastAppliedAssetRef.current = "";
          lastSeenAssetRef.current = "";
          lastDamPathBySelectionKey.set(selectionKey, "");
          // UX: show a single stable message rather than a transient "cleared" state.
          // Debug traces still indicate that a clear happened.
          setStatus({ state: "done", message: "No asset selected" });
          trace("tick", `run=${seq}:assetRemoved:cleared`, { reason });
        });
      }

      return;
    }

    // Determine whether the asset actually changed (vs an event firing before persisted state converges).
    // We key by selected resource + assetField to survive UI remounts without using localStorage.
    const selectionKey = `${selectedResource || ""}|${config.assetField}`;
    const prevAssetRef = lastDamPathBySelectionKey.get(selectionKey) || "";
    const assetChanged = Boolean(prevAssetRef) && prevAssetRef !== resolvedAssetRef;
    if (!prevAssetRef || assetChanged) {
      lastDamPathBySelectionKey.set(selectionKey, resolvedAssetRef);
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
    const isFirstAssetSelection = !prevAssetRef && Boolean(resolvedAssetRef) && isContentPatchEvent;

    // Only apply for a new (or first) selection, and only once per resolvedDamPath.
    const shouldApply =
      (assetChanged || isFirstAssetSelection) &&
      lastAppliedAssetRef.current !== resolvedAssetRef;

    if (resolvedAssetRef !== lastTraceResolvedDamPathRef.current) {
      lastTraceResolvedDamPathRef.current = resolvedAssetRef;
      trace("tick", `run=${seq}:decision`, {
        reason,
        assetChanged,
        isFirstAssetSelection,
        valueEmpty: !valueRef.current,
        prevDamPath: prevAssetRef || "(none)",
        lastApplied: lastAppliedAssetRef.current || "(none)",
        shouldApply: Boolean(shouldApply),
      });
    }

    // Track what we're currently seeing for debugging only (not used for apply decisions).
    lastSeenAssetRef.current = resolvedAssetRef;
    if (!shouldApply) return;

    trace("tick", `run=${seq}:apply:start`, {
      reason,
      resolvedAssetRef,
      metadataKey: config.metadataKey,
    });
    setStatus({ state: "loading", message: `Fetching ${config.metadataKey}…` });

    // Protect against stale writes if the user changes selection while async work is in-flight.
    const applyToken = `${resolvedAssetRef}|${seq}`;
    applyTokenRef.current = applyToken;

    const metadataJson = resolvedDamPath
      ? await fetchDamMetadataJson({
          aemHost,
          assetPath: resolvedDamPath,
          authScheme,
          token,
        })
      : await fetchDeliveryMetadataJson({
          deliveryOrigin,
          assetUrn,
        });
    const keysSample = metadataJson ? Object.keys(metadataJson).slice(0, 18).join(", ") : "";
    const resolved = resolveMetadataValue(metadataJson, config.metadataKey);
    const metadataValue = stringifyMetadataValue(resolved.value);

    trace("tick", `run=${seq}:apply:fetched`, {
      reason,
      metadataKeyResolved: resolved.resolvedKey || "(none)",
      metadataValue,
    });

    await withBlockWriteLock(blockKey, async () => {
      // Abort if newer apply attempt superseded this one.
      if (applyTokenRef.current !== applyToken) {
        trace("tick", `run=${seq}:apply:aborted`, { reason, note: "superseded" });
        return;
      }
      // Abort if the currently-seen asset changed while we waited.
      if (lastSeenAssetRef.current && lastSeenAssetRef.current !== resolvedAssetRef) {
        trace("tick", `run=${seq}:apply:aborted`, { reason, note: "assetChangedWhileWaiting" });
        return;
      }

      // Hygiene: only write when the value changes (avoids unnecessary content patches).
      //
      // IMPORTANT: We compare against `valueRef.current` (what this renderer is currently showing),
      // not `host.field.getValue()`. During asset changes UE can be eventually consistent, and
      // `getValue()` may transiently report a stale/incorrect value which could cause us to skip
      // a necessary write (especially when clearing to "").
      const currentValue = valueRef.current || "";

      // Mark as applied for this asset even if value matches, so we don't keep retrying.
      lastAppliedAssetRef.current = resolvedAssetRef;

      if (metadataValue !== currentValue) {
        connection.host.field.onChange(metadataValue);
        setValue(metadataValue);
        valueRef.current = metadataValue;
      } else {
        trace("tick", `run=${seq}:apply:skipped`, { reason, note: "noChange" });
      }

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
    });
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
    if (isReadOnly) return;
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
      if (!e || e.key !== "ue.assetmetadatadefaults.lastUeEvent") return;
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
          if (name === "aue:content-patch" || name === "aue:content-details") {
            scheduleRunAfter(250, `ueEvent:${name}:retry250`);
            scheduleRunAfter(1000, `ueEvent:${name}:retry1000`);
            scheduleRunAfter(2000, `ueEvent:${name}:retry2000`);
            scheduleRunAfter(5000, `ueEvent:${name}:retry5000`);
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
            isReadOnly={isReadOnly}
            onChange={isReadOnly ? undefined : onChange}
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
  return <LiveAssetMetadataDefaultField />;
}



