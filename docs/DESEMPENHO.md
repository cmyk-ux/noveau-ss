# O que pesa no PC de quem usa

Medições de 10/11/2026 no Chromium 153 sem placa de vídeo (tudo cai no processador). Uma tela
sintética de 2560x1440 a 60 fps. Os números são % de um núcleo de CPU para o navegador inteiro.
Contam as diferenças entre as linhas, não o valor absoluto.

| Situação | Antes | Depois |
| --- | --- | --- |
| Só a captura (base) | 38% | 38% |
| Ver a própria tela grande no palco (1600x900) | +59 | 0 (não vai mais para o palco) |
| Prévia da própria tela, aberta na barra de baixo (cópia 360p 15 fps) | | +5 |
| Clipe sempre gravando, tela de 1440p (canvas + H.264 1080p60) | +177 | +98 sem o canvas; 0 sem placa de vídeo |
| Clipe sempre gravando, tela de 1080p | +82 | igual com placa de vídeo; 0 sem placa |
| Laço do cursor (requestAnimationFrame sem cursores na tela) | +3 | 0 (dorme sem cursor) |
| 12 LEDs piscando (steps) | ~0 | ~0 |
| Chuvisco animado da prévia | +9 | 0 (chuvisco parado) |
| getStats (2 conexões) | 0,1 ms por chamada | igual |

## O que mudou

- **A sua própria tela não vai mais para o palco.** Quem transmite vê um cartão "Sua tela está no ar".
  A prévia fica numa tecla da barra de baixo, fechada até você pedir. Aberta, ela mostra uma cópia
  que o navegador já entrega em 360p a 15 fps.
- **"No ar" na barra de baixo.** As fotos de quem está com a tela aberta saíram do palco e foram para
  a barra. Passar o mouse mostra o nome e o que a pessoa está passando, sem vídeo. O vídeo ao vivo
  só liga no botão "prévia ao vivo".
- **Clipe mais leve:**
  - Sem canvas no meio quando só muda o tamanho, porque o próprio codificador reduz a imagem.
  - Grava só com o codificador da placa de vídeo. Antes, sem placa, codificava 1080p60 no processador.
  - É o primeiro a ceder. Com o processador "pesado" ou "no limite" (Compute Pressure), para de
    gravar vídeo e solta a placa. Volta depois de 15 s tranquilo.
- **Codec que todo mundo decodifica na placa.** Cada pessoa conta no atributo `hwdec` o que decodifica
  na placa de vídeo. No automático, quem transmite só usa AV1/H.265/VP9 se todos que estão na sala
  decodificam esse codec na placa. Senão usa o próximo da lista, normalmente H.264. Sem isso, AV1 em
  1440p60 era decodificado no processador de quem tem placa antiga e travava o PC dessa pessoa.
- **Cursor:** o laço de desenho só roda enquanto tem cursor de alguém na tela.

## O que ficou de fora (por enquanto)

