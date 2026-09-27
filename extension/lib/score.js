/*
 * Pontuação de privacidade (0 a 100).
 *
 * Metodologia: a página começa com 100 pontos e perde pontos por critério.
 * Desconto do critério = min(teto, valor medido × peso). Os tetos somam
 * exatamente 100, então a nota nunca fica negativa e cada critério tem um
 * limite claro de influência. Nas contagens (rastreadores, cookies,
 * domínios) o peso é teto / saturação: o desconto cresce linearmente até
 * a saturação (ex.: 25 pontos distribuídos até 30 rastreadores), o que
 * mantém a nota discriminando sites muito rastreados entre si. O peso
 * reflete a gravidade:
 * técnicas que contornam o bloqueio de cookies (fingerprint, bounce,
 * sincronismo de IDs) pesam mais que a simples contagem de domínios.
 *
 * Os critérios 1-6 correspondem aos testes do Blacklight (The Markup), para
 * permitir a comparação; os critérios 7-11 são sinais que só o plugin mede.
 *
 * Faixas: A >= 90 | B >= 75 | C >= 55 | D >= 35 | E < 35
 *
 * Regra de veto: se houver assinatura de framework de hook (ex.: BeEF), a
 * nota é limitada a VETO_MAX_SCORE, pois o navegador está sob controle de
 * terceiros e a soma dos demais critérios deixaria de representar o risco.
 */
const VETO_MAX_SCORE = 20;

// Serviços de gravação de sessão (replay de cliques, rolagem e digitação).
const SESSION_RECORDERS = new Set([
  "hotjar.com", "clarity.ms", "fullstory.com", "smartlook.com", "mouseflow.com",
  "logrocket.io", "logrocket.com", "contentsquare.net", "quantummetric.com", "inspectlet.com",
  "luckyorange.com", "sessioncam.com", "clicktale.net", "yandex.ru"
]);

// Pixels de redes sociais / plataformas de anúncio que acompanham o usuário entre sites.
const SOCIAL_PIXELS = {
  "facebook.net": "Meta", "facebook.com": "Meta", "tiktok.com": "TikTok", "tiktokw.us": "TikTok",
  "ads-twitter.com": "X", "twitter.com": "X", "t.co": "X", "linkedin.com": "LinkedIn", "licdn.com": "LinkedIn",
  "pinterest.com": "Pinterest", "pinimg.com": "Pinterest", "reddit.com": "Reddit", "redditstatic.com": "Reddit",
  "snapchat.com": "Snap", "sc-static.net": "Snap"
};

