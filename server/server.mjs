// Backend do Noveau: entrega tokens do LiveKit e (opcional) endereços RTMP de câmera.
// Reconstruído a partir do comportamento observado no cenaculum.capivaras.dev.
//
// Variáveis de ambiente (todas têm padrão para rodar local com `livekit-server --dev`):
//   PORT                 porta deste servidor (padrão 3001)
//   LIVEKIT_API_KEY      padrão "devkey"
//   LIVEKIT_API_SECRET   padrão "secret"
//   LIVEKIT_HTTP_URL     onde este servidor fala com o LiveKit (padrão http://127.0.0.1:7880)
//   LIVEKIT_PUBLIC_URL   URL que o navegador usa; se vazio, usa ws://<host da página>:7880
//   INSTANCE_SECRET      se definido, só entra quem souber essa senha
//   CAMERA_INGRESS       "1" para oferecer câmera por RTMP (precisa do serviço livekit-ingress)
//   STATIC_DIR           pasta do frontend compilado para servir junto (opcional)
//   DISCORD_*            login com Discord e sala da call (veja discord.mjs)
//
// Tudo isso pode ficar num arquivo .env na raiz do projeto (ele não vai para o git).

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// Carrega ../.env antes de ler as variáveis (inclusive as do discord.mjs, importado abaixo).
const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const { AccessToken, IngressClient, IngressInput, RoomServiceClient, TokenVerifier, TrackSource } = await import('livekit-server-sdk');
const discord = await import('./discord.mjs');
const clips = await import('./clips.mjs');

const PORT = Number(process.env.PORT ?? 3001);
const API_KEY = process.env.LIVEKIT_API_KEY ?? 'devkey';
const API_SECRET = process.env.LIVEKIT_API_SECRET ?? 'secret';
const LIVEKIT_HTTP_URL = process.env.LIVEKIT_HTTP_URL ?? 'http://127.0.0.1:7880';
const LIVEKIT_PUBLIC_URL = process.env.LIVEKIT_PUBLIC_URL ?? '';
const INSTANCE_SECRET = process.env.INSTANCE_SECRET ?? '';
const CAMERA_INGRESS = process.env.CAMERA_INGRESS === '1';
const STATIC_DIR = process.env.STATIC_DIR ?? '';
const TOKEN_TTL = '4h';
const CAMERA_HOURS = 4;

const ingress = new IngressClient(LIVEKIT_HTTP_URL, API_KEY, API_SECRET);
const rooms = new RoomServiceClient(LIVEKIT_HTTP_URL, API_KEY, API_SECRET);

/** O nome da sala vem só da chave do link: o rótulo na URL é decorativo. */
function roomFor(key) {
  return 'c_' + createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function validKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(key);
}

function cleanName(name) {
  return typeof name === 'string' ? name.trim().slice(0, 24) : '';
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function checkLink(body) {
  if (!validKey(body.key)) throw new HttpError(400, 'Este link não tem uma chave de sala válida.');
  if (INSTANCE_SECRET !== '' && body.secret !== INSTANCE_SECRET) throw new HttpError(403, 'Senha da instância incorreta.');
  return roomFor(body.key);
}

function publicUrl(req) {
  if (LIVEKIT_PUBLIC_URL !== '') return LIVEKIT_PUBLIC_URL;
  const host = (req.headers.host ?? 'localhost').replace(/:\d+$/, '');
  return `ws://${host}:7880`;
}

async function grantFor(req, room, name, attributes = undefined, device = undefined) {
  // Celular entra marcado, para os outros verem o ícone. A mesma conta pode estar no PC e no celular.
  if (device === 'mobile') attributes = { ...(attributes ?? {}), device: 'mobile' };
  const identity = `${name}#${randomBytes(4).toString('base64url').slice(0, 6)}`;
  const at = new AccessToken(API_KEY, API_SECRET, { identity, name, ttl: TOKEN_TTL, attributes });
  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
    canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO, TrackSource.CAMERA, TrackSource.MICROPHONE],
  });
  return { token: await at.toJwt(), url: publicUrl(req), name, identity, canPublish: true, camera: CAMERA_INGRESS };
}

async function token(req, body) {
  const room = checkLink(body);
  const name = cleanName(body.name);
  if (name === '') throw new HttpError(400, 'Digite um apelido.');
  return grantFor(req, room, name, undefined, body.device);
}

