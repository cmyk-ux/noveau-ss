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
  saiu no libaom, e a placa pode falhar no meio. Agora um vigia (`codec-guard.ts`) lê a cada 3 s o
  `powerEfficientEncoder` e o `encoderImplementation` do getStats, no codec principal e na reserva.
  Duas leituras seguidas no processador e ele republica a mesma captura num codec que a placa
  codifica (até 2 trocas por transmissão), com um aviso na tela.
- **Câmera.** Era sempre VP8 1080p30 + 360p, no processador. Agora vai em H.264 quando a placa
  codifica H.264; sem placa, VP8 em 720p.
- **Clipe sob demanda.** Uma tecla de tesoura na barra de baixo liga e desliga. Desligado (o padrão),
  nada grava e nada fica na memória. Ligado, grava só as telas dos outros que você assiste. É de quem
  assiste: quem transmite não paga nada pelo clipe de ninguém.
