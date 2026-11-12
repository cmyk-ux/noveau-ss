# Arquitetura e regras para o app não pesar

Revisão completa de 11/11/2026. Cada recurso novo (conversa direta, celular, OBS, clipes, plugin de DAW,
diagnóstico) tinha entrado com o seu próprio relógio, a sua própria leitura de estatísticas e o seu
próprio jeito de reagir à sala. Somados, eles se atropelavam: um "fulano começou a falar" fazia cada
pessoa redesenhar a sala inteira e mandar mensagens ao servidor do LiveKit pedindo de novo as telas que
já estava recebendo. Este documento descreve a base que ficou e as regras para ela continuar leve.

## O caminho do estado (um só)

```
LiveKit (Room) ──eventos──► RoomSession ──RoomSnapshot──► RoomStore (signals) ──► telas (Angular)
                              │  core/room-session.ts        core/room-store.ts      ui/*.ts
                              │
                              ├─ settle(): foco, o que baixar e em que qualidade, volumes, atributo "watching"
                              └─ describe(): o que aparece (pessoas, telas, quem assiste, conversa direta)
```

- **Só a `RoomSession` fala com o `Room` do LiveKit.** A interface nunca lê o `Room` direto para
  saber o estado; ela lê os signals do `RoomStore`. (Exceções contidas: cursores e som de estúdio, que
  usam o canal de dados e têm o seu próprio estado.)
- **Um estado por instante.** Os eventos do LiveKit chegam em rajadas (entrar alguém dispara 4-6
  eventos seguidos). Cada evento só marca `update('full')` ou `update('view')`; o estado é montado
  uma vez, no fim do instante (microtask).
  - `'full'`: refaz tudo (foco, inscrições, volumes, atributos). Para entrar/sair, publicar, atributos.
  - `'view'`: só o que aparece. Para o que muda muito e não mexe em mais nada: quem está falando,
    volume, proteção contra travadas.
  - Cuidado: o `'view'` reaproveita as telas (`this.live`) montadas no último `'full'`. Tudo o que um
    `'view'` deve mostrar diferente (volume, escondida, proteção) tem de ser lido de novo em
    `describe()`, não guardado no `ShareView` de `collectShares()`. O volume da tela ficava parado ali
    e o botão de mutar a tela não mudava (o segundo clique desfazia o primeiro sem aparecer).
- **O que não mudou continua sendo o mesmo objeto** (`core/same.ts`). Quando alguém começa a falar, só
  o `PersonView` dessa pessoa é novo; a lista de telas, os nomes, quem assiste, tudo continua igual
  (`===`), então nenhum `computed` nem nenhuma tela que dependa disso roda de novo. Se nada mudou,
  ninguém é avisado.
- Os `computed` de lista no `RoomStore` usam `{ equal: sameItems }`; mapas derivados (nomes, fotos)
  usam `{ equal: same }`.

## Regras

1. **Nada de relógio para descobrir o que mudou na sala.** Se uma tela precisa reagir a algo da sala e
   esse algo não está no estado, ponha no `RoomSnapshot`. Exemplos: `ShareView.ready` (o vídeo chegou
   e dá para ligar no elemento) e `ShareView.senderTx` (o que quem transmite conta do envio). Antes o
   palco e a grade "tentavam de novo" a cada mudança da sala, e uma barra relia o atributo a cada
   segundo.
2. **Vídeo só liga no elemento quando `ready` for true.** Caiu (`ready` false), solta e espera.
3. **Chamadas do LiveKit que mandam mensagem para o servidor só quando algo muda de verdade.**
   - `setSubscribed()` manda uma mensagem toda vez, mesmo sem mudar nada: só chame se `!pub.isDesired`.
     (`setEnabled` e `setVideoQuality` já ignoram valor repetido.) Era a principal mensagem que cada
     pessoa mandava ao servidor: ~2,5 por segundo por pessoa, uma a cada troca de quem fala.
   - `setVolume()` de áudio: só quando o nível muda (`tuned` em `room-session.ts`).
   - `setAttributes()` vai para a sala inteira e faz todo mundo refazer o estado. Valores em degraus
     (ex.: perda em 0; 0,5; 1; 2; 3; 5; 10; 20%) e no máximo uma escrita a cada 5 s (`tx`).
   - `publishData()` sem `destinationIdentities` vai para a sala inteira. Mande só para quem precisa
     (os cursores vão só para quem está com a mesma tela em foco).
