# Quebec administrative regions map

Plain JS + Leaflet cutout map of Québec’s **17 régions administratives**, embeddable in an iframe (GitHub Pages → Squarespace).

UI: map + legend + publications drawer + responsible-person popup.

## Quick start

```bash
npm install
npm run fetch:boundaries
npm run dev
```

Local demo with sample contacts + publications:

```text
http://localhost:5173/?demoContent=1
```

Build for GitHub Pages:

```bash
npm run build
```

Deploy the `dist/` folder. For a project site at `https://ORG.github.io/REPO/`:

```bash
VITE_BASE=/REPO/ npm run build
```

(Default `base` is `./`, which also works for many Pages setups.)

## Squarespace iframe embed

The map **does not** fetch Squarespace JSON (CORS). The parent page loads `?format=json` same-origin and **postMessages** content into the iframe.

```html
<iframe
  id="qc-map"
  src="https://ORG.github.io/REPO/"
  title="Carte des régions administratives du Québec"
  style="width:100%;height:720px;border:0;display:block;"
></iframe>
<script src="https://ORG.github.io/REPO/embed/squarespace-bridge.js"></script>
<script>
  QuebecMapBridge.mount({
    iframe: '#qc-map',
    publicationsUrl: '/publications?format=json',
    contactsUrl: '/responsables?format=json',
    contactRegionFrom: 'category'
    // autoHeight: true (default) — stretches the iframe on mobile when
    // publications open below the map (listens for quebec-map:resize).
  });
</script>
```

On mobile, publications render **below** the map. The iframe starts at a fixed height (e.g. `720px`); the bridge then grows it when the map posts `quebec-map:resize`. Keep using `squarespace-bridge.js` so that works — Squarespace will not stretch a bare iframe on its own.

### Content contract

```js
{
  type: 'quebec-map:setContent',
  content: {
    contacts: {
      "09": {
        fullName: "…",
        profileImg: "https://…",
        title: "…",
        body: "<p>HTML from CMS</p>"
      }
    },
    publications: [
      {
        id: "…",
        title: "…",
        summary: "plain text",
        publishedAt: 1717200000000,
        url: "https://…",
        imageUrl: "https://…",
        lat: 50.21,
        lng: -66.38
      }
    ]
  }
}
```

- **Contacts** keyed by region id (`01`–`17`).
- **Publications** assigned via geographic `findRegionAt(lng, lat)`.

## API

```js
const api = mountQuebecRegionsMap(el, config);

api.setContent(content);
api.findRegionAt(-73.57, 45.50); // → "06"
api.geoToDisplay(-73.57, 45.50);
```

## Layout knobs (`config.layout`)

- `globalScaleX` / `globalScaleY` — stretch the whole assembled map
- `manualOffsets` / `manualScales` — baked-in placement
- `ripple` / focus scales — optional size falloff
- `gap` — paper-cut inset

| Space | Purpose |
|-------|---------|
| **Geographic** (real lon/lat) | CMS containment (`findRegionAt`) |
| **Display** | Optical layout for drawing |
