/**
 * CMS content helpers: normalize, sanitize HTML, index pubs by region.
 */

/** @param {string} id */
export function padRegionId(id) {
  return String(id ?? '').padStart(2, '0');
}

/**
 * Resolve a public/ asset path against Vite BASE_URL (GitHub Pages safe).
 * @param {string} path
 * @param {string} [base]
 */
export function resolvePublicUrl(path, base = import.meta.env.BASE_URL || '/') {
  if (!path) return path;
  if (/^(https?:|data:|blob:)/i.test(path) || path.startsWith('//')) return path;
  const clean = String(path).replace(/^\//, '');
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}${clean}`;
}

/**
 * Light allowlist sanitizer for CMS HTML (contact body).
 * @param {string | null | undefined} html
 */
export function sanitizeHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  const allowed = new Set([
    'P',
    'BR',
    'STRONG',
    'EM',
    'B',
    'I',
    'U',
    'A',
    'UL',
    'OL',
    'LI',
    'SPAN',
    'DIV',
    'H1',
    'H2',
    'H3',
    'H4',
    'BLOCKQUOTE',
    'HR',
    'IMG',
    'FIGURE',
    'FIGCAPTION',
    'SECTION',
    'ARTICLE'
  ]);
  // Drop entirely (do NOT unwrap — <style>/<script> text would become visible).
  const removeEntire = new Set([
    'STYLE',
    'SCRIPT',
    'LINK',
    'META',
    'NOSCRIPT',
    'TEMPLATE',
    'IFRAME',
    'OBJECT',
    'EMBED',
    'SVG'
  ]);

  const scrub = (parent) => {
    for (const child of [...parent.childNodes]) {
      if (child.nodeType === Node.COMMENT_NODE) {
        parent.removeChild(child);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = /** @type {Element} */ (child);
      if (removeEntire.has(el.tagName)) {
        parent.removeChild(el);
        continue;
      }
      if (!allowed.has(el.tagName)) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
        continue;
      }
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'style') {
          el.removeAttribute(attr.name);
          continue;
        }
        if (el.tagName === 'A' && name === 'href') {
          const href = String(attr.value || '').trim();
          if (/^javascript:/i.test(href) || /^data:/i.test(href)) {
            el.removeAttribute('href');
          } else {
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noopener noreferrer');
          }
          continue;
        }
        if (
          el.tagName === 'IMG' &&
          (name === 'src' ||
            name === 'alt' ||
            name === 'loading' ||
            name === 'width' ||
            name === 'height')
        ) {
          if (name === 'src') {
            const src = String(attr.value || '').trim();
            if (!/^(https?:|data:image\/|\/)/i.test(src)) {
              el.removeAttribute('src');
            }
          }
          continue;
        }
        if (!(el.tagName === 'A' && name === 'href')) {
          el.removeAttribute(attr.name);
        }
      }
      scrub(el);
    }
  };

  scrub(doc.body);
  return doc.body.innerHTML;
}

/**
 * Plain-text summary from excerpt or first paragraph of HTML body.
 * @param {{ excerpt?: string, body?: string, summary?: string }} item
 */
export function extractSummary(item) {
  if (item?.summary != null && String(item.summary).trim()) {
    return String(item.summary).trim();
  }
  if (item?.excerpt != null && String(item.excerpt).trim()) {
    return stripHtml(String(item.excerpt)).trim();
  }
  const body = item?.body != null ? String(item.body) : '';
  if (!body) return '';
  const text = stripHtml(body).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const para = text.split(/(?<=[.!?])\s+/)[0] || text;
  return para.length > 280 ? `${para.slice(0, 277)}…` : para;
}

/** @param {string} html */
export function stripHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc
    .querySelectorAll('style, script, noscript, template, link, meta')
    .forEach((el) => el.remove());
  return doc.body.textContent || '';
}

/**
 * Normalize a full or partial CMS payload.
 * @param {unknown} raw
 * @returns {{
 *   contacts?: Record<string, object>,
 *   publications?: object[],
 *   regionPages?: Record<string, object>,
 *   hasContacts: boolean,
 *   hasPublications: boolean,
 *   hasRegionPages: boolean
 * }}
 */
export function normalizeContent(raw) {
  const src = raw && typeof raw === 'object' ? /** @type {any} */ (raw) : {};
  const hasContacts = Object.prototype.hasOwnProperty.call(src, 'contacts');
  const hasPublications = Object.prototype.hasOwnProperty.call(src, 'publications');
  const hasRegionPages = Object.prototype.hasOwnProperty.call(src, 'regionPages');

  /** @type {Record<string, object> | undefined} */
  let contacts;
  if (hasContacts) {
    contacts = {};
    const contactSrc =
      src.contacts && typeof src.contacts === 'object' && !Array.isArray(src.contacts)
        ? src.contacts
        : {};
    for (const [key, value] of Object.entries(contactSrc)) {
      const id = padRegionId(key);
      if (!/^(0[1-9]|1[0-7])$/.test(id)) continue;
      const c = value && typeof value === 'object' ? value : {};
      contacts[id] = {
        fullName: c.fullName != null ? String(c.fullName) : '',
        profileImg:
          c.profileImg != null && c.profileImg !== '' ? String(c.profileImg) : null,
        title: c.title != null ? String(c.title) : null,
        email: c.email != null && c.email !== '' ? String(c.email) : null,
        body: c.body != null ? String(c.body) : null
      };
    }
  }

  /** @type {object[] | undefined} */
  let publications;
  if (hasPublications) {
    const pubsIn = Array.isArray(src.publications) ? src.publications : [];
    publications = pubsIn.map((p, i) => normalizePublication(p, i)).filter(Boolean);
  }

  /** @type {Record<string, object> | undefined} */
  let regionPages;
  if (hasRegionPages) {
    regionPages = {};
    const pageSrc =
      src.regionPages && typeof src.regionPages === 'object' && !Array.isArray(src.regionPages)
        ? src.regionPages
        : {};
    for (const [key, value] of Object.entries(pageSrc)) {
      const id = padRegionId(key);
      if (!/^(0[1-9]|1[0-7])$/.test(id)) continue;
      const p = value && typeof value === 'object' ? value : {};
      regionPages[id] = {
        title: p.title != null ? String(p.title) : '',
        body: p.body != null ? String(p.body) : '',
        url: p.url != null ? String(p.url) : null
      };
    }
  }

  return {
    contacts,
    publications,
    regionPages,
    hasContacts,
    hasPublications,
    hasRegionPages
  };
}

/**
 * Merge a partial content update into existing CMS state.
 * Omitting a key leaves that side unchanged.
 * @param {{
 *   contacts?: Record<string, object>,
 *   publications?: object[],
 *   regionPages?: Record<string, object>
 * }} current
 * @param {unknown} raw
 */
export function mergeContent(current, raw) {
  const next = normalizeContent(raw);
  const base = current && typeof current === 'object' ? current : {};
  return {
    contacts: next.hasContacts ? next.contacts ?? {} : base.contacts ?? {},
    publications: next.hasPublications
      ? next.publications ?? []
      : base.publications ?? [],
    regionPages: next.hasRegionPages
      ? next.regionPages ?? {}
      : base.regionPages ?? {}
  };
}

/**
 * @param {any} p
 * @param {number} index
 */
function normalizePublication(p, index) {
  if (!p || typeof p !== 'object') return null;
  const lat = pickCoord(p.lat, p.location?.markerLat, p.location?.mapLat);
  const lng = pickCoord(p.lng, p.location?.markerLng, p.location?.mapLng);
  const publishedAt = Number(p.publishedAt ?? p.publishOn ?? p.addedOn);
  return {
    id: p.id != null ? String(p.id) : `pub-${index}`,
    title: p.title != null ? String(p.title) : 'Sans titre',
    summary: extractSummary(p),
    publishedAt: Number.isFinite(publishedAt) ? publishedAt : 0,
    url: p.url != null ? String(p.url) : p.fullUrl != null ? String(p.fullUrl) : '#',
    imageUrl:
      p.imageUrl != null && p.imageUrl !== ''
        ? String(p.imageUrl)
        : p.assetUrl != null && p.assetUrl !== ''
          ? String(p.assetUrl)
          : null,
    lat,
    lng
  };
}

function pickCoord(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Assign publications to administrative regions via geographic PIP.
 * @param {object[]} publications
 * @param {GeoJSON.FeatureCollection | null} geoCollection
 * @param {{ findRegionAt: Function }} layout
 * @returns {{ byRegion: Map<string, object[]>, unassigned: object[] }}
 */
export function indexPublicationsByRegion(publications, geoCollection, layout) {
  /** @type {Map<string, object[]>} */
  const byRegion = new Map();
  /** @type {object[]} */
  const unassigned = [];

  if (!geoCollection) {
    return { byRegion, unassigned: [...(publications ?? [])] };
  }

  for (const pub of publications ?? []) {
    const lat = pub.lat;
    const lng = pub.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      unassigned.push(pub);
      continue;
    }
    const rid = layout.findRegionAt(geoCollection, lng, lat);
    if (!rid) {
      unassigned.push(pub);
      continue;
    }
    if (!byRegion.has(rid)) byRegion.set(rid, []);
    byRegion.get(rid).push(pub);
  }

  for (const list of byRegion.values()) {
    list.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  }

  return { byRegion, unassigned };
}

/**
 * @param {number} ms
 * @param {string} [locale]
 */
export function formatPubDate(ms, locale = 'fr-CA') {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(ms));
  } catch {
    return '';
  }
}
