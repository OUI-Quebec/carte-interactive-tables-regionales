/**
 * Squarespace → Québec map iframe bridge.
 *
 * Load content-models.js FIRST, then this file:
 *   <script src="…/embed/content-models.js"></script>
 *   <script src="…/embed/squarespace-bridge.js"></script>
 *
 * Mapping (urlId, Nom/Rôle/email, region body) lives in content-models.js —
 * edit that file when Squarespace slugs or field shapes change.
 *
 * Usage:
 *   <iframe
 *     id="qc-map"
 *     src="https://ORG.github.io/REPO/"
 *     title="Carte"
 *     data-qc-region-pages="/carte-tables-regionales"
 *     data-qc-contacts="/carte-tables-rgionales-responsables"
 *     data-qc-contact-region-from="urlId"
 *   ></iframe>
 *   <script src="https://ORG.github.io/REPO/embed/content-models.js"></script>
 *   <script src="https://ORG.github.io/REPO/embed/squarespace-bridge.js"></script>
 *   <script>QuebecMapBridge.mount({ iframe: '#qc-map' });</script>
 */
(function (global) {
  'use strict';

  var MSG_SET = 'quebec-map:setContent';
  var MSG_READY = 'quebec-map:ready';
  var MSG_RESIZE = 'quebec-map:resize';
  var MSG_SCROLL = 'quebec-map:scrollBy';

  function models() {
    var m = global.QuebecMapContentModels;
    if (!m) {
      console.error(
        '[QuebecMapBridge] content-models.js not loaded — include it before squarespace-bridge.js'
      );
    }
    return m;
  }

  /**
   * Scroll the page behind the iframe. Squarespace often does not move via
   * window.scrollBy alone — walk overflow ancestors of the iframe first.
   */
  function scrollPageBy(iframe, dy) {
    var amount = Number(dy);
    if (!isFinite(amount) || amount === 0) return;

    function tryOverflowScroll(node) {
      if (
        !node ||
        node === global.document.body ||
        node === global.document.documentElement
      ) {
        return false;
      }
      var style = global.getComputedStyle(node);
      var oy = style.overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false;
      if (node.scrollHeight <= node.clientHeight + 1) return false;
      var prev = node.scrollTop;
      node.scrollTop = prev + amount;
      return node.scrollTop !== prev;
    }

    var node = iframe && iframe.parentElement;
    while (node && node !== global.document.documentElement) {
      if (tryOverflowScroll(node)) return;
      node = node.parentElement;
    }

    var root =
      global.document.scrollingElement || global.document.documentElement;
    var before =
      global.pageYOffset ||
      (root && root.scrollTop) ||
      (global.document.body && global.document.body.scrollTop) ||
      0;

    if (root) root.scrollTop = before + amount;
    if (global.document.body && global.document.body !== root) {
      global.document.body.scrollTop = before + amount;
    }
    global.scrollBy(0, amount);

    var fallbacks = [
      global.document.getElementById('siteWrapper'),
      global.document.querySelector('.App'),
      global.document.querySelector('#page')
    ];
    var after =
      global.pageYOffset ||
      (root && root.scrollTop) ||
      (global.document.body && global.document.body.scrollTop) ||
      0;
    if (after === before) {
      for (var i = 0; i < fallbacks.length; i++) {
        if (tryOverflowScroll(fallbacks[i])) return;
        var fb = fallbacks[i];
        if (fb && fb.scrollHeight > fb.clientHeight + 1) {
          var p = fb.scrollTop;
          fb.scrollTop = p + amount;
          if (fb.scrollTop !== p) return;
        }
      }
    }
  }

  function resolveIframe(target) {
    if (!target) return null;
    if (typeof target === 'string') return document.querySelector(target);
    return target;
  }

  function toCollectionJsonUrl(pathOrUrl, fallbackPath) {
    var raw =
      pathOrUrl != null && String(pathOrUrl).trim()
        ? String(pathOrUrl).trim()
        : fallbackPath
          ? String(fallbackPath).trim()
          : '';
    if (!raw) return null;

    var url;
    try {
      url = new URL(raw, global.location.origin);
    } catch (err) {
      console.error('[QuebecMapBridge] invalid collection URL:', raw);
      return null;
    }

    if (url.origin !== global.location.origin) {
      console.error(
        '[QuebecMapBridge] collection URL must be same-origin:',
        raw
      );
      return null;
    }

    if (!url.searchParams.has('format')) {
      url.searchParams.set('format', 'json');
    }
    return url.pathname + url.search + url.hash;
  }

  function readDataAttr(iframe, name) {
    if (!iframe || !iframe.getAttribute) return null;
    var v = iframe.getAttribute(name);
    if (v == null) return null;
    v = String(v).trim();
    return v || null;
  }

  function defaultPaths() {
    var m = models();
    var paths = (m && m.COLLECTION_PATHS) || {};
    return {
      regionPages: paths.regionPages || '/carte-tables-regionales',
      responsables: paths.responsables || '/carte-tables-rgionales-responsables'
    };
  }

  /**
   * Merge mount() options with iframe data-* attrs.
   * Priority: explicit JS options > data-* > content-models defaults.
   */
  function resolveMountConfig(iframe, options) {
    var opts = options || {};
    var paths = defaultPaths();
    var regionPages =
      opts.regionPagesUrl != null
        ? opts.regionPagesUrl
        : opts.publicationsUrl != null
          ? opts.publicationsUrl
          : readDataAttr(iframe, 'data-qc-region-pages') ||
            readDataAttr(iframe, 'data-qc-publications');
    var contactsRaw =
      opts.contactsUrl != null
        ? opts.contactsUrl
        : readDataAttr(iframe, 'data-qc-contacts');
    var regionFrom =
      opts.contactRegionFrom ||
      readDataAttr(iframe, 'data-qc-contact-region-from') ||
      'urlId';
    var siteOrigin =
      opts.siteOrigin ||
      readDataAttr(iframe, 'data-qc-site-origin') ||
      global.location.origin;

    return {
      regionPagesUrl: toCollectionJsonUrl(regionPages, paths.regionPages),
      contactsUrl: toCollectionJsonUrl(contactsRaw, paths.responsables),
      contactRegionFrom: regionFrom,
      siteOrigin: siteOrigin,
      autoHeight: opts.autoHeight,
      minHeight: opts.minHeight
    };
  }

  function postContent(iframe, content) {
    if (!iframe || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage(
      { type: MSG_SET, content: content },
      '*'
    );
  }

  function fetchJson(url) {
    if (!url) return Promise.resolve(null);
    return fetch(url, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) throw new Error('Fetch failed ' + res.status + ' for ' + url);
      return res.json();
    });
  }

  function buildContent(regionPagesJson, contactsJson, opts) {
    var m = models();
    if (!m || typeof m.buildContent !== 'function') {
      return { contacts: {}, regionPages: {} };
    }
    return m.buildContent(regionPagesJson, contactsJson, opts);
  }

  /**
   * @param {object} options
   * @param {string|HTMLIFrameElement} options.iframe
   * @param {string} [options.regionPagesUrl]
   * @param {string} [options.publicationsUrl] Alias of regionPagesUrl
   * @param {string} [options.contactsUrl]
   * @param {'category'|'tag'|'urlId'} [options.contactRegionFrom]
   * @param {string} [options.siteOrigin]
   * @param {boolean} [options.autoHeight=true]
   * @param {number} [options.minHeight=320]
   */
  function mount(options) {
    var rawOpts = options || {};
    var iframe = resolveIframe(rawOpts.iframe);
    if (!iframe) {
      console.error('[QuebecMapBridge] iframe not found');
      return { destroy: function () {} };
    }

    if (!models()) {
      return { destroy: function () {} };
    }

    var opts = resolveMountConfig(iframe, rawOpts);
    var pending = null;
    var destroyed = false;
    var autoHeight = opts.autoHeight !== false;
    var minHeight = opts.minHeight != null ? Number(opts.minHeight) : 320;

    if (!opts.regionPagesUrl && !opts.contactsUrl) {
      console.warn(
        '[QuebecMapBridge] no collection URLs — set data-qc-region-pages / data-qc-contacts'
      );
    }

    function send(content) {
      if (destroyed) return;
      pending = content;
      postContent(iframe, content);
    }

    function applyHeight(height) {
      if (!autoHeight || destroyed) return;
      var h = Math.max(minHeight, Math.ceil(Number(height) || 0));
      if (!isFinite(h) || h <= 0) return;
      iframe.style.height = h + 'px';
    }

    function load() {
      var cfg = resolveMountConfig(iframe, rawOpts);
      return Promise.all([
        fetchJson(cfg.regionPagesUrl),
        fetchJson(cfg.contactsUrl)
      ])
        .then(function (pair) {
          var content = buildContent(pair[0], pair[1], cfg);
          send(content);
          return content;
        })
        .catch(function (err) {
          console.error('[QuebecMapBridge]', err);
        });
    }

    function onMessage(event) {
      if (destroyed) return;
      if (iframe.contentWindow && event.source !== iframe.contentWindow) return;
      var data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === MSG_READY) {
        if (pending) postContent(iframe, pending);
        else load();
        return;
      }
      if (data.type === MSG_RESIZE && data.height != null) {
        applyHeight(data.height);
        return;
      }
      if (data.type === MSG_SCROLL && data.dy != null) {
        scrollPageBy(iframe, data.dy);
      }
    }

    function onLoad() {
      if (pending) postContent(iframe, pending);
    }

    global.addEventListener('message', onMessage);
    iframe.addEventListener('load', onLoad);
    load();

    return {
      reload: load,
      setContent: send,
      setHeight: applyHeight,
      destroy: function () {
        destroyed = true;
        global.removeEventListener('message', onMessage);
        iframe.removeEventListener('load', onLoad);
      }
    };
  }

  global.QuebecMapBridge = {
    mount: mount,
    buildContent: buildContent,
    get models() {
      return models();
    }
  };
})(typeof window !== 'undefined' ? window : this);
