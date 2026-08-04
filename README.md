# Quebec administrative regions map

Plain JS + Leaflet cutout map of Québec’s **17 régions administratives**, embeddable in an iframe (GitHub Pages → Squarespace).

UI: map + legend + region content panel + responsible-person popup.

**Content managers:** see **[CONTENT.md](./CONTENT.md)** for Squarespace collections, `urlId` matching, and embed setup.

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

### Recommended: paste a self-contained snippet (no runtime dependency on this repo)

`content-models.js` and `squarespace-bridge.js` are **copied into the page**, not
loaded from this repo at runtime. The published page then makes zero requests to
GitHub for scripts, and a change (or a disappearance) here cannot alter or break
a page that is already live.

1. Generate the snippet:

   ```bash
   npm run build:embed -- --src=https://oui-quebec.github.io/carte-interactive-tables-regionales/
   ```

   Output: `dist-embed/squarespace-snippet.html` (~21 KB, gitignored).
   Optional flags: `--height=720`.

2. Open the file, copy **the whole thing**, and paste it into a Squarespace
   **Code Block** (or a page-level Code Injection) on the map page.

3. Save and publish.

The snippet's header comment records the version, commit and generation date, so
you can tell which build is live on the site. To update: re-run the command,
recopy, repaste. Nothing else on Squarespace has to change.

**Rollback** — keep the previously pasted snippet (e.g. in a text file, or in
Squarespace's page version history) before overwriting. Restoring the old text
fully restores the old bridge behaviour.

**Caveat, stated plainly:** the pasted scripts are frozen, but the iframe still
loads the *map itself* from `--src`. If you also want the map immune to this
repo, host the built `dist/` output yourself (fork + your own Pages, or any
static host) and point `--src` there. Copy-pasting the bridge does not by itself
make the embed independent of the map's host.

### Alternative: load the scripts from GitHub Pages

Simpler to update (redeploy Pages and every page picks it up), at the cost of a
live dependency on this repo:

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

Redeploy Pages **and** hard-refresh the Squarespace page so both sides stay in
sync.

### Notes (both methods)

Content mapping (`urlId` → region, Nom/Rôle/email, region body) is in
[`public/embed/content-models.js`](public/embed/content-models.js) — it is the
source of truth for both methods, and must be loaded before the bridge. If the
Squarespace slugs change, edit that file and regenerate/repaste the snippet.

On mobile, the region panel renders **below** the map. The iframe starts at a
fixed height (e.g. `720px`); the bridge then grows it when the map posts
`quebec-map:resize`.

Wheel / touch over the map is forwarded to the host via `quebec-map:scrollBy`.

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
