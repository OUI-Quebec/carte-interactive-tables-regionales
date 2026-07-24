/**
 * Squarespace → Québec map iframe bridge.
 *
 * Paste into a Squarespace Code Block (or Code Injection) alongside the iframe.
 * Fetches collection JSON same-origin (?format=json), normalizes it, and
 * postMessages into the GitHub Pages map iframe.
 *
 * Usage:
 *   <iframe id="qc-map" src="https://ORG.github.io/REPO/" title="Carte"></iframe>
 *   <script src="https://ORG.github.io/REPO/embed/squarespace-bridge.js"></script>
 *   <script>
 *     QuebecMapBridge.mount({
 *       iframe: '#qc-map',
 *       publicationsUrl: '/publications?format=json',
 *       contactsUrl: '/responsables?format=json',
 *       contactRegionFrom: 'category' // or 'tag' | 'urlId'
 *     });
 *   </script>
 */
(function (global) {
  'use strict';

  var MSG_SET = 'quebec-map:setContent';
  var MSG_READY = 'quebec-map:ready';

  var REGIONS = [
    { id: '01', name: 'Bas-Saint-Laurent', shortName: 'Bas-Saint-Laurent' },
    { id: '02', name: 'Saguenay–Lac-Saint-Jean', shortName: 'Saguenay–Lac-Saint-Jean' },
    { id: '03', name: 'Capitale-Nationale', shortName: 'Capitale-Nationale' },
    { id: '04', name: 'Mauricie', shortName: 'Mauricie' },
    { id: '05', name: 'Estrie', shortName: 'Estrie' },
    { id: '06', name: 'Montréal', shortName: 'Montréal' },
    { id: '07', name: 'Outaouais', shortName: 'Outaouais' },
    { id: '08', name: 'Abitibi-Témiscamingue', shortName: 'Abitibi-Témiscamingue' },
    { id: '09', name: 'Côte-Nord', shortName: 'Côte-Nord' },
    { id: '10', name: 'Nord-du-Québec', shortName: 'Nord-du-Québec' },
    { id: '11', name: 'Gaspésie–Îles-de-la-Madeleine', shortName: 'Gaspésie–Îles-de-la-Madeleine' },
    { id: '12', name: 'Chaudière-Appalaches', shortName: 'Chaudière-Appalaches' },
    { id: '13', name: 'Laval', shortName: 'Laval' },
    { id: '14', name: 'Lanaudière', shortName: 'Lanaudière' },
    { id: '15', name: 'Laurentides', shortName: 'Laurentides' },
    { id: '16', name: 'Montérégie', shortName: 'Montérégie' },
    { id: '17', name: 'Centre-du-Québec', shortName: 'Centre-du-Québec' }
  ];

  function normKey(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  }

  var regionLookup = (function () {
    var map = {};
    REGIONS.forEach(function (r) {
      map[normKey(r.id)] = r.id;
      map[normKey(r.name)] = r.id;
      map[normKey(r.shortName)] = r.id;
    });
    return map;
  })();

  function padId(id) {
    return String(id || '').padStart(2, '0');
  }

  function stripHtml(html) {
    var d = document.createElement('div');
    d.innerHTML = String(html || '');
    return (d.textContent || d.innerText || '').replace(/\s+/g, ' ').trim();
  }

  function firstParagraphSummary(item) {
    if (item && item.excerpt) {
      var ex = stripHtml(item.excerpt);
      if (ex) return ex.length > 280 ? ex.slice(0, 277) + '…' : ex;
    }
    var body = item && item.body ? stripHtml(item.body) : '';
    if (!body) return '';
    var para = body.split(/(?<=[.!?])\s+/)[0] || body;
    return para.length > 280 ? para.slice(0, 277) + '…' : para;
  }

  function absoluteUrl(path, origin) {
    if (!path) return '#';
    if (/^https?:\/\//i.test(path)) return path;
    var o = origin || global.location.origin;
    if (path.charAt(0) === '/') return o + path;
    return o + '/' + path;
  }

  function pickCoord() {
    for (var i = 0; i < arguments.length; i++) {
      var n = Number(arguments[i]);
      if (isFinite(n)) return n;
    }
    return null;
  }

  function collectionItems(json) {
    if (!json) return [];
    if (Array.isArray(json.items)) return json.items;
    if (Array.isArray(json)) return json;
    return [];
  }

  function matchRegionToken(token) {
    if (token == null) return null;
    var raw = String(token).trim();
    if (/^(0?[1-9]|1[0-7])$/.test(raw)) return padId(raw);
    return regionLookup[normKey(raw)] || null;
  }

  function regionFromContactItem(item, mode) {
    var i;
    var list;
    if (mode === 'urlId') {
      return matchRegionToken(item.urlId) || matchRegionToken(item.title);
    }
    if (mode === 'tag') {
      list = item.tags || [];
      for (i = 0; i < list.length; i++) {
        var tid = matchRegionToken(list[i]);
        if (tid) return tid;
      }
      return null;
    }
    // default: category
    list = item.categories || [];
    for (i = 0; i < list.length; i++) {
      var cid = matchRegionToken(list[i]);
      if (cid) return cid;
    }
    return matchRegionToken(item.title) || matchRegionToken(item.urlId);
  }

  function mapPublication(item, siteOrigin) {
    var loc = item.location || {};
    return {
      id: item.id != null ? String(item.id) : undefined,
      title: item.title || 'Sans titre',
      summary: firstParagraphSummary(item),
      body: item.body || undefined,
      excerpt: item.excerpt || undefined,
      publishedAt: item.publishOn || item.addedOn || 0,
      url: absoluteUrl(item.fullUrl, siteOrigin),
      imageUrl: item.assetUrl || null,
      lat: pickCoord(loc.markerLat, loc.mapLat),
      lng: pickCoord(loc.markerLng, loc.mapLng)
    };
  }

  function mapContact(item) {
    return {
      fullName:
        item.fullName ||
        item.title ||
        (item.author && item.author.displayName) ||
        '',
      profileImg: item.profileImg || item.assetUrl || null,
      title: item.jobTitle || item.subtitle || item.excerpt || null,
      body: item.body || null
    };
  }

  function buildContent(pubsJson, contactsJson, opts) {
    var siteOrigin = opts.siteOrigin || global.location.origin;
    var mode = opts.contactRegionFrom || 'category';
    var publications = collectionItems(pubsJson).map(function (item) {
      return mapPublication(item, siteOrigin);
    });
    var contacts = {};
    collectionItems(contactsJson).forEach(function (item) {
      var rid = regionFromContactItem(item, mode);
      if (!rid) return;
      contacts[rid] = mapContact(item);
    });
    return { contacts: contacts, publications: publications };
  }

  function resolveIframe(target) {
    if (!target) return null;
    if (typeof target === 'string') return document.querySelector(target);
    return target;
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

  /**
   * @param {object} options
   * @param {string|HTMLIFrameElement} options.iframe
   * @param {string} [options.publicationsUrl]
   * @param {string} [options.contactsUrl]
   * @param {'category'|'tag'|'urlId'} [options.contactRegionFrom]
   * @param {string} [options.siteOrigin]
   */
  function mount(options) {
    var opts = options || {};
    var iframe = resolveIframe(opts.iframe);
    if (!iframe) {
      console.error('[QuebecMapBridge] iframe not found');
      return { destroy: function () {} };
    }

    var pending = null;
    var destroyed = false;

    function send(content) {
      if (destroyed) return;
      pending = content;
      postContent(iframe, content);
    }

    function load() {
      return Promise.all([
        fetchJson(opts.publicationsUrl),
        fetchJson(opts.contactsUrl)
      ])
        .then(function (pair) {
          var content = buildContent(pair[0], pair[1], opts);
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
      if (!data || data.type !== MSG_READY) return;
      if (pending) postContent(iframe, pending);
      else load();
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
    REGIONS: REGIONS
  };
})(typeof window !== 'undefined' ? window : this);
