# Plugging content into the Québec map

The map lives on GitHub Pages (an iframe). A **bridge** on your Squarespace page loads same-origin JSON and sends it into the map.

```text
/carte-tables-regionales?format=json              →  right panel (region SQS body HTML)
/carte-tables-rgionales-responsables?format=json  →  person card (name, role, email, photo)
         │
         ▼
   bridge (Code Block)  →  map iframe
```

| Collection | Path (default) | Role |
|------------|----------------|------|
| **Carte tables régionales** | `/carte-tables-regionales` | Right panel: region name + Squarespace `body` HTML |
| **Responsables** | `/carte-tables-rgionales-responsables` | Contact bubble (name, role, email, photo) |

Empty regions: if there is no page body and no responsable for a region, the side panel and contact bubble stay hidden.

---

## Embed (Code Block)

Load **content-models.js before** the bridge:

```html
<iframe
  id="qc-map"
  src="https://ORG.github.io/REPO/"
  title="Carte des régions administratives du Québec"
  style="width:100%;height:600px;border:0;display:block;"
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

Confirm in a browser:

```text
https://YOUR-SITE.com/carte-tables-regionales?format=json
https://YOUR-SITE.com/carte-tables-rgionales-responsables?format=json
```

**Field / urlId mapping** lives in [`public/embed/content-models.js`](public/embed/content-models.js). Edit that file to change how `urlId` maps to regions or how Nom / Rôle / email / body are read.

---

## Region pages (`/carte-tables-regionales`)

Each item in `items[]` is one region.

| Field | Use |
|-------|-----|
| **`urlId`** | Matched to region `shortName` (case/accents ignored). Example: `"estrie"` → Estrie (`05`) |
| **`body`** | Squarespace SQS HTML — shown in the right panel |
| **`title`** | Optional; panel heading uses the map region name |

Matching examples:

| `urlId` | Region |
|---------|--------|
| `estrie` | Estrie (`05`) |
| `outaouais` | Outaouais (`07`) |
| `montreal` | Montréal (`06`) |
| `cote-nord` | Côte-Nord (`09`) |
| `saguenay-lac-saint-jean` | Saguenay–Lac-Saint-Jean (`02`) |

The right panel shows:

1. **Heading** — region short name (e.g. Estrie)
2. **Body** — sanitized SQS HTML from that item

---

## Responsables (`/carte-tables-rgionales-responsables`)

Same `urlId` → region shortName matching as region pages (e.g. `"outaouais"` → `07`).

The SQS `body` is parsed for structured fields (not shown raw):

| In body / item | Becomes |
|----------------|---------|
| `Nom : …` | `fullName` |
| `Rôle : …` *(or `Note : …`)* | `title` (role line) — both labels feed the same line |
| **`Courriel : …`** | `email` — **preferred**, wins over the row below |
| `mailto:` link, or any address in the text | `email` fallback |
| Item thumbnail (`assetUrl`) or `<img>` in body | `profileImg` |

Example body text — one text block per line:

```text
Nom : Geneviève Nadeau
Rôle : Responsable
Courriel : genevieve@…
```

Notes on `Courriel :`

- Squarespace usually auto-linkifies the address into its own block, leaving a
  bare `Courriel :` label. That is fine — the address is read from the block
  right after the label.
- Use it whenever a body holds more than one address (a generic *Nous joindre*
  `mailto:`, an address inside the role text): the labelled line is the one that
  reaches the contact bubble.
- The older `Nom : Geneviève Nadeau (genevieve@…)` form still works, so existing
  items keep their email until they are rewritten.

The contact bubble shows photo + name + role + email link.

---

## Region codes / urlId mapping

Default: Squarespace `urlId` is matched to region `shortName` (case/accents ignored).

To override slugs that don’t match, edit `URL_ID_ALIASES` in [`public/embed/content-models.js`](public/embed/content-models.js):

```js
var URL_ID_ALIASES = {
  'mtl': '06'
};
```

| Code | shortName |
|------|-----------|
| `01` | Bas-Saint-Laurent |
| `02` | Saguenay–Lac-Saint-Jean |
| `03` | Capitale-Nationale |
| `04` | Mauricie |
| `05` | Estrie |
| `06` | Montréal |
| `07` | Outaouais |
| `08` | Abitibi-Témiscamingue |
| `09` | Côte-Nord |
| `10` | Nord-du-Québec |
| `11` | Gaspésie–Îles-de-la-Madeleine |
| `12` | Chaudière-Appalaches |
| `13` | Laval |
| `14` | Lanaudière |
| `15` | Laurentides |
| `16` | Montérégie |
| `17` | Centre-du-Québec |

---

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Still fetching `/responsables` or `/nos-realisations` | Old Code Block / cached bridge — update attrs + redeploy Pages |
| Empty right panel | `urlId` doesn’t match a shortName, or no `body` |
| No contact bubble | No matching responsable item, or body missing Nom/email/photo |
| `?format=json` returns HTML | Path points at the embed page, not the collection |

Build / embed notes: [README.md](./README.md)