Gravar o clipe com os bytes que já chegam prontos da rede, sem decodificar nem codificar de novo
(RTCRtpScriptTransform), deixaria o custo do clipe perto de zero. Não dá ainda: no Chrome, um transform
colocado depois que o vídeo começou não recebe quadros. Pior, tirar o transform depois *para* o vídeo.
A correção entrou no Chromium em 06/11/2026
([WPT #64860](https://github.com/web-platform-tests/wpt/pull/64860)). Ela ainda não está no Chrome das
pessoas, e o Chrome também não tem `generateKeyFrame` no transform. Dá para revisitar quando a correção
chegar ao Chrome estável.

## Segunda rodada (10/11/2026, noite): o FPS que cai "do nada"

Quem transmitia em 1080p com FPS alto passou a perder FPS de repente. A busca nas mudanças desde
então achou um caminho que bate com o "do nada":

- **A reserva do codec saía no processador, em resolução cheia.** Desde 09/11 o automático escolhia
  H.265 quando a placa codificava. Quando entra alguém que não decodifica H.265 (Firefox, iPhone,
  Linux, placa antiga), o LiveKit liga a reserva para a sala. A reserva era VP8, e nenhuma placa
  codifica VP8: o Chrome passa a codificar a tela inteira no processador de quem joga, no instante
  em que essa pessoa entra. Com AV1/VP9 e "compatibilidade máxima" (ligada por padrão) acontece o mesmo.
  - O H.265 foi para o fim da ordem do automático (AV1, H.264, VP9, H.265).
  - A reserva é H.264 quando a placa codifica H.264.
- **O que o navegador promete não é o que ele faz.** O Media Capabilities pode dizer "placa" e o
  Chrome codificar no processador: H.264 Constrained Baseline no Windows vai para o OpenH264, AV1 já
  saiu no libaom, e a placa pode falhar no meio. Agora um vigia (`codec-guard.ts`) lê a cada 2 s o
  `powerEfficientEncoder` e o `encoderImplementation` do getStats, no codec principal e na reserva.
  Três leituras seguidas (6 s) no processador e ele republica a mesma captura num codec que a placa
  codifica (até 2 trocas por transmissão), com um aviso na tela.
- **Câmera.** Era sempre VP8 1080p30 + 360p, no processador. Agora vai em H.264 quando a placa
  codifica H.264; sem placa, VP8 em 720p.
- **Clipe sob demanda.** Uma tecla de tesoura na barra de baixo liga e desliga. Desligado (o padrão),
  nada grava e nada fica na memória. Ligado, grava só as telas dos outros que você assiste. É de quem
  assiste: quem transmite não paga nada pelo clipe de ninguém.

## Terceira rodada (11/11/2026): revisão completa

Revisão de todos os fluxos para os recursos pararem de pesar e de se atropelar. As regras que saíram
dela estão em `docs/ARQUITETURA.md`.

Medição: LiveKit local, 3 navegadores Chromium sem placa de vídeo, 30 s. A transmite a tela, todos
com o microfone aberto num som que fala e para (o "falando" troca ~2 vezes por segundo), B e C
assistem. Média dos 3 navegadores, por segundo. "Sinal" é o que cada pessoa que assiste manda ao
servidor do LiveKit além do ping (0,4/s). Script e trabalho total são do processo da página.

| Situação | JavaScript (ms/s) | Trabalho total (ms/s) | Recálculo de estilo (/s) | Sinal de quem assiste (msg/s) |
| --- | --- | --- | --- | --- |
| Sala, painel de pessoas aberto | 2,7 → 1,8 | 20,3 → 9,7 | 11,4 → 2,7 | 1,9 → 0 |
| Grade com 2 telas (B com câmera), painel aberto | 4,0 → 2,4 | 26,4 → 13,6 | 9,8 → 3,0 | 2,2-4,4 → 0 |
| Sala, painel fechado | 2,4 → 1,3 | 9,8 → 6,3 | 0 → 0 | 2,3 → 0 |

Para rodar de novo: `tools/e2e/measure.mjs` (veja `docs/ARQUITETURA.md`).

O que pesava e o que mudou:

- **Cada troca de quem fala virava uma mensagem ao servidor por tela recebida.** A sala reaplicava,
  a cada evento, "quero receber esta tela" (`setSubscribed(true)`), e o livekit-client manda essa
  mensagem toda vez, mesmo sem mudar nada. Com 2 telas eram ~4,8 mensagens por segundo por pessoa,
  todas processadas pelo LiveKit na VPS. Agora só manda quando muda: zero.
- **Cada evento refazia a sala inteira.** Um "começou a falar" criava objetos novos para todas as
  pessoas e telas, e tudo o que dependia deles rodava de novo (grade, barra de baixo, clipes). Agora os
  eventos do mesmo instante viram uma atualização só, e o que não mudou continua sendo o mesmo objeto:
  só a linha de quem falou é redesenhada.
- **A transição do contorno de "falando"** (120 ms) redesenhava o painel por vários quadros a cada
  troca. Sozinha, custava ~40% do trabalho da página com o painel aberto. Agora acende na hora.
- **O contador de tempo da sala** fazia a tela da sala inteira ser conferida a cada segundo. Agora o
  relógio é um componente próprio.
- **getStats repetido.** Quem transmite lia as estatísticas da tela 3 vezes (saúde, perda na subida e
  codificador, cada um com o seu relógio); quem assiste lia 2 vezes (proteção contra travadas e
  diagnóstico). Agora é uma leitura a cada 2 s de cada lado, repartida.
- **Atributo `tx`** (como está o envio de quem transmite) era reescrito a cada mudança de 0,25% na
  perda, e cada escrita faz todo mundo da sala refazer o estado. Agora vai em faixas e no máximo a cada
  5 s.
- **Cursores** iam para a sala inteira, 30 vezes por segundo. Agora só para quem está com a mesma tela
  em foco (e nada, se ninguém está).
- **Lista da call do Discord** era pedida a cada 2 s com o painel aberto, mesmo com o Discord desligado
  no servidor (erro 404 a cada 2 s). Agora para quando não tem como dar certo e não pergunta com a aba
  escondida.
- **Varredura do som de estúdio** rodava 4 vezes por segundo mesmo sem som de estúdio na sala. Agora só
  existe enquanto tem algum tocando.

Servidor:

- **Site:** antes cada visita baixava o site inteiro de novo (~800 kB; `no-cache` sem ETag) e o Caddy
  comprimia tudo no processador da VPS. Agora os arquivos com hash ficam no navegador por 1 ano, o
  resto responde `304` quando não mudou, e o build já grava versões Brotli (1605 kB → 556 kB), que o
  servidor manda prontas.
- **Memória da API:** 118 MB → 87 MB (`--optimize-for-size --max-semi-space-size=2`).
- **Status "ao vivo" do Discord:** uma consulta `ListRooms` a cada 5 s em vez de uma `ListParticipants`
  por call com gente no Discord; só as calls com alguém no site perguntam quem está transmitindo.

Qualidade:

- **Som da tela: Opus 64 kbps → 192 kbps** (estéreo). 64 kbps em estéreo é 32 por canal, abaixo do que
  o Opus precisa para música; a Xiph considera 128 kbps em estéreo "praticamente transparente"
  ([Opus Recommended Settings](https://wiki.xiph.org/Opus_Recommended_Settings)). O modo estúdio (sem
  compressão) continua.

## Quarta rodada (12/11/2026): a qualidade da tela

Depois do PR #28 a tela passou a sair em VP8, com imagem ruim, FPS baixo e travadas no jogo. A causa
vinha de antes e ficou exposta quando o automático mudou de ordem.

- **O H.264 nunca ia para a placa de vídeo.** No Chrome (e no Brave e no Edge) do Windows e do Mac, só
  os perfis Baseline (`42001f`), Main (`4d001f`) e High (`6400xx`) vão para a placa. O "Constrained
  Baseline" (`42e01f`) vai sempre para o OpenH264, no processador, numa thread só
  (`kPlatformH264CbpEncoding` vem desligado). O LiveKit 1.13.11 responde com o `42e01f` primeiro
  (conferido rodando o servidor). E o teste do site perguntava "H.264 na placa?" sem perfil, o que o
  navegador lê como `42e01f`: a resposta era sempre não.
  - Consequência: num PC sem H.265 na placa, ou numa sala com alguém sem decodificador de H.265
    (Firefox, iPhone, Linux), a reserva da tela era VP8 por software em resolução cheia, e a sala
    inteira passava para ela.
  - Agora (`core/h264.ts`): ao criar a faixa de envio, o site diz ao navegador para oferecer só High e
    Baseline (`setCodecPreferences`). O LiveKit aceita os dois e o navegador codifica na placa (no
    getStats aparece `MediaFoundationVideoEncodeAccelerator` ou `D3D12VideoEncodeAccelerator`). O
    teste de capacidade pergunta pelo perfil que vai ser usado.
  - Quem assiste: o LiveKit entrega o vídeo no H.264 que cada um negociou, mesmo com outro perfil, e o
    decodificador lê o perfil do vídeo. O Firefox decodifica com o OpenH264, que aceita o "Constrained
    High" desde a 1.5 (o que os codificadores de chamada mandam, sem quadros B).
- **Ordem do automático:** AV1 da placa se todos na sala decodificam AV1 na placa (no Windows o Chrome
  não usa a placa para AV1 em chamada), senão **H.264 da placa**, senão H.265, VP9 ou AV1 da placa (com
  reserva H.264), e só sem placa nenhuma VP8. O H.264 da placa vai com a cópia menor para quem não
  aguenta e nunca obriga a sala a trocar de codec. H.265 continua no menu.
- **Captura sempre no tamanho original.** O Chrome captura numa thread que ele limita a meio núcleo:
  depois de cada quadro, espera o dobro do tempo que o quadro levou (`desktop_capture_device.cc`). Com
  um teto de resolução na captura (720p, 1080p, 1440p), essa thread converte a tela inteira e depois
  ainda reduz (`ARGBToI420` + `I420Scale`): mais trabalho por quadro, menos quadros por segundo,
  principalmente com o jogo disputando o processador. No tamanho original ela só entrega o quadro.
  Agora a captura pede só um teto de 7680x4320 e o tamanho escolhido é aplicado no codificador
  (`scaleResolutionDownBy`, `EncoderScale` em `share.ts`), também na reserva. O "Ceder se o PC apertar"
  baixa os quadros na captura e a resolução no codificador.

Medição (LiveKit local, Chromium sem placa, tela sintética 2560x1440 a 60 fps, `tools/e2e/qualidade.mjs`):

| Pedido | Captura | Saindo | Quem assiste recebe |
| --- | --- | --- | --- |
| H.264, 720p, 30 s | 2560x1440 | 1280x720 a 59 fps (escala 2) + 853x480 (escala 3), perfil `42001f` | 1280x720 a 56 fps em todas as leituras, 0 travadas |

Sem placa de vídeo o perfil fica Baseline (`42001f`): é o que o OpenH264 aceita. Com placa, o High
aparece na lista do navegador e vai primeiro.

## Quinta rodada (12/11/2026): jogo preso abaixo de 30 fps

Com qualquer jogo a tela não passava de ~30 fps (no print, 720p a 18 fps), mesmo com 60 ou 120 no menu
e o "Ceder quando o PC apertar" desligado. A área de trabalho ia a 60-120.

**Números de uma transmissão de verdade** (Vintin transmitindo, placa NVIDIA, "Números ao vivo"):
captura 47 de 120 fps, enviando 47, codificador `SimulcastEncoderAdapter` com dois
`MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)`, sem limitação, 0% de perda. Quem
assistia recebia 18 fps a 28 Mbps sem nenhum pacote perdido (outro momento, cena mais pesada). Ou seja:
o codificador da placa e a rede davam conta; quem segurava os quadros era a **captura**.

### Por que a captura do navegador cai com o jogo aberto (conferido no código do Chromium e do WebRTC)

- A captura de tela roda no processo do navegador, numa thread só (`desktopCaptureThread`,
  `content/browser/media/capture/desktop_capture_device.cc`). Depois de cada quadro ela agenda o próximo
  para `max(2 × duração da última captura, 1/fps pedido)` (`kDefaultMaximumCpuConsumptionPercentage =
  50`). A duração é tempo de relógio, inclusive a espera pela placa de vídeo.
- No Windows, a tela inteira usa o Desktop Duplication (DXGI); só no Windows 11 24H2 em diante a tela
  usa o Windows Graphics Capture (`IsWgcEnabledForScreenCapture`). Janela usa o WGC. Nos dois casos o
  quadro é copiado para uma textura que o processador lê e o código **espera a cópia terminar**
  (`DxgiTextureStaging::CopyFromTexture`: `CopyResource` + `Map`; `WgcCaptureSession::ProcessFrame`:
  `CopySubresourceRegion` + `Map` sem `DO_NOT_WAIT`). Depois ainda copia e converte (ARGB → I420) na
  mesma thread.
- Com o jogo usando a placa inteira (~99%), a cópia entra na fila atrás dos quadros do jogo e a espera
  cresce. Aí a regra de cima dobra: 27 ms de espera viram um quadro a cada ~55 ms, ~18 fps. Sem jogo a
  placa responde na hora e a mesma captura chega a 60-120.
- O Chrome não pede prioridade na placa de vídeo (não chama `D3DKMTSetProcessSchedulingPriorityClass`
  nem `SetGPUThreadPriority` fora de testes). O OBS só consegue isso rodando como administrador (fix do
  OBS 24.0.3), e o Looking Glass só como SYSTEM. A página que está capturando não é rebaixada pelo
  navegador (`FrameCapturingMediaStreamVoter` vota prioridade `kUserBlocking`), então não é isso.
- Existe no Chromium um caminho que deixa o quadro na placa (sem a espera do `Map`): `kWebRtcAllowWgcUsingTexture`
  ("Deliver texture from WGC desktop capturer", junho de 2026) e `kZeroCopyDesktopCapture`. Os dois vêm
  **desligados** e não aparecem em `chrome://flags`; só por linha de comando (`--enable-features=...`),
  e só para captura por WGC. Não testado aqui (precisa de Windows com placa).

Relatos de fora com o mesmo quadro: "quando o jogo usa 99-100% da placa a captura da área de trabalho
para, e volta assim que a carga cai um pouco ou o jogo perde o foco" (fórum de desenvolvedores da NVIDIA,
"GPU scheduling priority for DXGI/WGC capture under 100% GPU load", maio de 2026); OBS 24.0.3 ("fix
que pode aliviar problemas de fps causados por 95%+ de uso da placa", só como administrador); Looking
Glass (a captura DXGI "normalmente precisa de um limitador de quadros no jogo para sobrar tempo de placa").

### O que era do próprio site: o "Ceder" cortava para 30 fps em todo jogo

O "Ceder quando o PC apertar" vem ligado. Ele descia um degrau de fps a cada 6 s com o processador em
`serious`, e no Chrome `serious` é 75-90% do processador inteiro
(`services/device/public/cpp/compute_pressure/cpu_pressure_converter.cc`: 0,6 / 0,75 / 0,9), o normal de
qualquer jogo. Medido com o processador simulado pelo DevTools (`Emulation.setPressureStateOverride`,
`tools/e2e/captura.mjs ceder`): no `main`, 14 s de `serious` levaram a captura a **30 fps** (degrau 2);
nesta versão continua em 60.

### O que mudou

- **"Ceder" só no limite de verdade:** só desce com o processador em `critical` (acima de ~90%) por 5 s.
  Volta depois de 20 s fora do limite; se voltar ao limite logo depois de subir, a próxima subida espera
  o dobro (até 160 s), para não ficar indo e voltando.
- **O vigia do processador existe sempre** (com o "Ceder" desligado ele só lê). O uso vai para os
  números ao vivo e, só `serious`/`critical`, para o atributo `tx`.
- **Captura curta é dita, com o motivo e o que fazer** (`CaptureShortfall` em `core/stats.ts`): a captura
  entrega menos de 80% do pedido em todas as leituras de ~10 s, com a imagem mexendo (1,5 Mbps ou mais)
  e pelo menos 8 fps. Não acusa tela parada (poucos quadros) nem conteúdo que tem menos quadros mesmo
  (captura firme em 24, 25 ou 30: vídeo, jogo travado em 30).
  - Quem transmite: a tecla "prévia" mostra "20/60fps" em amarelo, com a explicação; um aviso uma vez
    por transmissão; o diário registra e manda ao servidor (`my-capture`, com tamanho, codec, se é na
    placa e o uso do processador), para a gente ver em que jogos e PCs acontece.
  - Quem assiste: na faixa de cima, "captura de fulano: ~20 de 60 fps", explicando que não é a internet
    nem o PC de quem assiste. As travadas nesse período vão para "PC de quem transmite".
  - Se a captura entrega e o codificador perde quadros, o aviso é do codificador (`lim: 'encoder'`).

Teste (`tools/e2e/captura.mjs`, fonte sintética 1280x720 muito mexida, 60 fps pedidos):

| Parte | Captura | Resultado |
| --- | --- | --- |
| curta | 18 fps | A vê "20/60fps", B vê "captura de A: ~20 de 60 fps", registro chega ao servidor |
| cheia | 60 fps | nada |
| video | 30 fps firmes | nada |
| parada | relógio mudando 2×/s (~2 fps) | nada |
| ceder | `serious` 14 s → `critical` → `fair` | 60 → 45 → volta a 60 em ~20 s |

### O que cada um pode fazer para ter fps cheio em jogo

1. **Limitar o FPS do jogo** um pouco abaixo do que ele roda hoje, para sobrar placa (no próprio jogo,
   "Taxa máxima de quadros" no painel da NVIDIA, "Frame Rate Target Control"/Chill no AMD, ou o RTSS).
   De preferência num múltiplo do fps da transmissão (120 para 60): a captura pega quadros num ritmo
   fixo, e um jogo a 144 com transmissão a 60 sai com quadros repetidos e pulados.
2. **OBS como administrador, com "Captura de jogo"**, transmitindo na sala pela tecla OBS (WHIP). O OBS
   copia o quadro dentro do próprio jogo e, como administrador, ganha prioridade na placa.
3. Quem assiste também pode ver menos quadros se estiver jogando no mesmo PC: há vários relatos de vídeo
   travando no segundo monitor com o jogo em janela sem borda, que somem com o jogo em tela cheia (fórum
   do Brave, "Video Playback Stuttering Dual Monitor"; Chromium 387478829). Sem aviso de captura curta
   na faixa de cima e com fps baixo, compare "Números ao vivo" dos dois lados.

## Sexta rodada (12/11/2026): tela saindo a 320x180 com 7 Mbps

Rhenan (H.264 na NVIDIA, 120 fps pedidos, "Ceder" desligado) mandava **320x180** com alvo de 7,3 Mbps e
"limitado por: bandwidth", 1 mudança de tamanho; quem assistia recebia 480x270 a ~200 kbps. Perda 0%.

- Não é a rede: o alvo do codificador para a camada era 7,3 Mbps (~2 bits por pixel por quadro a
  320x180; uma redução de verdade por banda fica em ~0,05-0,15).
- É o QualityScaler do WebRTC. Com `maintain-framerate` (o nosso) ele reduz a resolução em degraus de 3/5
  quando o QP passa do limiar (H.264: 24..37, `QualityScalingExperiment`, ligado por padrão fora do iOS),
  até o piso de 320x180. Só liga com uma camada ativa (`is_quality_scaling_allowed` em
  `webrtc_video_engine.cc`: um SSRC, ou o LiveKit pausando as outras). Para o codificador da placa
  (`RTCVideoEncoder`) o Chrome não dá limiar para H.264, então vale o do experimento se o QP for
  "confiável"; se não for, entra o `BandwidthQualityScaler`. Em stats, adaptação por qualidade aparece
  como "bandwidth" (`send_statistics_proxy.cc`).
- Correção: `ShrinkGuard` (regra 22). Trocar para `maintain-resolution` tira o limite de pixels na hora
  (`FilterRestrictionsByDegradationPreference` em `video_stream_adapter.cc`); faltando banda de verdade,
  aí ele corta quadros, e a cópia menor do simulcast e o vigia da subida continuam valendo.
- Aqui o OpenH264 não encolhe nem com 2 Mbps fixos, então o teste (`captura.mjs encolhe`) finge os
  números do Rhenan no getStats e confere o vigia, a troca no sender e o diário.
- O mesmo print mostrava "captura de Rhenan7: ~60 de 120 fps" na área de trabalho: era o conteúdo
  (vídeo de 60). 50 e 60 entraram nos ritmos de conteúdo que não acusam (`CONTENT_RATES`).

## Sétima rodada (12/11/2026): tela que não passa de 720p, sem jogo nenhum

Pedro (R7 5800X, RTX 3070, nada aberto) não passava de 720p compartilhando a tela; antes da cópia menor
e dos vigias, a tela dos amigos chegava "quase original" a 60 fps. Comparando o envio de hoje com o do
começo (uma camada, sem adaptação), três coisas seguravam a imagem:

- **A cópia menor (simulcast)**, desde 2e3b6d2 (09/11). Com duas camadas o servidor escolhe qual mandar
  pela estimativa de banda de quem assiste. Medido aqui, em loopback e sem limite de rede, quem assistia
  passava os primeiros ~10 s na cópia de 2/3 (1280x720 de uma tela 1080p); com a estimativa baixa (Wi-Fi,
  servidor pequeno, começo de conexão) fica nela. A tela voltou a sair numa camada só (`share.ts`).
  Quem precisa de cópia menor para rede ruim é exceção; a proteção contra travadas (que pulava para a
  cópia menor) fica sem efeito e diz "sem cópia menor".
- **`maintain-framerate`**. Com uma camada ativa o WebRTC liga o controle de qualidade do codificador: o
  QualityScaler (QP) ou, com H.264 da placa sem QP confiável, o `BandwidthQualityScaler`, que tem
  limites fixos por resolução para H.264 (1080p só com ~2,5 Mbps de estimativa, 720p com ~1,5). Com a
  estimativa de banda ainda subindo, ele encolhe para 720p e demora a voltar (precisa de QP baixo por um
  tempo). O `ShrinkGuard` da sexta rodada só agia abaixo da metade do tamanho, então 720p de 1080p
  passava. Agora a tela já sai em `maintain-resolution` (`stream.ts`): o navegador nunca encolhe; faltando
  banda de verdade ele corta quadros. O `ShrinkGuard` fica como rede de proteção.
- **O aviso de "captura curta"** culpava um jogo que não existia. O Chrome só captura quando a tela muda:
  área de trabalho, navegador e vídeo dão 30-40 fps num pedido de 60 sem nada de errado. O aviso saiu (o
  número continua no painel de estatísticas); fica só o do codificador perdendo quadros.

### Autoteste: `/teste`

Uma página que qualquer pessoa roda sozinha (link "Testar minha transmissão" no menu da tela). Abre uma
sala só dela no servidor de verdade, compartilha a tela com os ajustes da sala e, na mesma aba, uma
segunda conexão assiste como qualquer pessoa. Uma animação cobre a página durante a medição, para a tela
ter movimento em todo quadro. Em 20 s mostra o que chega a quem assiste (tamanho e fps) contra o que
deveria chegar (a captura inteira, ou o teto escolhido; fps até a taxa do monitor), e onde caiu: captura,
codificador, navegador encolhendo ou caminho (rede/servidor).

Medido aqui (OpenH264 no processador, tela sintética 1920x1080 a 60): quem assiste recebe 1920x1080 a
~54 fps (o processador do sandbox é o limite), em todas as leituras. Com 2560x1440 (`qualidade.mjs`):
1 camada, 2560x1440 do começo ao fim. Testes: `tools/e2e/autoteste.mjs`, `tools/e2e/captura.mjs`.

## Oitava rodada (12/11/2026): 48 fps num monitor de 144 Hz

Primeiro /teste do Pedro depois da sétima rodada:
- Tamanho cheio: 1920x1080, H.265 na placa, 11 Mbps chegando, 0 travadas, "limitado por: nada".
- Fps: a captura entregou **48** de 60 num monitor de **144 Hz**.
- 48 = 144 / 3, ou seja, um quadro a cada 3 atualizações do monitor.

O que o código do Chrome diz:
- O timer da captura (`DesktopCaptureDevice::Core::ScheduleNextCaptureFrame`) usa o maior entre o período pedido e 2x o tempo da última captura (teto de meio núcleo).
- O filtro de fps do `VideoTrackAdapter` tem 20% de tolerância e acumula a diferença; simulado, ele deixa passar 60 de uma fonte de 144.
- Portanto a conta "144 / 3" sozinha não está provada pelo código. Ela pode vir do ritmo pedido batendo nas atualizações do monitor, ou do tempo de cada captura (cópia da placa) passando de ~10 ms.

Mudanças:
- A captura passa a pedir o divisor do monitor logo acima do pedido. Exemplos: 144 Hz e 60 pedidos → 72; 165 Hz → 82,5; 60/120/240 Hz → o próprio pedido. O codificador continua com teto no pedido (`maxFramerate`).
- O monitor é medido pelos quadros de animação (`core/monitor.ts`).
- O "Ceder" usa o mesmo ritmo na qualidade total; nos degraus, usa o fps do degrau.
- O /teste agora faz uma varredura no fim: mede quantos quadros a captura entrega pedindo o fps escolhido, o divisor e a taxa do monitor (linhas "captura pedindo N").
  - Se pedir mais dá mais quadros, o limite era o ritmo.
  - Se todos dão o mesmo, é o teto da captura do navegador naquele PC, e o veredito diz isso.
- O canvas da animação do /teste não é mais recriado a cada quadro, o que pesava na mesma placa que a captura usa.
- Comparações de "codificador perdendo quadros" usam o menor entre captura e pedido, porque a captura agora pode passar do pedido.

Teste: `tools/e2e/autoteste.mjs monitor144` (monitor de 144 Hz fingido nos quadros de animação: pede 72, varre 60/72/144, quem assiste recebe ~60).

## Nona rodada (12/11/2026): tela inteira presa em 48 fps, janela a 144

A varredura do /teste no PC do Pedro deu sempre ~48 fps, pedindo 60, 72 ou 144. O ambiente:
- Windows 11 build 26200, Brave 157.1.99.56 (Chromium 157), RTX 3070.
- Um monitor 1920x1080 a 144 Hz.

Medição no próprio PC: Brave com perfil temporário, animação em tela cheia e contagem por `MediaStreamTrackProcessor`, 8 s depois de 2 s de aquecimento.

| captura | fps |
| --- | --- |
| tela inteira, sem flags | 48,1 |
| tela inteira, `WebRtcAllowWgcUsingTexture` | 48,1 |
| tela inteira, `ZeroCopyDesktopCapture` | 48,1 |
| tela inteira, as duas | 48,2 |
| tela inteira, pedindo 60 | 48,1 |
| **janela** (a própria janela do teste, 1920x1080) | **144,1** |

O que isso mostra:
- O teto é só da captura de **tela inteira** no Windows 11 24H2+. Ele não muda com o fps pedido nem com flags.
- 48 = 144 / 3. Num monitor de 240 Hz dá 60 (o Rhenan tinha 60 de 120).
- Explicação mais provável: no 24H2 o Windows Graphics Capture entrega no máximo um quadro a cada `MinUpdateInterval`, que tem padrão de 16 ms. O próximo quadro depois de 16 ms cai em 20,8 ms (144 Hz) ou 16,7 ms (240 Hz). O Chromium usa WGC para tela inteira a partir do 24H2 (`IsWgcEnabledForScreenCapture`) e não muda esse intervalo. Outros projetos medem ~58 fps com o padrão e ~188 com 1 ms (github.com/gjovanov/roomler-ai/pull/2915); o OBS muda o intervalo (PR 12759).
- A captura de janela não tem esse teto.

Mudanças:
- O seletor do navegador abre na aba de **janelas** (`displaySurface: 'window'`). A tela inteira continua disponível.
- O painel de estatísticas, com tela inteira e captura abaixo do pedido, sugere compartilhar a janela do jogo (em "janela sem bordas"; tela cheia exclusiva pode sair preta).
- O /teste tem "Testar pela janela" e "Testar pela tela inteira", mostra o que foi compartilhado e, na tela inteira com fps baixo, explica o teto.

Ainda não testado com um jogo de verdade (fps e som da janela).
