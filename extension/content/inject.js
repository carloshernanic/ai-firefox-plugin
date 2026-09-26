/*
 * Content script executado em document_start, em todos os frames.
 *
 * Para observar o que os scripts da página fazem, as APIs são substituídas
 * diretamente no "mundo" da página (window.wrappedJSObject) usando
 * exportFunction, recurso do Firefox que não depende de injetar <script>
 * e por isso não é bloqueado pela CSP do site.
 *
 * Os eventos observados são agrupados e enviados ao background em lotes,
 * já que alguns sites fazem centenas de escritas durante o carregamento.
 */
(function () {
  "use strict";

  const pageWin = window.wrappedJSObject;
  if (!pageWin || typeof exportFunction !== "function") return;

  // -------------------------------------------------------------------------
  // Envio em lote para o background
  // -------------------------------------------------------------------------
  let queue = [];
  let flushTimer = null;

  // Iframes about:blank / srcdoc herdam a origem (e o storage) do documento pai,
  // mas location.origin devolve "null". window.origin reflete a origem efetiva.
  function frameOrigin() {
    try { if (window.origin) return window.origin; } catch (e) {}
    return location.origin;
  }

  function flush() {
    flushTimer = null;
    if (!queue.length) return;
    const events = queue;
    queue = [];
    browser.runtime
      .sendMessage({ type: "pageEvents", events, frameUrl: location.href, origin: frameOrigin() })
      .catch(() => {});
  }

  // Janela curta: páginas de bounce redirecionam logo após gravar o ID.
  function send(event, data) {
    queue.push({ event, data });
    if (!flushTimer) flushTimer = setTimeout(flush, 50);
  }
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);

  // -------------------------------------------------------------------------
  // Utilitários de hook
  // -------------------------------------------------------------------------

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

  /**
   * Envolve um método de protótipo, chamando onCall antes do original.
   *
   * Os argumentos são espalhados aqui (orig.call(this, ...args)) em vez de
   * orig.apply(this, args): o array args pertence ao compartimento do content
   * script, e o código da página não tem permissão para ler suas propriedades
   * ("Permission denied to access property length"). Espalhando, cada valor
   * cruza a fronteira individualmente.
   */
  function hookMethod(proto, name, onCall) {
    const orig = proto && proto[name];
    if (typeof orig !== "function") return;
    proto[name] = exportFunction(function (...args) {
      try { onCall(args, this); } catch (e) { /* nunca quebrar a página */ }
      return orig.call(this, ...args);
    }, pageWin);
  }

  function tryHook(label, fn) {
    try { fn(); } catch (e) { console.warn(`[Privacy Inspector] hook ${label} falhou:`, e); }
  }

  const byteSize = (s) => (s == null ? 0 : String(s).length * 2); // UTF-16
  const preview = (s, n = 60) => {
    const str = s == null ? "" : String(s);
    return str.length > n ? str.slice(0, n) + "…" : str;
  };

  // -------------------------------------------------------------------------
  // Cookies via JavaScript
  // -------------------------------------------------------------------------
  tryHook("document.cookie", () => {
    hookSetter(pageWin.Document.prototype, "cookie", (value) => {
      send("cookieWrite", { raw: String(value) });
    });
  });

  // Cookie Store API (assíncrona). Aceita set(nome, valor) ou set({ ... }).
  tryHook("cookieStore", () => {
    if (!pageWin.CookieStore) return;
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
  });

  // -------------------------------------------------------------------------
  // Web Storage (localStorage / sessionStorage)
  // -------------------------------------------------------------------------

  function storageKind(storageObj) {
    // Acessar sessionStorage pode lançar SecurityError em frames sandbox.
    try { if (storageObj === window.sessionStorage) return "session"; } catch (e) {}
    return "local";
  }

  tryHook("Storage", () => {
    const proto = pageWin.Storage.prototype;
    hookMethod(proto, "setItem", (args, self) => {
      send("storageOp", { api: storageKind(self), op: "set", key: String(args[0]), size: byteSize(args[1]), preview: preview(args[1]) });
    });
    hookMethod(proto, "removeItem", (args, self) => {
      send("storageOp", { api: storageKind(self), op: "remove", key: String(args[0]) });
    });
    hookMethod(proto, "clear", (args, self) => {
      send("storageOp", { api: storageKind(self), op: "clear", key: "*" });
    });
  });

  // -------------------------------------------------------------------------
  // IndexedDB
  // -------------------------------------------------------------------------
  const idbWrites = new Map(); // "db/store" -> contagem (agregado para não inundar o background)

  tryHook("IndexedDB", () => {
    hookMethod(pageWin.IDBFactory.prototype, "open", (args) => {
      send("storageOp", { api: "idb", op: "open", key: String(args[0]) });
    });
    hookMethod(pageWin.IDBFactory.prototype, "deleteDatabase", (args) => {
      send("storageOp", { api: "idb", op: "remove", key: String(args[0]) });
    });
    for (const method of ["put", "add"]) {
      hookMethod(pageWin.IDBObjectStore.prototype, method, (args, store) => {
        const key = `${store.transaction.db.name}/${store.name}`;
        const n = (idbWrites.get(key) || 0) + 1;
        idbWrites.set(key, n);
        if (n === 1 || n % 50 === 0) send("storageOp", { api: "idb", op: "write", key, count: n });
      });
    }
  });

  // -------------------------------------------------------------------------
  // Canvas fingerprinting
  // -------------------------------------------------------------------------
  /*
   * Heurística de Englehardt & Narayanan (2016, "Online Tracking: A
   * 1-million-site Measurement and Analysis"): é fingerprinting quando
   *  1. o canvas tem pelo menos 16x16 px;
   *  2. o texto desenhado usa >= 10 caracteres distintos ou >= 2 cores;
   *  3. a imagem é extraída (toDataURL/toBlob/getImageData).
   * Leituras sem texto (ex.: editores de imagem) ficam como "leitura de canvas".
   */
  const canvasInfo = new WeakMap(); // canvas -> { chars:Set, colors:Set, sample, reported:Set }

  function infoFor(canvas) {
    let info = canvasInfo.get(canvas);
    if (!info) {
      info = { chars: new Set(), colors: new Set(), sample: "", reported: new Set() };
      canvasInfo.set(canvas, info);
    }
    return info;
  }

  /** Primeiro script da página na pilha de chamadas (quem chamou a API). */
  function callerScript() {
    try {
      const stack = new pageWin.Error().stack || "";
      for (const line of stack.split("\n")) {
        const m = line.match(/(https?:\/\/[^\s)]+?):\d+:\d+\)?$/);
        if (m) return m[1];
      }
    } catch (e) {}
    return location.href;
  }

  function onCanvasRead(canvas, api, area) {
    if (!canvas) return;
    const info = infoFor(canvas);
    if (info.reported.has(api)) return; // um evento por canvas/API
    info.reported.add(api);
    const width = canvas.width;
    const height = canvas.height;
    const hasText = info.chars.size > 0;
    const suspect = width >= 16 && height >= 16 && (info.chars.size >= 10 || info.colors.size >= 2) && hasText;
    send("canvasRead", {
      api, width, height, area,
      distinctChars: info.chars.size,
      colors: info.colors.size,
      sample: info.sample,
      suspect,
      script: callerScript()
    });
  }

  tryHook("canvas", () => {
    const ctx2d = pageWin.CanvasRenderingContext2D.prototype;
    for (const method of ["fillText", "strokeText"]) {
      hookMethod(ctx2d, method, (args, ctx) => {
        const info = infoFor(ctx.canvas);
        const text = String(args[0]);
        for (const ch of text) info.chars.add(ch);
        info.colors.add(String(method === "fillText" ? ctx.fillStyle : ctx.strokeStyle));
        if (!info.sample) info.sample = text.slice(0, 40);
      });
    }
    hookMethod(ctx2d, "getImageData", (args, ctx) => {
      onCanvasRead(ctx.canvas, "getImageData", `${args[2]}x${args[3]}`);
    });
    const canvasProto = pageWin.HTMLCanvasElement.prototype;
    hookMethod(canvasProto, "toDataURL", (args, canvas) => onCanvasRead(canvas, "toDataURL"));
    hookMethod(canvasProto, "toBlob", (args, canvas) => onCanvasRead(canvas, "toBlob"));
  });

  // -------------------------------------------------------------------------
  // Interação do usuário (distingue navegação por clique de redirecionamento)
  // -------------------------------------------------------------------------
  if (window === window.top) {
    const onInteraction = (e) => {
      if (!e.isTrusted) return;
      send("userInteraction", { type: e.type });
      window.removeEventListener("pointerdown", onInteraction, true);
      window.removeEventListener("keydown", onInteraction, true);
    };
    window.addEventListener("pointerdown", onInteraction, true);
    window.addEventListener("keydown", onInteraction, true);
  }

  // -------------------------------------------------------------------------
  // Snapshot do armazenamento do frame
  // -------------------------------------------------------------------------

  function readStorage(getter) {
    try {
      const s = getter();
      const items = [];
      let bytes = 0;
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i);
        const value = s.getItem(key);
        const size = byteSize(key) + byteSize(value);
        bytes += size;
        if (items.length < 100) items.push({ key, size, preview: preview(value) });
      }
      return { count: s.length, bytes, items };
    } catch (e) {
      return { count: 0, bytes: 0, items: [], error: String(e.name || e) };
    }
  }

  async function snapshot() {
    const snap = {
      local: readStorage(() => window.localStorage),
      session: readStorage(() => window.sessionStorage),
      idb: []
    };
    try {
      if (window.indexedDB && indexedDB.databases) {
        const dbs = await indexedDB.databases();
        snap.idb = dbs.map((d) => ({ name: d.name, version: d.version }));
      }
    } catch (e) { /* bloqueado ou indisponível */ }

    if (snap.local.count || snap.session.count || snap.idb.length || window === window.top) {
      send("storageSnapshot", snap);
      flush();
    }
  }

  // Snapshots no fim do carregamento e depois (scripts assíncronos gravam tarde).
  window.addEventListener("load", () => {
    snapshot();
    setTimeout(snapshot, 3000);
    setTimeout(snapshot, 10000);
  }, { once: true });

  // O popup pede um snapshot atualizado ao ser aberto.
  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "snapshotNow") snapshot();
  });
})();
