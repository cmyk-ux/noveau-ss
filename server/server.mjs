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

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { AccessToken, IngressClient, IngressInput, TrackSource } from 'livekit-server-sdk';

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

async function token(req, body) {
  const room = checkLink(body);
  const name = cleanName(body.name);
  if (name === '') throw new HttpError(400, 'Digite um apelido.');
  const identity = `${name}#${randomBytes(4).toString('base64url').slice(0, 6)}`;
  const at = new AccessToken(API_KEY, API_SECRET, { identity, name, ttl: TOKEN_TTL });
  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
    canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO, TrackSource.CAMERA, TrackSource.MICROPHONE],
  });
  return { token: await at.toJwt(), url: publicUrl(req), name, canPublish: true, camera: CAMERA_INGRESS };
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
  'GET /api/config': async () => ({ requiresSecret: INSTANCE_SECRET !== '' }),
  'POST /api/token': (req, body) => token(req, body),
  'POST /api/camera': (_req, body) => camera(body),
  'POST /api/camera/stop': (_req, body) => stopCamera(body),
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const route = routes[`${req.method} ${path}`];
  if (route === undefined) {
    if (STATIC_DIR !== '' && req.method === 'GET' && !path.startsWith('/api/')) return serveStatic(req, res);
    return send(res, 404, { error: 'Não encontrado.' });
  }
  try {
    const body = req.method === 'POST' ? await readJson(req) : {};
    send(res, 200, await route(req, body));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    send(res, status, { error: e instanceof HttpError ? e.message : 'Erro no servidor.' });
  }
});

server.listen(PORT, () => {
  console.log(`API do Noveau em http://localhost:${PORT} (LiveKit: ${LIVEKIT_HTTP_URL})`);
  if (STATIC_DIR !== '') console.log(`Servindo o site de ${STATIC_DIR}`);
});
