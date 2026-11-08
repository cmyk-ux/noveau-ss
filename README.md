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

**Pela internet:** precisa abrir/redirecionar as portas 7880, 7881 (TCP) e 7882 (UDP) no roteador, ou usar um servidor. Túneis HTTP comuns (ngrok, Cloudflare Tunnel) servem para o site e a API, mas não passam UDP, então a mídia fica limitada ao TCP 7881.

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
