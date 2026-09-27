/*
 * Background persistente: observa todo o tráfego via webRequest e mantém
 * um relatório por aba. O relatório é zerado a cada navegação principal
 * (main_frame) e enviado ao popup sob demanda; as páginas anteriores ficam
 * em um histórico curto por aba para a detecção de bounce tracking.
 */

/** tabId -> estado da página carregada naquela aba */
const tabState = new Map();

/** tabId -> estados das páginas anteriores da aba (para detectar bounce tracking) */
const navHistory = new Map();
const HISTORY_LIMIT = 10;

/** Índice global "valor de cookie -> site dono", usado na detecção de cookie sync */
const idIndex = new IdIndex();

function newPageState(url, requestId) {
  return {
    url,
    host: hostFromUrl(url),
    site: siteFromUrl(url),
    requestId,
    startedAt: Date.now(),
    endedAt: null,
    transitionType: null,  // webNavigation: link, typed, reload...
    qualifiers: [],        // webNavigation: client_redirect, server_redirect...
    arrivedByHttpRedirect: false,
    interacted: false,     // houve clique/tecla real do usuário?
    totalRequests: 0,
    firstPartyRequests: 0,
    thirdParty: new Map(), // site -> { site, hosts:Set, count, types:{}, classifications:Set, sample }
    cookies: new Map(),    // "domínio|path|nome" -> cookie observado
    cookieDeletions: 0,
    cookieRejected: new Map(), // "domínio|nome" -> tentativa rejeitada pelo navegador
    sentCookies: [],       // cookies enviados na requisição do documento (cabeçalho Cookie)
    storage: new Map(),    // origem -> { origin, site, thirdParty, ops:Map, snapshot }
    canvas: [],            // leituras de canvas observadas
    idSharing: new Map(),  // "dono|nome|destino|param" -> ID enviado a outro site
    syncRedirects: new Map(), // "origem->destino" -> redirecionamentos entre terceiros
    pageTrackingParams: trackingParamsIn(url),
    websockets: [],        // conexões WebSocket abertas pela página
    polling: new Map(),    // "host/caminho" de terceiro -> instantes das requisições
    keyListeners: new Map(), // "evento|script" -> ouvinte de teclado registrado
    globals: null,         // resultado da última verificação de objetos globais
    decoratedRequests: new Map() // site -> { site, params:Set, count }
  };
}

function getState(tabId) {
  return tabState.get(tabId);
}

function historyOf(tabId) {
  let h = navHistory.get(tabId);
  if (!h) navHistory.set(tabId, (h = []));
  return h;
}

// ---------------------------------------------------------------------------
// Compartilhamento de IDs (cookie sync)
// ---------------------------------------------------------------------------

function recordIdSharing(state, url, requestSite, kind) {
  for (const f of findIdsInUrl(url, idIndex, requestSite)) {
    const key = `${f.owner.site}|${f.owner.name}|${requestSite}|${f.param}`;
    const existing = state.idSharing.get(key);
    if (existing) { existing.count++; continue; }
    state.idSharing.set(key, {
      from: f.owner.site,
      cookie: f.owner.name,
      to: requestSite,
      param: f.param,
      value: f.value,
      url,
      count: 1,
      // ID de cookie da própria página enviado a terceiro, ou ID de um terceiro repassado a outro.
      kind: kind || (f.owner.site === state.site ? "id-1a-parte" : "cookie-sync")
    });
  }
}

// ---------------------------------------------------------------------------
// Requisições
// ---------------------------------------------------------------------------