/** Token para a sala da call do Discord em que o usuário logado está agora. */
async function discordToken(req, body = {}) {
  const { user, call } = await discord.requireCall(req);
  const grant = await grantFor(req, discord.roomForChannel(call.id), cleanName(user.name) || 'alguém', {
    discordId: user.id,
    ...(user.avatar ? { avatar: user.avatar } : {}),
  }, body.device);
  return { ...grant, camera: false, call };
}

// ---------- Convite de 1 uso (para quem não pode entrar com Discord)
// Alguém da call gera um link; a primeira pessoa que abrir escolhe um apelido e entra na sala da
// call. O link fica preso ao navegador dela (pode recarregar a página), e vale por GUEST_TTL_MS.
// Qualquer pessoa da sala que entrou com Discord pode expulsar o convidado, e aí o link morre.
const GUEST_TTL_MS = 12 * 3600_000;
const GUEST_MAX_PER_PERSON = 5;
/** id -> { room, call: {id, name}, by, byName, expiresAt, holder, identity } */
const guestInvites = new Map();

function pruneGuests() {
  const now = Date.now();
  for (const [id, g] of guestInvites) if (g.expiresAt < now) guestInvites.delete(id);
}

async function createGuestInvite(req) {
  const { user, call } = await discord.requireCall(req);
  pruneGuests();
  const mine = [...guestInvites.values()].filter((g) => g.by === user.id && g.holder === null).length;
  if (mine >= GUEST_MAX_PER_PERSON) throw new HttpError(429, `Você já tem ${GUEST_MAX_PER_PERSON} convites sem uso. Espere alguém usar.`);
  const id = randomBytes(12).toString('base64url');
  const expiresAt = Date.now() + GUEST_TTL_MS;
  guestInvites.set(id, { room: discord.roomForChannel(call.id), call, by: user.id, byName: user.name, expiresAt, holder: null, identity: null });
  console.log(`[convite] ${user.name} criou um convite de 1 uso para ${call.name}`);
  return { id, expiresAt };
}

async function guestToken(req, body) {
  pruneGuests();
  const g = typeof body.id === 'string' ? guestInvites.get(body.id) : undefined;
  const holder = typeof body.holder === 'string' && body.holder.length >= 16 && body.holder.length <= 64 ? body.holder : null;
  if (g === undefined || holder === null || (g.holder !== null && g.holder !== holder)) {
    throw new HttpError(410, 'Este convite já foi usado, venceu ou foi cancelado. Peça um novo a quem te chamou.');
  }
  const name = cleanName(body.name);
  if (name === '') throw new HttpError(400, 'Digite um apelido.');
  g.holder = holder;
  const grant = await grantFor(req, g.room, name, { guest: '1', invitedBy: cleanName(g.byName) || 'alguém' }, body.device);
  g.identity = grant.identity;
  return { ...grant, camera: false, call: g.call };
}

/** Quem está na sala com Discord tira um convidado (e o convite dele deixa de valer). */
async function kickGuest(req, body) {
  const { user, call } = await discord.requireCall(req);
  const room = discord.roomForChannel(call.id);
  const target = (await rooms.listParticipants(room)).find((p) => p.identity === body.identity);
  if (target === undefined) throw new HttpError(404, 'Essa pessoa já saiu da sala.');
  if (target.attributes?.guest !== '1') throw new HttpError(403, 'Só dá para expulsar quem entrou por convite, sem Discord.');
  for (const [id, g] of guestInvites) if (g.identity === target.identity) guestInvites.delete(id);
  await rooms.removeParticipant(room, target.identity);
  console.log(`[convite] ${user.name} expulsou o convidado ${target.name}`);
  return { ok: true };
}

async function camera(body) {
  if (!CAMERA_INGRESS) throw new HttpError(404, 'Câmera por RTMP não está ligada neste servidor.');
  const room = checkLink(body);
  const existing = (await ingress.listIngress({ roomName: room }))[0];
  const info =
    existing ??
    (await ingress.createIngress(IngressInput.RTMP_INPUT, {
      name: 'camera',
      roomName: room,
      participantIdentity: `camera-${room.slice(2, 10)}`,
      participantName: 'Câmera',
    }));
  return {
    url: info.url,
    streamKey: info.streamKey,
    pushUrl: `${info.url.replace(/\/$/, '')}/${info.streamKey}`,
    name: info.participantName || 'Câmera',
    sendAt: { resolution: '1080p', mbps: 6 },
    endsAfterHours: CAMERA_HOURS,
  };
}

