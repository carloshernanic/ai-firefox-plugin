/*
 * Utilitários de domínio.
 *
 * "Terceira parte" é definida por site (eTLD+1), não por host:
 * cdn.exemplo.com.br e www.exemplo.com.br são a mesma parte.
 * Como extensões não têm acesso à Public Suffix List do Firefox,
 * usamos um subconjunto com os sufixos compostos mais comuns.
 */
const MULTI_PART_SUFFIXES = new Set([
  // Brasil
  "com.br", "net.br", "org.br", "gov.br", "edu.br", "art.br", "blog.br",
  "eco.br", "ind.br", "inf.br", "jus.br", "leg.br", "mil.br", "tv.br", "app.br",
  // Outros ccTLDs comuns
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au",
  "co.jp", "ne.jp", "or.jp", "co.in", "co.nz", "co.za", "com.ar", "com.mx",
  "com.pt", "com.es", "com.tr", "com.cn", "com.hk", "com.sg", "co.kr",
  // Sufixos privados (cada subdomínio é um "site" diferente)
  "github.io", "gitlab.io", "herokuapp.com", "netlify.app", "vercel.app",
  "pages.dev", "workers.dev", "web.app", "firebaseapp.com", "appspot.com",
  "blogspot.com", "azurewebsites.net", "cloudfront.net", "s3.amazonaws.com"
]);

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch (e) {
    return "";
  }
}

function isIpAddress(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/** Retorna o site (eTLD+1) de um host. */
function baseDomain(host) {
  if (!host || isIpAddress(host) || !host.includes(".")) return host;
  const parts = host.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const suffix = parts.slice(i + 1).join(".");
    if (MULTI_PART_SUFFIXES.has(suffix)) {
      return parts.slice(i).join(".");
    }
  }
  return parts.slice(-2).join(".");
}

function siteFromUrl(url) {
  return baseDomain(hostFromUrl(url));
}

function isThirdParty(requestUrl, pageUrl) {
  const a = siteFromUrl(requestUrl);
  const b = siteFromUrl(pageUrl);
  return !!a && !!b && a !== b;
}
