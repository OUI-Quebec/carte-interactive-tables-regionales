/**
 * Dual-space layout for Québec regions.
 *
 * Geographic (lon/lat): containment for CMS geo-tagged content.
 * Display: Montréal-centered “ripple” projection — topology-safe
 * (whole-region scale + centroid pull; no vertex fisheye).
 *
 * At Montréal ≈ centerScale (default 2.5×); at the edges ≈ 0.6× with
 * anisotropic squash (north → more Y; east/Côte-Nord → more X).
 * Manual sx/sy + dx/dy from the editor still apply on top.
 */

export function createLayoutEngine(layoutCfg = {}) {
  const cfg = {
    gap: 0.01,
    /** When true (default), apply Montréal-centered ripple projection. */
    ripple: true,
    focusLon: -73.65,
    focusLat: 45.52,
    focusRegionId: '06',
    /** Size at epicentre (Montréal). */
    centerScale: 2.5,
    /**
     * Edge targets when fully “east” / “north” of Montréal.
     * Nord-du-Québec → mostly edgeScaleY; Côte-Nord → stronger edgeScaleX.
     */
    edgeScaleX: 0.55,
    edgeScaleY: 0.6,
    /** Horizontal scale when purely north of MTL (little X squash). */
    northScaleX: 0.9,
    /** Vertical scale when purely east of MTL (mild Y squash). */
    eastScaleY: 0.75,
    /** How far edge centroids are pulled toward MTL (1 = stay geographic — avoid stacking). */
    edgePull: 1,
    /** Distance (deg, lon-corrected) that maps to full edge falloff. */
    focusRadiusDeg: 14,
    /** Paper-cut clearance between region AABBs after sizing (degrees). */
    placeGap: 0.22,
    placeIterations: 55,
    /** Soft spring back to geographic home while separating overlaps. */
    homePull: 0.1,
    /** Uniform stretch of the whole assembled map (after per-region tweaks). */
    globalScaleX: 1,
    globalScaleY: 1,
    manualOffsets: {},
    manualScales: {},
    ...layoutCfg
  };

  function resolveFocus(collection) {
    const id = padId(cfg.focusRegionId || '06');
    const feature = (collection?.features ?? []).find(
      (f) => padId(f.properties?.id ?? f.properties?.RES_CO_REG) === id
    );
    if (feature?.geometry) {
      const [lon, lat] = featureCentroid(feature);
      return { lon, lat };
    }
    return {
      lon: Number(cfg.focusLon) || -73.65,
      lat: Number(cfg.focusLat) || 45.52
    };
  }

  function maxCentroidDist(collection, focus) {
    let max = 0;
    for (const f of collection.features ?? []) {
      const [lon, lat] = featureCentroid(f);
      max = Math.max(max, planarDist(lon, lat, focus.lon, focus.lat));
    }
    const configured = Number(cfg.focusRadiusDeg);
    if (Number.isFinite(configured) && configured > 0) {
      return Math.max(configured, max * 0.92);
    }
    return max || 14;
  }

  function rippleParams(lon, lat, focus, radius) {
    const cos = Math.cos((focus.lat * Math.PI) / 180);
    const dx = (lon - focus.lon) * cos;
    const dy = lat - focus.lat;
    const dist = Math.hypot(dx, dy);
    const t = smoothstep(clamp(dist / Math.max(radius, 1e-6), 0, 1));

    const ux = dist > 1e-9 ? dx / dist : 0;
    const uy = dist > 1e-9 ? dy / dist : 0;
    const east = clamp(ux, 0, 1);
    const north = clamp(uy, 0, 1);

    const center = Number(cfg.centerScale) || 2.5;
    const edgeSx = Number(cfg.edgeScaleX) || 0.55;
    const edgeSy = Number(cfg.edgeScaleY) || 0.6;
    const northSx = Number(cfg.northScaleX) || 0.9;
    const eastSy = Number(cfg.eastScaleY) || 0.75;

    // Directional edge targets: north → keep width, squash height;
    // east → squash width more, height a bit.
    const sxEdge = lerp(northSx, edgeSx, east);
    const syEdge = lerp(eastSy, edgeSy, north);

    const sx = lerp(center, sxEdge, t);
    const sy = lerp(center, syEdge, t);
    const pullCfg = Number(cfg.edgePull);
    const pull = lerp(1, Number.isFinite(pullCfg) ? pullCfg : 1, t);

    return { sx, sy, pull, t, dist };
  }

  function displayCentroid(cx, cy, focus, pull) {
    return [
      focus.lon + (cx - focus.lon) * pull,
      focus.lat + (cy - focus.lat) * pull
    ];
  }

  function geoToDisplay(lon, lat, enabled = true, regionId = null, collection = null) {
    if (!enabled || cfg.ripple === false) return [lon, lat];

    const focus = resolveFocus(collection);
    const radius = collection
      ? maxCentroidDist(collection, focus)
      : Number(cfg.focusRadiusDeg) || 14;

    if (regionId && collection) {
      const feature = (collection.features ?? []).find(
        (f) => padId(f.properties?.id ?? f.properties?.RES_CO_REG) === padId(regionId)
      );
      if (feature?.geometry) {
        const [cx, cy] = featureCentroid(feature);
        const { sx, sy, pull } = rippleParams(cx, cy, focus, radius);
        const inset = Math.max(0.9, 1 - (cfg.gap ?? 0));
        const [ncx, ncy] = displayCentroid(cx, cy, focus, pull);
        return [
          ncx + (lon - cx) * sx * inset,
          ncy + (lat - cy) * sy * inset
        ];
      }
    }

    const { sx, sy, pull } = rippleParams(lon, lat, focus, radius);
    const inset = Math.max(0.9, 1 - (cfg.gap ?? 0));
    const [ncx, ncy] = displayCentroid(lon, lat, focus, pull);
    // Point without a region: treat as its own tiny centroid.
    return [
      ncx + (lon - lon) * sx * inset,
      ncy + (lat - lat) * sy * inset
    ];
  }

  function toDisplayCollection(geoCollection, { enabled = true } = {}) {
    const focus = resolveFocus(geoCollection);

    // Basemap / disabled: true geography, no optical transforms.
    if (!enabled) {
      return {
        type: 'FeatureCollection',
        features: (geoCollection.features ?? []).map((feature) => {
          const id = padId(feature.properties?.id ?? feature.properties?.RES_CO_REG);
          return {
            type: 'Feature',
            properties: { ...feature.properties, id },
            geometry: feature.geometry
          };
        })
      };
    }

    let features;

    if (cfg.ripple === false) {
      // Geographic placement, but manuals + mapX/mapY still apply.
      features = (geoCollection.features ?? []).map((feature) => {
        const id = padId(feature.properties?.id ?? feature.properties?.RES_CO_REG);
        const geom = feature.geometry;
        return {
          type: 'Feature',
          properties: { ...feature.properties, id, _display: true },
          geometry: geom
            ? {
                type: geom.type,
                coordinates: mapCoords(geom.coordinates, (lon, lat) => [lon, lat])
              }
            : geom
        };
      });
    } else {
      const radius = maxCentroidDist(geoCollection, focus);
      const inset = Math.max(0.9, 1 - (cfg.gap ?? 0));

      features = (geoCollection.features ?? []).map((feature) => {
        const id = padId(feature.properties?.id ?? feature.properties?.RES_CO_REG);
        const geom = feature.geometry;
        if (!geom) {
          return {
            type: 'Feature',
            properties: { ...feature.properties, id },
            geometry: geom
          };
        }

        const [cx, cy] = featureCentroid(feature);
        const { sx, sy, pull, t } = rippleParams(cx, cy, focus, radius);
        const [ncx, ncy] = displayCentroid(cx, cy, focus, pull);
        const coordinates = mapCoords(geom.coordinates, (lon, lat) => [
          ncx + (lon - cx) * sx * inset,
          ncy + (lat - cy) * sy * inset
        ]);

        return {
          type: 'Feature',
          properties: {
            ...feature.properties,
            id,
            _display: true,
            _ripple: {
              t: Number(t.toFixed(3)),
              sx: Number((sx * inset).toFixed(3)),
              sy: Number((sy * inset).toFixed(3))
            }
          },
          geometry: { type: geom.type, coordinates }
        };
      });

      // Keep Québec arrangement: clear overlaps from enlarged south without
      // collapsing everything onto Montréal.
      separateOverlaps(features, {
        gap: Number(cfg.placeGap) || 0.22,
        iterations: Math.max(0, Number(cfg.placeIterations) || 0),
        homePull: Number(cfg.homePull) || 0.1,
        focus
      });
    }

    // Hand-tuned scale then offset from the editor export
    const scales = cfg.manualScales ?? {};
    for (const f of features) {
      const id = f.properties?.id;
      const raw = scales[id];
      if (!raw) continue;
      let sx;
      let sy;
      if (raw.sx != null || raw.sy != null) {
        sx = Number(raw.sx);
        sy = Number(raw.sy);
        if (!Number.isFinite(sx) || sx <= 0) sx = 1;
        if (!Number.isFinite(sy) || sy <= 0) sy = 1;
      } else {
        const s = Number(raw.s);
        sx = sy = Number.isFinite(s) && s > 0 ? s : 1;
      }
      if (sx === 1 && sy === 1) continue;
      // Y scales about the southern edge so squashing north regions
      // doesn't open a gap with Mauricie / Capitale / Gaspésie.
      const [cx] = featureCentroid(f);
      const south = featureMinLat(f);
      f.geometry = {
        ...f.geometry,
        coordinates: scaleAboutXY(f.geometry.coordinates, cx, south, sx, sy)
      };
    }

    const manual = cfg.manualOffsets ?? {};
    for (const f of features) {
      const id = f.properties?.id;
      const o = manual[id];
      if (!o) continue;
      const dx = Number(o.dx) || 0;
      const dy = Number(o.dy) || 0;
      if (dx || dy) translateFeature(f, dx, dy);
    }

    applyGlobalScale(features, cfg, focus);

    return { type: 'FeatureCollection', features };
  }

  function findRegionAt(geoCollection, lon, lat) {
    for (const feature of geoCollection.features ?? []) {
      if (pointInFeature(lon, lat, feature)) {
        return padId(feature.properties?.id ?? feature.properties?.RES_CO_REG);
      }
    }
    return null;
  }

  return {
    cfg,
    geoToDisplay,
    toDisplayCollection,
    findRegionAt,
    featureCentroid,
    resolveFocus
  };
}