4. **Uma leitura de estatísticas por lado.**
   - Quem transmite: `StatsFeed` (`core/stats.ts`) lê o `getStats()` da tela uma vez a cada 2 s e
     entrega a mesma leitura para a saúde do envio (`ShareWatch`), a perda na subida (`UploadGuard`) e o
     vigia do codificador (`CodecGuard`). Vigia novo: `feed.add(...)`, nunca outro `setInterval` com
     `getStats()`.
   - Quem assiste: `RoomSession.readFocused()` lê a tela em foco a cada 2 s, usa para a proteção contra
     travadas e entrega em `onFocusedStats` (o diagnóstico recebe por aí).
   - O painel de números ao vivo (`stats-panel`) só lê enquanto está aberto.
5. **Relógio de tela em componente próprio** (`ui/ticking.ts`: `cen-timecode`, `cen-countdown`). Um
   componente grande que lê um relógio é conferido inteiro a cada tique.
6. **Nada de `transition` em algo que muda várias vezes por segundo.** Medido: a transição de 120 ms
   do contorno de "falando" fazia o painel de pessoas ser redesenhado por vários quadros a cada troca
   e custava ~40% de todo o trabalho da página com o painel aberto. LED acende na hora.
7. **Template sem busca por linha.** Nada de `participants().find(...)` dentro de `@for`; use os mapas
   do store (`store.names()`, `store.avatars()`).
8. **Pergunta ao servidor que não tem como dar certo, para.** A lista da call do Discord para de ser
   pedida quando o servidor diz que o Discord está desligado (404) ou que não tem login (401), e não é
   pedida com a aba escondida.
9. **Timer que só faz sentido com algo ligado, só existe enquanto esse algo existe** (ex.: a varredura
   do som de estúdio só roda enquanto tem player tocando).
10. **Recursos que mexem na mesma coisa precisam saber um do outro.** Casos que estavam colidindo e
    foram acertados:
    - Som de estúdio de uma tela escondida continuava tocando (o som normal já parava). Agora segue a
      mesma regra: escondida não toca.
    - O "Parar de compartilhar" do navegador não desligava o modo estúdio: o LiveKit ouve o mesmo
      `ended` da faixa antes de nós e já tirou a publicação, então o nosso teste "a publicação ainda é
      esta?" nunca passava e o PCM (silêncio) seguia indo para sempre, com o selo "estúdio 24-bit"
      aceso em quem assistia. Agora o envio para sozinho quando a faixa acaba, manda um pacote de
      0 frames ("acabou"), e quem recebe fecha o player quando a tela sai e ignora PCM de quem não
      tem tela publicada. Para qualquer coisa presa à tela: confira o `ended` sem exigir a publicação.
    - Depois que o vigia do codificador trocava de codec, a proteção de perda na subida continuava
      contando do teto do codec antigo. Agora recomeça do teto novo (`UploadGuard.retarget`).
11. **Ação que demora (ligar microfone, mudar a voz, republicar) vai numa fila.** Ligar o microfone cria a
    trilha, carrega a redução de ruído e publica; um segundo clique nesse meio-tempo corria junto e o
    microfone ficava ligado (ou publicado duas vezes). `RoomSession.setMicrophone`/`setVoice`/
    `followRoomAudio` passam por `serial()` (`micQueue`), e o `RoomStore` inverte o que o último clique
    pediu, não o que a sala mostra.
12. **Mudo não é 0.** O LiveKit refaz o nó de ganho (ou o elemento) de cada faixa (ao "Ativar áudio", ao
    trocar o elemento) e só reaplica o volume guardado se ele não for 0. Com 0, quem estava mutado (ou
    escondido, fora de foco, na conversa direta) voltava a tocar em 100%. `tune()` usa `SILENT_GAIN`
    (-100 dB). Testes que precisam ler a sala usam `window.__noveau` (só com `noveau:e2e=1`).
13. **Tela: captura no tamanho original, resolução no codificador.** Nunca ponha `width`/`height`
    menores em `getDisplayMedia` nem em `applyConstraints` da tela: o Chrome converte a tela inteira e
    depois reduz, na thread de captura que ele limita a meio núcleo, e o FPS cai. O teto escolhido e a
    redução do "Ceder se o PC apertar" vão em `scaleResolutionDownBy` (`EncoderScale` em `share.ts`).
    Os quadros por segundo podem cair na captura (`frameRate`).
14. **H.264 só nos perfis que vão para a placa.** `installH264Preference()` (`core/h264.ts`) tira o
    `42e01f` da oferta de toda faixa de vídeo que o site publica. Qualquer teste de capacidade de H.264
    pergunta pelo perfil (`h264ContentTypes()`), nunca só `video/H264`.
