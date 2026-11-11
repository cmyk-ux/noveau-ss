# Celular como câmera e microfone

Parecido com o Iriun Webcam e o WO Mic, mas sem instalar nada: o celular abre um link e vira a
câmera (e, se quiser, o microfone) de quem está no PC.

## Como usar

1. No PC, dentro da sala, abra a setinha da tecla da **câmera** (ou do microfone) e clique em
   **Usar o celular**.
2. Aponte a câmera do celular para o QR, ou mande o link para ele.
3. O celular liga **só o que você escolheu**: pelo menu da câmera, só a câmera (traseira); pelo menu
   do microfone, só o microfone (a página nem pede a câmera). Lá dá para ligar o outro, virar para a
   câmera frontal e escolher entre **voz limpa** (tira eco e ruído) e **som cru** (para música).
4. No PC, as teclas de câmera e microfone da barra passam a comandar o celular, cada uma só a sua
   parte: mutar o microfone não mexe na câmera, e vice-versa. O menu mostra o que está ligado e tem
   o botão **Desconectar o celular**.

Regras:

- Um aparelho por link. Se outro celular abrir o mesmo link, ele é recusado. Para trocar de
  aparelho, clique em **Desconectar** no PC e gere outro link.
- O mesmo celular pode recarregar a página: ele volta sozinho, com o que estava ligado.
- Se o PC pedir algo que o celular ainda não liberou (ex.: link de microfone e o PC liga a câmera),
  o celular mostra **O PC pediu a câmera: toque para ligar**. Sem um toque o navegador esconde o
  pedido de permissão.
- Link sem uso vence em 15 minutos.
- Se o PC sair da sala, o celular pausa depois de 20 s e volta sozinho quando o PC entrar de novo.
- Ligar o microfone do celular desliga o do PC (para a voz não sair dobrada).
- O celular não recebe nada da sala: não gasta a internet dele e não faz eco.
- A tela do celular precisa ficar ligada com a página aberta. Com a tela apagada o sistema corta a
  câmera.

Ao abrir o link, o celular mostra primeiro um botão **Permitir câmera e microfone**. O pedido de
permissão só sai de dentro desse toque: pedido sem toque o Chrome esconde num ícone ao lado do
endereço que some em segundos. Se a câmera já estiver bloqueada, a página mostra como liberar no
Android e no iPhone. Aberto pelo navegador de dentro do Discord, WhatsApp, Instagram etc., ela avisa
e oferece abrir no Chrome (Android) ou explica como abrir no Safari (iPhone), porque esses
navegadores costumam negar a câmera sem perguntar.

O celular precisa abrir o site por **https** (o navegador não libera a câmera em http). No
noveau.riajuu.net isso já acontece. Rodando local, use o endereço do Tailscale (`https://…ts.net`).

## Qualidade

- Câmera do celular: 1080p a 30 fps em H.264, até 4 Mbps. O H.264 roda no chip de vídeo do celular,
  que esquenta menos e gasta menos bateria. Vai junto uma cópia em 360p para a janelinha do canto.
- Câmera do PC: 1080p a 30 fps em VP8, até 4 Mbps, com cópia em 360p. Antes era 720p a 1,7 Mbps.
- Microfone do celular: Opus 128 kbps, sem DTX, com RED (resiste a perda de pacote).

## Câmeras: onde fica cada botão

**A câmera de outra pessoa** tem uma tecla só, a de câmera (com LED). Ela liga e desliga a câmera
e fica sempre no mesmo lugar:

- Na grade (várias telas ao mesmo tempo), no canto de cima de cada monitor, ao lado do contador de
  quem assiste. Ligada, a câmera aparece logo abaixo, no formato dela, na cópia de 360p.
- Com uma tela em foco, na barra de botões do palco (aparece com o mouse em cima; no celular, com um toque).

Desligada, o servidor para de mandar o vídeo, e nada é baixado nem decodificado. Vale para a grade e
para o foco ao mesmo tempo. Clicar na câmera da grade abre a tela em foco com a câmera grande. Na
janelinha em foco, clicar troca a câmera com a tela.

**A sua câmera** aparece no monitorzinho **você**, no canto de cima à esquerda:

- No formato real da câmera (4:3, 16:9, celular em pé), sem cortar.
- Espelhada, como num espelho, venha do PC ou do celular. A tecla de espelho na plaqueta desliga
  (fica guardado). Só você vê espelhado: quem assiste vê do jeito certo, com texto legível.
- Puxe o canto com as listrinhas para aumentar. Clique para ver em tela cheia, e clique de novo (ou
  Esc) para voltar.
- A cópia acompanha o tamanho: pequena em 360p a 15 fps, maior em 720p a 30 fps e, em tela cheia,
  na resolução da câmera. Quem assiste recebe sempre a original.
- **Parar de ver** desliga a cópia de verdade e fica guardado neste navegador. A tecla **você**
  traz de volta.

**A sua tela** fica fora do palco por padrão, porque mostrar a própria tela grande pesa no PC de
quem transmite. Para ver: tecla **prévia** da barra (cópia de 360p) → **ver grande no palco**, ou
**Ver minha tela aqui** quando ninguém mais está transmitindo. No palco ela é uma cópia de 720p a
30 fps. O olho riscado tira ela do palco de novo. Ao recarregar a página, volta a ficar desligada.

## Como funciona por dentro

`server/phone.mjs` guarda os links na memória. O celular entra na sala do LiveKit como outro
participante, com `canSubscribe: false` e o atributo `phoneOf` (identidade do PC). Os navegadores
juntam esse participante ao dono: a câmera dele vira a câmera do dono e a voz dele vira a voz do
dono (com o volume do dono). Ele não aparece na lista de pessoas.

O PC comanda o celular trocando o atributo `ctl` do celular pela API do LiveKit
(`/api/phone/control`). Quando o PC recarrega a página, a identidade dele muda; o site avisa o
servidor (`GET /api/phone/link`) e o servidor atualiza o `phoneOf` do celular.

Nada muda no LiveKit nem no Caddy: só a imagem do app.
