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
    thirdParty: new Map() // site -> { site, hosts:Set, count, types:{}, classifications:Set, sample }
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

  return {
    url: state.url,
    host: state.host,
    site: state.site,
    startedAt: state.startedAt,
    totalRequests: state.totalRequests,
    firstPartyRequests: state.firstPartyRequests,
    thirdPartyRequests: thirdParty.reduce((s, e) => s + e.count, 0),
    thirdParty
  };
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "getReport") {
    const state = getState(msg.tabId);
    return Promise.resolve(state ? serializeReport(state) : null);
  }
});