function padId(id) {
  return String(id ?? '').padStart(2, '0');
}

function planarDist(lon, lat, flon, flat) {
  const cos = Math.cos((flat * Math.PI) / 180);
  return Math.hypot((lon - flon) * cos, lat - flat);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/** Smooth Hermite falloff (smoother than linear for a “ripple”). */
function smoothstep(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function mapCoords(coords, fn) {
  if (typeof coords[0] === 'number') return fn(coords[0], coords[1]);
  return coords.map((c) => mapCoords(c, fn));
}

function largestRing(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') return geometry.coordinates[0];
  if (geometry.type === 'MultiPolygon') {
    let best = null;
    let bestLen = 0;
    for (const poly of geometry.coordinates) {
      const ring = poly[0];
      if (ring?.length > bestLen) {
        best = ring;
        bestLen = ring.length;
      }
    }
    return best;
  }
  return null;
}

export function featureCentroid(feature) {
  const ring = largestRing(feature.geometry);
  if (!ring?.length) return [0, 0];
  let x = 0;
  let y = 0;
  let n = 0;
  for (const [lon, lat] of ring) {
    if (lon == null || lat == null) continue;
    x += lon;
    y += lat;
    n++;
  }
  return n ? [x / n, y / n] : [0, 0];
}

/** Southernmost latitude — Y-scale anchor so the bottom edge stays put. */
export function featureMinLat(feature) {
  let min = Infinity;
  mapCoords(feature.geometry?.coordinates, (lon, lat) => {
    if (lat < min) min = lat;
    return [lon, lat];
  });
  return Number.isFinite(min) ? min : 0;
}

function scaleAboutXY(coords, cx, cy, sx, sy) {
  return mapCoords(coords, (lon, lat) => [
    cx + (lon - cx) * sx,
    cy + (lat - cy) * sy
  ]);
}

function translateFeature(feature, dx, dy) {
  feature.geometry = {
    ...feature.geometry,
    coordinates: mapCoords(feature.geometry.coordinates, (lon, lat) => [
      lon + dx,
      lat + dy
    ])
  };
}

/** Stretch the whole map about its bbox centre (fallback: focus). */
function applyGlobalScale(features, cfg, focus) {
  let gx = Number(cfg.globalScaleX);
  let gy = Number(cfg.globalScaleY);
  if (!Number.isFinite(gx) || gx <= 0) gx = 1;
  if (!Number.isFinite(gy) || gy <= 0) gy = 1;
  if (gx === 1 && gy === 1) return;

  const box = collectionBBox(features);
  const ox = Number.isFinite(box.cx) ? box.cx : focus?.lon ?? 0;
  const oy = Number.isFinite(box.cy) ? box.cy : focus?.lat ?? 0;

  for (const f of features) {
    if (!f.geometry) continue;
    f.geometry = {
      ...f.geometry,
      coordinates: scaleAboutXY(f.geometry.coordinates, ox, oy, gx, gy)
    };
  }
}

function collectionBBox(features) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const f of features) {
    const b = featureBBox(f);
    if (!Number.isFinite(b.minX)) continue;
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2
  };
}

