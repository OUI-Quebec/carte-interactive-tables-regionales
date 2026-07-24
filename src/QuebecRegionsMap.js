import L from 'leaflet';
import { createLayoutEngine } from './layout.js';
import {
  normalizeContent,
  indexPublicationsByRegion,
  sanitizeHtml,
  formatPubDate
} from './content.js';

/**
 * Mount the Québec régions cutout map into `el`.
 * Driven by CMS JSON `config` (see public/config/map-config.schema.json).
 *
 * Returns helpers so lat/lon-tagged content stays geographically correct
 * while the drawing uses a separate optical / screen layout.
 *
 * @param {HTMLElement} el
 * @param {object} config
 */
export function mountQuebecRegionsMap(el, config) {
  const ui = config.ui ?? {};
  const styleCfg = config.style ?? {};
  const view = config.view ?? {};
  const layout = createLayoutEngine(config.layout ?? {});

  const regionById = new Map();
  for (const r of config.regions ?? []) {
    regionById.set(padId(r.id), r);
  }
  const visibleRegions = (config.regions ?? []).filter((r) => r.visible !== false);

  /** Baked-in optical offsets from config (dx=lon, dy=lat). */
  const manualOffsets = {
    ...(config.layout?.manualOffsets ?? {})
  };
  /** Baked-in per-region scales from config (`sx`/`sy`). */
  const manualScales = {
    ...(config.layout?.manualScales ?? {})
  };
  /** Whole-map stretch (after per-region tweaks). */
  let globalScaleX = Number(config.layout?.globalScaleX);
  let globalScaleY = Number(config.layout?.globalScaleY);
  if (!Number.isFinite(globalScaleX) || globalScaleX <= 0) globalScaleX = 1;
  if (!Number.isFinite(globalScaleY) || globalScaleY <= 0) globalScaleY = 1;

  /** Keep these under every other region unless hovered. */
  const Z_BACK_IDS = ['10', '09', '02']; // Nord-du-Québec, Côte-Nord, Saguenay
  const zBackSet = new Set(Z_BACK_IDS);

  /** @type {Map<string, L.Layer>} */
  const regionLayersById = new Map();
  /** @type {L.SVGOverlay | null} */
  let mtlInsetOverlay = null;
  /** @type {L.LayerGroup | null} */
  let mtlLeaderLayer = null;
  /** HTML labels for Laval / Montréal inside the inset (same font as map labels). */
  /** @type {L.LayerGroup | null} */
  let mtlInsetLabelLayer = null;
  /** @type {Map<string, L.Marker>} */
  const mtlInsetLabelMarkers = new Map();
  /** @type {{ id: string, x: number, y: number, name: string, off?: { x: number, y: number } }[]} */
  let mtlInsetLabelLayout = [];
  /** ViewBox size used by the current inset (for label projection). */
  let mtlInsetVb = { w: 250, h: 200 };
  /** Currently selected administrative region (`01`…`17`), or null. */
  let selectedId = null;
  /** @type {L.LayerGroup | null} */
  let personBubbleGroup = null;
  /** @type {{ id: string, target: L.LatLng } | null} */
  let personBubbleAnchor = null;

  /** CMS content from parent postMessage / config.content / demo. */
  let cmsContent = normalizeContent(config.content ?? null);
  /** @type {Map<string, object[]>} */
  let pubsByRegion = new Map();

  el.innerHTML = shellHtml(ui, visibleRegions);
  applyCutoutClass(el, styleCfg);

  const canvas = el.querySelector('.qc-map-canvas');
  const statusEl = el.querySelector('.qc-map-status');
  const pubsPane = el.querySelector('[data-pubs-drawer]');
  const pubsRegionEl = el.querySelector('[data-pubs-region]');
  const pubsListEl = el.querySelector('[data-pubs-list]');
  const pubsCloseBtn = el.querySelector('[data-pubs-close]');
  const quantityRoot = el.querySelector('[data-quantity]');
  const quantityRange = el.querySelector('[data-quantity-range]');

  /** Fraction of the map container the regions should fill at max zoom-out. */
  const fitFillConfigured = Math.min(1, Math.max(0.5, view.fitFill ?? 0.98));
  /** Mobile keeps a little breathing room so pinch-zoom feels useful. */
  const fitFillMobile = Math.min(0.92, Math.max(0.5, view.fitFillMobile ?? 0.85));

  const mobileMq =
    typeof matchMedia === 'function'
      ? matchMedia('(max-width: 720px)')
      : { matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };

  function isMobileViewport() {
    return Boolean(mobileMq.matches);
  }

  function currentFitFill() {
    return isMobileViewport() ? fitFillMobile : fitFillConfigured;
  }

  const map = L.map(canvas, {
    center: view.center ?? [53.2, -71.5],
    zoom: view.zoom ?? 5,
    minZoom: view.minZoom ?? 4,
    maxZoom: view.maxZoom ?? 10,
    // Fractional zoom so pinch on mobile isn't stuck on integer steps.
    zoomSnap: view.zoomSnap ?? 0,
    zoomDelta: view.zoomDelta ?? 0.25,
    wheelPxPerZoomLevel: view.wheelPxPerZoomLevel ?? 100,
    zoomControl: false,
    attributionControl: false,
    // Desktop starts locked; applyZoomMode() enables pinch/pan on mobile.
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    touchZoom: true,
    dragging: false
  });

  /** Enable pinch zoom + pan on mobile only; lock camera on desktop. */
  function applyZoomMode() {
    const mobile = isMobileViewport();
    if (mobile) {
      map.touchZoom.enable();
      map.dragging.enable();
      map.doubleClickZoom.disable();
      map.scrollWheelZoom.disable();
      map.boxZoom.disable();
    } else {
      map.touchZoom.disable();
      map.dragging.disable();
      map.doubleClickZoom.disable();
      map.scrollWheelZoom.disable();
      map.boxZoom.disable();
    }
  }

  /** Tell the Squarespace parent to stretch the iframe when content grows. */
  function notifyHostHeight() {
    if (destroyed) return;
    // Desktop pubs overlay the map — only mobile needs parent resize.
    if (!isMobileViewport()) return;
    if (typeof window === 'undefined' || window.parent === window) return;
    window.clearTimeout(heightNotifyTimer);
    heightNotifyTimer = window.setTimeout(() => {
      if (destroyed || !isMobileViewport()) return;
      // Measure the map root only — document scrollHeight is inflated by
      // min-height:100% to the current iframe viewport and won't shrink.
      const height = Math.max(320, Math.ceil(el.getBoundingClientRect().height));
      if (Math.abs(height - lastPostedHeight) < 2) return;
      lastPostedHeight = height;
      window.parent.postMessage({ type: 'quebec-map:resize', height }, '*');
    }, 50);
  }

  /** On-map name labels for large peripheral regions (from maps-test). */
  const MAP_LABELS = {
    '02': 'Saguenay',
    '08': 'Abitibi',
    '09': 'Côte-Nord',
    '10': 'Nord-du-Québec'
  };
  /**
   * Optical pixel nudges from the anchor (x right, y down).
   * Prefer MAP_LABEL_BOUNDS_FRAC for regions that must stay put across
   * small vs full-page embeds — fixed px drifts when the map scale changes.
   */
  const MAP_LABEL_OFFSETS = {
    '02': { x: 0, y: 0 },
    '08': { x: -15, y: -50 },
    '09': { x: 0, y: 0 },
    '10': { x: -50, y: 0 }
  };
  /**
   * Scale-independent nudges as a fraction of the region latLng bounds
   * (x → east, y → south). Used for Saguenay / Côte-Nord so placement
   * holds when the iframe is short or full-page.
   */
  const MAP_LABEL_BOUNDS_FRAC = {
    '02': { x: 0, y: 0.08 },
    '09': { x: 0.06, y: 0.12 }
  };

  /**
   * Mobile chrome: hide legend; all regions get labels on mobile.
   * Desktop keeps the legend + the four peripheral MAP_LABELS.
   */
  function syncMobileChrome() {
    const mobile = isMobileViewport();
    el.classList.toggle('qc-map-root--mobile', mobile);
    const legendEl = el.querySelector('[data-legend-bubble]');
    if (legendEl) {
      legendEl.hidden = mobile;
    }
    syncRegionLabels();
    notifyHostHeight();
  }

  /** Inline transform so the first paint is already centered (avoids bottom-right flash). */
  function regionLabelHtml(text, off = { x: 0, y: 0 }, extraClass = '') {
    const x = Number(off.x) || 0;
    const y = Number(off.y) || 0;
    const cls = extraClass
      ? `qc-region-label ${extraClass}`
      : 'qc-region-label';
    return `<span class="${cls}" style="transform:translate(calc(-50% + ${x}px),calc(-50% + ${y}px))">${escapeHtml(text)}</span>`;
  }

  function regionLabelIcon(text, off, extraClass) {
    return L.divIcon({
      className: 'qc-region-label-wrap leaflet-div-icon',
      html: regionLabelHtml(text, off, extraClass),
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    });
  }

  /** Anchor lat/lng for a region label (bounds-fraction or centroid). */
  function regionLabelLatLng(layer, id) {
    const frac = MAP_LABEL_BOUNDS_FRAC[id];
    const bounds = layer.getBounds?.();
    if (frac && bounds?.isValid()) {
      const base = bounds.getCenter();
      const h = bounds.getNorth() - bounds.getSouth();
      const w = bounds.getEast() - bounds.getWest();
      return L.latLng(
        base.lat - h * (frac.y || 0),
        base.lng + w * (frac.x || 0)
      );
    }

    if (layer.feature) {
      const [lon, lat] = featureCentroidLonLat(layer.feature);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return L.latLng(lat, lon);
      }
    }
    if (bounds?.isValid()) return bounds.getCenter();
    return null;
  }

  /** Place region names on polygons (maps-test sizing + offsets for key regions). */
  function syncRegionLabels() {
    if (regionLabelGroup) {
      map.removeLayer(regionLabelGroup);
      regionLabelGroup = null;
    }
    if (regionLayersById.size === 0) return;

    const mobile = isMobileViewport();
    const skipInsetIds =
      ui.showMontrealInset === false ? new Set() : new Set(['06', '13']);

    regionLabelGroup = L.layerGroup();
    regionLayersById.forEach((layer, id) => {
      if (skipInsetIds.has(id)) return;
      const mapped = MAP_LABELS[id];
      if (!mobile && !mapped) return;
      const cfg = regionById.get(id);
      const label = mapped || cfg?.shortName || cfg?.name || id;
      if (!label) return;

      const ll = regionLabelLatLng(layer, id);
      if (!ll) return;

      const off = MAP_LABEL_OFFSETS[id] ?? { x: 0, y: 0 };
      const marker = L.marker(ll, {
        interactive: false,
        keyboard: false,
        zIndexOffset: 400,
        icon: regionLabelIcon(label, off)
      });
      regionLabelGroup.addLayer(marker);
    });
    regionLabelGroup.addTo(map);
  }

  /**
   * Lock min zoom (and soft maxBounds) so fully zoomed-out regions
   * fill ~fitFill of the container — not a tiny island in empty space.
   * On desktop, also lock maxZoom to the fit level (no zoom UI).
   */
  function clampCameraToRegions(bounds, { fit = false } = {}) {
    if (!bounds?.isValid()) return;
    map.invalidateSize();
    const size = map.getSize();
    if (!size.x || !size.y) return;

    const fill = currentFitFill();
    const padX = Math.max(4, size.x * (1 - fill) / 2);
    const padY = Math.max(4, size.y * (1 - fill) / 2);
    const padding = L.point(padX, padY);

    let z = map.getBoundsZoom(bounds, false, padding);
    if (!Number.isFinite(z)) return;
    const configuredMax = view.maxZoom ?? 10;
    z = Math.min(z, configuredMax);
    if (view.minZoom != null) z = Math.max(z, view.minZoom);

    map.setMinZoom(z);

    const mobile = isMobileViewport();
    if (mobile) {
      map.setMaxZoom(configuredMax);
    } else {
      // Desktop: regions fill the pane; no zoom in/out.
      map.setMaxZoom(z);
    }

    // Allow a little pan slack, but keep the cutout framed.
    const slack = bounds.pad(Math.max(0.04, (1 - fill) * 0.75));
    map.setMaxBounds(slack);
    map.options.maxBoundsViscosity = view.maxBoundsViscosity ?? 1;

    applyZoomMode();

    if (fit) {
      map.fitBounds(bounds, {
        padding: [padY, padX],
        maxZoom: mobile ? configuredMax : z,
        animate: false
      });
    } else if (map.getZoom() < z) {
      map.setZoom(z, { animate: false });
    } else if (!mobile && map.getZoom() > z) {
      map.setZoom(z, { animate: false });
    }
    syncQuantityFromMap();
  }

  /** @type {GeoJSON.FeatureCollection | null} */
  let geoCollection = null;
  let regionLayer = null;
  let destroyed = false;
  /** @type {L.LayerGroup | null} */
  let regionLabelGroup = null;
  let lastPostedHeight = 0;
  let heightNotifyTimer = 0;

  function setStatus(text, isError = false) {
    if (!statusEl) return;
    if (!text) {
      statusEl.hidden = true;
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', isError);
  }

  function regionPathStyle(feature, hoverId = null) {
    const id = padId(feature.properties?.id ?? feature.properties?.RES_CO_REG);
    return pathStyle(
      feature,
      regionById,
      styleCfg,
      hoverId,
      selectedId === id,
      map
    );
  }

  function setActiveLegend(ids) {
    const active =
      ids instanceof Set
        ? ids
        : new Set(ids == null || ids === '' ? [] : [].concat(ids));
    el.querySelectorAll('.qc-map-legend-item').forEach((item) => {
      item.classList.toggle('is-active', active.has(item.dataset.id));
      item.classList.toggle('is-selected', selectedId === item.dataset.id);
    });
  }

  function clearPersonBubble() {
    if (personBubbleGroup) {
      map.removeLayer(personBubbleGroup);
      personBubbleGroup = null;
    }
    personBubbleAnchor = null;
  }

  /**
   * Comic-style contact card: prefer top-right of the region, with a black
   * triangle tail from a card corner (base on two adjacent edges) to center.
   */
  function computeContactCardLayout(target) {
    // Match .qc-person-bubble (248px + border-box); height ≈ banner + body.
    const BUBBLE_W = 248;
    const BUBBLE_H = 120;
    // Pull bases into the card so the black fill fuses with the 3px border.
    const INSET = 5;
    const size = map.getSize();
    const terr = regionLayer?.getBounds();
    const tPt = map.latLngToContainerPoint(target);

    let terrBox = {
      minX: tPt.x - 80,
      maxX: tPt.x + 80,
      minY: tPt.y - 80,
      maxY: tPt.y + 80
    };
    if (terr?.isValid()) {
      const corners = [
        terr.getNorthWest(),
        terr.getNorthEast(),
        terr.getSouthWest(),
        terr.getSouthEast()
      ].map((ll) => map.latLngToContainerPoint(ll));
      terrBox = {
        minX: Math.min(...corners.map((p) => p.x)),
        maxX: Math.max(...corners.map((p) => p.x)),
        minY: Math.min(...corners.map((p) => p.y)),
        maxY: Math.max(...corners.map((p) => p.y))
      };
    }

    const pubsOpen = Boolean(pubsPane?.classList.contains('is-open'));
    const mapRect = map.getContainer().getBoundingClientRect();
    const legendEl = el.querySelector('[data-legend-bubble]');
    let legendRight = 16;
    let legendBottom = 0;
    if (legendEl && !legendEl.hidden) {
      const lr = legendEl.getBoundingClientRect();
      legendRight = Math.max(16, lr.right - mapRect.left + 14);
      legendBottom = Math.max(0, lr.bottom - mapRect.top + 10);
    }

    const padL = legendRight;
    // Floating pubs panel (desktop only): inset 16px from right, ~300px wide (+ gap).
    // On mobile, publications sit below the map — no side padding.
    const pubsW = Math.min(300, Math.max(0, size.x - 32));
    const padR =
      (pubsOpen && !isMobileViewport() ? pubsW + 16 : 0) + 16;
    const padT = 16;
    const padB = 16;
    const ox = Math.max(56, Math.min(130, size.x * 0.07));
    const oy = Math.max(36, Math.min(110, size.y * 0.09));

    // Prefer top-right of the region (comic bubble). `corner` = where the
    // tail leaves the card (bl = bottom-left, etc.).
    const candidates = [
      {
        corner: 'bl',
        prefer: 6,
        x: tPt.x + ox * 0.55,
        y: tPt.y - BUBBLE_H - oy * 0.45
      },
      {
        corner: 'bl',
        prefer: 5,
        x: Math.max(tPt.x + ox * 0.35, terrBox.maxX - BUBBLE_W * 0.25),
        y: Math.min(tPt.y, terrBox.minY) - BUBBLE_H - oy * 0.25
      },
      {
        corner: 'bl',
        prefer: 4,
        x: terrBox.maxX + ox * 0.2,
        y: tPt.y - BUBBLE_H * 0.75
      },
      {
        corner: 'br',
        prefer: 3,
        x: tPt.x - BUBBLE_W - ox * 0.55,
        y: tPt.y - BUBBLE_H - oy * 0.45
      },
      {
        corner: 'tl',
        prefer: 2,
        x: tPt.x + ox * 0.55,
        y: tPt.y + oy * 0.55
      },
      {
        corner: 'tr',
        prefer: 1,
        x: tPt.x - BUBBLE_W - ox * 0.55,
        y: tPt.y + oy * 0.55
      }
    ];

    const overlapsLegend = (c) => c.x < legendRight && c.y < legendBottom;

    const fits = (c) =>
      c.x >= padL &&
      c.y >= padT &&
      c.x + BUBBLE_W <= size.x - padR &&
      c.y + BUBBLE_H <= size.y - padB &&
      !overlapsLegend(c);

    let best =
      candidates.filter(fits).sort((a, b) => b.prefer - a.prefer)[0] || {
        corner: 'bl',
        x: Math.max(padL, tPt.x + ox * 0.4),
        y: Math.max(padT, tPt.y - BUBBLE_H - oy * 0.3),
        prefer: 0
      };

    best = {
      ...best,
      x: Math.min(Math.max(best.x, padL), Math.max(padL, size.x - padR - BUBBLE_W)),
      y: Math.min(Math.max(best.y, padT), Math.max(padT, size.y - padB - BUBBLE_H))
    };
    if (overlapsLegend(best)) {
      best.x = padL;
      best.corner = 'bl';
    }

    // Comic tail: base on two adjacent edges near a corner. Bottom (or
    // top) attachment runs farther along the card so it reads as one shape.
    const x = best.x;
    const y = best.y;
    let base1;
    let base2;
    if (best.corner === 'bl') {
      base1 = L.point(x + INSET, y + BUBBLE_H * 0.6); // left, 40% from bottom
      base2 = L.point(x + BUBBLE_W * 0.58, y + BUBBLE_H - INSET); // bottom, farther right
    } else if (best.corner === 'br') {
      base1 = L.point(x + BUBBLE_W - INSET, y + BUBBLE_H * 0.6);
      base2 = L.point(x + BUBBLE_W * 0.42, y + BUBBLE_H - INSET);
    } else if (best.corner === 'tl') {
      base1 = L.point(x + INSET, y + BUBBLE_H * 0.4); // left, 40% from top
      base2 = L.point(x + BUBBLE_W * 0.58, y + INSET);
    } else {
      base1 = L.point(x + BUBBLE_W - INSET, y + BUBBLE_H * 0.4);
      base2 = L.point(x + BUBBLE_W * 0.42, y + INSET);
    }

    return {
      corner: best.corner,
      cardLatLng: map.containerPointToLatLng(L.point(x, y)),
      base1: map.containerPointToLatLng(base1),
      base2: map.containerPointToLatLng(base2),
      target
    };
  }

  function ensureContactStemPane() {
    if (!map.getPane('contactStemPane')) {
      map.createPane('contactStemPane');
      const pane = map.getPane('contactStemPane');
      pane.style.zIndex = '550';
      pane.style.pointerEvents = 'none';
    }
  }

  function reindexPublications() {
    const indexed = indexPublicationsByRegion(
      cmsContent.publications,
      geoCollection,
      layout
    );
    pubsByRegion = indexed.byRegion;
  }

  /**
   * Apply CMS contacts + publications (from parent postMessage or config).
   * Publications are assigned to regions via geographic lat/lng PIP.
   * @param {object} content
   */
  function setContent(content) {
    cmsContent = normalizeContent(content);
    reindexPublications();
    if (selectedId) {
      syncPublicationsPanel();
    } else {
      updatePersonBubble();
    }
  }

  function showPersonBubble(id, layer) {
    clearPersonBubble();
    ensureContactStemPane();
    const cfg = regionById.get(id);
    const regionName = cfg?.shortName || cfg?.name || id;
    const contact = cmsContent.contacts[padId(id)] ?? null;
    const target = layer.getBounds().getCenter();
    personBubbleAnchor = { id, target };

    const fullName = contact?.fullName?.trim() || 'Nom Prénom';
    const role = contact?.title?.trim() || 'Titre / rôle';
    const bodyHtml = contact?.body ? sanitizeHtml(contact.body) : '';
    const photoInner = contact?.profileImg
      ? `<img class="qc-person-bubble__photo-img" src="${escapeAttr(contact.profileImg)}" alt="" loading="lazy" />`
      : `<span class="qc-person-bubble__photo-ph">Photo</span>`;
    const noteBlock = bodyHtml
      ? `<div class="qc-person-bubble__cms">${bodyHtml}</div>`
      : `<div class="qc-person-bubble__note">Informations à venir</div>`;

    const layoutCard = computeContactCardLayout(target);
    const html = `
      <div class="qc-person-bubble${bodyHtml ? ' qc-person-bubble--rich' : ''}" role="dialog" aria-label="Contact — ${escapeAttr(regionName)}">
        <div class="qc-person-bubble__banner">
          <span>${escapeHtml(regionName)}</span>
        </div>
        <div class="qc-person-bubble__body">
          <div class="qc-person-bubble__photo" aria-hidden="true">
            ${photoInner}
          </div>
          <div class="qc-person-bubble__meta">
            <div class="qc-person-bubble__name">${escapeHtml(fullName)}</div>
            <div class="qc-person-bubble__role">${escapeHtml(role)}</div>
            ${noteBlock}
          </div>
        </div>
      </div>`;

    const iconH = bodyHtml ? 200 : 120;
    const marker = L.marker(layoutCard.cardLatLng, {
      interactive: false,
      keyboard: false,
      zIndexOffset: 1400,
      icon: L.divIcon({
        className: 'qc-person-bubble-wrap',
        html,
        iconSize: [248, iconH],
        iconAnchor: [0, 0]
      })
    });

    // Full black triangle: base on the card edge → apex at region center.
    const triangle = L.polygon(
      [layoutCard.base1, layoutCard.base2, layoutCard.target],
      {
        pane: 'contactStemPane',
        color: '#0a0a0a',
        weight: 0,
        fillColor: '#0a0a0a',
        fillOpacity: 1,
        opacity: 1,
        interactive: false,
        className: 'qc-person-bubble-stem'
      }
    );

    personBubbleGroup = L.layerGroup([triangle, marker]).addTo(map);
  }

  function updatePersonBubble() {
    if (!personBubbleAnchor || !selectedId) return;
    const layer = regionLayersById.get(personBubbleAnchor.id);
    if (!layer) return;
    showPersonBubble(personBubbleAnchor.id, layer);
  }

  function syncInsetSelectionHatch() {
    const svg = mtlInsetOverlay?.getElement?.() ?? mtlInsetOverlay?._image;
    if (!svg) return;
    svg.querySelectorAll('.qc-mtl-inset__hit').forEach((pathEl) => {
      const id = padId(pathEl.getAttribute('data-id'));
      const cfg = regionById.get(id);
      const fill = cfg?.color ?? '#ccc';
      pathEl.setAttribute(
        'fill',
        selectedId === id ? ensureHatchPattern(svg, fill) : fill
      );
      pathEl.classList.toggle('is-selected', selectedId === id);
    });
  }

  function syncPublicationsPanel() {
    const open = Boolean(selectedId);
    el.classList.toggle('qc-map-root--region-selected', open);
    if (pubsPane) {
      pubsPane.hidden = false;
      pubsPane.classList.toggle('is-open', open);
      pubsPane.setAttribute('aria-hidden', open ? 'false' : 'true');
    }
    if (!open || !selectedId) {
      updatePersonBubble();
      notifyHostHeight();
      return;
    }

    const cfg = regionById.get(selectedId);
    const name = cfg?.name || selectedId;
    if (pubsRegionEl) {
      pubsRegionEl.textContent = name;
    }
    if (pubsListEl) {
      const pubs = pubsByRegion.get(selectedId) ?? [];
      if (!pubs.length) {
        pubsListEl.innerHTML = `<li class="qc-map-pubs__empty">Aucune publication pour cette région.</li>`;
      } else {
        pubsListEl.innerHTML = pubs
          .map((pub) => {
            const href = pub.url || '#';
            const dateLabel = formatPubDate(pub.publishedAt);
            const media = pub.imageUrl
              ? `<img src="${escapeAttr(pub.imageUrl)}" alt="" loading="lazy" />`
              : `<span class="qc-map-pubs__card-media-ph">Image</span>`;
            const dateHtml = dateLabel
              ? `<time class="qc-map-pubs__card-date" datetime="${escapeAttr(new Date(pub.publishedAt).toISOString())}">${escapeHtml(dateLabel)}</time>`
              : '';
            return `<li class="qc-map-pubs__item">
            <a class="qc-map-pubs__card" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">
              <div class="qc-map-pubs__card-media" aria-hidden="true">
                ${media}
              </div>
              <div class="qc-map-pubs__card-body">
                <h3 class="qc-map-pubs__card-title">${escapeHtml(pub.title)}</h3>
                ${dateHtml}
                <p class="qc-map-pubs__card-desc">${escapeHtml(pub.summary || '')}</p>
                <span class="qc-map-pubs__card-cta">Lire la suite</span>
              </div>
            </a>
          </li>`;
          })
          .join('');
      }
    }
    // Drawer open/close changes available space for the contact card.
    updatePersonBubble();
    notifyHostHeight();
  }

  function refreshRegionStyles(hoverId = null) {
    regionLayersById.forEach((layer, id) => {
      layer.setStyle(regionPathStyle(layer.feature, hoverId === id ? id : null));
    });
    syncInsetSelectionHatch();
    applyRegionZOrder();
    if (selectedId && !zBackSet.has(selectedId)) {
      regionLayersById.get(selectedId)?.bringToFront();
    }
  }

  function selectRegion(id) {
    const rid = id == null || id === '' ? null : padId(id);
    if (rid && rid === selectedId) {
      // Toggle off
      selectedId = null;
      clearPersonBubble();
      setActiveLegend(null);
      syncPublicationsPanel();
      refreshRegionStyles();
      return;
    }

    selectedId = rid;
    const layer = rid ? regionLayersById.get(rid) : null;
    setActiveLegend(rid);
    syncPublicationsPanel();
    refreshRegionStyles(rid);

    if (rid && layer) {
      showPersonBubble(rid, layer);
    } else {
      clearPersonBubble();
    }
  }

  /**
   * Nord-du-Québec / Saguenay / Côte-Nord always stay at the bottom of the stack.
   */
  function applyRegionZOrder() {
    for (const id of Z_BACK_IDS) {
      regionLayersById.get(id)?.bringToBack();
    }
  }

  /** Approximate planar area of a latLng bounds (for hit ranking). */
  function boundsArea(bounds) {
    if (!bounds?.isValid()) return Number.POSITIVE_INFINITY;
    return (
      Math.abs(bounds.getEast() - bounds.getWest()) *
      Math.abs(bounds.getNorth() - bounds.getSouth())
    );
  }

  /** Ray-cast point-in-ring (lat/lng treated as planar for display space). */
  function pointInRing(latlng, ring) {
    if (!ring?.length) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].lng;
      const yi = ring[i].lat;
      const xj = ring[j].lng;
      const yj = ring[j].lat;
      const dy = yj - yi;
      if (dy === 0) continue;
      const intersect =
        yi > latlng.lat !== yj > latlng.lat &&
        latlng.lng < ((xj - xi) * (latlng.lat - yi)) / dy + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function isLatLngObj(x) {
    return x != null && typeof x.lat === 'number' && typeof x.lng === 'number';
  }

  /**
   * Leaflet polygon latlngs: ring | [ring, holes…] | multi [[ring, holes…], …]
   */
  function latLngsContain(latlngs, latlng) {
    if (!latlngs?.length) return false;
    const a = latlngs[0];
    if (isLatLngObj(a)) {
      return pointInRing(latlng, latlngs);
    }
    if (Array.isArray(a) && isLatLngObj(a[0])) {
      if (!pointInRing(latlng, a)) return false;
      for (let h = 1; h < latlngs.length; h++) {
        if (pointInRing(latlng, latlngs[h])) return false;
      }
      return true;
    }
    if (Array.isArray(a)) {
      return latlngs.some((poly) => latLngsContain(poly, latlng));
    }
    return false;
  }

  function layerContainsLatLng(layer, latlng) {
    if (!layer?.getBounds || !layer.getBounds().contains(latlng)) return false;
    if (typeof layer.getLatLngs !== 'function') return true;
    return latLngsContain(layer.getLatLngs(), latlng);
  }

  /**
   * Prefer the smallest region under the cursor so back-stacked giants
   * (Nord-du-Québec, etc.) don't steal clicks from overlapping neighbors,
   * while still receiving clicks on their exposed area.
   */
  function findRegionAtLatLng(latlng) {
    const hits = [];
    regionLayersById.forEach((layer, id) => {
      if (layerContainsLatLng(layer, latlng)) {
        hits.push({ id, layer, area: boundsArea(layer.getBounds()) });
      }
    });
    if (!hits.length) return null;
    hits.sort((a, b) => a.area - b.area);
    return hits[0];
  }

  let hoverId = null;

  function setHoveredRegion(id) {
    const next = id ? padId(id) : null;
    if (next === hoverId) return;
    const prev = hoverId;
    hoverId = next;
    if (prev && regionLayersById.has(prev)) {
      const prevLayer = regionLayersById.get(prev);
      prevLayer.setStyle(regionPathStyle(prevLayer.feature, null));
    }
    if (hoverId && regionLayersById.has(hoverId)) {
      const layer = regionLayersById.get(hoverId);
      layer.setStyle(regionPathStyle(layer.feature, hoverId));
      if (!zBackSet.has(hoverId)) layer.bringToFront();
    }
    setActiveLegend(
      selectedId && hoverId && selectedId !== hoverId
        ? [selectedId, hoverId]
        : hoverId || selectedId
    );
    applyRegionZOrder();
    if (selectedId && !zBackSet.has(selectedId)) {
      regionLayersById.get(selectedId)?.bringToFront();
    }
  }

  function onMapRegionMove(e) {
    if (!interactiveRegions()) return;
    const hit = findRegionAtLatLng(e.latlng);
    setHoveredRegion(hit?.id ?? null);
  }

  function onMapRegionClick(e) {
    if (!interactiveRegions()) return;
    // Ignore clicks that originated on UI chrome (bubble, drawer, slider).
    const t = e.originalEvent?.target;
    if (
      t?.closest?.(
        '.qc-map-bubble, .qc-map-pubs-drawer, .qc-map-quantity, .qc-mtl-inset-svg-overlay'
      )
    ) {
      return;
    }
    const hit = findRegionAtLatLng(e.latlng);
    if (hit) activateRegion(hit.id);
  }

  function interactiveRegions() {
    return ui.interactive !== false;
  }

  function redraw(collection) {
    if (regionLayer) map.removeLayer(regionLayer);
    if (mtlInsetOverlay) {
      map.removeLayer(mtlInsetOverlay);
      mtlInsetOverlay = null;
    }
    if (mtlLeaderLayer) {
      map.removeLayer(mtlLeaderLayer);
      mtlLeaderLayer = null;
    }
    if (mtlInsetLabelLayer) {
      map.removeLayer(mtlInsetLabelLayer);
      mtlInsetLabelLayer = null;
    }
    mtlInsetLabelMarkers.clear();
    mtlInsetLabelLayout = [];
    clearPersonBubble();
    hoverId = null;
    regionLayersById.clear();

    layout.cfg.manualOffsets = { ...manualOffsets };
    layout.cfg.manualScales = { ...manualScales };
    layout.cfg.globalScaleX = globalScaleX;
    layout.cfg.globalScaleY = globalScaleY;

    const display = layout.toDisplayCollection(collection, { enabled: true });

    regionLayer = L.geoJSON(display, {
      style(feature) {
        return regionPathStyle(feature, null);
      },
      onEachFeature(feature, featureLayer) {
        const id = padId(feature.properties?.id ?? feature.properties?.RES_CO_REG);
        regionLayersById.set(id, featureLayer);
      }
    }).addTo(map);

    applyRegionZOrder();

    map.invalidateSize();
    const bounds = regionLayer.getBounds();
    if (bounds.isValid()) {
      clampCameraToRegions(bounds, { fit: true });
    }
    // Labels after camera settle — avoids a first frame at the wrong zoom.
    syncMobileChrome();
    requestAnimationFrame(() => map.invalidateSize());
    renderMontrealInset(collection);
    syncMontrealZoomUi();
    if (selectedId && regionLayersById.has(selectedId)) {
      const layer = regionLayersById.get(selectedId);
      refreshRegionStyles();
      showPersonBubble(selectedId, layer);
      syncPublicationsPanel();
    } else {
      selectedId = null;
      syncPublicationsPanel();
    }
  }

  function activateRegion(id) {
    selectRegion(padId(id));
  }

  /**
   * Montréal inset — tweak these only (position ≠ size).
   *   offsetLat     up (+) / down (-)
   *   offsetLng     right/east (+) / left/west (-)
   *   halfLng       east half-width (west side grows via leftExtend)
   *   leftExtend    grow total width westward (0.25 ≈ +25%)
   */
  const MTL_INSET = {
    offsetLat: 1.35,
    offsetLng: 4.5,
    // ~15% larger than the previous 1.4; grows around the same anchor.
    halfLng: 1.61,
    leftExtend: 0.25
  };
  // Landscape rectangle (was ~square 200×230).
  const MTL_INSET_VB = { w: 250, h: 200 };

  function insetAnchorLatLng() {
    const estrie = regionLayersById.get('05')?.getBounds();
    const gaspe = regionLayersById.get('11')?.getBounds();
    const bsl = regionLayersById.get('01')?.getBounds();
    if (estrie?.isValid() && gaspe?.isValid()) {
      const southRef = bsl?.isValid()
        ? Math.min(estrie.getSouth(), bsl.getSouth())
        : estrie.getSouth();
      const lat = Math.min(gaspe.getSouth(), southRef) + MTL_INSET.offsetLat;
      const lng = estrie.getEast() + MTL_INSET.offsetLng;
      return L.latLng(lat, lng);
    }
    if (gaspe?.isValid()) {
      return L.latLng(
        gaspe.getSouth() + MTL_INSET.offsetLat - 0.7,
        gaspe.getWest() + MTL_INSET.offsetLng
      );
    }
    return L.latLng(46.0 + MTL_INSET.offsetLat, -68.4 + MTL_INSET.offsetLng);
  }

  /**
   * Geographic footprint matching the SVG viewBox aspect in screen space.
   * East edge stays put; width grows left via leftExtend so leaders stay on
   * the (new) west corners.
   */
  function insetMapBounds() {
    const anchor = insetAnchorLatLng();
    const halfLng = MTL_INSET.halfLng;
    const leftExtend = Math.max(0, MTL_INSET.leftExtend ?? 0);
    const c = map.project(anchor, map.getZoom());
    const west = map.project(
      L.latLng(anchor.lat, anchor.lng - halfLng),
      map.getZoom()
    );
    const halfWpx = Math.max(1, Math.abs(c.x - west.x));
    const fullWpx = 2 * halfWpx * (1 + leftExtend);
    // Keep the east edge; push the west edge further left.
    const rightX = c.x + halfWpx;
    const leftX = rightX - fullWpx;
    const fullHpx = fullWpx * (MTL_INSET_VB.h / MTL_INSET_VB.w);
    const halfHpx = fullHpx / 2;
    const sw = map.unproject(
      L.point(leftX, c.y + halfHpx),
      map.getZoom()
    );
    const ne = map.unproject(
      L.point(rightX, c.y - halfHpx),
      map.getZoom()
    );
    return L.latLngBounds(sw, ne);
  }

  function renderMontrealInset(collection) {
    if (ui.showMontrealInset === false) return;

    const order = ['06', '13']; // Montréal under, Laval on top
    const features = order
      .map((id) =>
        (collection.features ?? []).find(
          (f) => padId(f.properties?.id ?? f.properties?.RES_CO_REG) === id
        )
      )
      .filter(Boolean);

    if (features.length < 2) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const f of features) {
      mapGeomCoords(f.geometry, (lon, lat) => {
        if (lon < minX) minX = lon;
        if (lat < minY) minY = lat;
        if (lon > maxX) maxX = lon;
        if (lat > maxY) maxY = lat;
      });
    }

    const pad = Math.max(maxX - minX, maxY - minY) * 0.012 || 0.004;
    minX -= pad;
    maxX += pad;
    minY -= pad;
    maxY += pad;
    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    const vbW = MTL_INSET_VB.w;
    const vbH = MTL_INSET_VB.h;
    // Banner strip + title sizing matched to maps-test (20px title).
    const mapTop = 34;
    const edge = 4;
    const mapH = vbH - mapTop - edge;
    const mapW = vbW - edge * 2;
    const scale = Math.min(mapW / w, mapH / h) * 0.98;
    const ox = edge + (mapW - w * scale) / 2;
    const oy = mapTop + (mapH - h * scale) / 2;

    function project(lon, lat) {
      return [ox + (lon - minX) * scale, oy + (maxY - lat) * scale];
    }

    function ringToPath(ring) {
      if (!ring?.length) return '';
      return (
        ring
          .map((pt, i) => {
            const [x, y] = project(pt[0], pt[1]);
            return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
          })
          .join(' ') + ' Z'
      );
    }

    function geomToPath(geometry) {
      if (!geometry) return '';
      if (geometry.type === 'Polygon') {
        return geometry.coordinates.map(ringToPath).join(' ');
      }
      if (geometry.type === 'MultiPolygon') {
        return geometry.coordinates
          .map((poly) => poly.map(ringToPath).join(' '))
          .join(' ');
      }
      return '';
    }

    const strokeW = 2.6;
    const paths = features
      .map((f) => {
        const id = padId(f.properties?.id ?? f.properties?.RES_CO_REG);
        const cfg = regionById.get(id);
        const fill = cfg?.color ?? '#ccc';
        const stroke = boldenColor(fill, styleCfg.strokeDarken ?? 0.45);
        const name = cfg?.shortName || cfg?.name || id;
        const d = geomToPath(f.geometry);
        return `<path class="qc-mtl-inset__hit" data-id="${id}" d="${d}" fill="${escapeAttr(fill)}" fill-opacity="0.92" stroke="${escapeAttr(stroke)}" stroke-width="${strokeW}" stroke-linejoin="round" pointer-events="all" role="button" aria-label="${escapeAttr(name)}"><title>${escapeHtml(name)}</title></path>`;
      })
      .join('');

    // HTML labels (not SVG <text>) so Laval / Montréal share the same font as
    // the main map region labels — SVG text was falling back inconsistently.
    mtlInsetVb = { w: vbW, h: vbH };
    mtlInsetLabelLayout = features.map((f) => {
      const id = padId(f.properties?.id ?? f.properties?.RES_CO_REG);
      const name = id === '06' ? 'Montréal' : id === '13' ? 'Laval' : id;
      const [cx, cy] = featureCentroidLonLat(f);
      const [x, y] = project(cx, cy);
      const yLabel = id === '06' ? y + 12 : y;
      // Optical nudges (x right, y down) — keep labels inside their shapes.
      const labelOff =
        id === '13' ? { x: -8, y: 0 } : id === '06' ? { x: -15, y: 0 } : { x: 0, y: 0 };
      return { id, x, y: yLabel, name, off: labelOff };
    });

    const svgInner = `
      <rect x="0" y="0" width="${vbW}" height="${vbH}" fill="#0a0a0a" pointer-events="none"/>
      <rect x="3" y="3" width="${vbW - 6}" height="${vbH - 6}" fill="#0a0a0a" stroke="#0a0a0a" stroke-width="2" pointer-events="none"/>
      <text x="${vbW / 2}" y="${(mapTop - 2) / 2}" text-anchor="middle" dominant-baseline="middle" font-family="Roboto, Arial, sans-serif" font-size="20" font-weight="700" class="qc-mtl-inset__banner-svg" style="font-family:Roboto,Arial,sans-serif;font-size:20px;font-weight:700" pointer-events="none"><tspan class="qc-mtl-inset__banner-muted" font-family="Roboto, Arial, sans-serif" font-size="20" style="font-family:Roboto,Arial,sans-serif;font-size:20px">Région de </tspan><tspan font-family="Roboto, Arial, sans-serif" font-size="20" style="font-family:Roboto,Arial,sans-serif;font-size:20px">Montréal</tspan></text>
      <rect x="${edge}" y="${mapTop - 2}" width="${vbW - edge * 2}" height="${vbH - mapTop - edge + 2}" fill="#eef8fa" pointer-events="none"/>
      ${paths}
    `;

    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svgEl.setAttribute('viewBox', `0 0 ${vbW} ${vbH}`);
    svgEl.setAttribute('preserveAspectRatio', 'none');
    svgEl.setAttribute('class', 'qc-mtl-inset-svg-overlay');
    svgEl.innerHTML = svgInner;

    mtlInsetOverlay = L.svgOverlay(svgEl, insetMapBounds(), {
      opacity: 1,
      interactive: true,
      zIndex: 700,
      className: 'qc-mtl-inset-overlay'
    }).addTo(map);

    bindMontrealInsetEvents(svgEl);
    updateMontrealLeaders();
    updateMontrealInsetLabels();
    syncMontrealZoomUi();
  }

  /** Project inset viewBox coords → map lat/lng (matches svgOverlay bounds). */
  function insetViewBoxToLatLng(x, y) {
    const box = insetMapBounds();
    if (!box?.isValid()) return null;
    const z = map.getZoom();
    const sw = map.project(box.getSouthWest(), z);
    const ne = map.project(box.getNorthEast(), z);
    const px = sw.x + (x / mtlInsetVb.w) * (ne.x - sw.x);
    const py = ne.y + (y / mtlInsetVb.h) * (sw.y - ne.y);
    return map.unproject(L.point(px, py), z);
  }

  /** Laval / Montréal labels as HTML markers — same face as Saguenay etc. */
  function updateMontrealInsetLabels() {
    if (ui.showMontrealInset === false || !mtlInsetLabelLayout.length) {
      if (mtlInsetLabelLayer) {
        map.removeLayer(mtlInsetLabelLayer);
        mtlInsetLabelLayer = null;
      }
      mtlInsetLabelMarkers.clear();
      return;
    }

    if (!mtlInsetLabelLayer) {
      mtlInsetLabelLayer = L.layerGroup().addTo(map);
    }

    const seen = new Set();
    for (const item of mtlInsetLabelLayout) {
      const ll = insetViewBoxToLatLng(item.x, item.y);
      if (!ll) continue;
      seen.add(item.id);
      const existing = mtlInsetLabelMarkers.get(item.id);
      const icon = regionLabelIcon(
        item.name,
        item.off ?? { x: 0, y: 0 },
        'qc-mtl-inset__html-label'
      );
      if (existing) {
        // Move in place — avoid remove/re-add flash on zoom/pan.
        existing.setLatLng(ll);
        existing.setIcon(icon);
        continue;
      }
      const marker = L.marker(ll, {
        interactive: false,
        keyboard: false,
        zIndexOffset: 750,
        icon
      });
      mtlInsetLabelMarkers.set(item.id, marker);
      mtlInsetLabelLayer.addLayer(marker);
    }

    for (const [id, marker] of mtlInsetLabelMarkers) {
      if (seen.has(id)) continue;
      mtlInsetLabelLayer.removeLayer(marker);
      mtlInsetLabelMarkers.delete(id);
    }
  }

  /** Callout lines: Laval top → inset top, Montréal bottom → inset bottom. */
  function layerExtremeLatLng(layer, mode) {
    let best = null;
    let bestVal = mode === 'north' ? -Infinity : Infinity;
    const walk = (latlngs) => {
      if (!latlngs) return;
      if (latlngs.lat != null) {
        const v = latlngs.lat;
        if (mode === 'north' ? v > bestVal : v < bestVal) {
          bestVal = v;
          best = latlngs;
        }
        return;
      }
      for (const part of latlngs) walk(part);
    };
    walk(layer.getLatLngs());
    return best;
  }

  function updateMontrealLeaders() {
    if (ui.showMontrealInset === false) {
      if (mtlLeaderLayer) {
        map.removeLayer(mtlLeaderLayer);
        mtlLeaderLayer = null;
      }
      return;
    }

    const lavLayer = regionLayersById.get('13');
    const mtlLayer = regionLayersById.get('06');
    // Always use geographic inset bounds — DOM getBoundingClientRect can be
    // 0×0 mid-zoom/pan and would send leaders to the map's top-left (0,0).
    const box = insetMapBounds();
    if (!lavLayer || !mtlLayer || !box?.isValid()) return;

    const lavTop =
      layerExtremeLatLng(lavLayer, 'north') ?? lavLayer.getBounds().getNorthWest();
    const mtlBot =
      layerExtremeLatLng(mtlLayer, 'south') ?? mtlLayer.getBounds().getSouthWest();
    if (
      !lavTop ||
      !mtlBot ||
      !Number.isFinite(lavTop.lat) ||
      !Number.isFinite(mtlBot.lat)
    ) {
      return;
    }

    const boxTop = L.latLng(box.getNorth(), box.getWest());
    const boxBot = L.latLng(box.getSouth(), box.getWest());

    const topLine = [lavTop, boxTop];
    const botLine = [mtlBot, boxBot];

    const style = {
      color: '#0a0a0a',
      weight: 1.35,
      opacity: 0.85,
      lineCap: 'round',
      interactive: false,
      className: 'qc-mtl-leader'
    };

    if (mtlLeaderLayer) {
      map.removeLayer(mtlLeaderLayer);
    }
    mtlLeaderLayer = L.layerGroup([
      L.polyline(topLine, style),
      L.polyline(botLine, style)
    ]).addTo(map);
  }

  /** Keep Montréal inset chrome in sync (labels are HTML markers now). */
  function syncMontrealZoomUi() {
    if (ui.showMontrealInset === false) return;
  }

  function bindMontrealInsetEvents(svgEl) {
    const hitFrom = (t) =>
      t?.classList?.contains('qc-mtl-inset__hit')
        ? t
        : t?.closest?.('.qc-mtl-inset__hit');

    /** White/frame clicks: briefly disable the SVG and retarget the map underneath. */
    const passThrough = (ev) => {
      svgEl.style.setProperty('pointer-events', 'none', 'important');
      const below = document.elementFromPoint(ev.clientX, ev.clientY);
      svgEl.style.removeProperty('pointer-events');
      if (below && below !== svgEl) {
        below.dispatchEvent(
          new MouseEvent(ev.type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: ev.clientX,
            clientY: ev.clientY,
            screenX: ev.screenX,
            screenY: ev.screenY,
            button: ev.button,
            buttons: ev.buttons,
            ctrlKey: ev.ctrlKey,
            shiftKey: ev.shiftKey,
            altKey: ev.altKey,
            metaKey: ev.metaKey,
            view: window
          })
        );
      }
      ev.stopPropagation();
      ev.preventDefault();
    };

    const onActivate = (ev, pathEl) => {
      L.DomEvent.stop(ev);
      if (typeof pathEl.blur === 'function') pathEl.blur();
      if (document.activeElement?.blur) document.activeElement.blur();
      activateRegion(pathEl.getAttribute('data-id'));
    };

    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
      svgEl.addEventListener(
        type,
        (ev) => {
          const pathEl = hitFrom(ev.target);
          if (!pathEl) {
            passThrough(ev);
            return;
          }
          if (type === 'mousedown') {
            L.DomEvent.stop(ev);
            ev.preventDefault();
            return;
          }
          if (type === 'click') onActivate(ev, pathEl);
          else L.DomEvent.stop(ev);
        },
        true
      );
    }

    svgEl.querySelectorAll('.qc-mtl-inset__hit').forEach((pathEl) => {
      pathEl.addEventListener('mouseenter', () => {
        const id = padId(pathEl.getAttribute('data-id'));
        const layer = regionLayersById.get(id);
        if (!layer) return;
        setActiveLegend(selectedId ? [selectedId, id] : id);
        layer.setStyle(regionPathStyle(layer.feature, id));
        if (!zBackSet.has(id)) layer.bringToFront();
        applyRegionZOrder();
        if (selectedId && !zBackSet.has(selectedId)) {
          regionLayersById.get(selectedId)?.bringToFront();
        }
      });
      pathEl.addEventListener('mouseleave', () => {
        const id = padId(pathEl.getAttribute('data-id'));
        const layer = regionLayersById.get(id);
        setActiveLegend(selectedId);
        if (!layer) return;
        layer.setStyle(regionPathStyle(layer.feature, null));
        applyRegionZOrder();
        if (selectedId && !zBackSet.has(selectedId)) {
          regionLayersById.get(selectedId)?.bringToFront();
        }
      });
    });
    syncInsetSelectionHatch();
  }

  function onMontrealViewChange() {
    if (mtlInsetOverlay) {
      mtlInsetOverlay.setBounds(insetMapBounds());
    }
    updateMontrealLeaders();
    updateMontrealInsetLabels();
    syncMontrealZoomUi();
    updatePersonBubble();
  }
  map.on('zoom move', onMontrealViewChange);
  map.on('mousemove', onMapRegionMove);
  map.on('click', onMapRegionClick);
  map.on('mouseout', (e) => {
    // Clear hover when the pointer leaves the map container.
    if (!e.relatedTarget || !map.getContainer().contains(e.relatedTarget)) {
      setHoveredRegion(null);
    }
  });

  async function loadRegions() {
    setStatus('Chargement…');
    const geoUrl = config.geoUrl || resolveGeoUrlFallback();
    try {
      const res = await fetch(geoUrl);
      if (!res.ok) throw new Error(`GeoJSON ${res.status}`);
      geoCollection = await res.json();
      if (destroyed) return;
      reindexPublications();
      redraw(geoCollection);
      setStatus('');
      if (selectedId) syncPublicationsPanel();
    } catch (err) {
      console.error(err);
      setStatus(
        String(err.message || err).includes('GeoJSON')
          ? 'Missing region data. Run: npm run fetch:boundaries'
          : String(err.message || err),
        true
      );
    }
  }

  function resolveGeoUrlFallback() {
    const base = import.meta.env.BASE_URL || '/';
    const b = base.endsWith('/') ? base : `${base}/`;
    return `${b}geo/regions-admin.json`;
  }

  /** Soft oscillating blue↔white noise field behind the cutout map. */
  let pulseRaf = 0;
  const pulseRoot = el.querySelector('.qc-map-pulse');
  const prefersReducedMotion =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** @type {HTMLCanvasElement | null} */
  let noiseCanvas = null;
  /** @type {CanvasRenderingContext2D | null} */
  let noiseCtx = null;
  /** @type {{ phase: number, speed: number, amp: number }[] | null} */
  let noiseCells = null;
  let noiseCols = 0;
  let noiseRows = 0;
  let noiseStart = 0;

  function parseCssColor(input, fallback) {
    const raw = String(input || '').trim() || fallback;
    const hex = raw.startsWith('#') ? raw.slice(1) : raw;
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16)
      };
    }
    const fb = String(fallback).replace('#', '');
    return {
      r: parseInt(fb.slice(0, 2), 16),
      g: parseInt(fb.slice(2, 4), 16),
      b: parseInt(fb.slice(4, 6), 16)
    };
  }

  function stopNoiseBackground() {
    if (pulseRaf) {
      cancelAnimationFrame(pulseRaf);
      pulseRaf = 0;
    }
    noiseCanvas = null;
    noiseCtx = null;
    noiseCells = null;
    noiseFieldCanvas = null;
    if (pulseRoot) pulseRoot.replaceChildren();
  }

  function initNoiseGrid(cols, rows) {
    noiseCols = cols;
    noiseRows = rows;
    noiseCells = [];
    for (let i = 0; i < cols * rows; i++) {
      noiseCells.push({
        phase: Math.random() * Math.PI * 2,
        // Slow, varied oscillation — valleys rise/fall out of sync
        speed: 0.18 + Math.random() * 0.35,
        amp: 0.55 + Math.random() * 0.45
      });
    }
  }

  function resizeNoiseCanvas() {
    if (!noiseCanvas || !pulseRoot) return;
    const rect = pulseRoot.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (noiseCanvas.width === w && noiseCanvas.height === h) return;
    noiseCanvas.width = w;
    noiseCanvas.height = h;
    // Keep a soft grid density (~cell every 70–90px before blur)
    const cols = Math.max(8, Math.round(w / 80));
    const rows = Math.max(6, Math.round(h / 80));
    if (cols !== noiseCols || rows !== noiseRows || !noiseCells) {
      initNoiseGrid(cols, rows);
    }
  }

  /** @type {HTMLCanvasElement | null} */
  let noiseFieldCanvas = null;
  let noiseBlue = { r: 126, g: 182, b: 255 };
  let noiseWhite = { r: 238, g: 248, b: 250 };

  function refreshNoiseColors() {
    noiseBlue = parseCssColor(
      getComputedStyle(el).getPropertyValue('--qc-pulse-color').trim() ||
        styleCfg.pulseColor,
      '7EB6FF'
    );
    noiseWhite = parseCssColor(
      getComputedStyle(el).getPropertyValue('--qc-cutout-bg').trim() ||
        styleCfg.background,
      'EEF8FA'
    );
  }

  function paintNoiseFrame(timeMs) {
    if (!noiseCtx || !noiseCanvas || !noiseCells) return;
    const w = noiseCanvas.width;
    const h = noiseCanvas.height;
    if (!w || !h) return;

    const t = (timeMs - noiseStart) / 1000;
    const blue = noiseBlue;
    const white = noiseWhite;

    const fieldW = noiseCols;
    const fieldH = noiseRows;
    if (
      !noiseFieldCanvas ||
      noiseFieldCanvas.width !== fieldW ||
      noiseFieldCanvas.height !== fieldH
    ) {
      noiseFieldCanvas = document.createElement('canvas');
      noiseFieldCanvas.width = fieldW;
      noiseFieldCanvas.height = fieldH;
    }
    const tctx = noiseFieldCanvas.getContext('2d');
    if (!tctx) return;
    const field = tctx.createImageData(fieldW, fieldH);
    const data = field.data;

    for (let y = 0; y < fieldH; y++) {
      for (let x = 0; x < fieldW; x++) {
        const cell = noiseCells[y * fieldW + x];
        let v = Math.sin(t * cell.speed + cell.phase) * cell.amp;
        const left = noiseCells[y * fieldW + ((x + fieldW - 1) % fieldW)];
        const up = noiseCells[((y + fieldH - 1) % fieldH) * fieldW + x];
        v +=
          0.22 * Math.sin(t * left.speed * 0.9 + left.phase) +
          0.22 * Math.sin(t * up.speed * 0.9 + up.phase);
        let n = 0.5 + 0.5 * Math.tanh(v * 0.85);
        n = n * n * (3 - 2 * n);
        const i = (y * fieldW + x) * 4;
        data[i] = Math.round(white.r + (blue.r - white.r) * n);
        data[i + 1] = Math.round(white.g + (blue.g - white.g) * n);
        data[i + 2] = Math.round(white.b + (blue.b - white.b) * n);
        data[i + 3] = 255;
      }
    }

    tctx.putImageData(field, 0, 0);
    noiseCtx.imageSmoothingEnabled = true;
    noiseCtx.imageSmoothingQuality = 'high';
    noiseCtx.clearRect(0, 0, w, h);
    noiseCtx.drawImage(noiseFieldCanvas, 0, 0, w, h);
  }

  function noiseLoop(now) {
    if (destroyed || !noiseCanvas) {
      pulseRaf = 0;
      return;
    }
    paintNoiseFrame(now);
    if (!prefersReducedMotion) {
      pulseRaf = requestAnimationFrame(noiseLoop);
    } else {
      pulseRaf = 0;
    }
  }

  function startNoiseBackground() {
    if (!pulseRoot) return;
    stopNoiseBackground();
    noiseCanvas = document.createElement('canvas');
    noiseCanvas.className = 'qc-map-pulse-noise';
    noiseCanvas.setAttribute('aria-hidden', 'true');
    pulseRoot.appendChild(noiseCanvas);
    noiseCtx = noiseCanvas.getContext('2d', { alpha: false });
    noiseStart = performance.now();
    refreshNoiseColors();
    resizeNoiseCanvas();
    paintNoiseFrame(noiseStart);
    if (!prefersReducedMotion) {
      pulseRaf = requestAnimationFrame(noiseLoop);
    }
  }

  el.querySelectorAll('.qc-map-legend-item').forEach((item) => {
    const activate = () => activateRegion(item.dataset.id);
    item.addEventListener('click', activate);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
  });

  if (pubsCloseBtn) {
    pubsCloseBtn.addEventListener('click', () => selectRegion(null));
  }

  const sideBubble = el.querySelector('[data-legend-bubble]');
  if (sideBubble) {
    L.DomEvent.disableClickPropagation(sideBubble);
    L.DomEvent.disableScrollPropagation(sideBubble);
  }
  if (pubsPane) {
    L.DomEvent.disableClickPropagation(pubsPane);
    L.DomEvent.disableScrollPropagation(pubsPane);
  }

  /** Bottom-right quantity slider ↔ map zoom. */
  let quantitySyncing = false;

  function zoomToQuantityValue() {
    const zMin = map.getMinZoom();
    const zMax = map.getMaxZoom();
    const span = Math.max(0.001, zMax - zMin);
    return ((map.getZoom() - zMin) / span) * 100;
  }

  function quantityValueToZoom(value) {
    const zMin = map.getMinZoom();
    const zMax = map.getMaxZoom();
    return zMin + (Number(value) / 100) * (zMax - zMin);
  }

  function syncQuantityFromMap() {
    if (!quantityRange || quantitySyncing) return;
    quantitySyncing = true;
    quantityRange.value = String(zoomToQuantityValue());
    updateQuantityFill();
    quantitySyncing = false;
  }

  function updateQuantityFill() {
    if (!quantityRange) return;
    const v = Number(quantityRange.value);
    quantityRange.style.setProperty('--qc-quantity-pct', `${v}%`);
  }

  if (quantityRoot && quantityRange) {
    L.DomEvent.disableClickPropagation(quantityRoot);
    L.DomEvent.disableScrollPropagation(quantityRoot);
    updateQuantityFill();
    quantityRange.addEventListener('input', () => {
      updateQuantityFill();
      if (quantitySyncing) return;
      quantitySyncing = true;
      map.setZoom(quantityValueToZoom(quantityRange.value), { animate: false });
      quantitySyncing = false;
    });
    map.on('zoom zoomend minzoom', syncQuantityFromMap);
    // After fit/clamp settles minZoom, refresh once.
    map.whenReady(() => {
      requestAnimationFrame(syncQuantityFromMap);
    });
  }

  const onWinResize = () => {
    if (destroyed) return;
    map.invalidateSize();
    applyZoomMode();
    syncMobileChrome();
    if (!regionLayer) return;
    const bounds = regionLayer.getBounds();
    if (bounds.isValid()) clampCameraToRegions(bounds, { fit: true });
  };
  window.addEventListener('resize', onWinResize);

  /** @type {ResizeObserver | null} */
  let hostResizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    hostResizeObserver = new ResizeObserver(() => {
      onWinResize();
    });
    hostResizeObserver.observe(el);
  }

  if (typeof mobileMq.addEventListener === 'function') {
    mobileMq.addEventListener('change', onWinResize);
  } else if (typeof mobileMq.addListener === 'function') {
    mobileMq.addListener(onWinResize);
  }

  applyZoomMode();
  syncMobileChrome();

  requestAnimationFrame(() => {
    map.invalidateSize();
    loadRegions();
  });

  return {
    map,
    destroy() {
      destroyed = true;
      window.clearTimeout(heightNotifyTimer);
      clearPersonBubble();
      if (regionLabelGroup) {
        map.removeLayer(regionLabelGroup);
        regionLabelGroup = null;
      }
      if (mtlInsetLabelLayer) {
        map.removeLayer(mtlInsetLabelLayer);
        mtlInsetLabelLayer = null;
      }
      mtlInsetLabelMarkers.clear();
      stopNoiseBackground();
      window.removeEventListener('resize', onWinResize);
      if (typeof mobileMq.removeEventListener === 'function') {
        mobileMq.removeEventListener('change', onWinResize);
      } else if (typeof mobileMq.removeListener === 'function') {
        mobileMq.removeListener(onWinResize);
      }
      hostResizeObserver?.disconnect();
      hostResizeObserver = null;
      map.off('zoom move', onMontrealViewChange);
      map.off('mousemove', onMapRegionMove);
      map.off('click', onMapRegionClick);
      map.remove();
      el.innerHTML = '';
    },
    /** Apply CMS contacts + publications (parent postMessage / bridge). */
    setContent,
    /** Geographic containment — use real lon/lat from CMS content. */
    findRegionAt(lon, lat) {
      if (!geoCollection) return null;
      return layout.findRegionAt(geoCollection, lon, lat);
    },
    /** Project geographic lon/lat into display space. */
    geoToDisplay(lon, lat) {
      return layout.geoToDisplay(lon, lat, true);
    }
  };
}