async function stopCamera(body) {
  if (!CAMERA_INGRESS) throw new HttpError(404, 'Câmera por RTMP não está ligada neste servidor.');
  const room = checkLink(body);
  for (const i of await ingress.listIngress({ roomName: room })) await ingress.deleteIngress(i.ingressId);
  return { ok: true };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

function serveStatic(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(STATIC_DIR, path));
  if (!file.startsWith(normalize(STATIC_DIR))) file = '';
  if (file === '' || !existsSync(file) || statSync(file).isDirectory()) file = join(STATIC_DIR, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e5) reject(new HttpError(413, 'Corpo grande demais.'));
    });
    req.on('end', () => {
      try {
        resolve(raw === '' ? {} : JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

const routes = {
  'GET /api/config': async () => ({
    requiresSecret: INSTANCE_SECRET !== '',
    discord: discord.discordEnabled,
    clips: clips.clipsEnabled ? { ttlMs: clips.CLIP_TTL_MS } : null,
  }),
  'GET /api/me': (req) => discord.me(req),
  'POST /api/discord/token': (req, body) => discordToken(req, body),
  'GET /api/discord/members': (req) => discord.callMembers(req),
  'POST /api/discord/ping': (req) => discord.pingMyCall(req),
  'POST /api/discord/invite': (req, body) => discord.inviteToRoom(req, body),
  'POST /api/discord/guest-invite': (req) => createGuestInvite(req),
  'POST /api/discord/kick': (req, body) => kickGuest(req, body),
  'POST /api/guest/token': (req, body) => guestToken(req, body),
  'POST /api/token': (req, body) => token(req, body),
  'POST /api/camera': (_req, body) => camera(body),
  'POST /api/camera/stop': (_req, body) => stopCamera(body),
};

/** Alguém saiu (ou trocou) de call no Discord: tira a pessoa da sala do site daquela call. */
async function kickFromCallRoom(userId, channelId) {
  const room = discord.roomForChannel(channelId);
  try {
    for (const p of await rooms.listParticipants(room)) {
      if (p.attributes?.discordId === userId) {
        await rooms.removeParticipant(room, p.identity);
        console.log(`[discord] ${p.name} saiu da call, removido da sala dela`);
      }
    }
  } catch (e) {
    // Sala vazia ou inexistente: nada a fazer.
    if (!/not found|does not exist/i.test(e.message ?? '')) console.error('[discord] remover da sala:', e.message);
  }
}
discord.startDiscordBot((userId, channelId) => void kickFromCallRoom(userId, channelId));

// Rotas que respondem com redirecionamento (fluxo de login do Discord).
const redirects = {
  'GET /api/discord/login': discord.login,
  'GET /api/discord/callback': discord.callback,
  'GET /api/discord/logout': discord.logout,
};

/** Quem manda clipe precisa estar numa sala: prova com o próprio token do LiveKit. */
const verifier = new TokenVerifier(API_KEY, API_SECRET);
async function roomMember(req) {
  const auth = String(req.headers.authorization ?? '');
  if (!auth.startsWith('Bearer ')) throw new clips.ClipError(401, 'Entre numa sala para clipar.');
  try {
    const claims = await verifier.verify(auth.slice(7));
    return { identity: claims.sub ?? 'anon', name: claims.name ?? '' };
  } catch {
    throw new clips.ClipError(401, 'Sessão da sala expirou. Recarregue a página.');
  }
}

async function clipRoute(req, res, path) {
  try {
    if (req.method === 'POST' && path === '/api/clips') {
      const who = await roomMember(req);
      const name = decodeURIComponent(String(req.headers['x-clip-name'] ?? ''));
      return send(res, 200, await clips.uploadClip(req, who.identity, name));
    }
    const m = /^\/api\/clips\/([\w-]+)$/.exec(path);
    if (req.method === 'DELETE' && m !== null) {
      return send(res, 200, await clips.deleteClip(m[1], String(req.headers['x-clip-token'] ?? '')));
    }
    return send(res, 404, { error: 'Não encontrado.' });
  } catch (e) {
    const status = e instanceof clips.ClipError ? e.status : 500;
    if (status === 500) console.error('[clipes]', e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Não foi possível guardar o clipe.' : e.message });
  }
}

// ---------- Diário de problemas: cada navegador manda as travadas que viu e o motivo provável.
// Vai para o log (docker compose logs app | grep diag) e, se DIAG_FILE estiver definido, para um
// arquivo JSONL (um registro por linha), que gira em 10 MB.
const DIAG_FILE = process.env.DIAG_FILE ?? '';
const DIAG_MAX_BYTES = 10 * 1024 * 1024;
const DIAG_CAUSES = new Set(['their-net', 'their-pc', 'my-net', 'my-pc', 'unknown']);
const diagRate = new Map(); // identidade -> { minute, count }

async function diagRoute(req, res) {
  try {
    const who = await roomMember(req);
    const claims = await verifier.verify(String(req.headers.authorization).slice(7));
    const body = await readJson(req);
    const minute = Math.floor(Date.now() / 60_000);
    const r = diagRate.get(who.identity);
    const used = r?.minute === minute ? r.count : 0;
    const events = (Array.isArray(body.events) ? body.events : []).slice(0, Math.max(0, 30 - used));
    diagRate.set(who.identity, { minute, count: used + events.length });
    const clean = (v, n = 60) => String(v ?? '').slice(0, n);
    const lines = [];
    for (const e of events) {
      if (!DIAG_CAUSES.has(e?.cause)) continue;
      const metrics = {};
      for (const [k, v] of Object.entries(e.metrics ?? {}).slice(0, 16)) {
        metrics[clean(k, 32)] = typeof v === 'number' && Number.isFinite(v) ? v : clean(v, 32);
      }
      const rec = {
        at: new Date(Number(e.at) || Date.now()).toISOString(),
        room: clean(claims.video?.room, 40),
        viewer: clean(who.name, 40),
        streamer: clean(e.who, 40),
        cause: e.cause,
        freezes: Math.min(999, Number(e.count) || 1),
        ...metrics,
      };
      lines.push(JSON.stringify(rec));
      console.log(`[diag] ${rec.viewer} viu ${rec.freezes} travada(s) em ${rec.streamer}: ${rec.cause}`);
    }
    if (DIAG_FILE !== '' && lines.length > 0) {
      const { appendFile, rename, stat } = await import('node:fs/promises');
      const size = await stat(DIAG_FILE).then((s) => s.size).catch(() => 0);
      if (size > DIAG_MAX_BYTES) await rename(DIAG_FILE, `${DIAG_FILE}.1`).catch(() => undefined);
      await appendFile(DIAG_FILE, lines.join('\n') + '\n').catch((e) => console.error('[diag] arquivo:', e.message));
    }
    send(res, 200, { ok: true, saved: lines.length });
  } catch (e) {
    const status = e instanceof clips.ClipError || e instanceof HttpError ? e.status : 500;
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Erro no servidor.' : e.message });
  }
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/api/clips' || path.startsWith('/api/clips/')) return clipRoute(req, res, path);
  if (path === '/api/diag' && req.method === 'POST') return diagRoute(req, res);
  const redirectRoute = redirects[`${req.method} ${path}`];
  if (redirectRoute !== undefined) return redirectRoute(req, res);
  const route = routes[`${req.method} ${path}`];
  if (route === undefined) {
    if (STATIC_DIR !== '' && req.method === 'GET' && !path.startsWith('/api/')) return serveStatic(req, res);
    return send(res, 404, { error: 'Não encontrado.' });
  }
  try {
    const body = req.method === 'POST' ? await readJson(req) : {};
    send(res, 200, await route(req, body));
  } catch (e) {
    const known = e instanceof HttpError || e instanceof discord.DiscordError;
    const status = known ? e.status : 500;
    if (status === 500) console.error(e);
    send(res, status, { error: known ? e.message : 'Erro no servidor.' });
  }
});

// HOST=127.0.0.1 em produção (rede do host): só o Caddy alcança a API.
server.listen(PORT, process.env.HOST || undefined, () => {
  console.log(`API do Noveau em http://localhost:${PORT} (LiveKit: ${LIVEKIT_HTTP_URL})`);
  if (STATIC_DIR !== '') console.log(`Servindo o site de ${STATIC_DIR}`);
  console.log(`Endereço do LiveKit que o navegador recebe: ${LIVEKIT_PUBLIC_URL !== '' ? LIVEKIT_PUBLIC_URL : 'ws://<endereço da página>:7880 (LIVEKIT_PUBLIC_URL vazio)'}`);
  console.log(discord.discordEnabled ? 'Login com Discord: ligado' : 'Login com Discord: desligado (faltam DISCORD_* no .env)');
  console.log(clips.clipsEnabled ? 'Clipes: ligados (Cloudflare R2)' : 'Clipes: desligados (faltam R2_* no .env)');
});
// Clipes grandes demoram para subir: não corta a conexão no meio.
server.requestTimeout = 10 * 60_000;
