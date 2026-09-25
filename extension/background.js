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
    cookieDeletions: 0
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
// Eventos vindos do content script (APIs chamadas pela página)
// ---------------------------------------------------------------------------

function onPageEvent(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  const state = tabId !== undefined && getState(tabId);
  if (!state) return;

  const frameUrl = msg.frameUrl || sender.url || state.url;
  // Descarta eventos atrasados de um documento anterior da mesma aba.
  if (sender.frameId === 0 && siteFromUrl(frameUrl) !== state.site) return;

  switch (msg.event) {
    case "cookieWrite":
      recordCookie(state, msg.data.raw, hostFromUrl(frameUrl), "js", frameUrl);
      break;
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
    cookieSummary
  };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === "pageEvent") {
    onPageEvent(msg, sender);
    return;
  }
  if (msg.type === "getReport") {
    const state = getState(msg.tabId);
    return Promise.resolve(state ? serializeReport(state) : null);
  }
});