function shellHtml(ui, visibleRegions) {
  const legend =
    ui.showLegend === false
      ? ''
      : `<aside class="qc-map-bubble qc-map-bubble--legend" aria-label="Légende des régions" data-legend-bubble>
          <div class="qc-map-legend" data-legend-pane>
            <div class="qc-map-legend-heading">Légende</div>
            <ol class="qc-map-legend-list">
              ${visibleRegions
                .map((r) => {
                  const id = padId(r.id);
                  return `<li class="qc-map-legend-item" data-id="${id}" role="button" tabindex="0">
                    <span class="qc-map-swatch" style="background:${escapeAttr(r.color || '#ccc')}"></span>
                    <span class="qc-map-legend-id">${id}</span>
                    <span class="qc-map-legend-name">${escapeHtml(r.name || id)}</span>
                  </li>`;
                })
                .join('')}
            </ol>
          </div>
        </aside>`;

  const pubsDrawer = `<aside
      class="qc-map-pubs-drawer"
      data-pubs-drawer
      aria-label="Publications de la région"
      aria-hidden="true"
    >
      <div class="qc-map-pubs">
        <div class="qc-map-pubs__head">
          <div class="qc-map-pubs__heading">Dernières publications</div>
          <button type="button" class="qc-map-pubs__close" data-pubs-close aria-label="Fermer">×</button>
        </div>
        <p class="qc-map-pubs__region" data-pubs-region></p>
        <ul class="qc-map-pubs__list" data-pubs-list></ul>
      </div>
    </aside>`;

  return `
    <div class="qc-map-body">
      <div class="qc-map-stage">
        <div class="qc-map-pulse" aria-hidden="true"></div>
        <div class="qc-map-canvas" role="application"></div>
        ${legend}
        <div class="qc-map-quantity" data-quantity>
          <label class="qc-map-quantity__label" for="qc-quantity-range">Zoom</label>
          <div class="qc-map-quantity__pill">
            <input
              id="qc-quantity-range"
              class="qc-map-quantity__range"
              data-quantity-range
              type="range"
              min="0"
              max="100"
              step="0.1"
              value="50"
              aria-label="Indicateur de quantité"
            />
          </div>
        </div>
      </div>
      ${pubsDrawer}
    </div>
    <div class="qc-map-status" hidden></div>`;
}

