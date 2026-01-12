/**
 * Lightweight tracing utilities for debugging Universal Editor iframe mount/unmount + polling behavior.
 *
 * Goals:
 * - Provide a consistent log prefix with a monotonically increasing sequence number.
 * - Allow switching verbosity without changing code:
 *   - localStorage key: `ue.assetMetadataDefaults.debug` = "off" | "tick" | "all"
 *   - global override (useful if iframe storage is blocked): `window.__UE_ASSET_METADATA_DEFAULTS_DEBUG__` = "off" | "tick" | "all"
 *   - Default: "off"
 * - Avoid logging huge objects by default; prefer small summaries.
 */
const TRACE_PREFIX = "[ue-asset-metadata-defaults]";
// Single switch controlling both console tracing + in-field debug UI.
// (The field UI treats any non-off value as "show debug UI".)
const TRACE_STORAGE_KEY = "ue.assetMetadataDefaults.debug";
const TRACE_GLOBAL_KEY = "__UE_ASSET_METADATA_DEFAULTS_DEBUG__";
// Default to OFF so the extension runs cleanly unless the developer opts in.
const DEFAULT_TRACE_LEVEL = "off";
let globalSeq = 0;

function normalizeLevel(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return "off";
  if (v === "debug" || v === "on" || v === "yes") return "tick";
  if (v === "all") return "all";
  if (v === "tick" || v === "1" || v === "true") return "tick";
  return "";
}

/**
 * @returns {"off"|"tick"|"all"} trace level based on localStorage, falling back to default.
 */
export function getTraceLevel() {
  // First: global override (useful in environments that partition or block storage for iframes).
  try {
    const global = normalizeLevel(window?.[TRACE_GLOBAL_KEY]);
    if (global) return global;
  } catch {
    // ignore
  }

  try {
    const raw = normalizeLevel(window?.localStorage?.getItem(TRACE_STORAGE_KEY));
    if (raw) return raw;
  } catch {
    // Ignore storage access issues (privacy modes).
  }
  return DEFAULT_TRACE_LEVEL;
}

/**
 * @param {"tick"|"all"} level
 * @returns {boolean}
 */
export function isTraceEnabled(level) {
  const current = getTraceLevel();
  if (current === "off") return false;
  if (current === "all") return true;
  // current === "tick"
  return level === "tick";
}

/**
 * Produce a small, safe summary for logging.
 * @param {any} v
 * @returns {any}
 */
export function summarize(v) {
  if (v == null) return v;
  const t = typeof v;
  if (t === "string") return v.length > 180 ? v.slice(0, 180) + "…" : v;
  if (t === "number" || t === "boolean") return v;
  if (Array.isArray(v)) return { type: "array", length: v.length };
  if (t === "function") return { type: "function", name: v.name || "(anonymous)" };
  if (t === "object") {
    // Avoid dumping editorState or connection objects.
    const keys = Object.keys(v);
    return { type: "object", keys: keys.slice(0, 16), moreKeys: Math.max(0, keys.length - 16) };
  }
  return { type: t };
}

/**
 * Emit a trace log line.
 * @param {"tick"|"all"} level
 * @param {string} event
 * @param {Record<string, any>=} details
 * @returns {number|undefined} sequence id if logged
 */
export function trace(level, event, details) {
  if (!isTraceEnabled(level)) return undefined;
  const seq = (globalSeq += 1);
  const t = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`${TRACE_PREFIX} #${seq} ${t} ${event}`, details || {});
  return seq;
}

/**
 * Wrap a function to trace enter/exit/error in a consistent way.
 * Intended for debugging; keep summaries small.
 *
 * @template {(...args: any[]) => any} T
 * @param {string} name
 * @param {"tick"|"all"} level
 * @param {T} fn
 * @returns {T}
 */
export function traceFn(name, level, fn) {
  // @ts-ignore - plain JS file, keep typing lightweight.
  return function tracedFn(...args) {
    const enabled = isTraceEnabled(level);
    const enterSeq = enabled ? trace(level, `${name}:enter`, { args: args.map(summarize) }) : undefined;
    try {
      const result = fn(...args);
      // Promise support (async functions).
      if (result && typeof result.then === "function") {
        return result
          .then((v) => {
            if (enabled) trace(level, `${name}:exit`, { enterSeq, result: summarize(v) });
            return v;
          })
          .catch((e) => {
            if (enabled) trace(level, `${name}:error`, { enterSeq, message: String(e?.message || e) });
            throw e;
          });
      }
      if (enabled) trace(level, `${name}:exit`, { enterSeq, result: summarize(result) });
      return result;
    } catch (e) {
      if (enabled) trace(level, `${name}:error`, { enterSeq, message: String(e?.message || e) });
      throw e;
    }
  };
}


