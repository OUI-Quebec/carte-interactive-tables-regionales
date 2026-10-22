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

  /** Fraction of the remaining distance applied per frame (wheel easing). */
  var SCROLL_EASE = 0.4;

  /**
   * Scrolls the page behind the iframe on the map's behalf.
   *
   * Squarespace often does not move via window.scrollBy alone, so we hunt for
   * the real scroller among the iframe's overflow ancestors. That hunt costs
   * getComputedStyle on every ancestor, so the winner is cached and only
   * re-resolved when it stops moving (end of page, DOM swap).
   *
   * Wheel deltas are eased over a few frames — the browser animates native
   * wheel scrolls too, and jumping the full delta in one write reads as jerky.
   * Touch deltas track the finger and are applied whole, immediately.
   *
   * @param {HTMLIFrameElement} iframe
   * @param {number} speed Multiplier applied to every delta.
   */
  function createScrollController(iframe, speed) {
    var factor = isFinite(speed) && speed > 0 ? speed : 1;
    var cached = null;
    var pending = 0;
    var raf = 0;

    function isOverflowScrollable(node) {
      var style = global.getComputedStyle(node);
      var oy = style.overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false;
      return node.scrollHeight > node.clientHeight + 1;
    }

    /**
     * Write the delta and report whether the node actually moved.
     *
     * Must bypass CSS `scroll-behavior: smooth` — Squarespace sets it on
     * <html>, and under it every `scrollTop = …` starts a fresh eased
     * animation from wherever the page currently is. Writing once per frame
     * then keeps restarting that animation, and the page crawls: 400px asked
     * for lands ~66px. `behavior: 'instant'` scrolls now, and our own rAF
     * easing supplies the smoothness.
     */
    function applyTo(node, amount) {
      if (!node) return false;
      var prev = node.scrollTop;
      if (typeof node.scrollTo === 'function') {
        try {
          node.scrollTo({ top: prev + amount, left: node.scrollLeft, behavior: 'instant' });
        } catch (err) {
          node.scrollTop = prev + amount;
        }
      } else {
        node.scrollTop = prev + amount;
      }
      if (node.scrollTop === prev && amount) {
        // Options form ignored (older engine) — plain write as a last resort.
        node.scrollTop = prev + amount;
      }
      return node.scrollTop !== prev;
    }

    /** Ordered scroll candidates: nearest overflow ancestor → page → SQS shells. */
    function candidates() {
      var doc = global.document;
      var list = [];
      var node = iframe && iframe.parentElement;
      while (node && node !== doc.documentElement) {
        if (
          node !== doc.body &&
          node.nodeType === 1 &&
          isOverflowScrollable(node)
        ) {
          list.push(node);
        }
        node = node.parentElement;
      }
      list.push(doc.scrollingElement || doc.documentElement);
      list.push(doc.documentElement);
      list.push(doc.body);
      list.push(doc.getElementById('siteWrapper'));
      list.push(doc.querySelector('.App'));
      list.push(doc.querySelector('#page'));
      return list;
    }

    function applyScroll(amount) {
      if (!amount) return true;
      if (applyTo(cached, amount)) return true;
      var list = candidates();
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i] !== cached && applyTo(list[i], amount)) {
          cached = list[i];
          return true;
        }
      }
      // Nothing moved: page end reached, or the host swapped its scroller.
      cached = null;
      return false;
    }

    function step() {
      raf = 0;
      if (!pending) return;
      var move = pending * SCROLL_EASE;
      // Finish the tail in one write instead of chasing sub-pixel remainders.
      if (Math.abs(move) < 1 || Math.abs(pending) < 2) move = pending;
      pending -= move;
      if (Math.abs(pending) < 0.5) pending = 0;
      if (!applyScroll(move)) {
        pending = 0;
        return;
      }
      if (pending) raf = global.requestAnimationFrame(step);
    }

    return {
      push: function (dy, smooth) {
        var amount = Number(dy) * factor;
        if (!isFinite(amount) || amount === 0) return;
        pending += amount;
        if (smooth === false) {
          if (raf) global.cancelAnimationFrame(raf);
          raf = 0;
          var whole = pending;
          pending = 0;
          applyScroll(whole);
          return;
        }
        if (!raf) raf = global.requestAnimationFrame(step);
      },
      destroy: function () {
        if (raf) global.cancelAnimationFrame(raf);
        raf = 0;
        pending = 0;
        cached = null;
      }
    };
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
    var scrollSpeed =
      opts.scrollSpeed != null
        ? Number(opts.scrollSpeed)
        : Number(readDataAttr(iframe, 'data-qc-scroll-speed'));

    return {
      regionPagesUrl: toCollectionJsonUrl(regionPages, paths.regionPages),
      contactsUrl: toCollectionJsonUrl(contactsRaw, paths.responsables),
      contactRegionFrom: regionFrom,
      siteOrigin: siteOrigin,
      autoHeight: opts.autoHeight,
      minHeight: opts.minHeight,
      scrollSpeed: isFinite(scrollSpeed) && scrollSpeed > 0 ? scrollSpeed : 1
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
   * @param {number} [options.scrollSpeed=1] Multiplier for scroll forwarded
   *   from the map (also `data-qc-scroll-speed` on the iframe).
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
    var scroller = createScrollController(iframe, opts.scrollSpeed);

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
        scroller.push(data.dy, data.smooth !== false);
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
        scroller.destroy();
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