function onBeforeRequest(details) {
  if (details.tabId < 0) return; // requisições internas do navegador / service workers

  if (details.type === "main_frame") {
    const prev = getState(details.tabId);
    const next = newPageState(details.url, details.requestId);
    if (prev) {
      prev.endedAt = Date.now();
      // Mesmo requestId = redirecionamento HTTP (30x): a página anterior nunca foi exibida.
      next.arrivedByHttpRedirect = prev.requestId === details.requestId;
      const hist = historyOf(details.tabId);
      hist.push(prev);
      if (hist.length > HISTORY_LIMIT) hist.shift();
    }
    tabState.set(details.tabId, next);
    // ID de um site levado na URL da navegação para outro site (ex.: bounce tracking).
    recordIdSharing(next, details.url, next.site, "navegação");
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

  if (details.type === "websocket" && state.websockets.length < 50) {
    state.websockets.push({ url: details.url, site: reqSite, thirdParty: reqSite !== state.site, at: Date.now() - state.startedAt });
  }

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

  // Parâmetros de rastreamento repassados a terceiros (gclid, utm_*, _gl...).
  const params = trackingParamsIn(details.url);
  if (params.length) {
    const d = state.decoratedRequests.get(reqSite) || { site: reqSite, params: new Set(), count: 0 };
    d.count++;
    for (const p of params) d.params.add(p.name);
    state.decoratedRequests.set(reqSite, d);
  }

  // IDs de cookies de outros sites presentes na URL (cookie sync).
  recordIdSharing(state, details.url, reqSite);

  // Instantes das requisições por endpoint, para detectar polling persistente.
  if (POLLING_TYPES.has(details.type)) {
    let path = "";
    try { path = new URL(details.url).pathname; } catch (e) {}
    const key = `${reqHost}${path}`;
    let p = state.polling.get(key);
    if (!p && state.polling.size < 500) {
      p = { endpoint: key, site: reqSite, type: details.type, times: [] };
      state.polling.set(key, p);
    }
    if (p && p.times.length < 300) p.times.push(Date.now());
  }

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

/**
 * Redirecionamento de sub-recurso entre dois sites de terceiros: é o
 * mecanismo típico de cookie sync (pixel A -> 302 -> pixel B?uid=...),
 * mesmo quando o ID vai cifrado e não pode ser reconhecido.
 */
browser.webRequest.onBeforeRedirect.addListener((details) => {
  if (details.tabId < 0 || details.type === "main_frame") return;
  const state = getState(details.tabId);
  if (!state) return;
  const from = siteFromUrl(details.url);
  const to = siteFromUrl(details.redirectUrl);
  if (!from || !to || from === to || from === state.site || to === state.site) return;
  const key = `${from}->${to}`;
  const r = state.syncRedirects.get(key) || { from, to, count: 0, sample: details.redirectUrl };
  r.count++;
  state.syncRedirects.set(key, r);
}, { urls: ["<all_urls>"] });

/** Cabeçalho Cookie enviado: ensina ao índice os IDs já guardados por cada site. */
browser.webRequest.onBeforeSendHeaders.addListener((details) => {
  if (details.tabId < 0 || !details.requestHeaders) return;
  const site = siteFromUrl(details.url);
  for (const h of details.requestHeaders) {
    if (h.name.toLowerCase() !== "cookie" || !h.value) continue;
    for (const pair of h.value.split(";")) {
      const i = pair.indexOf("=");
      if (i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      idIndex.add(value, { site, name, source: "cookie enviado" });
      if (details.type === "main_frame") {
        const state = getState(details.tabId);
        if (state && state.requestId === details.requestId) state.sentCookies.push({ name, value });
      }
    }
  }
}, { urls: ["<all_urls>"] }, ["requestHeaders"]);

/** Tipo de transição da navegação principal (link, digitada, redirecionamento...). */
browser.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  const state = getState(details.tabId);
  if (!state || state.site !== siteFromUrl(details.url)) return;
  state.transitionType = details.transitionType || null;
  state.qualifiers = details.transitionQualifiers || [];
});

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

  const reason = cookieRejection(c, defaultHost);
  if (reason) {
    const rkey = `${c.domain}|${c.name}`;
    const r = state.cookieRejected.get(rkey) || { name: c.name, domain: c.domain, reason, source, setBy, attempts: 0 };
    r.attempts++;
    state.cookieRejected.set(rkey, r);
    return;
  }

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
  idIndex.add(c.value, { site, name: c.name, source });
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
  let state = tabId !== undefined && getState(tabId);
  if (!state) return;

  const frameUrl = msg.frameUrl || sender.url || state.url;
  // Eventos atrasados de um documento anterior da aba (ex.: página de bounce
  // que gravou o ID e redirecionou em seguida) vão para o estado daquela página.
  // Compara por URL exata: origem e destino do bounce podem ser do mesmo site.
  if (sender.frameId === 0 && frameUrl !== state.url) {
    const past = [...historyOf(tabId)].reverse();
    const byUrl = past.find((s) => s.url === frameUrl);
    if (byUrl) {
      state = byUrl;
    } else if (siteFromUrl(frameUrl) !== state.site) {
      state = past.find((s) => s.site === siteFromUrl(frameUrl));
      if (!state) return;
    }
    // senão: mesma página com URL alterada por pushState/hash; segue no estado atual.
  }
  const origin = msg.origin || new URL(frameUrl).origin;

  for (const { event, data } of msg.events || []) {
    switch (event) {
      case "cookieWrite":
        // Host efetivo do documento (about:blank herda o do pai via origin).
        recordCookie(state, data.raw, hostFromUrl(origin !== "null" ? origin : frameUrl), "js", frameUrl);
        break;
      case "storageOp":
        recordStorageOp(storageEntry(state, origin, frameUrl), data);
        break;
      case "storageSnapshot":
        storageEntry(state, origin, frameUrl).snapshot = data;
        break;
      case "canvasRead":
        if (state.canvas.length < 100) {
          state.canvas.push({ ...data, frameUrl, thirdParty: siteFromUrl(data.script) !== state.site });
        }
        break;
      case "userInteraction":
        if (sender.frameId === 0) state.interacted = true;
        break;
      case "keyListener": {
        const key = `${data.type}|${data.script}`;
        if (!state.keyListeners.has(key) && state.keyListeners.size < 200) {
          state.keyListeners.set(key, { ...data, frameUrl, thirdParty: siteFromUrl(data.script) !== state.site });
        }
        break;
      }
      case "globalsCheck":
        if (sender.frameId === 0) state.globals = data;
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Hijacking / hook
// ---------------------------------------------------------------------------
/*
 * Um navegador "fisgado" (ex.: pelo framework BeEF via XSS) mantém um canal
 * de comando com o servidor do atacante: WebSocket ou polling periódico
 * (XHR/script/imagem a cada poucos segundos). Um endpoint é considerado
 * polling quando recebeu >= POLL_MIN_HITS requisições, ao longo de pelo
 * menos POLL_MIN_SPAN ms, com intervalos regulares (coeficiente de variação
 * baixo) entre 0,5 s e 2 min. Beacons de analytics costumam ser disparados
 * por eventos (irregulares) e ficam de fora.
 */
const POLLING_TYPES = new Set(["xmlhttprequest", "script", "image", "beacon", "ping", "other"]);
const POLL_MIN_HITS = 5;
const POLL_MIN_SPAN = 15000;
const POLL_MAX_CV = 0.35;

function detectPolling(state) {
  const found = [];
  for (const p of state.polling.values()) {
    if (p.times.length < POLL_MIN_HITS) continue;
    const span = p.times[p.times.length - 1] - p.times[0];
    if (span < POLL_MIN_SPAN) continue;
    const gaps = p.times.slice(1).map((t, i) => t - p.times[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (mean < 500 || mean > 120000) continue;
    const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
    const cv = sd / mean;
    if (cv > POLL_MAX_CV) continue;
    found.push({ endpoint: p.endpoint, site: p.site, type: p.type, hits: p.times.length, intervalMs: Math.round(mean), cv: Math.round(cv * 100) / 100 });
  }
  return found.sort((a, b) => b.hits - a.hits);
}

function evaluateHijack(state) {
  const websockets = state.websockets;
  const polling = detectPolling(state);
  const keyListeners = [...state.keyListeners.values()];
  const g = state.globals || { overwritten: [], addedCount: 0, addedSample: [], signatures: [] };

  const indicators = [];
  const thirdWs = websockets.filter((w) => w.thirdParty);
  if (thirdWs.length) indicators.push({ id: "websocket", severity: "alta", text: `WebSocket para terceiro: ${[...new Set(thirdWs.map((w) => w.site))].join(", ")}` });
  if (polling.length) indicators.push({ id: "polling", severity: "alta", text: `Polling persistente para terceiro: ${[...new Set(polling.map((p) => p.site))].join(", ")}` });
  const thirdKeys = keyListeners.filter((k) => k.thirdParty);
  if (thirdKeys.length) indicators.push({ id: "keylogger", severity: "média", text: `Script de terceiro ouvindo teclas: ${[...new Set(thirdKeys.map((k) => siteFromUrl(k.script)))].join(", ")}` });
  if (g.overwritten.length) indicators.push({ id: "overwritten", severity: "média", text: `APIs nativas substituídas pela página: ${g.overwritten.join(", ")}` });
  if (g.signatures.length) indicators.push({ id: "signature", severity: "crítica", text: `Assinatura de framework de hook: ${g.signatures.join(", ")}` });

  return { websockets, polling, keyListeners, globals: g, indicators, detected: indicators.length > 0 };
}

// ---------------------------------------------------------------------------
// Bounce tracking
// ---------------------------------------------------------------------------
/*
 * Bounce tracking: o usuário é levado por uma página intermediária de um
 * site rastreador, que roda na posição de 1ª parte (e portanto pode ler e
 * gravar seus próprios cookies) e redireciona imediatamente ao destino,
 * muitas vezes levando o ID na URL.
 *
 * Uma página X da cadeia é considerada "salto" quando saiu dela por:
 *  - redirecionamento HTTP 30x (nunca foi exibida), ou
 *  - redirecionamento de cliente (JS/meta refresh) sinalizado pelo Firefox, ou
 *  - navegação sem interação do usuário em menos de BOUNCE_MAX_DWELL ms.
 */
const BOUNCE_MAX_DWELL = 10000;
const NON_REDIRECT_TRANSITIONS = new Set(["typed", "auto_bookmark", "reload", "generated", "keyword", "keyword_generated"]);

function leftByRedirect(page, next) {
  if (next.arrivedByHttpRedirect) return "http";
  if (next.qualifiers.includes("server_redirect")) return "http";
  if (next.qualifiers.includes("client_redirect")) return "js";
  if (next.qualifiers.includes("forward_back") || NON_REDIRECT_TRANSITIONS.has(next.transitionType)) return null;
  const dwell = (page.endedAt || Date.now()) - page.startedAt;
  if (!page.interacted && dwell < BOUNCE_MAX_DWELL) return "js";
  return null;
}

function valuesWrittenBy(page) {
  const values = new Map(); // valor -> descrição
  for (const c of page.cookies.values()) if (c.value) values.set(c.value, `cookie ${c.name}`);
  for (const c of page.sentCookies) if (c.value) values.set(c.value, `cookie ${c.name}`);
  for (const e of page.storage.values()) {
    for (const o of e.ops.values()) if (o.preview) values.set(o.preview, `${o.api}Storage ${o.key}`);
  }
  return values;
}

/** Reconstrói a cadeia de redirecionamentos que levou à página atual. */
function evaluateBounce(tabId, current) {
  const seq = [...historyOf(tabId), current];
  const hops = [];
  let i = seq.length - 1;
  while (i > 0) {
    const via = leftByRedirect(seq[i - 1], seq[i]);
    if (!via) break;
    hops.unshift({ page: seq[i - 1], via });
    i--;
  }
  // seq[i] é o primeiro salto; a página anterior a ele (se houver) é a origem.
  const origin = hops.length && i > 0 ? seq[i - 1] : null;

  const result = hops.map(({ page, via }) => {
    const cookies = [...page.cookies.values()].map((c) => c.name);
    const storageKeys = [...page.storage.values()].flatMap((e) => [...e.ops.values()].filter((o) => o.op !== "open").map((o) => o.key));
    return {
      url: page.url,
      site: page.site,
      via,
      dwellMs: (page.endedAt || Date.now()) - page.startedAt,
      interacted: page.interacted,
      cookiesSet: cookies,
      cookiesSent: page.sentCookies.map((c) => c.name),
      storageKeys,
      // O salto é de outro site em relação à origem da navegação (ou, sem origem
      // conhecida, ao destino): ganhou acesso de 1ª parte sem o usuário escolher.
      crossSite: page.site !== (origin ? origin.site : current.site)
    };
  });

  // IDs gravados/lidos pelos saltos que reaparecem na URL da página seguinte.
  const leaks = [];
  hops.forEach(({ page }, k) => {
    const nextUrl = k + 1 < hops.length ? hops[k + 1].page.url : current.url;
    const values = valuesWrittenBy(page);
    for (const [param, value] of urlParams(nextUrl)) {
      if (value && values.has(value)) leaks.push({ from: page.site, to: siteFromUrl(nextUrl), param, value, source: values.get(value) });
    }
  });

  const trackers = result.filter((h) => h.crossSite && (h.cookiesSet.length || h.cookiesSent.length || h.storageKeys.length || leaks.some((l) => l.from === h.site)));
  return {
    origin: origin ? { url: origin.url, site: origin.site } : null,
    hops: result,
    leaks,
    detected: trackers.length > 0,
    trackers: [...new Set(trackers.map((h) => h.site))]
  };
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

browser.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  navHistory.delete(tabId);
});

// ---------------------------------------------------------------------------
// Relatório para o popup
// ---------------------------------------------------------------------------

function serializeReport(state, tabId) {
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
    deletions: state.cookieDeletions,
    rejected: state.cookieRejected.size
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

  const canvasSuspects = state.canvas.filter((c) => c.suspect);
  const tracking = {
    canvas: {
      reads: state.canvas,
      fingerprinting: canvasSuspects.length > 0,
      scripts: [...new Set(canvasSuspects.map((c) => c.script))]
    },
    bounce: evaluateBounce(tabId, state),
    hijack: evaluateHijack(state),
    idSharing: [...state.idSharing.values()].sort((a, b) => (a.kind === "id-1a-parte") - (b.kind === "id-1a-parte")),
    syncRedirects: [...state.syncRedirects.values()].sort((a, b) => b.count - a.count),
    trackingParams: {
      page: state.pageTrackingParams,
      requests: [...state.decoratedRequests.values()].map((d) => ({ site: d.site, params: [...d.params], count: d.count }))
    }
  };

  const report = {
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
    cookieRejected: [...state.cookieRejected.values()],
    storage,
    storageSummary,
    tracking
  };
  report.score = computePrivacyScore(report);
  return report;
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === "pageEvents") {
    onPageEvents(msg, sender);
    return;
  }
  if (msg.type === "getReport") {
    const state = getState(msg.tabId);
    return Promise.resolve(state ? serializeReport(state, msg.tabId) : null);
  }
});
