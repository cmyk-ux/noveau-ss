# Plugin de DAW

Manda a saída da DAW para a sala **sem compressão**, como o Listento do Audiomovers. Resolve o caso
de quem usa ASIO: o som da DAW não passa pelo mixer do Windows, então compartilhar a tela não pega.

## Como funciona

```
DAW ─ plugin (VST3/AU) ──wss──▶ servidor (/api/daw/send) ──wss──▶ site de quem está na sala (/api/daw/listen)
```

- **Pareamento**: no site, a tecla de faders na barra de baixo gera um código de 8 letras (vale 10 min,
  uma vez). O plugin troca o código por uma chave que guarda no projeto e reconecta sozinho por 24 h.
- **Áudio**: blocos de 10 ms, cabeçalho de 16 bytes + PCM (16/24-bit inteiro ou 32-bit float), na taxa
  do projeto (44,1 a 192 kHz). Formato em `plugin/Source/Packet.h` e `server/daw.mjs`.
- **Quem ouve** toca pelo mesmo player do modo estúdio, na taxa original (sem reamostrar no caminho),
  com o atraso ajustável (100 ms a 1 s). O plugin toca sempre, independente da tela em foco.
- **Rede ruim**: o plugin descarta pacotes se mais de 0,5 s ficar parado na fila (nunca acumula atraso);
  o servidor pula pacotes só para o ouvinte que não está dando conta; o site completa com silêncio.

Banda por plugin (upload de quem toca, uma vez só, não importa quantos ouvem):

| formato | 44,1 kHz | 48 kHz | 96 kHz |
|---|---|---|---|
| 16-bit | 1,4 Mbps | 1,5 Mbps | 3,1 Mbps |
| 24-bit | 2,1 Mbps | 2,3 Mbps | 4,6 Mbps |
| 32-bit float | 2,8 Mbps | 3,1 Mbps | 6,1 Mbps |

O servidor repassa isso para cada ouvinte (download dele). CPU do servidor é quase zero.

## Baixar e instalar

Cada push que mexe em `plugin/` roda `.github/workflows/plugin.yml`: compila Windows (VST3 + .exe)
e macOS (VST3 + AU + .app, Intel e Apple Silicon) e roda o teste de ponta a ponta. Os zips ficam em
**Actions > Plugin de DAW > Artifacts**. Para publicar uma versão (o link do site aponta para os
Releases):

```sh
git tag plugin-v0.1.0 && git push origin plugin-v0.1.0
```

Instruções para o usuário final: `plugin/LEIA-ME.txt` (vai dentro do zip).

## Compilar no PC

```sh
cmake -S plugin -B plugin/build
cmake --build plugin/build --config Release
```

Windows precisa do Visual Studio 2022 (C++). O CMake baixa JUCE 9, IXWebSocket e mbedTLS sozinho.

Teste sem DAW (Linux/macOS): `cmake -S plugin -B build -DNOVEAU_TESTS=ON`, compile `stream_test` e
`packet_test` e rode `node plugin/Tests/e2e.mjs build/stream_test_artefacts/Release/stream_test build/packet_test`.

## Servidor

Nada a configurar: os WebSockets passam pelo Caddy como o resto do site. Se o Caddyfile do chie tiver
algo diferente de `reverse_proxy` para a API (ex.: limite de tempo), conferir que `/api/daw/*` fica
aberto por horas.

## Licença

O plugin usa JUCE sob AGPLv3 (o repositório é público, então está ok). Se um dia o código fechar, a JUCE
tem licença comercial. VST3 é MIT desde a versão 3.8 do SDK (out/2025).

## Limites conhecidos

- Pro Tools (AAX): compilado (o SDK vem na JUCE, GPLv3), mas **sem assinatura** só abre no Pro Tools
  Developer. Para o Pro Tools comum: criar conta em developer.avid.com/aax, pedir as ferramentas de
  assinatura (e-mail para audiosdk@avid.com, assunto "PACE Eden Signing Tools Request", com descrição
  do plugin e um vídeo), ter uma conta iLok, e então assinar com o `wraptool` da PACE.
- VST2 (o "VST" antigo): a Steinberg não dá mais licença do SDK do VST2 para quem não tinha contrato
  até 2018, e o SDK MIT de 2025 é só do VST3. Toda DAW atual abre VST3.
- CLAP não está incluso (VST3 cobre Bitwig e Reaper). Dá para adicionar com `clap-juce-extensions`.
- O plugin só manda; ouvir a sala de volta dentro da DAW seria um segundo plugin.
- O macOS é assinado "ad hoc": na primeira vez precisa do `xattr` do LEIA-ME.
