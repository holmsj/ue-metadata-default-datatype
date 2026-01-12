# Universal Editor - Asset Metadata Defaults (WIP)

This example UI Extension demonstrates a **custom field renderer** for Universal Editor that:

- Reads a **neighbor asset field** (e.g. `image`) from the currently selected editable (via `editorState`)
- Fetches **AEM Author DAM metadata** for the selected asset (e.g. `dc:title`)
- Auto-fills the current field (e.g. `imageAlt`) **only when** a **new asset is selected**
  (or on the first asset selection event for a component).
  - It does **not** auto-fill merely because the field is empty (empty can be intentional).

## Local dev / testing

- Start the extension:
  - `aio app run`
- Accept the local cert (first run): open `https://localhost:9080`
- Load Universal Editor in dev mode and force-load your local extension UI from `https://localhost:9080`.

### ✅ Working Universal Editor URL format (author-hosted UE)

**Important:** for Universal Editor, `devMode=true` and `ext=...` must be **after** the `index.html` inside the hash-route URL (not on the `/ui?...` part), otherwise UE will ignore them and your localhost app will never be requested.

**Example (working, recommended / unencoded):**

`https://author-p82652-e710588.adobeaemcloud.com/ui#/@psc/aem/universal-editor/canvas/author-p82652-e710588.adobeaemcloud.com/content/xwalk-april/index.html?devMode=true&ext=https://localhost:9080`

**Example (working, URL-encoded):**

`https://author-p82652-e710588.adobeaemcloud.com/ui#/@psc/aem/universal-editor/canvas/author-p82652-e710588.adobeaemcloud.com/content/xwalk-april/index.html?devMode=true&ext=https%3A%2F%2Flocalhost%3A9080`

**Template:**

`https://<author-host>/ui#/@<org>/aem/universal-editor/canvas/<author-host>/<path-to-page>.html?devMode=true&ext=https://localhost:9080`

If you need to URL-encode `ext` (e.g., when pasting into tooling that re-escapes URLs), use:

`ext=https%3A%2F%2Flocalhost%3A9080`

## `component-models.json` example

To use this renderer, set your target field's `component` to match the renderer `dataType`:

```json
{
  "name": "imageAlt",
  "label": "Alt Text",
  "component": "uix-asset-metadata-default",
  "valueType": "string",
  "assetField": "image",
  "metadataKey": "dc:title"
}
```

- `assetField`: the neighbor field name that contains the asset reference (e.g. `/content/dam/...`)
- `metadataKey`: the DAM metadata key to use as default (e.g. `dc:title`)

## Implementation notes (why it looks “more complex than expected”)

### Dynamic Media delivery URLs vs persisted DAM paths

In AEM/UE authoring, the asset field value you see in `editorState` can be a Dynamic Media delivery URL
even when the author selected an asset from `/content/dam/...`.

To reliably determine **which DAM asset is actually selected**, the renderer resolves the persisted
component property by fetching:

- `<selectedResourcePath>.json` (e.g. `.../hero.json`) and reading the configured `assetField`

### UE eventual consistency (“lags 1”)

Host events like `aue:content-patch` can fire **before** the newly selected asset is persisted,
meaning `<component>.json` can briefly still return the *previous* DAM path.

This implementation avoids applying stale defaults by:

- Scheduling short delayed re-checks (e.g. 250ms and 1000ms) after `aue:content-patch`
- Refusing to cache/use a persisted DAM path if its filename doesn’t match the current DM URL filename

### Event-driven (no polling) via a localStorage bridge

UE host events are received in the “registration” iframe. The renderer iframe listens for those events
via a small `localStorage` bridge (writing the last event payload to a key and reacting to `storage`).

This keeps the renderer **event-driven** (no constant polling), while staying robust across UE iframe
lifecycle behavior.

