# Celular como câmera e microfone

Parecido com o Iriun Webcam e o WO Mic, mas sem instalar nada: o celular abre um link e vira a
câmera (e, se quiser, o microfone) de quem está no PC.

## Como usar

1. No PC, dentro da sala, abra a setinha da tecla da **câmera** (ou do microfone) e clique em
   **Usar o celular**.
2. Aponte a câmera do celular para o QR, ou mande o link para ele.
3. O celular entra na sala com a câmera traseira ligada. Lá dá para ligar o microfone, virar para a
   câmera frontal e escolher entre **voz limpa** (tira eco e ruído) e **som cru** (para música).
4. No PC, as teclas de câmera e microfone da barra passam a comandar o celular. O menu da câmera
   mostra o que está ligado e tem o botão **Desconectar o celular**.

Regras:

- Um aparelho por link. Se outro celular abrir o mesmo link, ele é recusado. Para trocar de
  aparelho, clique em **Desconectar** no PC e gere outro link.
- O mesmo celular pode recarregar a página: ele volta sozinho.
- Link sem uso vence em 15 minutos.
- Se o PC sair da sala, o celular pausa depois de 20 s e volta sozinho quando o PC entrar de novo.
- Ligar o microfone do celular desliga o do PC (para a voz não sair dobrada).
- O celular não recebe nada da sala: não gasta a internet dele e não faz eco.
- A tela do celular precisa ficar ligada com a página aberta. Com a tela apagada o sistema corta a
  câmera.

O celular precisa abrir o site por **https** (o navegador não libera a câmera em http). No
noveau.riajuu.net isso já acontece. Rodando local, use o endereço do Tailscale (`https://…ts.net`).

## Qualidade

- Câmera do celular: 1080p a 30 fps em H.264, até 4 Mbps. O H.264 roda no chip de vídeo do celular,
  que esquenta menos e gasta menos bateria. Vai junto uma cópia em 360p para a janelinha do canto.
- Câmera do PC: 1080p a 30 fps em VP8, até 4 Mbps, com cópia em 360p. Antes era 720p a 1,7 Mbps.
- Microfone do celular: Opus 128 kbps, sem DTX, com RED (resiste a perda de pacote).

## Como funciona por dentro

`server/phone.mjs` guarda os links na memória. O celular entra na sala do LiveKit como outro
participante, com `canSubscribe: false` e o atributo `phoneOf` (identidade do PC). Os navegadores
juntam esse participante ao dono: a câmera dele vira a câmera do dono e a voz dele vira a voz do
dono (com o volume do dono). Ele não aparece na lista de pessoas.

O PC comanda o celular trocando o atributo `ctl` do celular pela API do LiveKit
(`/api/phone/control`). Quando o PC recarrega a página, a identidade dele muda; o site avisa o
servidor (`GET /api/phone/link`) e o servidor atualiza o `phoneOf` do celular.

Nada muda no LiveKit nem no Caddy: só a imagem do app.
