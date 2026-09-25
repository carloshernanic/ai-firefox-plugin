/*
 * Parser de cookies. O mesmo formato "nome=valor; Atributo=x; ..." é usado
 * tanto no cabeçalho Set-Cookie quanto em escritas via document.cookie.
 *
 * Classificação:
 *  - sessão:      sem Expires nem Max-Age (some ao fechar o navegador)
 *  - persistente: com Expires/Max-Age no futuro
 *  - remoção:     Expires/Max-Age no passado (técnica usada para apagar cookie)
 */
function parseCookieString(raw, defaultHost, now = Date.now()) {
  const parts = raw.split(";");
  const first = parts.shift() || "";
  const eq = first.indexOf("=");
  const name = (eq >= 0 ? first.slice(0, eq) : "").trim();
  const value = (eq >= 0 ? first.slice(eq + 1) : first).trim();
  if (!name && !value) return null;

  const cookie = {
    name,
    value,
    domain: null,
    hostOnly: true,
    path: "/",
    secure: false,
    httpOnly: false,
    sameSite: null,
    partitioned: false,
    session: true,
    expiry: null,
    deleted: false
  };

  let maxAge = null;
  let expires = null;
  for (const part of parts) {
    const i = part.indexOf("=");
    const key = (i >= 0 ? part.slice(0, i) : part).trim().toLowerCase();
    const val = i >= 0 ? part.slice(i + 1).trim() : "";
    switch (key) {
      case "domain": if (val) { cookie.domain = val; cookie.hostOnly = false; } break;
      case "path": if (val) cookie.path = val; break;
      case "secure": cookie.secure = true; break;
      case "httponly": cookie.httpOnly = true; break;
      case "samesite": cookie.sameSite = val.toLowerCase(); break;
      case "partitioned": cookie.partitioned = true; break;
      case "max-age": maxAge = parseInt(val, 10); break;
      case "expires": expires = Date.parse(val); break;
    }
  }

  // Max-Age tem precedência sobre Expires (RFC 6265 §5.3).
  if (maxAge !== null && !isNaN(maxAge)) cookie.expiry = now + maxAge * 1000;
  else if (expires !== null && !isNaN(expires)) cookie.expiry = expires;

  cookie.session = cookie.expiry === null;
  cookie.deleted = cookie.expiry !== null && cookie.expiry <= now;
  cookie.domain = (cookie.domain || defaultHost || "").replace(/^\./, "").toLowerCase();
  return cookie;
}

/**
 * Motivo pelo qual o navegador rejeitaria o cookie (RFC 6265 §5.3, passos 5-6),
 * ou null se ele é aceito. Scripts de analytics usam essas rejeições de
 * propósito ("domain probing"): tentam gravar em br, com.br, uol.com.br… até
 * descobrir o domínio mais alto que aceita cookies.
 */
function cookieRejection(cookie, setterHost) {
  if (!cookie.domain) return "sem domínio";
  if (cookie.hostOnly) return null;
  if (isPublicSuffix(cookie.domain) && cookie.domain !== setterHost) return "sufixo público";
  if (!domainMatches(setterHost, cookie.domain)) return "domínio não corresponde ao host";
  return null;
}
