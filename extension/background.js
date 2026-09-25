/*
 * Background persistente: observa todo o tráfego via webRequest e mantém
 * um relatório por aba. O relatório é zerado a cada navegação principal
 * (main_frame) e enviado ao popup sob demanda.
 */

/** tabId -> estado da página carregada naquela aba */
const tabState = new Map();

function newPageState(url) {
  return {
    url,
    host: hostFromUrl(url),
    site: siteFromUrl(url),
    startedAt: Date.now(),
    totalRequests: 0,
    firstPartyRequests: 0,
    thirdParty: new Map(), // site -> { site, hosts:Set, count, types:{}, classifications:Set, sample }
    cookies: new Map(),    // "domínio|path|nome" -> cookie observado
    cookieDeletions: 0,
    storage: new Map()     // origem -> { origin, site, thirdParty, ops:Map, snapshot }
  };
}

function getState(tabId) {
  return tabState.get(tabId);
}

// ---------------------------------------------------------------------------
// Requisições
// ---------------------------------------------------------------------------

function onBeforeRequest(details) {
  if (details.tabId < 0) return; // requisições internas do navegador / service workers

  if (details.type === "main_frame") {
    tabState.set(details.tabId, newPageState(details.url));
    updateBadge(details.tabId);
    return;
  }

  let state = getState(details.tabId);
  if (!state) {
    // Aba já estava aberta antes da extensão carregar: usa a origem do documento.
    const pageUrl = details.documentUrl || details.originUrl;
    if (!pageUrl) return;
    state = newPageState(pageUrl);
    tabState.set(details.tabId, state);
  }

  state.totalRequests++;
  const reqHost = hostFromUrl(details.url);
  const reqSite = baseDomain(reqHost);
  if (!reqSite || !/^(https?|wss?):/.test(details.url)) return;

  // Firefox informa se a requisição é de terceira parte em relação ao topo;
  // usamos a comparação por eTLD+1 como fallback.
  const third = typeof details.thirdParty === "boolean"
    ? details.thirdParty && reqSite !== state.site
    : reqSite !== state.site;

  if (!third) {
    state.firstPartyRequests++;
    return;
  }

  let entry = state.thirdParty.get(reqSite);
  if (!entry) {
    entry = { site: reqSite, hosts: new Set(), count: 0, types: {}, classifications: new Set(), sample: details.url };
    state.thirdParty.set(reqSite, entry);
  }
  entry.count++;
  entry.hosts.add(reqHost);
  entry.types[details.type] = (entry.types[details.type] || 0) + 1;

  // Classificação da Enhanced Tracking Protection do Firefox (lista Disconnect),
  // ex.: tracking_ad, tracking_analytics, tracking_social, fingerprinting, cryptomining.
  const cls = details.urlClassification;
  if (cls) {
    for (const c of [...(cls.thirdParty || []), ...(cls.firstParty || [])]) {
      entry.classifications.add(c);
    }
  }

  updateBadge(details.tabId);
}

browser.webRequest.onBeforeRequest.addListener(
  onBeforeRequest,
  { urls: ["<all_urls>"] },
  []
);

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/**
 * Registra um cookie criado durante o carregamento da página.
 * source: "http" (Set-Cookie) ou "js" (document.cookie / cookieStore).
 */
function recordCookie(state, raw, defaultHost, source, setBy) {
  const c = parseCookieString(raw, defaultHost);
  if (!c) return;

  const key = `${c.domain}|${c.path}|${c.name}`;
  if (c.deleted) {
    state.cookieDeletions++;
    const existing = state.cookies.get(key);
    if (existing) existing.deleted = true;
    return;
  }

  const site = baseDomain(c.domain);
  let entry = state.cookies.get(key);
  if (!entry) {
    entry = { ...c, site, thirdParty: site !== state.site, sources: new Set(), setBy, writes: 0 };
    state.cookies.set(key, entry);
  } else {
    Object.assign(entry, c, { deleted: false });
  }
  entry.writes++;
  entry.sources.add(source);
}

function onHeadersReceived(details) {
  if (details.tabId < 0 || !details.responseHeaders) return;
  const state = getState(details.tabId);
  if (!state) return;

  const host = hostFromUrl(details.url);
  for (const h of details.responseHeaders) {
    if (h.name.toLowerCase() !== "set-cookie" || !h.value) continue;
    // O Firefox junta múltiplos Set-Cookie em um único cabeçalho separado por \n.
    for (const line of h.value.split("\n")) {
      if (line.trim()) recordCookie(state, line, host, "http", details.url);
    }
  }
}

