/*
 * Content script executado em document_start, em todos os frames.
 *
 * Para observar o que os scripts da página fazem, as APIs são substituídas
 * diretamente no "mundo" da página (window.wrappedJSObject) usando
 * exportFunction, recurso do Firefox que não depende de injetar <script>
 * e por isso não é bloqueado pela CSP do site.
 *
 * Cada evento observado é enviado ao background, que monta o relatório.
 */
(function () {
  "use strict";

  const pageWin = window.wrappedJSObject;
  if (!pageWin || typeof exportFunction !== "function") return;

  function send(event, data) {
    browser.runtime
      .sendMessage({ type: "pageEvent", event, data, frameUrl: location.href })
      .catch(() => {});
  }

  /** Substitui o setter de uma propriedade de protótipo mantendo o original. */
  function hookSetter(proto, prop, onSet) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    const origGet = desc.get;
    const origSet = desc.set;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: exportFunction(function () {
        return origGet.call(this);
      }, pageWin),
      set: exportFunction(function (value) {
        try { onSet(value); } catch (e) { /* nunca quebrar a página */ }
        return origSet.call(this, value);
      }, pageWin)
    });
  }

  /** Envolve um método de protótipo, chamando onCall antes do original. */
  function hookMethod(proto, name, onCall) {
    const orig = proto && proto[name];
    if (typeof orig !== "function") return;
    proto[name] = exportFunction(function (...args) {
      try { onCall(args, this); } catch (e) { /* nunca quebrar a página */ }
      return orig.apply(this, args);
    }, pageWin);
  }

  // -------------------------------------------------------------------------
  // Cookies via JavaScript
  // -------------------------------------------------------------------------
  try {
    hookSetter(pageWin.Document.prototype, "cookie", (value) => {
      send("cookieWrite", { raw: String(value) });
    });
  } catch (e) {
    console.warn("[Privacy Inspector] hook document.cookie falhou:", e);
  }

  // Cookie Store API (assíncrona). Aceita set(nome, valor) ou set({ ... }).
  try {
    if (pageWin.CookieStore) {
      hookMethod(pageWin.CookieStore.prototype, "set", (args) => {
        const [a, b] = args;
        let raw;
        if (typeof a === "string") {
          raw = `${a}=${b}`;
        } else if (a) {
          raw = `${a.name}=${a.value}`;
          if (a.domain) raw += `; Domain=${a.domain}`;
          if (a.path) raw += `; Path=${a.path}`;
          if (a.expires) raw += `; Expires=${new Date(a.expires).toUTCString()}`;
        }
        if (raw) send("cookieWrite", { raw, api: "cookieStore" });
      });
    }
  } catch (e) {
    console.warn("[Privacy Inspector] hook cookieStore falhou:", e);
  }
})();
