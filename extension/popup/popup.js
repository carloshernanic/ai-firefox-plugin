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

$("ck-only-third").addEventListener("change", () => report && renderCookies());

// ---------------------------------------------------------------------------

async function load() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
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
}

load();
