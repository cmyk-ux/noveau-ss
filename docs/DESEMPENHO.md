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