15. **Áudio fora do Web Audio sempre que der.** Cada passagem por um `AudioContext` soma um buffer de
    saída e uma fila entre relógios (~10-20 ms).
    - O microfone é tratado num Worker (`voice.worker.ts`), em quadros de 10 ms, entre um
      `MediaStreamTrackProcessor` e um `MediaStreamTrackGenerator`. O `AudioContext` que o LiveKit exige
      para aceitar o processador fica parado (`dormantContext()`).
    - A voz dos outros toca direto no elemento (`webAudioMix: false`). Só quem está acima de 100% passa
      por um `AudioContext` (`route()`), e só enquanto estiver. No iPhone/iPad fica tudo no Web Audio
      (lá o volume do elemento não muda por código).
    - O analisador do equalizador só existe com a aba aberta; os medidores do worker só são enviados com
      a janela da voz aberta (`meterVoice`).
16. **Ajuste que vale para a sala inteira vai nos metadados da sala, pelo servidor.** A qualidade de áudio
    da sala (`metadata.audio`) é escrita pela API (`/api/room/audio`, uma vez a cada 2 s por sala) e chega
    a todos em `RoomMetadataChanged` → `update('full')`. Não use atributo de participante para isso.
17. **Opus com quadro próprio por trilha.** `wantPtime(track, ms)` marca a trilha; a resposta do servidor
    ganha `a=ptime` só na seção dela. Trilha nova do microfone (republicar, IA forte entrando) tem de ser
    marcada de novo.
18. **Som novo nasce no volume certo.** Toda faixa de som que chega guarda o volume (`setVolume`) antes
    do `attach()`: o elemento já nasce nele, e quem está mutado não toca nem um instante (o elemento vai
    até 100%; acima disso `route()` passa pelo Web Audio). Onde existe ganho do Web Audio (iPhone, ou
    acima de 100%), o LiveKit cria o ganho em 100% e desce numa rampa de ~0,5 s: `snapGain()` põe no
    valor na hora (também depois de `startAudio()`, em `unlockAudio`), e `rampGain()` troca a rampa por
    uma curta (15 ms no mudo, 60 ms no fader). O mixer passa por todas as faixas de som de cada pessoa:
    numa republicação a nova chega antes da antiga sair.
19. **Reconectando não é desconectado.** `SignalReconnecting` (retomada: só o canal de controle caiu, a
    mídia segue) e `Reconnecting` viram `'reconnecting'`; só `Disconnected` limpa o palco. Estado que o
    servidor guarda (atributos, permissões de faixa) não é zerado do nosso lado durante a queda; na
    volta (`RoomEvent.Reconnected`) reenvia o que pode ter se perdido (`DirectTalk.reconnected()`,
    `hwdec`). Testes: `simulateScenario('signal-reconnect' | 'full-reconnect')` na parte `queda-sinal`.
20. **O foco não é roubado.** Quem assiste uma tela continua nela quando chega outra tela ou câmera
    (`focusOnArrival`); aparece um aviso com "ver" (`onShareArrived`). Só uma câmera em foco automático
    dá lugar à grade. Voltar a ver uma tela escondida volta para a grade se o foco era automático.
21. **Fps baixo em jogo tem nome.** Quando a captura do navegador entrega menos que o pedido (jogo usando a
    placa de vídeo inteira; o Chrome espera a cópia de cada quadro e dobra o intervalo entre capturas),
    quem transmite e quem assiste veem "captura em ~N de M fps" com o motivo e o que fazer
    (`CaptureShortfall` em `core/stats.ts`, `captureAdvice`/`CAPTURE_FIX` em `core/diag.ts`). Nada de
    baixar fps ou resolução "por precaução": o "Ceder" só age com o processador em `critical` (acima de
    ~90%); `serious` (75-90%) é o normal de um jogo. Números em `docs/DESEMPENHO.md`, "Quinta rodada".
    Teste: `tools/e2e/captura.mjs`.

## Atributos dos participantes

Atributos vão para todo mundo da sala. Antes de criar um, veja se já não existe e quantas vezes ele
vai mudar.

