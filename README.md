# Quebec administrative regions map

Plain JS + Leaflet cutout map of Québec’s **17 régions administratives**, embeddable in an iframe (GitHub Pages → Squarespace).

UI: map + legend + publications drawer + responsible-person popup.

**Content managers:** see **[CONTENT.md](./CONTENT.md)** for how to plug Squarespace publications and responsables into the map.

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

For the full content workflow, see **[CONTENT.md](./CONTENT.md)**.

- **Region panel** — `/carte-tables-regionales?format=json` (`urlId` → region shortName; `body` = SQS HTML)
- **Responsables** — `/carte-tables-rgionales-responsables?format=json` (`urlId` → region; Nom / Rôle / email / photo from SQS body)

```html
<iframe
  id="qc-map"
  src="https://ORG.github.io/REPO/"
  title="Carte des régions administratives du Québec"
  style="width:100%;height:720px;border:0;display:block;"
  data-qc-region-pages="/carte-tables-regionales"
  data-qc-contacts="/carte-tables-rgionales-responsables"
  data-qc-contact-region-from="urlId"
></iframe>
<script src="https://ORG.github.io/REPO/embed/content-models.js"></script>
<script src="https://ORG.github.io/REPO/embed/squarespace-bridge.js"></script>
<script>
  QuebecMapBridge.mount({ iframe: '#qc-map' });
</script>
```

Content mapping (`urlId` → region, Nom/Rôle/email, region body) is in [`public/embed/content-models.js`](public/embed/content-models.js). Load it before the bridge.

On mobile, the region panel renders **below** the map. The iframe starts at a fixed height (e.g. `720px`); the bridge then grows it when the map posts `quebec-map:resize`.

Wheel / touch over the map is forwarded to the host via `quebec-map:scrollBy`. Redeploy Pages **and** refresh the bridge script on Squarespace so both sides stay in sync.

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
