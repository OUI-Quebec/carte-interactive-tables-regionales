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
 * or ?demoContent=1. Partial payloads merge.
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
    if (params.get('demoContent') === '1') {
      try {
        const demoRes = await fetch(resolvePublicUrl('config/demo-content.json'));
        if (demoRes.ok) {
          api.setContent(await demoRes.json());
        }
      } catch (err) {
        console.warn('demoContent load failed', err);
      }
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
