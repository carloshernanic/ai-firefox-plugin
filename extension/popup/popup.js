const $ = (id) => document.getElementById(id);

// Categorias agregadoras da ETP que só repetem as específicas.
const HIDDEN_CLASSIFICATIONS = new Set(["any_basic_tracking", "any_strict_tracking", "any_social_tracking"]);

let report = null;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

const tag = (text, cls = "") => el("span", { class: `tag ${cls}` }, text);

function truncate(s, n = 40) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function formatExpiry(ts) {
  const days = (ts - Date.now()) / 86400000;
  if (days >= 365) return `${(days / 365).toFixed(1)} anos`;
  if (days >= 1) return `${Math.round(days)} dias`;
  return `${Math.max(1, Math.round(days * 24))} h`;
}

// ---------------------------------------------------------------------------
// Abas
// ---------------------------------------------------------------------------

for (const btn of document.querySelectorAll(".tabs button")) {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
  });
}

// ---------------------------------------------------------------------------
// Terceiros
// ---------------------------------------------------------------------------

function renderThirdParty() {
  $("stat-third").textContent = report.thirdParty.length;
  $("stat-trackers").textContent = report.thirdParty.filter((e) => e.tracker).length;
  $("stat-requests").textContent = report.totalRequests;
  $("n-third").textContent = `(${report.thirdParty.length})`;

  const list = $("third-list");
  list.replaceChildren();
  $("third-empty").hidden = report.thirdParty.length > 0;

  for (const e of report.thirdParty) {
    const tags = el("div");
    for (const c of e.classifications) {
      if (!HIDDEN_CLASSIFICATIONS.has(c)) tags.append(tag(c, "tracker"));
    }
    if (e.cookies) tags.append(tag(`🍪 ${e.cookies}`, "persistent"));
    for (const [type, n] of Object.entries(e.types)) tags.append(tag(`${type} ×${n}`));

    list.append(el("li", {},
      el("div", { class: "row" },
        el("span", { class: "site" }, e.site),
        el("span", { class: "count" }, `${e.count} req`)
      ),
      el("div", { class: "meta" }, e.hosts.join(", ")),
      tags
    ));
  }
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

function renderCookies() {
  const s = report.cookieSummary;
  $("ck-total").textContent = s.total;
  $("ck-first").textContent = s.firstParty;
  $("ck-third").textContent = s.thirdParty;
  $("ck-session").textContent = s.session;
  $("ck-persistent").textContent = s.persistent;
  $("ck-origin").textContent = `${s.viaHttp} / ${s.viaJs}`;
  $("n-cookies").textContent = `(${s.total})`;

  const onlyThird = $("ck-only-third").checked;
  const cookies = report.cookies.filter((c) => !onlyThird || c.thirdParty);

  const list = $("cookie-list");
  list.replaceChildren();
  $("cookie-empty").hidden = cookies.length > 0;

  for (const c of cookies) {
    const tags = el("div",
      {},
      c.thirdParty ? tag("3ª parte", "third") : tag("1ª parte", "first"),
      c.session ? tag("sessão") : tag(`persistente · ${formatExpiry(c.expiry)}`, "persistent"),
      tag(c.sources.map((x) => x.toUpperCase()).join("+")),
      c.httpOnly ? tag("HttpOnly") : null,
      c.secure ? tag("Secure") : null,
      c.sameSite ? tag(`SameSite=${c.sameSite}`) : null,
      c.partitioned ? tag("Partitioned") : null
    );

    list.append(el("li", {},
      el("div", { class: "row" },
        el("span", { class: "site" }, c.name || "(sem nome)"),
        el("span", { class: "count" }, c.domain)
      ),
      el("div", { class: "meta" }, `valor: ${truncate(c.value) || "(vazio)"}`),
      tags
    ));
  }
}

// ---------------------------------------------------------------------------
// Storage HTML5
// ---------------------------------------------------------------------------

function formatBytes(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function storageGroup(title, items) {
  if (!items.length) return null;
  const group = el("div", { class: "group" }, el("div", { class: "group-title" }, title));
  for (const [k, v] of items) {
    group.append(el("div", { class: "kv" }, el("span", { class: "k" }, k), el("span", { class: "v" }, v)));
  }
  return group;
}

function renderStorage() {
  const s = report.storageSummary;
  $("st-local").textContent = s.localItems;
  $("st-session").textContent = s.sessionItems;
  $("st-idb").textContent = s.idbDatabases;
  $("st-origins").textContent = s.origins;
  $("st-third").textContent = s.thirdPartyOrigins;
  $("st-bytes").textContent = formatBytes(s.bytes);
  $("n-storage").textContent = `(${s.localItems + s.sessionItems + s.idbDatabases})`;

  const list = $("storage-list");
  list.replaceChildren();
  $("storage-empty").hidden = report.storage.length > 0;

  for (const e of report.storage) {
    const idbWrites = {};
    for (const o of e.ops) if (o.api === "idb" && o.ops.write) idbWrites[o.key] = o.writes;

    list.append(el("li", {},
      el("div", { class: "row" },
        el("span", { class: "site" }, e.origin),
        el("span", { class: "count" }, `${e.writes} escritas`)
      ),
      el("div", {}, e.thirdParty ? tag("3ª parte", "third") : tag("1ª parte", "first")),
      storageGroup(`localStorage · ${e.local.count} itens`, e.local.items.map((i) => [i.key, formatBytes(i.size)])),
      storageGroup(`sessionStorage · ${e.session.count} itens`, e.session.items.map((i) => [i.key, formatBytes(i.size)])),
      storageGroup(`IndexedDB · ${e.idb.length} bancos`, [
        ...e.idb.map((name) => [name, "banco"]),
        ...Object.entries(idbWrites).map(([k, n]) => [k, `${n} escritas`])
      ])
    ));
  }
}

function renderRejectedCookies() {
  const rejected = report.cookieRejected || [];
  $("ck-rejected-box").hidden = rejected.length === 0;
  $("ck-rejected-n").textContent = rejected.length;
  const list = $("ck-rejected-list");
  list.replaceChildren();
  for (const r of rejected) {
    list.append(el("li", {},
      el("div", { class: "row" },
        el("span", { class: "site" }, r.name || "(sem nome)"),
        el("span", { class: "count" }, `Domain=${r.domain}`)
      ),
      el("div", {}, tag(r.reason, "third"), tag(r.source.toUpperCase()), r.attempts > 1 ? tag(`${r.attempts} tentativas`) : null),
      el("div", { class: "meta" }, `por ${truncate(r.setBy, 70)}`)
    ));
  }
}

// ---------------------------------------------------------------------------
// Rastreio: canvas, bounce, cookie sync, parâmetros de URL
// ---------------------------------------------------------------------------

function setStatus(id, found, foundText, cls = "third") {
  const node = $(id);
  node.textContent = found ? foundText : "não detectado";
  node.className = `tag ${found ? cls : "ok"}`;
}

function emptyItem(text) {
  return el("li", { class: "empty" }, text);
}

function renderCanvas(canvas) {
  const reads = canvas.reads;
  setStatus("tr-canvas-status", reads.length, canvas.fingerprinting ? "FINGERPRINT" : "leitura de canvas", canvas.fingerprinting ? "third" : "warn");
  const list = $("tr-canvas");
  list.replaceChildren();
  if (!reads.length) list.append(emptyItem("Nenhuma extração de imagem de canvas."));
  for (const c of reads) {
    list.append(el("li", {},
      el("div", { class: "row" },
        el("span", { class: "site" }, c.api),
        el("span", { class: "count" }, `${c.width}×${c.height}`)
      ),
      el("div", {},
        c.suspect ? tag("suspeito", "third") : tag("inconclusivo"),
        tag(`${c.distinctChars} caracteres`),
        tag(`${c.colors} cores`),
        c.thirdParty ? tag("script de 3ª parte", "third") : tag("script de 1ª parte", "first")
      ),
      c.sample ? el("div", { class: "meta mono" }, `texto: "${c.sample}"`) : null,
      el("div", { class: "meta" }, `por ${truncate(c.script, 80)}`)
    ));
  }
}

function renderBounce(b) {
  setStatus("tr-bounce-status", b.detected || b.hops.length, b.detected ? "DETECTADO" : "redirecionamento", b.detected ? "third" : "warn");
  const box = $("tr-bounce");
  box.replaceChildren();
  if (!b.hops.length) {
    box.append(el("p", { class: "empty" }, "A página não foi alcançada por redirecionamentos."));
    return;
  }
  const chain = el("div", { class: "chain" });
  if (b.origin) chain.append(el("span", { class: "hop" }, b.origin.site), "→");
  for (const h of b.hops) {
    const via = h.via === "http" ? "HTTP 30x" : "JS";
    chain.append(el("span", { class: `hop ${b.trackers.includes(h.site) ? "bad" : ""}` }, `${h.site} (${via})`), "→");
  }
  chain.append(el("span", { class: "hop" }, report.site));
  box.append(chain);

  const list = el("ul", { class: "list" });
  for (const h of b.hops) {
    list.append(el("li", {},
      el("div", { class: "row" },
        el("span", { class: "site" }, h.site),
        el("span", { class: "count" }, `${h.dwellMs} ms na página`)
      ),
      el("div", {},
        h.crossSite ? tag("site diferente da origem", "third") : tag("mesmo site"),
        h.interacted ? tag("com interação") : tag("sem interação", "warn"),
        h.cookiesSet.length ? tag(`gravou cookie: ${h.cookiesSet.join(", ")}`, "third") : null,
        h.cookiesSent.length ? tag(`leu cookie: ${h.cookiesSent.join(", ")}`, "warn") : null,
        h.storageKeys.length ? tag(`gravou storage: ${h.storageKeys.join(", ")}`, "third") : null
      ),
      el("div", { class: "meta" }, truncate(h.url, 100))
    ));
  }
  for (const l of b.leaks) {
    list.append(el("li", {},
      el("div", { class: "site" }, "ID repassado na URL"),
      el("div", { class: "meta mono" }, `${l.param}=${truncate(l.value, 40)}  ←  ${l.source} de ${l.from}`)
    ));
  }
  box.append(list);
}

const SYNC_KIND_LABEL = {
  "cookie-sync": "cookie sync",
  "id-1a-parte": "ID de 1ª parte → terceiro",
  "navegação": "ID na navegação"
};

function renderSync(t) {
  const n = t.idSharing.length + t.syncRedirects.length;
  const hasSync = t.idSharing.some((s) => s.kind !== "id-1a-parte") || t.syncRedirects.length > 0;
  setStatus("tr-sync-status", n, hasSync ? "DETECTADO" : "ID de 1ª parte enviado", hasSync ? "third" : "warn");
  const list = $("tr-sync");
  list.replaceChildren();
  if (!n) list.append(emptyItem("Nenhum ID de cookie encontrado em URLs de outros sites."));
  for (const s of t.idSharing) {
    list.append(el("li", {},
      el("div", { class: "row" },
        el("span", { class: "site" }, `${s.from} → ${s.to}`),
        el("span", { class: "count" }, `${s.count}×`)
      ),
      el("div", {}, tag(SYNC_KIND_LABEL[s.kind] || s.kind, s.kind === "id-1a-parte" ? "warn" : "third"), tag(`cookie ${s.cookie}`)),
      el("div", { class: "meta mono" }, `${s.param}=${truncate(s.value, 48)}`),
      el("div", { class: "meta" }, truncate(s.url, 100))
    ));
  }
  for (const r of t.syncRedirects) {
    list.append(el("li", {},
      el("div", { class: "row" },
        el("span", { class: "site" }, `${r.from} ⇢ ${r.to}`),
        el("span", { class: "count" }, `${r.count}×`)
      ),
      el("div", {}, tag("redirecionamento entre terceiros", "warn")),
      el("div", { class: "meta" }, truncate(r.sample, 100))
    ));
  }
}

function renderParams(p) {
  const n = p.page.length + p.requests.length;
  setStatus("tr-params-status", n, `${n} ocorrências`, "warn");
  const list = $("tr-params");
  list.replaceChildren();
  if (!n) list.append(emptyItem("Nenhum parâmetro de rastreamento conhecido."));
  if (p.page.length) {
    list.append(el("li", {},
      el("div", { class: "site" }, "URL desta página"),
      el("div", { class: "meta mono" }, p.page.map((x) => `${x.name}=${truncate(x.value, 30)}`).join("  "))
    ));
  }
  for (const r of p.requests) {
    list.append(el("li", {},
      el("div", { class: "row" }, el("span", { class: "site" }, r.site), el("span", { class: "count" }, `${r.count} req`)),
      el("div", {}, ...r.params.map((x) => tag(x)))
    ));
  }
}

function renderHijack(h) {
  const critical = h.indicators.some((i) => i.severity === "crítica");
  setStatus("tr-hijack-status", h.detected, critical ? "HOOK DETECTADO" : `${h.indicators.length} indicador(es)`, critical || h.indicators.some((i) => i.severity === "alta") ? "third" : "warn");
  const list = $("tr-hijack");
  list.replaceChildren();
  if (!h.detected) list.append(emptyItem("Nenhum canal persistente, captura de teclas por terceiro ou alteração de APIs nativas."));
  const sevClass = { "crítica": "third", "alta": "third", "média": "warn" };
  for (const i of h.indicators) {
    list.append(el("li", {},
      el("div", {}, tag(i.severity, sevClass[i.severity] || "")),
      el("div", { class: "meta" }, i.text)
    ));
  }
  for (const p of h.polling) {
    list.append(el("li", {},
      el("div", { class: "row" }, el("span", { class: "site" }, "Polling"), el("span", { class: "count" }, `${p.hits}× a cada ~${(p.intervalMs / 1000).toFixed(1)} s`)),
      el("div", { class: "meta mono" }, truncate(p.endpoint, 90))
    ));
  }
  for (const w of h.websockets) {
    list.append(el("li", {},
      el("div", { class: "row" }, el("span", { class: "site" }, "WebSocket"), el("span", { class: "count" }, w.thirdParty ? "3ª parte" : "1ª parte")),
      el("div", { class: "meta mono" }, truncate(w.url, 90))
    ));
  }
  const thirdKeys = h.keyListeners.filter((k) => k.thirdParty);
  if (thirdKeys.length) {
    list.append(el("li", {},
      el("div", { class: "site" }, "Ouvintes de teclado de terceiros"),
      ...thirdKeys.slice(0, 8).map((k) => el("div", { class: "meta" }, `${k.type} em ${k.target} ← ${truncate(k.script, 70)}`))
    ));
  }
  if (h.globals.addedCount) {
    list.append(el("li", {},
      el("div", { class: "row" }, el("span", { class: "site" }, "Globais criados pela página"), el("span", { class: "count" }, String(h.globals.addedCount))),
      el("div", { class: "meta mono" }, truncate(h.globals.addedSample.join(", "), 160))
    ));
  }
}

function renderTracking() {
  const t = report.tracking;
  renderCanvas(t.canvas);
  renderBounce(t.bounce);
  renderSync(t);
  renderParams(t.trackingParams);
  if (t.hijack) renderHijack(t.hijack);
  const alerts = [t.canvas.fingerprinting, t.bounce.detected, t.idSharing.length + t.syncRedirects.length > 0, t.hijack && t.hijack.detected].filter(Boolean).length;
  $("n-tracking").textContent = alerts ? `(${alerts}⚠)` : "";
}

$("ck-only-third").addEventListener("change", () => report && renderCookies());

// ---------------------------------------------------------------------------

async function load() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  // Pede a todos os frames um snapshot atualizado do storage antes de ler o relatório.
  try {
    await browser.tabs.sendMessage(tab.id, { type: "snapshotNow" });
    await new Promise((r) => setTimeout(r, 400));
  } catch (e) { /* página sem content script (about:, loja de extensões...) */ }
  report = await browser.runtime.sendMessage({ type: "getReport", tabId: tab.id });
  if (!report) {
    $("page").textContent = "Recarregue a página para iniciar a análise.";
    $("third-empty").hidden = false;
    return;
  }
  $("page").textContent = report.url;
  if (!report.cookieSummary) {
    // Popup novo com background antigo: a extensão não foi recarregada.
    $("page").textContent = "Versão desatualizada: clique em Recarregar no about:debugging.";
  }
  renderThirdParty();
  if (!report.cookieSummary) return;
  renderCookies();
  renderRejectedCookies();
  if (report.storageSummary) renderStorage();
  if (report.tracking) renderTracking();
}

load();