const SCORE_CRITERIA = [
  {
    id: "trackers",
    name: "Rastreadores de terceiros conhecidos",
    weight: 22 / 30, cap: 22,
    why: "Domínios classificados como rastreadores pela Enhanced Tracking Protection (lista Disconnect). Principal vetor de perfilamento entre sites.",
    measure: (r) => r.thirdParty.filter((e) => e.tracker).length
  },
  {
    id: "thirdPartyCookies",
    name: "Cookies de terceira parte",
    weight: 13 / 40, cap: 13,
    why: "Cookies de outros sites identificam o usuário em todas as páginas que carregam o mesmo terceiro.",
    measure: (r) => r.cookieSummary.thirdParty
  },
  {
    id: "canvas",
    name: "Canvas fingerprint",
    weight: 11, cap: 11,
    why: "Identifica o dispositivo sem cookies, contornando bloqueio e limpeza de cookies; o usuário não tem como apagar.",
    measure: (r) => (r.tracking.canvas.fingerprinting ? 1 : 0)
  },
  {
    id: "sessionRecording",
    name: "Gravação de sessão",
    weight: 8, cap: 8,
    why: "Replay de cliques, rolagem e campos digitados; pode capturar dados sensíveis antes do envio de formulários.",
    measure: (r) => r.thirdParty.filter((e) => SESSION_RECORDERS.has(e.site)).length
  },
  {
    id: "socialPixels",
    name: "Pixels de redes sociais",
    weight: 2, cap: 8,
    why: "Meta, TikTok, X, LinkedIn etc. associam a visita ao perfil do usuário na rede social, mesmo sem clique.",
    measure: (r) => new Set(r.thirdParty.map((e) => SOCIAL_PIXELS[e.site]).filter(Boolean)).size
  },
  {
    id: "remarketing",
    name: "Remarketing do Google Analytics",
    weight: 4, cap: 4,
    why: "O Analytics envia o ID do visitante ao doubleclick.net/google.com (ads/ga-audiences) para montar públicos de anúncios.",
    measure: (r) => (r.thirdParty.some((e) => e.site === "doubleclick.net") &&
      r.thirdParty.some((e) => e.site === "google-analytics.com" || e.site === "googletagmanager.com") ? 1 : 0)
  },
  {
    id: "unclassified",
    name: "Outros domínios de terceiros",
    weight: 3 / 15, cap: 3,
    why: "Terceiros sem classificação (CDNs, widgets) ainda recebem IP, User-Agent e Referer do visitante.",
    measure: (r) => r.thirdParty.filter((e) => !e.tracker).length
  },
  {
    id: "cookieSync",
    name: "Cookie sync entre terceiros",
    weight: 2, cap: 8,
    why: "Um rastreador repassa seu ID a outro, unindo perfis de empresas diferentes.",
    measure: (r) => new Set(r.tracking.idSharing.filter((s) => s.kind === "cookie-sync").map((s) => `${s.from}>${s.to}`)).size +
      r.tracking.syncRedirects.length
  },
  {
    id: "firstPartyIdLeak",
    name: "ID de 1ª parte enviado a terceiros",
    weight: 1.25, cap: 5,
    why: "Cookie gravado como 1ª parte (escapa do bloqueio de cookies de terceiros) mas enviado a um terceiro na URL.",
    measure: (r) => new Set(r.tracking.idSharing.filter((s) => s.kind === "id-1a-parte").map((s) => s.to)).size
  },
  {
    id: "bounce",
    name: "Bounce tracking",
    weight: 6, cap: 6,
    why: "Redirecionamento por um site rastreador que ganha acesso de 1ª parte sem o usuário escolher visitá-lo.",
    measure: (r) => (r.tracking.bounce.detected ? 1 : 0)
  },
  {
    id: "hijack",
    name: "Indicadores de hijacking / hook",
    weight: 4, cap: 8,
    why: "Canal persistente com terceiro (WebSocket/polling), captura de teclas por script de terceiro ou APIs nativas substituídas: sinais de navegador sequestrado. Assinatura de framework de hook (BeEF) zera o critério.",
    measure: (r) => {
      const ind = r.tracking.hijack ? r.tracking.hijack.indicators : [];
      return ind.some((i) => i.id === "signature") ? 2 : ind.length;
    }
  },
  {
    id: "thirdPartyStorage",
    name: "Armazenamento HTML5 de terceiros",
    weight: 2, cap: 4,
    why: "localStorage/IndexedDB de iframes de terceiros guardam identificadores fora do alcance da limpeza de cookies.",
    measure: (r) => r.storageSummary.thirdPartyOrigins
  }
];

function gradeFor(score) {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 35) return "D";
  return "E";
}

/** Calcula a pontuação a partir do relatório serializado da página. */
function computePrivacyScore(report) {
  const items = SCORE_CRITERIA.map((c) => {
    let value = 0;
    try { value = c.measure(report) || 0; } catch (e) { value = 0; }
    const penalty = Math.min(c.cap, value * c.weight);
    return { id: c.id, name: c.name, value, weight: c.weight, cap: c.cap, penalty: Math.round(penalty * 10) / 10, why: c.why };
  });
  const total = items.reduce((s, i) => s + i.penalty, 0);
  let score = Math.max(0, Math.round(100 - total));

  // Regra de veto: com assinatura de framework de hook (BeEF), o navegador está
  // sob controle de terceiros; nenhuma outra ausência de rastreamento compensa.
  let veto = null;
  const hijack = report.tracking && report.tracking.hijack;
  if (hijack && hijack.indicators.some((i) => i.id === "signature") && score > VETO_MAX_SCORE) {
    score = VETO_MAX_SCORE;
    veto = "Assinatura de framework de hook detectada: nota limitada a " + VETO_MAX_SCORE + ".";
  }
  return { score, grade: gradeFor(score), items, veto };
}