function applyCutoutClass(el, styleCfg = {}) {
  el.className = 'qc-map-root qc-map-root--cutout';
  const pulse = styleCfg.pulseColor || '#7EB6FF';
  el.style.setProperty('--qc-pulse-color', pulse);
  el.style.setProperty('--qc-cutout-bg', 'transparent');
}

function padId(id) {
  return String(id ?? '').padStart(2, '0');
}

function mapGeomCoords(geometry, fn) {
  if (!geometry?.coordinates) return;
  const walk = (coords) => {
    if (typeof coords[0] === 'number') {
      fn(coords[0], coords[1]);
      return;
    }
    coords.forEach(walk);
  };
  walk(geometry.coordinates);
}

function featureCentroidLonLat(feature) {
  let x = 0;
  let y = 0;
  let n = 0;
  mapGeomCoords(feature.geometry, (lon, lat) => {
    x += lon;
    y += lat;
    n++;
  });
  return n ? [x / n, y / n] : [0, 0];
}

function pathStyle(
  feature,
  regionById,
  styleCfg,
  hoverId,
  selected = false,
  mapForHatch = null
) {
  const id = padId(feature.properties?.id ?? feature.properties?.RES_CO_REG);
  const cfg = regionById.get(id);
  const fill = cfg?.color ?? '#9DC3E6';
  const highlighted = Boolean(cfg?.highlighted);
  const hovering = hoverId === id;
  const strokeW = styleCfg.strokeWidth ?? 2.75;

  let fillColor = fill;
  if (selected && mapForHatch) {
    const svg =
      mapForHatch.getPanes?.()?.overlayPane?.querySelector('svg') ?? null;
    if (svg) fillColor = ensureHatchPattern(svg, fill);
  }

  return {
    color: boldenColor(fill, styleCfg.strokeDarken ?? 0.45),
    weight:
      selected
        ? strokeW + 2
        : highlighted || hovering
          ? strokeW + 1.25
          : strokeW,
    opacity: 1,
    fillColor,
    fillOpacity: 1,
    lineJoin: 'round',
    lineCap: 'round',
    className: selected ? 'qc-region-path is-selected' : 'qc-region-path'
  };
}

