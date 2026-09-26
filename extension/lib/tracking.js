/*
 * Rastreamento via URL: parâmetros de rastreamento (link decoration) e
 * compartilhamento de identificadores entre sites (cookie sync).
 *
 * Cookie sync: o rastreador A envia o ID que guardou em cookie para o
 * rastreador B, normalmente como parâmetro de URL (ex.: pixel
 * b.com/sync?partner_uid=<ID de A>). Para detectar, o plugin mantém um índice
 * "valor de cookie -> site dono" e procura esses valores nas URLs das
 * requisições feitas a outros sites.
 */

// Parâmetros de clique/campanha conhecidos (Google, Meta, Microsoft, TikTok...).
const TRACKING_PARAMS = new Set([
  "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "_ga", "_gl", "_gac",
  "fbclid", "fb_source", "fb_ref", "fb_action_ids", "fb_action_types", "fb_comment_id",
  "msclkid", "yclid", "ysclid", "ttclid", "twclid", "igshid", "igsh", "li_fat_id",
  "mc_cid", "mc_eid", "mkt_tok", "_hsenc", "_hsmi", "__hssc", "__hstc", "__hsfp", "hsctatracking",
  "vero_id", "vero_conv", "s_cid", "epik", "rb_clickid", "irclickid", "wickedid",
  "oly_anon_id", "oly_enc_id", "_openstat", "cmpid", "sc_cid", "srsltid", "si", "ref_src"
]);
const TRACKING_PARAM_PREFIXES = ["utm_", "pk_", "mtm_", "hsa_", "matomo_"];

function isTrackingParam(name) {
  const n = name.toLowerCase();
  return TRACKING_PARAMS.has(n) || TRACKING_PARAM_PREFIXES.some((p) => n.startsWith(p));
}

/** Pares [nome, valor] da query string e de um fragmento no formato de query. */
function urlParams(url) {
  let u;
  try { u = new URL(url); } catch (e) { return []; }
  const out = [...u.searchParams.entries()];
  if (u.hash.includes("=")) {
    try { out.push(...new URLSearchParams(u.hash.slice(1)).entries()); } catch (e) {}
  }
  return out;
}

function trackingParamsIn(url) {
  return urlParams(url).filter(([name]) => isTrackingParam(name)).map(([name, value]) => ({ name, value }));
}

// ---------------------------------------------------------------------------
// Identificadores
// ---------------------------------------------------------------------------

/**
 * Um valor "parece identificador" se é longo o bastante para ser único e não
 * é um valor comum. Timestamps (10-13 dígitos) são descartados porque
 * aparecem em todas as URLs e gerariam falsos positivos.
 */
function isIdLike(v) {
  if (!v || v.length < 8 || v.length > 256) return false;
  if (!/[0-9]/.test(v)) return false;
  if (/^\d{1,13}$/.test(v)) return false;
  if (/^(true|false|null|undefined)$/i.test(v)) return false;
  if (/^\d+(\.\d+)?$/.test(v) && v.length < 14) return false;
  return /^[A-Za-z0-9._\-~+/=%]+$/.test(v);
}

/** Candidatos a ID contidos em um valor de cookie (valor inteiro e partes). */
function idTokens(value) {
  const out = new Set();
  let v = value;
  try { v = decodeURIComponent(value); } catch (e) {}
  out.add(v);
  for (const part of v.split(/[|,;:&\s]/)) out.add(part);
  // _ga = GA1.1.<client id>; o Google Analytics envia só o client id (cid=...).
  const ga = v.match(/^GA\d\.\d+\.(.+)$/);
  if (ga) out.add(ga[1]);
  return [...out].filter(isIdLike);
}

/** Índice global valor -> dono (site e nome do cookie). */
class IdIndex {
  constructor(limit = 20000) {
    this.map = new Map();
    this.limit = limit;
  }
  add(value, owner) {
    for (const token of idTokens(value)) {
      if (this.map.size >= this.limit) this.map.delete(this.map.keys().next().value);
      this.map.set(token, owner);
    }
  }
  get(token) {
    return this.map.get(token);
  }
}

/**
 * Procura IDs conhecidos na URL de uma requisição feita a requestSite.
 * Retorna [{ param, value, owner }] para IDs que pertencem a outro site.
 */
function findIdsInUrl(url, index, requestSite) {
  const found = [];
  const seen = new Set();
  const check = (param, raw) => {
    let v = raw;
    try { v = decodeURIComponent(raw); } catch (e) {}
    for (const c of [v, ...v.split(/[^A-Za-z0-9._\-~]/)]) {
      if (seen.has(c) || !isIdLike(c)) continue;
      seen.add(c);
      const owner = index.get(c);
      if (owner && owner.site !== requestSite) found.push({ param, value: c, owner });
    }
  };
  for (const [name, value] of urlParams(url)) check(name, value);
  // Alguns sincronismos passam o ID no caminho: /sync/<id>/
  try {
    for (const seg of new URL(url).pathname.split("/")) if (seg.length >= 16) check("(caminho)", seg);
  } catch (e) {}
  return found;
}
