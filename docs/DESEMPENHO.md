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
