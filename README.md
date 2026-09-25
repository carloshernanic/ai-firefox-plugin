# Privacy Inspector — extensão Firefox

Avaliação Intermediária de Cibersegurança (Insper). Extensão para detectar e
apresentar rastreamento e violações de privacidade no cliente web.

## Funcionalidades

| Funcionalidade | Status |
|---|---|
| Conexões a domínios de terceira parte (com classificação de rastreadores do Firefox) | ✅ |
| Cookies: contagem, 1ª/3ª parte, sessão/persistente | ⏳ |
| Armazenamento HTML5 (localStorage, sessionStorage, IndexedDB) | ⏳ |
| Canvas fingerprint | ⏳ |
| Cookie sync / bounce tracking | ⏳ |
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
  lib/domain.js      Cálculo de site (eTLD+1) e classificação 1ª/3ª parte
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
