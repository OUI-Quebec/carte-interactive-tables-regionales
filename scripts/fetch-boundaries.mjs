/**
 * Downloads Quebec administrative region boundaries (layer 0)
 * from MRNF ArcGIS into public/geo/.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'geo');

const ARCGIS_BASE =
  'https://servicescarto.mern.gouv.qc.ca/pes/rest/services/Territoire/SDA_WMS/MapServer';

const SOURCE = 'MRNF Découpages administratifs (CC-BY 4.0)';

/** Official 17 régions administratives — ids match RES_CO_REG. */
export const ADMIN_REGIONS = [
  { id: '01', name: 'Bas-Saint-Laurent' },
  { id: '02', name: 'Saguenay–Lac-Saint-Jean' },
  { id: '03', name: 'Capitale-Nationale' },
  { id: '04', name: 'Mauricie' },
  { id: '05', name: 'Estrie' },
  { id: '06', name: 'Montréal' },
  { id: '07', name: 'Outaouais' },
  { id: '08', name: 'Abitibi-Témiscamingue' },
  { id: '09', name: 'Côte-Nord' },
  { id: '10', name: 'Nord-du-Québec' },
  { id: '11', name: 'Gaspésie–Îles-de-la-Madeleine' },
  { id: '12', name: 'Chaudière-Appalaches' },
  { id: '13', name: 'Laval' },
  { id: '14', name: 'Lanaudière' },
  { id: '15', name: 'Laurentides' },
  { id: '16', name: 'Montérégie' },
  { id: '17', name: 'Centre-du-Québec' }
];

async function fetchPage(pageOffset, pageSize, attempt = 0) {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'RES_CO_REG,RES_NM_REG,RES_VA_SUP,RES_DE_IND',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    // Slightly simplified for web map performance
    maxAllowableOffset: '0.008',
    resultRecordCount: String(pageSize),
    resultOffset: String(pageOffset)
  });

  const url = `${ARCGIS_BASE}/0/query?${params}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      return fetchPage(pageOffset, pageSize, attempt + 1);
    }
    throw err;
  }
}

async function fetchAll() {
  const pageSize = 50;
  let pageOffset = 0;
  const features = [];

  for (;;) {
    process.stdout.write(`  offset ${pageOffset}… `);
    const page = await fetchPage(pageOffset, pageSize);
    const count = page.features?.length ?? 0;
    console.log(`${count} features`);
    if (!count) break;
    features.push(...page.features);
    if (count < pageSize) break;
    pageOffset += pageSize;
  }

  // Normalize + merge same-code polygons (e.g. Côte-Nord arrives as 2 parts)
  const byId = new Map();
  for (const f of features) {
    const code = String(f.properties?.RES_CO_REG ?? '').padStart(2, '0');
    const catalog = ADMIN_REGIONS.find((r) => r.id === code);
    const props = {
      ...f.properties,
      id: code,
      name: catalog?.name ?? f.properties?.RES_NM_REG ?? code,
      level: 'administrative-region',
      source: SOURCE
    };

    const existing = byId.get(code);
    if (!existing) {
      byId.set(code, { type: 'Feature', properties: props, geometry: f.geometry });
      continue;
    }

    existing.geometry = mergeGeometries(existing.geometry, f.geometry);
    const a = Number(existing.properties.RES_VA_SUP) || 0;
    const b = Number(f.properties?.RES_VA_SUP) || 0;
    existing.properties.RES_VA_SUP = a + b;
  }

  return {
    type: 'FeatureCollection',
    features: [...byId.values()]
  };
}

function ringList(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function mergeGeometries(a, b) {
  const rings = [...ringList(a), ...ringList(b)];
  if (rings.length === 1) return { type: 'Polygon', coordinates: rings[0] };
  return { type: 'MultiPolygon', coordinates: rings };
}

async function main() {
  await mkdir(OUT, { recursive: true });

  console.log('Fetching régions administratives (layer 0)…');
  const regions = await fetchAll();

  // Stable sort by id
  regions.features.sort((a, b) =>
    String(a.properties.id).localeCompare(String(b.properties.id))
  );

  await writeFile(
    path.join(OUT, 'regions-admin.json'),
    JSON.stringify(regions)
  );
  console.log(`Wrote regions-admin.json (${regions.features.length} regions)`);

  await writeFile(
    path.join(OUT, 'manifest.json'),
    JSON.stringify(
      {
        source: SOURCE,
        layer: 0,
        name: 'Région administrative',
        regionCount: regions.features.length,
        regions: ADMIN_REGIONS,
        fetchedAt: new Date().toISOString()
      },
      null,
      2
    )
  );

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
