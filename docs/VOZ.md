# Voz: equalizador, redução de ruído, eco e atraso

Tudo da voz fica na janela **"sua voz"** (menu do microfone na barra de baixo → "Equalizador, ruído, eco e
sala"). Três abas:

- **equalizador**: gráfico estilo Pro-Q 3 (analisador do microfone cru e do que vai para a sala, pontos que
  se arrastam, até 8 bandas: sino, prateleira de grave/agudo, corte de grave/agudo de 6/12/24/48 dB por
  oitava, notch), **solo de banda**, **EQ dinâmico** por banda, 9 presets prontos e presets salvos pela
  pessoa, ganho final.
- **ruído e eco**: redução de ruído (desligada, do navegador, IA leve, IA forte) com **intensidade** de
  3 dB até a máxima, portão (automático pela IA ou com limiar manual), cancelamento de eco (desligado,
  som do site, tudo do PC), ganho automático.
- **sala e atraso**: qualidade de áudio da sala (vale para todo mundo) e a conta do atraso da voz, ao
  vivo.

O botão **me ouvir** (fone) é o teste do microfone. Fica ao lado do X, no menu do microfone e no topo da
janela da voz (vale em qualquer aba). Toca para você a sua voz já tratada, como ela sai para a sala. Use
fone (na caixa de som vira microfonia). Enquanto testa (`RoomSession.selfTest`):

- **a sala não te ouve**: o worker manda silêncio no mesmo ritmo (`hold`); sem worker, o envio fica sem
  trilha (`replaceTrack(null)`). Ninguém precisa ouvir você se testando;
- **você não ouve a sala**: vozes e som das telas ficam mudos só para você (`levelOf` devolve o mudo);
- **o cancelamento de eco do navegador desliga.** Era a voz "travando": o AEC3 usa como referência o que
  o navegador toca (com "eco do PC inteiro", tudo que o PC toca), e a escuta toca a sua própria voz uns
  50 ms depois. Ele entende a voz no microfone como eco da escuta e apaga pedaços dela. Com a sala muda
  para você não sobra eco para cancelar. O Chrome ignora `applyConstraints({ echoCancellation })` numa
  trilha viva (resolve sem mudar nada, medido no Chromium 153), então a captura reabre (`restartTrack`),
  sem republicar. O ganho automático do navegador recomeça junto e leva uns segundos para assentar.

Ao parar, nessa ordem: o eco volta, a voz volta para a sala, os outros voltam a tocar. O teste para sozinho
ao fechar o menu do microfone e a janela da voz, ao desligar o microfone, ao cair da sala ou quando a
sala troca a qualidade de áudio (o microfone é republicado). O solo de banda usa o mesmo teste.

Os ajustes valem no quadro seguinte (10 ms), sem republicar o microfone. Ficam no navegador
(`noveau:voz2`; os presets em `noveau:eq-presets`). O modo antigo (`noveau:voice`) é convertido.

## Equalizador estilo Pro-Q 3

Lido do manual do FabFilter Pro-Q 3 e trazido o que faz sentido para voz numa chamada:

- **Mouse**: clique num lugar vazio põe uma banda e já arrasta (na ponta esquerda, abaixo de 40 Hz, vira
  corte de grave; na direita, acima de 14 kHz, corte de agudo). O arrasto é relativo: Shift deixa fino sem
  pular. Roda: largura (Q), ou inclinação nos cortes. Ctrl + roda: ganho. Alt + roda: alcance dinâmico.
  Alt + clique: liga/desliga a banda. Clique duplo no ponto: vai para os números. Clique direito: apaga.
  Passando o mouse aparece a frequência, a **nota musical** (com cents) e o dB.
- **Solo de banda** (segurar o fone da banda, como o Pro-Q): você ouve só a faixa da banda. Num sino é
  um passa-faixa com a largura dela; numa prateleira ou corte, a parte que ela mexe (o que o corte de
  grave tira, por exemplo). Arrastando o fone para os lados a banda anda (40 px por oitava; Shift: 5x mais
  fino), para caçar o zumbido ou o S que arde. **Só você ouve**: o solo sai numa terceira trilha do worker
  (a da escuta). Se o teste do microfone estava desligado, o solo liga (a sala recebe silêncio e você não
  ouve a sala enquanto segura) e, ao soltar, desliga de novo.
- **EQ dinâmico** (sino e prateleiras): limiar e alcance (±24 dB). Um detector com o mesmo passa-faixa
  do solo mede a faixa a cada 10 ms (ataque rápido, soltura ~80 ms); a banda começa a agir no limiar e
  chega ao alcance todo 10 dB acima. Alcance negativo abaixa (S ardido, estouro de P, grave que embola
  quando chega perto); positivo sobe. No gráfico: anel no ponto, tracejado até onde ela pode ir e um
  traço mostrando onde está agora; a curva branca é a real naquele instante. O preset "Menos chiado de
  S" agora é dinâmico (6,8 kHz, só age no S), e o "Perto do microfone" segura o grave dinamicamente.
- **Analisador**: pré (cru) e pós (sala) liga/desliga, **congelar** (segura o pico de cada frequência,
  bom para achar um zumbido), inclinação de 4,5 dB por oitava em volta de 1 kHz (como o Pro-Q: voz cai
  nos agudos e assim a imagem fica reta), escala ±3/6/12/30 dB (sobe sozinha se uma banda passar dela).

Medido no `voz-teste.mjs` (tom de 221 Hz do microfone falso): solo com a banda longe do tom -68 dB, em
cima do tom -19 dB; a sala ficou em -15 dB durante o solo (igual a antes); banda dinâmica a -9 dB em
cima do tom abaixou a saída de -15,4 para -21,1 dB.

Ficou de fora do Pro-Q: fase linear (soma atraso; numa chamada não vale), mid/side (o microfone é
mono), EQ Match e "spectrum grab" (pegar o pico do analisador direto).

## Atraso: de ~105 ms para ~52 ms com a IA ligada

`tools/e2e/latencia.mjs` mede do som entrando na trilha do microfone de A até o som decodificado saindo da
fila de chegada de B, passando pelo LiveKit (local). Não conta a captura nem a placa de som, iguais nas duas
versões. Mediana de 33 sílabas por rodada, Chromium 153, 12/11/2026:

| Versão | Rodadas (mediana, ms) |
| --- | --- |
| Antes, IA (RNNoise no AudioWorklet, quadros de 20 ms) | 118, 89, 104 |
| **Agora, IA leve** (worker, quadros de 10 ms) | **50, 55** |
| Agora, IA leve + equalizador | 53 |
| Antes, sem tratamento | 48 |
| Agora, sem tratamento | 42 |
| Agora, IA forte (DeepFilterNet 3) | 100, 105 |

De onde saiu o tempo:

1. **Sem AudioContext no caminho.** Antes: microfone → AudioContext → AudioWorklet (blocos de 128) →
   RNNoise (quadros de 480, com fila para casar os dois) → MediaStreamDestination → WebRTC. Cada
   passagem pelo relógio do Web Audio soma um buffer. Agora: `MediaStreamTrackProcessor` →
   **Worker** (quadros de 10 ms, do jeito que o WebRTC já entrega) → `MediaStreamTrackGenerator`. O
   tratamento soma só o que o algoritmo precisa: 0 ms (equalizador, portão), 10 ms (RNNoise), 30 ms
   (DeepFilterNet; medido offline com correlação: 1440 amostras).
2. **Opus em quadros de 10 ms** (modo "Instantâneo", padrão). O Chrome escolhe o tamanho do quadro pelo
   `a=ptime` da resposta do servidor; o LiveKit não manda, então o site acrescenta `a=ptime:10` só na
   seção do microfone (`withPtime` em `voice.ts`). Conferido: 50 → ~100 pacotes/s falando.
3. **A voz dos outros toca direto no elemento de áudio** (`webAudioMix: false`). Antes cada voz passava
   pelo AudioContext do LiveKit. Quem está acima de 100% de volume passa por um AudioContext só dela
   (`route()` em `room-session.ts`); no iPhone/iPad o volume do elemento não muda por código, então lá
   continua tudo no Web Audio.

O resto do atraso é rede e a fila de chegada (jitter buffer, ~20-40 ms aqui), que o WebRTC ajusta sozinho
à rede. Bluetooth soma 100-200 ms; fone com fio é o que muda o jogo.

## Redução de ruído com intensidade

"Parece muito mascarada": com a IA no máximo, o fundo some e volta entre as palavras e a voz perde corpo.
A intensidade é um **limite de quanto o ruído pode descer** (o `atten_lim` do DeepFilterNet; no RNNoise,
a voz tratada mais o som original, alinhado, por baixo: `y = (1-k)·limpo + k·original`, `k = 10^(-dB/20)`).

Medido com voz real e ruído na mesma altura (amostras em `noveau-voz/intensidade/` nos arquivos do projeto):

| | voz (p90) | fundo (p10) |
| --- | --- | --- |
| original | -19,4 dB | -40,4 dB |
| IA leve, 12 dB | -19,7 | -51,2 |
| IA leve, 24 dB (padrão) | -19,7 | -60,5 |
| IA leve, máxima | -19,8 | -78,7 |
| IA forte, 24 dB | -20,0 | -60,4 |
| IA forte, máxima | -20,0 | -78,9 |

A voz não perde volume (menos de 0,6 dB); o fundo desce o que foi pedido.

- **IA leve: RNNoise** (xiph, BSD; wasm do `@sapphi-red/web-noise-suppressor`, MIT). 10 ms, ~2-3% de um
  núcleo. Bom para ruído constante (ventilador, ar, chiado).
- **IA forte: DeepFilterNet 3** (Rikorose, MIT/Apache-2.0). Melhor com teclado, mastigação, cachorro;
  30 ms, ~15% de um núcleo no sandbox (lento). O wasm (libDF compilado do código-fonte) vem do
  `@workadventure/noise-suppression` 0.2.0 (MIT): `web/scripts/vendor-dfn.mjs` baixa o pacote com
  `npm pack`, confere o hash publicado no npm e tira só os dois arquivos (14 MB de wasm, 2,4 MB em Brotli,
  e 8 MB de modelo), que o site só baixa quando alguém escolhe a IA forte. Montar o modelo trava o
  worker ~0,3-1 s, então ela carrega num **segundo worker** enquanto o primeiro segue com a IA leve; pronta,
  a saída troca de trilha no envio (`replaceTrack`, sem renegociar). Se o PC não der conta (mais de
  50% de um núcleo por 2 s), volta para a leve e avisa.
- **Do navegador**: o filtro clássico do WebRTC (e o isolamento de voz do sistema, onde existe).

## Eco: sim, e agora dá para escolher

A redução de ruído não cancela eco (nenhuma IA de ruído faz isso). O eco é do **navegador** (AEC3 do
WebRTC), porque só ele sabe o que está saindo na caixa de som:

- **som do site** (padrão): tira do microfone as vozes e telas da sala.
- **tudo do PC**: Chrome/Edge 141+ no Windows e no macOS usam como referência tudo o que o PC toca
  (jogo, Spotify, Discord) (`echoCancellation: 'all'`). No Linux o navegador volta sozinho para "som do
  site"; a janela avisa quando o navegador não oferece (`getCapabilities()`).
- **desligado**: para fone fechado e microfone bom (a voz não passa pelo cancelador).

## Portão

Corta tudo entre as falas. Automático: abre com a chance de voz do RNNoise (que olha o quadro 10 ms antes
de ele sair, então o começo da palavra não é comido). Manual: limiar em dB, com o nível ao vivo. Fecha
devagar depois de 300 ms sem voz.

## Qualidade de áudio da sala

Fica nos metadados da sala (`POST /api/room/audio`, só para quem tem token da sala, uma troca a cada 2 s):
todo mundo republica o microfone com o Opus novo e aparece um aviso de quem trocou.

| Modo | Quadro | Taxa | Corte de silêncio |
| --- | --- | --- | --- |
| Instantâneo (padrão) | 10 ms | 128 kbps | sim |
| Música | 20 ms | 256 kbps | não (o corte come a cauda das notas) |
| Economia | 20 ms | 48 kbps | sim |

Todos com RED (cada pacote vai de novo junto do próximo; perda isolada vira nada).

## Código

- `web/src/app/core/voice-dsp.ts`: tipos, presets, biquads (RBJ cookbook), resposta do equalizador,
  conta do atraso, saneamento do que vem do `localStorage`.
- `web/src/app/core/voice.worker.ts`: RNNoise, DeepFilterNet, reamostragem (se o microfone vier em
  outra taxa), portão, equalizador (DF2T), ganho, limitador, medidores.
- `web/src/app/core/voice.ts`: restrições da captura, `VoiceProcessor` (processador do LiveKit, com a
  troca de worker da IA forte), `wantPtime`/`withPtime`.
- `web/src/app/core/room-session.ts`: `publishMic`, `setVoice`, `followRoomAudio`, `voiceStats`,
  `route()`.
- `web/src/app/ui/voice-panel.ts`: a janela.
- Testes: `tools/e2e/voz-teste.mjs` (worker, 10 ms pela sala, janela, me ouvir, clique cria banda, solo
  só na escuta, EQ dinâmico, presets, IA forte sem cortar a
  voz, troca da qualidade da sala, volume acima de 100%), `tools/e2e/latencia.mjs` (atraso).

Firefox e Safari não têm `MediaStreamTrackProcessor` para áudio: lá vale só o filtro do navegador, e a
janela avisa.

## O que ficou de fora (e por quê)

- **Krisp** do LiveKit: só no LiveKit Cloud.
- **GTCRN**: trabalha a 16 kHz (a voz perde o que passa de 8 kHz).
- **Quadro de 2,5/5 ms no Opus**: o WebRTC do Chrome não aceita menos de 10 ms.
- **Cancelamento de eco próprio** (fora do navegador): precisaria do som que sai da caixa, que o site não
  tem; o "tudo do PC" do Chrome é o caminho.