browser.webRequest.onHeadersReceived.addListener(
  onHeadersReceived,
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ---------------------------------------------------------------------------
// Armazenamento HTML5 (localStorage, sessionStorage, IndexedDB)
// ---------------------------------------------------------------------------

function storageEntry(state, origin, frameUrl) {
  let entry = state.storage.get(origin);
  if (!entry) {
    // Origem opaca ("null") de iframes sandbox: usa a URL do frame para o site;
    // about:blank/srcdoc não têm site próprio e pertencem ao documento da aba.
    const site = siteFromUrl(origin !== "null" ? origin : frameUrl) || state.site;
    entry = { origin, site, thirdParty: site !== state.site, frameUrl, ops: new Map(), snapshot: null };
    state.storage.set(origin, entry);
  }
  return entry;
}

/** Operação observada por hook: set/remove/clear (Web Storage), open/write (IndexedDB). */
function recordStorageOp(entry, op) {
  const key = `${op.api}|${op.key}`;
  let rec = entry.ops.get(key);
  if (!rec) {
    rec = { api: op.api, key: op.key, ops: {}, writes: 0, size: 0, preview: "" };
    entry.ops.set(key, rec);
  }
  // Escritas IndexedDB chegam já agregadas no content script (campo count).
  rec.ops[op.op] = op.count || (rec.ops[op.op] || 0) + 1;
  if (op.op === "set" || op.op === "write") rec.writes = op.count || rec.writes + 1;
  if (op.size !== undefined) rec.size = op.size;
  if (op.preview !== undefined) rec.preview = op.preview;
}

// ---------------------------------------------------------------------------
// Eventos vindos do content script (APIs chamadas pela página)
// ---------------------------------------------------------------------------

function onPageEvents(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  const state = tabId !== undefined && getState(tabId);
  if (!state) return;

  const frameUrl = msg.frameUrl || sender.url || state.url;
  // Descarta eventos atrasados de um documento anterior da mesma aba.
  if (sender.frameId === 0 && siteFromUrl(frameUrl) !== state.site) return;
  const origin = msg.origin || new URL(frameUrl).origin;

  for (const { event, data } of msg.events || []) {
    switch (event) {
      case "cookieWrite":
        recordCookie(state, data.raw, hostFromUrl(frameUrl), "js", frameUrl);
        break;
      case "storageOp":
        recordStorageOp(storageEntry(state, origin, frameUrl), data);
        break;
      case "storageSnapshot":
        storageEntry(state, origin, frameUrl).snapshot = data;
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

function updateBadge(tabId) {
  const state = getState(tabId);
  const n = state ? state.thirdParty.size : 0;
  browser.browserAction.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {});
  browser.browserAction.setBadgeBackgroundColor({ tabId, color: n > 10 ? "#c62828" : n > 3 ? "#ef6c00" : "#2e7d32" }).catch(() => {});
}

browser.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId));

// ---------------------------------------------------------------------------
// Relatório para o popup
// ---------------------------------------------------------------------------

function serializeReport(state) {
  const thirdParty = [...state.thirdParty.values()]
    .map((e) => ({
      site: e.site,
      hosts: [...e.hosts],
      count: e.count,
      types: e.types,
      classifications: [...e.classifications],
      tracker: e.classifications.size > 0,
      sample: e.sample
    }))
    .sort((a, b) => (b.tracker - a.tracker) || (b.count - a.count));

  const cookies = [...state.cookies.values()]
    .filter((c) => !c.deleted)
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      site: c.site,
      path: c.path,
      thirdParty: c.thirdParty,
      session: c.session,
      expiry: c.expiry,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      partitioned: c.partitioned,
      sources: [...c.sources],
      writes: c.writes,
      setBy: c.setBy
    }))
    .sort((a, b) => (b.thirdParty - a.thirdParty) || a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));

  const cookiesBySite = {};
  for (const c of cookies) cookiesBySite[c.site] = (cookiesBySite[c.site] || 0) + 1;
  for (const e of thirdParty) e.cookies = cookiesBySite[e.site] || 0;

  const count = (pred) => cookies.filter(pred).length;
  const cookieSummary = {
    total: cookies.length,
    firstParty: count((c) => !c.thirdParty),
    thirdParty: count((c) => c.thirdParty),
    session: count((c) => c.session),
    persistent: count((c) => !c.session),
    viaHttp: count((c) => c.sources.includes("http")),
    viaJs: count((c) => c.sources.includes("js")),
    deletions: state.cookieDeletions
  };

  const storage = [...state.storage.values()]
    .map((e) => {
      const snap = e.snapshot || { local: { count: 0, bytes: 0, items: [] }, session: { count: 0, bytes: 0, items: [] }, idb: [] };
      const ops = [...e.ops.values()];
      // Bancos IndexedDB abertos por hook, mesmo que o snapshot não os liste.
      const idbNames = new Set(snap.idb.map((d) => d.name));
      for (const o of ops) if (o.api === "idb") idbNames.add(o.key.split("/")[0]);
      return {
        origin: e.origin,
        site: e.site,
        thirdParty: e.thirdParty,
        local: snap.local,
        session: snap.session,
        idb: [...idbNames],
        ops,
        writes: ops.reduce((n, o) => n + o.writes, 0)
      };
    })
    .filter((e) => e.local.count || e.session.count || e.idb.length || e.ops.length)
    .sort((a, b) => (a.thirdParty - b.thirdParty) || a.origin.localeCompare(b.origin));

  const sum = (f) => storage.reduce((n, e) => n + f(e), 0);
  const storageSummary = {
    origins: storage.length,
    thirdPartyOrigins: storage.filter((e) => e.thirdParty).length,
    localItems: sum((e) => e.local.count),
    sessionItems: sum((e) => e.session.count),
    idbDatabases: sum((e) => e.idb.length),
    bytes: sum((e) => e.local.bytes + e.session.bytes),
    writes: sum((e) => e.writes)
  };

  return {
    url: state.url,
    host: state.host,
    site: state.site,
    startedAt: state.startedAt,
    totalRequests: state.totalRequests,
    firstPartyRequests: state.firstPartyRequests,
    thirdPartyRequests: thirdParty.reduce((s, e) => s + e.count, 0),
    thirdParty,
    cookies,
    cookieSummary,
    storage,
    storageSummary
  };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === "pageEvents") {
    onPageEvents(msg, sender);
    return;
  }
  if (msg.type === "getReport") {
    const state = getState(msg.tabId);
    return Promise.resolve(state ? serializeReport(state) : null);
  }
});
