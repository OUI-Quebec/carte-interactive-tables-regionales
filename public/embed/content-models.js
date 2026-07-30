(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Collection URL defaults (same-origin paths on Squarespace)
  // ---------------------------------------------------------------------------
  var COLLECTION_PATHS = {
    /** Right panel: SQS body HTML per region */
    regionPages: '/carte-tables-regionales',
    /** Contact bubble: Nom / Rôle / email / photo */
    responsables: '/carte-tables-rgionales-responsables'
  };

  // ---------------------------------------------------------------------------
  // Regions — id is the map key; shortName drives default urlId matching
  // ---------------------------------------------------------------------------
  // urlId "outaouais" → shortName "Outaouais" → id "07"
  // Matching ignores case, accents, and punctuation (normKey).
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

  /**
   * Optional urlId overrides when the Squarespace slug ≠ shortName.
   * Keys are normalized the same way as urlId (lowercase, no accents).
   *
   * Example:
   *   'mtl': '06',
   *   'gaspesie': '11'
   */
  var URL_ID_ALIASES = {
    // 'montreal-region': '06'
  };

  // ---------------------------------------------------------------------------
  // Field maps (documentation + single place to tweak source fields)
  // ---------------------------------------------------------------------------

  /**
   * Region page item (carte-tables-regionales) → map panel payload
   *
   * Squarespace item          →  regionPages[regionId]
   * ---------------------------|------------------------
   * urlId / title             →  region key (via matchUrlId)
   * title                     →  title
   * body (SQS HTML)           →  body  (shown in right panel)
   * fullUrl                   →  url
   */
  var REGION_PAGE_FIELDS = {
    regionFrom: ['urlId', 'title'],
    title: 'title',
    body: 'body',
    url: 'fullUrl'
  };

  /**
   * Responsable item (carte-tables-rgionales-responsables) → contact bubble
   *
   * Squarespace item / body   →  contacts[regionId]
   * ---------------------------|------------------------
   * urlId / title             →  region key (via matchUrlId)
   * body "Nom : …"            →  fullName
   * body "Rôle : …"           →  title (role line)
   * body mailto: / email text →  email
   * assetUrl / profileImg /   →  profileImg
   *   first <img> in body
   */
  var RESPONSABLE_FIELDS = {
    regionFrom: ['urlId', 'title'],
    fullNameFromBody: /Nom\s*:\s*(.+?)(?=\s+R[oô]le\s*:|$)/i,
    roleFromBody: /R[oô]le\s*:\s*(.+?)(?=\s+Nom\s*:|$)/i,
    photoFromItem: ['profileImg', 'assetUrl'],
    emailFromMailto: true
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function normKey(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  }

  function padId(id) {
    return String(id || '').padStart(2, '0');
  }

  var regionLookup = (function () {
    var map = {};
    REGIONS.forEach(function (r) {
      map[normKey(r.id)] = r.id;
      map[normKey(r.name)] = r.id;
      map[normKey(r.shortName)] = r.id;
    });
    Object.keys(URL_ID_ALIASES).forEach(function (alias) {
      var id = padId(URL_ID_ALIASES[alias]);
      map[normKey(alias)] = id;
    });
    return map;
  })();

  /**
   * Map a Squarespace urlId (or name token) to a region id "01"…"17".
   * "outaouais" → "07", "estrie" → "05", etc.
   */
  function matchUrlId(token) {
    if (token == null) return null;
    var raw = String(token).trim();
    if (/^(0?[1-9]|1[0-7])$/.test(raw)) return padId(raw);
    return regionLookup[normKey(raw)] || null;
  }

  function absoluteUrl(path, origin) {
    if (!path) return '#';
    if (/^https?:\/\//i.test(path)) return path;
    var o = origin || global.location.origin;
    if (path.charAt(0) === '/') return o + path;
    return o + '/' + path;
  }

  function collectionItems(json) {
    if (!json) return [];
    if (Array.isArray(json.items)) return json.items;
    if (Array.isArray(json)) return json;
    return [];
  }

  function regionIdFromItem(item, mode) {
    var i;
    var list;
    var from = mode || 'urlId';

    if (from === 'urlId') {
      return matchUrlId(item && item.urlId) || matchUrlId(item && item.title);
    }
    if (from === 'tag') {
      list = (item && item.tags) || [];
      for (i = 0; i < list.length; i++) {
        var tid = matchUrlId(list[i]);
        if (tid) return tid;
      }
      return null;
    }
    // category
    list = (item && item.categories) || [];
    for (i = 0; i < list.length; i++) {
      var cid = matchUrlId(list[i]);
      if (cid) return cid;
    }
    return matchUrlId(item && item.title) || matchUrlId(item && item.urlId);
  }

  // ---------------------------------------------------------------------------
  // Region pages model
  // ---------------------------------------------------------------------------

  /**
   * @returns {{ regionId: string, title: string, body: string, url: string } | null}
   */
  function mapRegionPage(item, siteOrigin) {
    if (!item) return null;
    var rid =
      matchUrlId(item[REGION_PAGE_FIELDS.regionFrom[0]]) ||
      matchUrlId(item[REGION_PAGE_FIELDS.regionFrom[1]]);
    if (!rid) return null;
    return {
      regionId: rid,
      title: item[REGION_PAGE_FIELDS.title] || '',
      body:
        item[REGION_PAGE_FIELDS.body] != null
          ? String(item[REGION_PAGE_FIELDS.body])
          : '',
      url: absoluteUrl(item[REGION_PAGE_FIELDS.url], siteOrigin)
    };
  }

  // ---------------------------------------------------------------------------
  // Responsables model
  // ---------------------------------------------------------------------------

  /**
   * Pull Nom / Rôle / mailto / img out of Squarespace SQS body HTML.
   */
  function parseResponsableBody(html) {
    var out = { fullName: null, title: null, email: null, profileImg: null };
    if (!html) return out;

    var doc;
    try {
      doc = new DOMParser().parseFromString(String(html), 'text/html');
    } catch (err) {
      return out;
    }

    if (RESPONSABLE_FIELDS.emailFromMailto) {
      var mailto = doc.querySelector('a[href^="mailto:"], a[href^="MAILTO:"]');
      if (mailto) {
        var href = String(mailto.getAttribute('href') || '');
        var m = href.match(/^mailto:([^?&#]+)/i);
        if (m) out.email = decodeURIComponent(m[1]).trim();
      }
    }

    var img = doc.querySelector('img[src]');
    if (img) {
      var src = String(img.getAttribute('src') || '').trim();
      if (src) out.profileImg = src;
    }

    var text = (doc.body && (doc.body.textContent || doc.body.innerText)) || '';
    text = text.replace(/\s+/g, ' ').trim();

    if (!out.email) {
      var em = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      if (em) out.email = em[0];
    }

    var nom = text.match(RESPONSABLE_FIELDS.fullNameFromBody);
    if (nom) {
      var name = nom[1]
        .replace(/\([^)]*@[^)]*\)/g, '')
        .replace(out.email || '', '')
        .replace(/\(\s*\)/g, '')
        .trim()
        .replace(/[,\s]+$/g, '');
      if (name) out.fullName = name;
    }

    var role = text.match(RESPONSABLE_FIELDS.roleFromBody);
    if (role) {
      var roleText = role[1].trim();
      if (roleText) out.title = roleText;
    }

    return out;
  }

  /**
   * @returns {{ fullName: string, profileImg: string|null, title: string|null, email: string|null, body: null }}
   */
  function mapResponsable(item) {
    var parsed = parseResponsableBody(item && item.body);
    var photo = null;
    var i;
    for (i = 0; i < RESPONSABLE_FIELDS.photoFromItem.length; i++) {
      var key = RESPONSABLE_FIELDS.photoFromItem[i];
      if (item && item[key]) {
        photo = item[key];
        break;
      }
    }
    if (!photo) photo = parsed.profileImg;

    return {
      fullName:
        parsed.fullName ||
        (item && item.fullName) ||
        (item && item.title) ||
        (item && item.author && item.author.displayName) ||
        '',
      profileImg: photo || null,
      title:
        parsed.title ||
        (item && item.jobTitle) ||
        (item && item.subtitle) ||
        (item && item.excerpt) ||
        null,
      email: parsed.email || (item && item.email) || null,
      body: null
    };
  }

  // ---------------------------------------------------------------------------
  // Build full postMessage content from both collection JSON responses
  // ---------------------------------------------------------------------------

  function buildContent(regionPagesJson, contactsJson, opts) {
    var siteOrigin = (opts && opts.siteOrigin) || global.location.origin;
    var mode = (opts && opts.contactRegionFrom) || 'urlId';

    var regionPages = {};
    collectionItems(regionPagesJson).forEach(function (item) {
      var page = mapRegionPage(item, siteOrigin);
      if (!page) return;
      regionPages[page.regionId] = {
        title: page.title,
        body: page.body,
        url: page.url
      };
    });

    var contacts = {};
    collectionItems(contactsJson).forEach(function (item) {
      var rid = regionIdFromItem(item, mode);
      if (!rid) return;
      contacts[rid] = mapResponsable(item);
    });

    return { contacts: contacts, regionPages: regionPages };
  }

  global.QuebecMapContentModels = {
    COLLECTION_PATHS: COLLECTION_PATHS,
    REGIONS: REGIONS,
    URL_ID_ALIASES: URL_ID_ALIASES,
    REGION_PAGE_FIELDS: REGION_PAGE_FIELDS,
    RESPONSABLE_FIELDS: RESPONSABLE_FIELDS,
    normKey: normKey,
    padId: padId,
    matchUrlId: matchUrlId,
    regionIdFromItem: regionIdFromItem,
    mapRegionPage: mapRegionPage,
    mapResponsable: mapResponsable,
    parseResponsableBody: parseResponsableBody,
    collectionItems: collectionItems,
    buildContent: buildContent
  };
})(typeof window !== 'undefined' ? window : this);
