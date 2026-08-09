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
    'gaspesie': '11'
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
   * body "Nom : …"            →  fullName (+ email if in parentheses)
   * body "Rôle : …"           →  title (role line)
   * excerpt <strong>…</strong>→  fullName fallback
   * body mailto: / email text →  email
   * assetUrl / profileImg /   →  profileImg
   *   first <img> in body
   *
   * Example body lines:
   *   Nom : Alexis St-Maurice (alexis.s@ouiquebec.org)
   *   Rôle : Responsable à la mobilisation et au financement (niveau national)
   */
  var RESPONSABLE_FIELDS = {
    regionFrom: ['urlId', 'title'],
    /** Labelled line: "Nom :" … optional "(email)"; stop before Rôle if flattened */
    fullNameFromBody: /Nom\s*:\s*(.+?)(?=\s*R[oô]le\s*:|$)/i,
    roleFromBody: /R[oô]le\s*:\s*(.+?)(?=\s*Nom\s*:|$)/i,
    photoFromItem: ['profileImg', 'assetUrl'],
    emailFromMailto: true,
    maxNameLen: 80,
    maxRoleLen: 120
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

  /**
   * Squarespace JSON shows body as "\u003Cdiv…\u003E" in raw form.
   * `fetch().json()` already turns those into real "<" / ">".
   * This also covers double-encoded leftovers (literal backslash-u sequences)
   * and common HTML entities before DOMParser / regex run.
   */
  function decodeSqspHtmlString(raw) {
    if (raw == null) return '';
    var s = String(raw);

    // Literal \u003C / \u003E / \u0026 still in the string (not JSON-decoded).
    if (/\\u[0-9a-fA-F]{4}/.test(s)) {
      try {
        // s already holds JSON-style escapes; wrap as a JSON string and parse.
        s = JSON.parse(
          '"' +
            s
              .replace(/"/g, '\\"')
              .replace(/\r/g, '\\r')
              .replace(/\n/g, '\\n')
              .replace(/\t/g, '\\t') +
            '"'
        );
      } catch (err1) {
        s = s
          .replace(/\\u003[cC]/g, '<')
          .replace(/\\u003[eE]/g, '>')
          .replace(/\\u0026/gi, '&')
          .replace(/\\u00a0/gi, ' ')
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"');
      }
    }

    // Named / numeric HTML entities in text (&nbsp; é etc.).
    if (/&[#a-zA-Z0-9]+;/.test(s)) {
      try {
        var ta =
          global.document && global.document.createElement
            ? global.document.createElement('textarea')
            : null;
        if (ta) {
          ta.innerHTML = s;
          s = ta.value;
        }
      } catch (err3) {
        /* keep s */
      }
    }

    return s;
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
          ? decodeSqspHtmlString(item[REGION_PAGE_FIELDS.body])
          : '',
      url: absoluteUrl(item[REGION_PAGE_FIELDS.url], siteOrigin)
    };
  }

  // ---------------------------------------------------------------------------
  // Responsables model
  // ---------------------------------------------------------------------------

  function stripCssJunk(s) {
    return String(s || '')
      .replace(/#block-[\s\S]*$/i, '')
      .replace(/\{[\s\S]*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function looksLikeCssJunk(s) {
    var t = String(s || '');
    return (
      !t ||
      t.indexOf('{') !== -1 ||
      t.indexOf('}') !== -1 ||
      /#block-/i.test(t) ||
      /mix-blend-mode|sqs-html-content|--tweak-/i.test(t)
    );
  }

  /**
   * Person display name — never a region label, email, or CSS scrap.
   */
  function cleanNameCandidate(raw, emailHint) {
    var name = String(raw || '')
      .replace(/\([^)]*@[^)]*\)/g, ' ')
      .replace(emailHint || '', ' ')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ')
      .replace(/^Nom\s*:\s*/i, '')
      .replace(/\(\s*\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '');
    if (!name || name.length > RESPONSABLE_FIELDS.maxNameLen) return null;
    if (looksLikeCssJunk(name) || /@/.test(name)) return null;
    // Don't treat a region slug/name as a person ("Laurentides", "Montréal").
    if (matchUrlId(name)) return null;
    if (!/[a-zA-ZÀ-ÿ]/.test(name)) return null;
    // Require at least one letter sequence that isn't tiny junk.
    if (name.length < 2) return null;
    return name;
  }

  function cleanRoleCandidate(raw) {
    var roleText = stripCssJunk(raw)
      .replace(/^R[oô]le\s*:\s*/i, '')
      .trim();
    if (!roleText || roleText.length > RESPONSABLE_FIELDS.maxRoleLen) return null;
    if (looksLikeCssJunk(roleText)) return null;
    if (matchUrlId(roleText)) return null;
    return roleText;
  }

  function emailFromText(text) {
    var em = String(text || '').match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
    );
    return em ? em[0] : null;
  }

  /**
   * Prefer the leading <strong>Name</strong> in the Squarespace excerpt.
   */
  function nameFromExcerpt(html) {
    if (!html) return null;
    var raw = decodeSqspHtmlString(html);
    var strong = raw.match(/<strong[^>]*>\s*([^<]{2,80}?)\s*<\/strong>/i);
    if (strong) {
      var fromStrong = cleanNameCandidate(strong[1]);
      if (fromStrong) return fromStrong;
    }
    // Plain-text excerpt fallback: first words before " est " / " is ".
    var plain = raw
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    var beforeEst = plain.match(
      /^([A-ZÀ-Ÿ][\wÀ-ÿ'’.-]+(?:\s+[A-ZÀ-Ÿ][\wÀ-ÿ'’.-]+){0,4})\s+est\b/i
    );
    if (beforeEst) return cleanNameCandidate(beforeEst[1]);
    return null;
  }

  /**
   * Pull Nom / Rôle / mailto / img out of Squarespace SQS body HTML.
   * Ignores <style>/<script> text (SQS injects CSS into the body string).
   */
  function parseResponsableBody(html) {
    var out = { fullName: null, title: null, email: null, profileImg: null };
    if (!html) return out;

    var source = decodeSqspHtmlString(html);

    var doc;
    try {
      doc = new DOMParser().parseFromString(source, 'text/html');
    } catch (err) {
      return out;
    }

    doc
      .querySelectorAll('style, script, noscript, template, link, meta')
      .forEach(function (el) {
        el.remove();
      });

    var mailto = null;
    if (RESPONSABLE_FIELDS.emailFromMailto) {
      mailto = doc.querySelector('a[href^="mailto:"], a[href^="MAILTO:"]');
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

    // Prefer labelled text blocks (one SQS text block per field).
    var chunks = [];
    var seen = {};
    doc
      .querySelectorAll(
        '.sqs-html-content, [data-sqsp-text-block-content], p, li'
      )
      .forEach(function (el) {
        var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || seen[t]) return;
        seen[t] = true;
        chunks.push(t);
      });
    var text =
      chunks.length > 0
        ? chunks.join('\n')
        : ((doc.body && (doc.body.textContent || doc.body.innerText)) || '')
            .replace(/\s+/g, ' ')
            .trim();

    if (!out.email) out.email = emailFromText(text);

    // --- Nom / Rôle from labelled lines (handles "Nom : Name (email@…)") ---
    var i;
    for (i = 0; i < chunks.length; i++) {
      var chunk = chunks[i];
      var nomLine = chunk.match(RESPONSABLE_FIELDS.fullNameFromBody);
      if (nomLine && !out.fullName) {
        if (!out.email) out.email = emailFromText(nomLine[1]) || out.email;
        out.fullName = cleanNameCandidate(nomLine[1], out.email);
      }
      var roleLine = chunk.match(RESPONSABLE_FIELDS.roleFromBody);
      if (roleLine && !out.title) {
        out.title = cleanRoleCandidate(roleLine[1]);
      }
    }

    // Whole-body fallback if chunks missed labels (flattened HTML).
    if (!out.fullName) {
      var nom = text.match(RESPONSABLE_FIELDS.fullNameFromBody);
      if (nom) {
        if (!out.email) out.email = emailFromText(nom[1]) || out.email;
        out.fullName = cleanNameCandidate(nom[1], out.email);
      }
    }
    if (!out.title) {
      var role = text.match(RESPONSABLE_FIELDS.roleFromBody);
      if (role) out.title = cleanRoleCandidate(role[1]);
    }

    // Mailto link label often holds the display name.
    if (!out.fullName && mailto) {
      out.fullName = cleanNameCandidate(mailto.textContent || '', out.email);
    }

    // Last resort: derive a readable name from the email local-part.
    // alexis.s@… → "Alexis S"
    if (!out.fullName && out.email) {
      var local = String(out.email).split('@')[0] || '';
      var parts = local.split(/[._-]+/).filter(Boolean);
      if (parts.length) {
        out.fullName = parts
          .map(function (p) {
            return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
          })
          .join(' ');
      }
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

    var excerptName = nameFromExcerpt(item && item.excerpt);
    var authorName =
      item && item.author && item.author.displayName
        ? cleanNameCandidate(item.author.displayName)
        : null;
    var itemFullName =
      item && item.fullName ? cleanNameCandidate(item.fullName) : null;

    // Never use the Squarespace item title — it is almost always the region
    // name (e.g. "Laurentides", "Montréal") for these collection items.
    var fullName =
      parsed.fullName || excerptName || itemFullName || authorName || '';

    return {
      fullName: fullName,
      profileImg: photo || null,
      title:
        parsed.title ||
        (item && item.jobTitle ? cleanRoleCandidate(item.jobTitle) : null) ||
        (item && item.subtitle ? cleanRoleCandidate(item.subtitle) : null) ||
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
    decodeSqspHtmlString: decodeSqspHtmlString,
    collectionItems: collectionItems,
    buildContent: buildContent
  };
})(typeof window !== 'undefined' ? window : this);
