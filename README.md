# Privacy Inspector — extensão Firefox

Avaliação Intermediária de Cibersegurança (Insper). Extensão para detectar e
apresentar rastreamento e violações de privacidade no cliente web.

## Funcionalidades

| Funcionalidade | Status |
|---|---|
| Conexões a domínios de terceira parte (com classificação de rastreadores do Firefox) | ✅ |
| Cookies: contagem, 1ª/3ª parte, sessão/persistente, origem HTTP/JS | ✅ |
| Armazenamento HTML5 (localStorage, sessionStorage, IndexedDB), por origem 1ª/3ª parte | ✅ |
| Canvas fingerprint (heurística de Englehardt & Narayanan) | ✅ |
| Cookie sync, bounce tracking e parâmetros de rastreamento na URL | ✅ |
| Indicadores de hijacking / hook | ⏳ |
| Pontuação de privacidade | ⏳ |
| Lista de bloqueio personalizada | ⏳ |

## Como instalar (modo desenvolvimento)

1. Abra o Firefox e acesse `about:debugging#/runtime/this-firefox`.
2. Clique em **Carregar extensão temporária…** (*Load Temporary Add-on…*).
3. Selecione o arquivo `extension/manifest.json` deste repositório.
4. O ícone do **Privacy Inspector** aparece na barra de ferramentas. Abra (ou
   recarregue) uma página e clique no ícone para ver o relatório.

> Extensões temporárias são removidas ao fechar o Firefox; repita o passo 2
> a cada nova sessão. Após alterar o código, clique em **Recarregar** na
> mesma página do `about:debugging`.

## Estrutura

```
extension/
  manifest.json      Manifest V2 (background persistente + webRequest)
  background.js      Coleta do tráfego por aba e montagem do relatório
  content/inject.js  Hooks nas APIs da página (cookies, storage, canvas…)
  lib/domain.js      Cálculo de site (eTLD+1) e classificação 1ª/3ª parte
  lib/cookies.js     Parser de Set-Cookie / document.cookie
  lib/tracking.js    Parâmetros de rastreamento e índice de IDs (cookie sync)
  popup/             Interface do relatório
evidencias/          HARs e prints usados no relatório
```

## Decisões técnicas

- **Manifest V2** com background persistente: no Firefox o MV3 usa *event
  pages* que podem ser descarregadas, perdendo o estado em memória por aba.
- **Terceira parte por site (eTLD+1)**, não por host: `cdn.exemplo.com.br` e
  `www.exemplo.com.br` são a mesma parte.
- **`details.urlClassification`** (exclusivo do Firefox) informa quando a
  Enhanced Tracking Protection classifica a URL como rastreador (lista
  Disconnect), o que permite marcar rastreadores conhecidos sem embutir uma
  lista própria.
- **Cookies por duas fontes:** cabeçalhos `Set-Cookie` (`webRequest.onHeadersReceived`)
  e escritas via JavaScript (`document.cookie` e Cookie Store API), interceptadas
  no mundo da página com `exportFunction` — técnica do Firefox que não depende
  de injetar `<script>` e por isso não é bloqueada pela CSP do site.
- **Classificação de cookies:** 3ª parte quando o site (eTLD+1) do domínio do
  cookie difere do site da aba; sessão quando não há `Expires`/`Max-Age`;
  `Expires`/`Max-Age` no passado é contado como remoção, não como injeção.
- **Cookies rejeitados (RFC 6265 §5.3):** um `Domain` que seja sufixo público
  (`br`, `com.br`) ou que não corresponda ao host que grava o cookie é recusado
  pelo navegador. Essas tentativas não entram na contagem e são listadas à parte:
  elas revelam *domain probing*, técnica do Google Analytics e de outros scripts
  (ex.: `_ga` e `_rdc…=writeable` tentados em `br`, `com.br` e só aceitos em
  `uol.com.br`).
- **Limitação conhecida:** um cabeçalho `Set-Cookie` observado não garante que
  o cookie foi aceito — a Enhanced Tracking Protection pode rejeitá-lo ou
  particioná-lo (Total Cookie Protection). O plugin mede o que a página
  *tentou* gravar.
- **Storage HTML5 por duas técnicas complementares:**
  - *hooks* em `Storage.prototype.setItem/removeItem/clear` e em
    `IDBFactory.open` / `IDBObjectStore.put/add` registram as escritas feitas
    durante o carregamento;
  - *snapshot* do `localStorage`, `sessionStorage` e `indexedDB.databases()` de
    cada frame (no `load`, +3 s, +10 s e ao abrir o popup) captura o estado final,
    inclusive escritas por atribuição direta (`localStorage.x = 1`), que não
    passam por `setItem`.
- **Storage de terceiros:** cada iframe tem o storage da própria origem. Uma
  origem é de 3ª parte quando seu site difere do site da aba. No Firefox, esse
  storage é **particionado** pela Total Cookie Protection (chaveado pelo site do
  topo), então não é compartilhado entre sites diferentes — relevante para
  interpretar a página *Storage partitioning* do DDG.
- **Canvas fingerprint:** hooks em `fillText`/`strokeText` registram o texto e
  as cores desenhadas em cada canvas; `toDataURL`, `toBlob` e `getImageData`
  disparam a avaliação. Segue o critério de Englehardt & Narayanan (2016):
  canvas ≥ 16×16 px, texto com ≥ 10 caracteres distintos ou ≥ 2 cores, e
  extração da imagem. O script responsável é identificado pela pilha de
  chamadas (`new Error().stack` no mundo da página).
- **Bounce tracking:** o background guarda as últimas páginas de cada aba. Uma
  página intermediária é um "salto" quando foi deixada por redirecionamento HTTP
  30x (mesmo `requestId`), por redirecionamento de cliente sinalizado em
  `webNavigation` (`client_redirect`) ou sem interação do usuário em menos de
  10 s. É *bounce tracking* quando o salto é de site diferente da origem e
  gravou/leu cookie ou storage, ou repassou um ID na URL do destino. Eventos que
  a página de salto envia depois de já ter redirecionado são atribuídos a ela
  pela URL exata do documento.
- **Cookie sync:** todo valor de cookie visto (`Set-Cookie`, `document.cookie`
  e cabeçalho `Cookie` enviado) com cara de identificador entra num índice
  valor → site. Cada URL de requisição é procurada nesse índice; um ID de outro
  site na URL de um terceiro é *cookie sync* (ou "ID de 1ª parte → terceiro",
  como o client id do `_ga` enviado ao Google Analytics). Redirecionamentos de
  sub-recursos entre dois terceiros também são listados, pois são o mecanismo de
  sync mesmo quando o ID vai cifrado. Timestamps (10–13 dígitos) são ignorados
  para evitar falsos positivos.
- **Parâmetros de rastreamento:** `utm_*`, `gclid`, `fbclid`, `msclkid`, `_gl`
  e outros na URL da página (link decoration) e nas requisições a terceiros.
- **Hooks e compartimentos do Firefox:** o método original é chamado com
  `orig.call(this, ...args)`, nunca `orig.apply(this, args)`. O array `args`
  pertence ao compartimento do content script e o código da página não pode
  ler suas propriedades (`Permission denied to access property "length"`),
  o que quebrava `setItem`, `getImageData` etc. na própria página.

## Uma Curiosidade

Eu uso o zen browser como navegador principal, diferente de outros navegadores que a base são chromium o zen tem como base o firefox e as extensões também funcionaram para ele.
