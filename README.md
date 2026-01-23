# Universal Editor - Asset Metadata Defaults (WIP)

This example UI Extension demonstrates a **custom field renderer** for Universal Editor that:

- Reads a **neighbor asset field** (e.g. `image`) from the currently selected editable (via `editorState`)
- Fetches **AEM Author DAM metadata** for the selected asset (e.g. `dc:title`)
- Auto-fills the current field (e.g. `imageAlt`) **only when** a **new asset is selected**
  (or on the first asset selection event for a component).
  - It does **not** auto-fill merely because the field is empty (empty can be intentional).

<video src="assets/basic-demo.mp4" autoplay loop muted playsinline controls width="640"></video>

If the video doesn’t render inline on GitHub, open it directly: [`assets/basic-demo.mp4`](assets/basic-demo.mp4)

**Full feature overview / design notes:** see [`docs/developer/metadata-default-field.md`](docs/developer/metadata-default-field.md).

## Docs

- **Developer overview (recommended)**: [`docs/developer/metadata-default-field.md`](docs/developer/metadata-default-field.md)
- **Diagrams**: [`docs/diagrams/README.md`](docs/diagrams/README.md)

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
  "component": "asset-metadata-default",
  "valueType": "string",
  "assetField": "image",
  "metadataKey": "dc:title"
}
```

- `assetField`: the neighbor field name that contains the asset reference (e.g. `/content/dam/...`)
- `metadataKey`: the DAM metadata key to use as default (e.g. `dc:title`)

## Notes

For deeper implementation details (Dynamic Media OpenAPI handling, eventual consistency behavior, CORS/PNA, and troubleshooting), see:

- [`docs/developer/metadata-default-field.md`](docs/developer/metadata-default-field.md)

