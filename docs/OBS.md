# Transmitir pelo OBS (WHIP)

O OBS (30 ou mais novo) manda vídeo e som direto para o LiveKit por WHIP. Ninguém recodifica nada:
o OBS codifica na placa de vídeo e o servidor só repassa para quem assiste, como faz com a tela do navegador.

## Por que este jeito

| Jeito | Servidor | Qualidade | Situação |
| --- | --- | --- | --- |
| **WHIP direto no LiveKit (este)** | nada novo: o LiveKit 1.13 já atende `/whip/v1` | o que sai do OBS, sem recodificar | escolhido |
| LiveKit Ingress (WHIP ou RTMP) | serviço `livekit-ingress` + Redis; RTMP transcodifica (2–6 núcleos) | RTMP perde qualidade na conversão | inviável no chie (1 núcleo, 1 GB) |
| Câmera virtual do OBS no navegador | nada | o navegador codifica de novo, sem o som do OBS | pior |

O `livekit-ingress` com WHIP "sem transcodificar" só repassa a oferta SDP para o `/whip/v1` do próprio
LiveKit (`pkg/whip/whip_proxy_handler.go`). Aqui a API do Noveau faz essa ponte, então não precisa do Ingress nem do Redis.

## Fluxo

1. Na sala, botão **OBS** (na barra de baixo) → *Mostrar o endereço e a chave*. A API (`POST /api/obs/key`, com o token da sala) devolve uma chave assinada.
2. No OBS: Configurações → Transmissão → Serviço **WHIP**, Servidor `https://<site>/api/whip`, Bearer Token = a chave.
3. "Iniciar transmissão": o OBS manda a oferta para `/api/whip`; a API cria um token do LiveKit na hora e repassa para `LIVEKIT_HTTP_URL/whip/v1`. PATCH/DELETE em `/api/whip/<sessão>` são repassados também.
4. A mídia vai do OBS direto para o LiveKit (7882/UDP ou 7881/TCP), como a de um navegador.

Chave de quem entrou com Discord: segue a call em que a pessoa estiver (vale 1 ano); se ela sair da call, o
bot tira o OBS da sala junto. Chave de sala por link: presa à sala (30 dias). As chaves são assinadas com o
`SESSION_SECRET`; sem ele (e sem Discord) elas deixam de valer quando a API reinicia.

## Detalhes

- O LiveKit marca o que chega por WHIP como câmera + microfone. O participante do OBS tem os atributos
  `obs=1`, `obsName` e `obsOf` (id do Discord); o site mostra a "câmera" dele como tela e o "microfone" como o som da tela, e não lista o OBS como pessoa.
- O LiveKit também não marca esse som como estéreo, e o Chrome então juntaria os canais em mono. O site pede estéreo em todo Opus que recebe (`web/src/app/core/stereo.ts`).
- O som da sua própria transmissão do OBS não toca de volta para você.
- O OBS não atende pedido de quadro-chave: use intervalo de quadro-chave de 1 s.
- OBS 32.1+: simulcast de 2 camadas (100% + 50%) deixa o LiveKit mandar a cópia menor só para quem não aguenta. O LiveKit aceita no máximo 3.
- Codec: H.264 toca em todo navegador. AV1 também funciona, mas não há conversão: quem não decodifica AV1 não vê.