/**
 * Animated 4px diagonal hatch over the region fill colour.
 * @param {SVGElement} svg
 * @param {string} fillHex
 */
function ensureHatchPattern(svg, fillHex) {
  const fill = fillHex || '#888888';
  const safe = String(fill).replace(/[^a-zA-Z0-9]/g, '') || '888';
  const pid = `qc-hatch-${safe}`;
  const NS = 'http://www.w3.org/2000/svg';

  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS(NS, 'defs');
    svg.insertBefore(defs, svg.firstChild);
  }

  let pattern = defs.querySelector(`#${pid}`);
  if (!pattern) {
    pattern = document.createElementNS(NS, 'pattern');
    pattern.setAttribute('id', pid);
    pattern.setAttribute('patternUnits', 'userSpaceOnUse');
    pattern.setAttribute('width', '12');
    pattern.setAttribute('height', '12');
    pattern.setAttribute('patternTransform', 'rotate(45)');

    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', '12');
    bg.setAttribute('height', '12');
    bg.setAttribute('fill', fill);

    const stripe = document.createElementNS(NS, 'line');
    stripe.setAttribute('x1', '2');
    stripe.setAttribute('y1', '0');
    stripe.setAttribute('x2', '2');
    stripe.setAttribute('y2', '12');
    stripe.setAttribute('stroke', 'rgba(0,0,0,0.32)');
    stripe.setAttribute('stroke-width', '4');
    stripe.setAttribute('stroke-linecap', 'butt');

    const anim = document.createElementNS(NS, 'animate');
    anim.setAttribute('attributeName', 'x');
    anim.setAttribute('from', '0');
    anim.setAttribute('to', '12');
    anim.setAttribute('dur', '0.85s');
    anim.setAttribute('repeatCount', 'indefinite');

    pattern.appendChild(bg);
    pattern.appendChild(stripe);
    pattern.appendChild(anim);
    defs.appendChild(pattern);
  } else {
    const bg = pattern.querySelector('rect');
    if (bg) bg.setAttribute('fill', fill);
  }

  return `url(#${pid})`;
}

/** Darker / richer border derived from the fill colour. */
function boldenColor(hex, darken = 0.42) {
  const rgb = parseHex(hex);
  if (!rgb) return '#333333';
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  hsl.s = Math.min(1, hsl.s * 1.2);
  hsl.l = Math.max(0.1, hsl.l * (1 - darken));
  return hslToHex(hsl.h, hsl.s, hsl.l);
}

function parseHex(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length === 3) {
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16)
    };
  }
  if (h.length !== 6) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h, s, l };
}

function hslToHex(h, s, l) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r;
  let g;
  let b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const to = (x) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replaceAll("'", '&#39;');
}
