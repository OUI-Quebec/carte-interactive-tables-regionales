import { mountQuebecRegionsMap } from './QuebecRegionsMap.js';
import { resolvePublicUrl } from './content.js';
import './embed.css';

const MSG_SET_CONTENT = 'quebec-map:setContent';
const MSG_READY = 'quebec-map:ready';

/**
 * Iframe / standalone boot.
 *
 * Config loading order:
 * 1. window.__QUEBEC_MAP_CONFIG__ (inline from host / CMS)
 * 2. ?config=<url> query param
 * 3. config/map-config.json (BASE_URL-relative for GitHub Pages)
 *
 * CMS content arrives via postMessage (`quebec-map:setContent`) from the
 * Squarespace bridge (publications + responsables), optional config.content,
 * or — in `npm run dev` only — loadDevContent() below. Partial payloads merge.
 */
async function resolveConfig() {
  if (window.__QUEBEC_MAP_CONFIG__) {
    return window.__QUEBEC_MAP_CONFIG__;
  }

  const params = new URLSearchParams(window.location.search);
  const raw = params.get('config') || 'config/map-config.json';
  const configUrl = /^https?:\/\//i.test(raw) ? raw : resolvePublicUrl(raw);
  const res = await fetch(configUrl);
  if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
  return res.json();
}

function parseAllowedOrigins() {
  const params = new URLSearchParams(window.location.search);
  return (params.get('allowedOrigins') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function originAllowed(origin, allowed) {
  if (!allowed.length) return true;
  return allowed.includes('*') || allowed.includes(origin);
}

/** Load a classic (non-module) script and resolve once it has run. */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Script load failed: ${src}`));
    document.head.appendChild(el);
  });
}

/**
 * Dev-only stand-in for the Squarespace bridge.
 *
 * Standalone there is no parent frame to postMessage content in, so the map
 * stays empty and clicking a region shows nothing. Rather than fixtures, this
 * replays what the bridge does — fetch both collections as JSON, run them
 * through the shared content-models.js — against the live site. The Vite dev
 * proxy makes those paths same-origin (see vite.config.js).
 *
 * Stripped from production builds: `import.meta.env.DEV` is false there.
 * @param {{ setContent: (content: object) => void }} api
 */
async function loadDevContent(api) {
  await loadScript(resolvePublicUrl('embed/content-models.js'));
  const models = window.QuebecMapContentModels;
  if (!models) throw new Error('QuebecMapContentModels missing');

  const paths = models.COLLECTION_PATHS;
  const fetchCollection = async (path) => {
    const res = await fetch(`${path}?format=json`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${res.status} on ${path}`);
    return res.json();
  };
  const [regionPages, contacts] = await Promise.all([
    fetchCollection(paths.regionPages),
    fetchCollection(paths.responsables)
  ]);

  // The proxy hides the real origin, so page URLs must be rebuilt against it.
  const siteOrigin = new URL(
    regionPages?.website?.baseUrl || contacts?.website?.baseUrl || window.location.origin
  ).origin;
  const content = models.buildContent(regionPages, contacts, {
    siteOrigin,
    contactRegionFrom: 'urlId'
  });
  api.setContent(content);
  console.info(
    `[dev] Squarespace content: ${Object.keys(content.contacts).length} contacts, ` +
      `${Object.keys(content.regionPages).length} pages régionales (${siteOrigin})`
  );
}

async function boot() {
  const root = document.getElementById('root');
  try {
    const config = await resolveConfig();
    if (config.geoUrl && !/^https?:\/\//i.test(config.geoUrl)) {
      config.geoUrl = resolvePublicUrl(config.geoUrl);
    }

    const api = mountQuebecRegionsMap(root, config);
    window.__QUEBEC_MAP_API__ = api;

    if (config.content) {
      api.setContent(config.content);
    }

    const params = new URLSearchParams(window.location.search);
    // Standalone dev: no bridge to feed us, so pull the collections ourselves.
    // Skipped inside an iframe — the host is authoritative there.
    const embedded = window.parent && window.parent !== window;
    if (import.meta.env.DEV && !embedded && params.get('devContent') !== '0') {
      loadDevContent(api).catch((err) => {
        console.warn(
          '[dev] Squarespace content unavailable — check the /carte-tables- proxy ' +
            'in vite.config.js (VITE_SQSP_ORIGIN to point elsewhere).',
          err
        );
      });
    }

    const allowed = parseAllowedOrigins();
    window.addEventListener('message', (event) => {
      if (!originAllowed(event.origin, allowed)) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === MSG_SET_CONTENT && data.content) {
        api.setContent(data.content);
      }
    });

    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: MSG_READY }, '*');
    }
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="boot-error">Failed to load map config.<br/><code>${escapeHtml(
      String(err.message || err)
    )}</code></div>`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

boot();
