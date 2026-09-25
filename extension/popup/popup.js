const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function renderThirdParty(report) {
  const list = $("third-list");
  list.replaceChildren();
  $("empty").hidden = report.thirdParty.length > 0;

  for (const e of report.thirdParty) {
    const tags = el("div");
    for (const c of e.classifications) tags.append(el("span", { class: "tag tracker" }, c));
    for (const [type, n] of Object.entries(e.types)) tags.append(el("span", { class: "tag" }, `${type} ×${n}`));

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

async function load() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const report = await browser.runtime.sendMessage({ type: "getReport", tabId: tab.id });
  if (!report) {
    $("page").textContent = "Recarregue a página para iniciar a análise.";
    $("empty").hidden = false;
    return;
  }
  $("page").textContent = report.url;
  $("stat-third").textContent = report.thirdParty.length;
  $("stat-trackers").textContent = report.thirdParty.filter((e) => e.tracker).length;
  $("stat-requests").textContent = report.totalRequests;
  renderThirdParty(report);
}

load();