| Atributo | Quem escreve | Quando muda |
| --- | --- | --- |
| `watching` | cada pessoa (`room-session.ts`) | troca de foco/grade |
| `tx` | quem transmite (`room-store.ts` → `publishSendHealth`) | perda/teto mudam de faixa, CPU entra ou sai de `serious`/`critical`, captura curta começa/acaba ou muda de degrau (`cf`/`wf`, de 5 em 5 fps); no máximo 1 a cada 5 s |
| `act` | quem transmite (`activity.ts`) | começa/para de transmitir, troca de janela |
| `hwdec` | cada pessoa, ao entrar | ao entrar e ao voltar de uma queda |
| `direct` | cada pessoa (`direct.ts`) | conversa direta começa/acaba |
| `discordId`, `avatar`, `guest`, `invitedBy`, `device` | servidor, no token | nunca |
| `phoneOf`, `phoneOfDiscord`, `ctl` | servidor (`phone.mjs`) | celular liga/desliga câmera ou microfone |
| `obs`, `obsName`, `obsOf` | servidor (`obs.mjs`), no token | nunca |

## Servidor (VPS de 1 núcleo e ~1 GB, dividida com outros serviços)

- **Site compilado:** lido uma vez na partida (`indexStatic` em `server/server.mjs`). Arquivos com hash
  no nome vão com `cache-control: immutable` por 1 ano; o resto com ETag e `304`. O build grava
  versões `.br`/`.gz` ao lado de cada arquivo (`web/scripts/precompress.mjs`), e o servidor manda a
  pronta; o Caddy não comprime de novo o que já chega com `Content-Encoding`. Antes cada visita baixava
  ~800 kB e o Caddy comprimia tudo no processador da VPS.
- **Memória do Node:** `--optimize-for-size --max-semi-space-size=2` no `CMD` do Dockerfile. Medido com
  o Discord ligado: 118 MB → 87 MB.
- **Status "ao vivo" do Discord:** a cada 5 s, uma consulta `ListRooms` diz quais calls têm alguém no
  site; só essas consultam quem está transmitindo.

## Como medir e testar

Precisa do `livekit-server --dev --bind 127.0.0.1 --node-ip 127.0.0.1`, da API servindo o site compilado
(`STATIC_DIR=web/dist/noveau-ss/browser node server/server.mjs`, porta 3001 por padrão) e do Playwright
com o Chromium.

- `BASE=http://127.0.0.1:3001 node tools/e2e/flows.mjs`: 3 navegadores; tela, grade, foco, esconder,
  câmera junto da tela, reiniciar a tela, painel de pessoas, conversa direta, mutar a tela (o botão
  tem de mudar em até 1 s), voz mutada continua muda depois de "Ativar áudio", dois cliques rápidos
  no microfone, erros no console.
- `BASE=http://127.0.0.1:3001 node tools/e2e/controles.mjs`: clica em todos os controles da sala e
  confere o efeito de verdade (volume que chega no som, inscrição e camada no servidor, codec e tamanho que
  chegam, permissões da conversa direta), inclusive quedas de sinal e reconexão completa simuladas.
  Cada parte começa do mesmo ponto (`baseline`), então uma falha não derruba as outras. `ONLY=tela,volume`
  roda só essas partes; `SHOTS=pasta` guarda a tela de cada um quando uma parte quebra.
- `BASE=http://127.0.0.1:3001 node tools/e2e/voz-teste.mjs`: o microfone no worker, Opus a ~100
  pacotes/s, janela da voz, presets, IA forte entrando sem cortar a voz, troca da qualidade da sala,
  volume acima de 100% (`SHOTS=pasta` grava fotos da janela).
- `BASE=http://127.0.0.1:3001 node tools/e2e/latencia.mjs rotulo`: atraso da voz de A até B
  (`VOZ='{"denoise":"forte"}'` muda o tratamento). Veja `docs/VOZ.md`.
- `BASE=http://127.0.0.1:3001 node tools/e2e/qualidade.mjs [codec] [resolução] [segundos]`: o que a
  tela manda de verdade (codec e perfil do H.264, tamanho e fps de cada camada, quem codifica) e o que
  quem assiste recebe. A tela é sintética (2560x1440 a 60 fps).
- `BASE=http://127.0.0.1:3001 node tools/e2e/captura.mjs [partes]`: captura curta (aviso para quem
  transmite e para quem assiste, registro no servidor), captura cheia, vídeo de 30 fps e tela parada sem
  aviso, e o "Ceder" com o processador simulado pelo DevTools (`serious` não mexe, `critical` desce, volta).
- `BASE=http://127.0.0.1:3001 PANEL=1 node tools/e2e/measure.mjs rotulo`: custo por segundo em cada
  navegador (JavaScript, trabalho total, recálculo de estilo, mensagens de sinalização por tipo).
  `CAM=1` faz B ligar a câmera (grade com 2 telas).

Os números desta revisão estão em `docs/DESEMPENHO.md` ("Terceira rodada").
