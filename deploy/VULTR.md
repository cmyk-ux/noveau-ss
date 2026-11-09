# Noveau em uma VPS (Vultr)

No servidor tudo roda em Docker: o **site + API**, o **LiveKit** e o **Caddy**, que dá HTTPS automático.
Com HTTPS os navegadores liberam microfone e captura de tela sem nenhuma flag, e ninguém precisa de VPN.

```
navegador ──https──> Caddy (80/443) ──> site + API (app)
          ──wss────> Caddy (/livekit) ─> LiveKit (sinalização)
          ──UDP 7882 / TCP 7881 ───────> LiveKit (vídeo e áudio, direto)
```

## 1. Criar a VPS

1. No painel da Vultr: **Deploy > Cloud Compute**, imagem **Ubuntu 24.04**.
2. Escolha a região mais perto de vocês (para o Brasil, São Paulo).
3. 2 vCPU e 4 GB de memória sobram: o LiveKit só repassa a mídia, não a recodifica.
4. **A banda é o que pesa.** Cada pessoa assistindo recebe o stream inteiro do servidor. Um stream de 25 Mbps
   gasta cerca de 11 GB por hora por espectador; confira a franquia de tráfego do plano.
5. Anote o **IP público** da VPS.

## 2. Domínio

Precisa de um domínio (ou subdomínio) seu. Crie um registro **A** apontando para o IP da VPS, por exemplo
`noveau.seudominio.com`. Se usar o Cloudflare, deixe a nuvem **cinza** (só DNS): a mídia não passa pelo proxy deles.

## 3. Firewall

No painel da Vultr: **Products > Firewall**, crie um grupo, associe à VPS e libere de entrada:

| Protocolo | Porta | Para quê |
|-----------|-------|----------|
| TCP | 22   | você entrar por SSH |
| TCP | 80   | certificado HTTPS (Let's Encrypt) |
| TCP | 443  | site e sinalização |
| UDP | 443  | HTTP/3 (opcional) |
| TCP | 7881 | mídia do LiveKit por TCP |
| UDP | 7882 | mídia do LiveKit por UDP (o caminho rápido) |

Sem a UDP 7882 e a TCP 7881 a pessoa entra na sala, mas o vídeo e o som não chegam.

**Firewall dentro da VPS (ufw).** Os serviços rodam na rede do host (`network_mode: host`), então o
ufw do Ubuntu vale para eles (antes o Docker passava por cima). Se o ufw estiver ligado
(`sudo ufw status`), libere as mesmas portas, senão o site para de abrir:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw allow 7881/tcp
sudo ufw allow 7882/udp
```

As portas 7880 (LiveKit) e 3000 (API) ficam fechadas: só o Caddy fala com elas, por dentro.

## 4. Instalar o Docker

Entre na VPS (`ssh root@IP-DA-VPS`) e rode:

```bash
curl -fsSL https://get.docker.com | sh
```

## 5. Baixar o projeto

```bash
git clone https://github.com/cmyk-ux/noveau-ss.git
cd noveau-ss
git checkout claude/reconstrucao   # depois do merge, use a main
```

Se o repositório for privado, o `git clone` pede usuário e um token do GitHub como senha.

## 6. Configurar

```bash
cp .env.prod.example .env.prod
nano .env.prod
```

Preencha:

- `DOMAIN`: o domínio do passo 2.
- `LIVEKIT_API_SECRET` e `SESSION_SECRET`: gere cada um com `openssl rand -hex 32` e cole o resultado.
- `DISCORD_*`: os mesmos valores do seu `.env` do PC (Client ID, Client Secret, Bot Token e ID do servidor).
- `INSTANCE_SECRET` (opcional): uma senha extra; se preencher, só entra quem souber.

Não cole esses valores em chats nem no git. O `.env.prod` já está no `.gitignore`.

## 7. Subir

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

A primeira vez demora alguns minutos (compila o site). Para acompanhar:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f
```

O Caddy pega o certificado sozinho na primeira visita. Abra `https://SEU-DOMINIO`.

## 8. Discord

No Developer Portal, em **OAuth2 > Redirects**, adicione:

```
https://SEU-DOMINIO/api/discord/callback
```

O bot continua o mesmo (o token está no `.env.prod`).

## Atualizar depois

```bash
cd noveau-ss
git pull
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

## Se algo der errado

| Sintoma | Causa provável |
|---------|----------------|
| Site não abre ou erro de certificado | o registro A ainda não propagou, ou as portas 80/443 estão fechadas no firewall |
| Entra na sala mas não vê nem ouve ninguém | UDP 7882 e TCP 7881 fechadas no firewall da Vultr |
| Login do Discord falha com "redirect_uri inválido" | falta o endereço do passo 8 no Developer Portal |
| Quer ver o que o LiveKit está fazendo | `docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f livekit` |


## Perda de pacotes / travadas: checar o servidor

O diário de travadas do site diz se a perda é na internet de quem transmite ou de quem assiste.
Se todo mundo trava junto, vale olhar se é a própria VPS descartando pacotes:

```bash
# 1) O LiveKit reclama do buffer de UDP? (com o serviço "tuning" não deve aparecer mais)
docker compose -f docker-compose.prod.yml logs livekit | grep -i "receive buffer"

# 2) O kernel está jogando pacote UDP fora por buffer cheio? Rode duas vezes com 1 min de intervalo
#    durante uma transmissão: se UdpRcvbufErrors subir, o servidor está perdendo pacotes.
nstat -az UdpRcvbufErrors UdpSndbufErrors UdpInErrors

# 3) Valores atuais (o "tuning" põe 16 MB no máximo)
sysctl net.core.rmem_max net.core.wmem_max

# 4) Processador e memória dos serviços
docker stats --no-stream
```

Para deixar os buffers grandes mesmo sem o compose (opcional, sobrevive a reinício da VPS):

```bash
printf 'net.core.rmem_max=16777216\nnet.core.wmem_max=16777216\nnet.core.rmem_default=4194304\nnet.core.wmem_default=1048576\nnet.core.netdev_max_backlog=10000\n' | sudo tee /etc/sysctl.d/99-noveau.conf
sudo sysctl --system
```
