# noveau-ss

Compartilhamento de tela com voz, no estilo do antigo Cenaculum: framerate variável, presets de qualidade (Jogos, Filme, Código, Personalizado), escolha de codec (AV1, VP9, H.264, VP8), áudio da tela em estéreo, microfone, webcam e câmera RTMP opcional.

Roda inteiro no seu PC: um servidor LiveKit local, uma API pequena em Node e o frontend Angular.

## O que precisa ter instalado

- **Node.js 22 ou mais novo** (https://nodejs.org)
- **Docker Desktop** (https://www.docker.com/products/docker-desktop), para subir o LiveKit.
  Sem Docker, dá para baixar o `livekit-server` (https://github.com/livekit/livekit/releases) e rodar `livekit-server --dev` por conta própria, depois usar `npm run dev:sem-docker`.

## Rodando

```bash
npm run setup   # só na primeira vez: instala as dependências
npm run dev     # sobe LiveKit + API + site
```

Abra http://localhost:4200, crie uma sala e mande o link.

O que sobe:

| Parte    | Porta                         | O que faz                                    |
|----------|-------------------------------|----------------------------------------------|
| LiveKit  | 7880 (ws), 7881 tcp, 7882 udp | transporta vídeo e áudio (modo `--dev`)       |
| API      | 3001                          | gera os tokens de entrada (`/api/token`)      |
| Site     | 4200                          | Angular em modo dev, com proxy de `/api`      |

## Testando com outras pessoas

**Mesma rede (Wi‑Fi de casa):** descubra o IP do seu PC na rede (ex.: `192.168.0.10`) e suba com ele:

```bash
# Windows (PowerShell)
$env:NODE_IP="192.168.0.10"; npm run dev
# macOS / Linux
NODE_IP=192.168.0.10 npm run dev
```

Os outros abrem `http://192.168.0.10:4200/...`. Obs.: fora do `localhost`, o navegador só libera captura de tela e microfone em HTTPS, então para amigos na rede é preciso HTTPS (por exemplo com um túnel) ou ativar a flag `chrome://flags/#unsafely-treat-insecure-origin-as-secure` para esse endereço.

**Com amigos, pelo Tailscale (recomendado para testar):** veja a seção "Compartilhar com amigos (Tailscale)" abaixo.

**Pela internet:** precisa abrir/redirecionar as portas 7880, 7881 (TCP) e 7882 (UDP) no roteador, ou usar um servidor. Túneis HTTP comuns (ngrok, Cloudflare Tunnel) servem para o site e a API, mas não passam UDP, então a mídia fica limitada ao TCP 7881.

## Compartilhar com amigos (Tailscale)

`localhost` só abre no seu PC. O Tailscale (VPN grátis) dá ao seu PC um endereço que seus amigos alcançam, com HTTPS (necessário para microfone e captura de tela), sem mexer no roteador.

1. Instale o Tailscale (https://tailscale.com/download), entre com sua conta e, no painel https://login.tailscale.com/admin/dns, confirme que **MagicDNS** e **HTTPS Certificates** estão ligados.
2. Descubra o IP do Tailscale do PC: `tailscale ip -4` (algo como `100.x.y.z`).
3. Dê HTTPS ao site e ao LiveKit (uma vez só, fica salvo):
   ```
   tailscale serve --bg --https=443 http://127.0.0.1:3000
   tailscale serve --bg --https=7443 http://127.0.0.1:7880
   ```
   `tailscale serve status` mostra o endereço, no formato `https://SEU-PC.SUA-REDE.ts.net`.
4. No `.env` (copie de `.env.example`), preencha `NODE_IP`, `LIVEKIT_PUBLIC_URL=wss://SEU-PC.SUA-REDE.ts.net:7443` e, se usar o Discord, `DISCORD_REDIRECT_URI=https://SEU-PC.SUA-REDE.ts.net/api/discord/callback` (adicione o mesmo endereço em OAuth2 > Redirects no Developer Portal).
5. Rode `npm run compartilhar` (compila o site e sobe LiveKit + site na porta 3000).
6. Compartilhe o PC com cada amigo: painel do Tailscale > **Machines** > menu `...` do seu PC > **Share**. O amigo instala o Tailscale, aceita o convite e abre `https://SEU-PC.SUA-REDE.ts.net`.

## Login com Discord (sala da call)

Com isso ligado, quem está numa call do seu servidor e abre o site cai direto numa sala com as mesmas pessoas da call. As salas avulsas continuam funcionando.

1. Em https://discord.com/developers/applications clique em **New Application** e dê um nome.
2. Aba **OAuth2**: copie o **Client ID** e o **Client Secret** (Reset Secret). Em **Redirects**, adicione `http://localhost:4200/api/discord/callback` e salve.
3. Aba **Bot**: clique em **Reset Token** e copie o token. Não precisa ligar nenhum "Privileged Gateway Intent".
4. Coloque o bot no seu servidor abrindo este link (troque `SEU_CLIENT_ID`): `https://discord.com/oauth2/authorize?client_id=SEU_CLIENT_ID&scope=bot&permissions=1051648` ("Ver canais", "Conectar" e "Enviar mensagens": enxergar quem está em cada call e marcar a call no chat dela).
5. No Discord, ative **Configurações > Avançado > Modo desenvolvedor**, clique com o botão direito no servidor e em **Copiar ID do servidor**.
6. Copie `.env.example` para `.env` na raiz do projeto e preencha os quatro `DISCORD_*` e um `SESSION_SECRET` qualquer. Reinicie o `npm run dev`.

Se o site for aberto por outro endereço (IP da rede, túnel), adicione também `<endereço>/api/discord/callback` nos Redirects.

## Configuração (variáveis de ambiente da API)

| Variável              | Padrão                    | Para quê                                                  |
|-----------------------|---------------------------|-----------------------------------------------------------|
| `PORT`                | `3001`                    | porta da API                                              |
| `LIVEKIT_API_KEY`     | `devkey`                  | chave do LiveKit (a do modo `--dev`)                      |
| `LIVEKIT_API_SECRET`  | `secret`                  | segredo do LiveKit. Em servidor real, troque e não compartilhe |
| `LIVEKIT_HTTP_URL`    | `http://127.0.0.1:7880`   | onde a API fala com o LiveKit                             |
| `LIVEKIT_PUBLIC_URL`  | `ws://<host da página>:7880` | endereço que o navegador usa para conectar no LiveKit  |
| `INSTANCE_SECRET`     | vazio                     | se definido, pede uma senha para entrar nas salas         |
| `CAMERA_INGRESS`      | vazio                     | `1` liga a câmera RTMP (precisa do serviço Ingress do LiveKit) |
| `STATIC_DIR`          | vazio                     | pasta do build do site para a API servir tudo numa porta  |
| `DISCORD_*`, `SESSION_SECRET` | vazio             | login com Discord, veja acima e `.env.example`            |

Essas variáveis podem ficar num arquivo `.env` na raiz do projeto.

Para um build de produção: `npm run build` e depois `npm run serve` (site + API em http://localhost:3000; o LiveKit continua separado).

## Como funciona

- O link da sala é `/room/<nome>#<chave>`. A chave fica no `#`, então não vai para o servidor no carregamento da página. A sala no LiveKit é `c_` + os 32 primeiros hex de `sha256(chave)`, igual ao Cenaculum original.
- A API (`server/server.mjs`) só emite tokens JWT (4 h) para a sala certa. Toda a mídia passa pelo LiveKit.
- Áudio da tela: Opus estéreo, sem DTX, com RED (`web/src/app/core/share.ts`, `SCREEN_AUDIO_PUBLISH`). É aqui que entra o próximo passo: subir para 510 kbps e depois um "modo estúdio" com PCM sem compressão pelo canal de dados.

## Estrutura

```
docker-compose.yml   LiveKit em modo dev
server/              API Node (tokens, config, câmera RTMP)
web/                 frontend Angular 22 + livekit-client
  src/app/core/      lógica: sala, transmissão, codecs, volumes, stats
  src/app/ui/        componentes de tela
  src/app/pages/     início e sala
```