function featureBBox(feature) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  mapCoords(feature.geometry?.coordinates, (lon, lat) => {
    if (lon < minX) minX = lon;
    if (lat < minY) minY = lat;
    if (lon > maxX) maxX = lon;
    if (lat > maxY) maxY = lat;
    return [lon, lat];
  });
  return {
    minX,
    minY,
    maxX,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2
  };
}

/**
 * Push overlapping AABBs apart (with paper-cut gap), springing lightly
 * toward each region's post-ripple home so the map stays Québec-shaped.
 */
function separateOverlaps(features, { gap, iterations, homePull, focus }) {
  if (!features.length || iterations <= 0) return;

  const homes = features.map((f) => {
    const [cx, cy] = featureCentroid(f);
    return { cx, cy };
  });

  const pad = Math.max(0, gap) / 2;

  for (let iter = 0; iter < iterations; iter++) {
    const boxes = features.map(featureBBox);

    for (let i = 0; i < features.length; i++) {
      for (let j = i + 1; j < features.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (!Number.isFinite(a.minX) || !Number.isFinite(b.minX)) continue;

        const overlapX =
          Math.min(a.maxX + pad, b.maxX + pad) -
          Math.max(a.minX - pad, b.minX - pad);
        const overlapY =
          Math.min(a.maxY + pad, b.maxY + pad) -
          Math.max(a.minY - pad, b.minY - pad);
        if (overlapX <= 0 || overlapY <= 0) continue;

        let dx = b.cx - a.cx;
        let dy = b.cy - a.cy;
        let len = Math.hypot(dx, dy);

        // If centres coincide (stacked), push along vector from Montréal.
        if (len < 1e-8 && focus) {
          dx = (a.cx + b.cx) / 2 - focus.lon;
          dy = (a.cy + b.cy) / 2 - focus.lat;
          len = Math.hypot(dx, dy) || 1;
        } else if (len < 1e-8) {
          dx = 1;
          dy = 0;
          len = 1;
        }

        const push = Math.min(overlapX, overlapY) * 0.55;
        const ux = dx / len;
        const uy = dy / len;

        // Prefer moving the farther-from-focus region outward.
        let wA = 0.5;
        let wB = 0.5;
        if (focus) {
          const dA = planarDist(a.cx, a.cy, focus.lon, focus.lat);
          const dB = planarDist(b.cx, b.cy, focus.lon, focus.lat);
          const sum = dA + dB || 1;
          wA = dB / sum;
          wB = dA / sum;
        }

        const ax = -ux * push * wA;
        const ay = -uy * push * wA;
        const bx = ux * push * wB;
        const by = uy * push * wB;

        translateFeature(features[i], ax, ay);
        translateFeature(features[j], bx, by);
        boxes[i].cx += ax;
        boxes[i].cy += ay;
        boxes[i].minX += ax;
        boxes[i].maxX += ax;
        boxes[i].minY += ay;
        boxes[i].maxY += ay;
        boxes[j].cx += bx;
        boxes[j].cy += by;
        boxes[j].minX += bx;
        boxes[j].maxX += bx;
        boxes[j].minY += by;
        boxes[j].maxY += by;
      }
    }

    if (homePull > 0) {
      for (let i = 0; i < features.length; i++) {
        const [cx, cy] = featureCentroid(features[i]);
        translateFeature(
          features[i],
          (homes[i].cx - cx) * homePull,
          (homes[i].cy - cy) * homePull
        );
      }
    }
  }
}

function pointInFeature(lon, lat, feature) {
  const g = feature.geometry;
  if (!g) return false;
  if (g.type === 'Polygon') return pointInPolygon(lon, lat, g.coordinates);
  if (g.type === 'MultiPolygon') {
    return g.coordinates.some((poly) => pointInPolygon(lon, lat, poly));
  }
  return false;
}

function pointInPolygon(lon, lat, rings) {
  if (!rings?.length) return false;
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lon, lat, rings[i])) return false;
  }
  return true;
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
