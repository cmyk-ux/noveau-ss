// Transmitir pelo OBS: o OBS manda vídeo e som por WHIP (WebRTC) direto para o LiveKit.
//
// Por que assim:
//  - O LiveKit (1.13) já recebe WHIP sozinho em /whip/v1, sem o serviço livekit-ingress e sem
//    Redis. A mídia vai do OBS direto para as portas do LiveKit (7882/UDP, 7881/TCP), do mesmo
//    jeito que a de um navegador, e é repassada para quem assiste sem ser recodificada. O servidor
//    não gasta processador com isso (o chie tem 1 núcleo, transcodificar seria inviável).
//  - O OBS codifica na placa de vídeo (NVENC/AMF/QuickSync), com as configurações dele, e o
//    navegador de quem transmite nem precisa estar capturando a tela.
//
// O OBS só sabe falar com um endereço e um "Bearer Token". O token do LiveKit (JWT) vence e é
// enorme, então o OBS recebe uma chave nossa, assinada (HMAC), e este servidor faz a ponte:
//   POST   /api/whip            OBS manda a oferta SDP com a chave → criamos um JWT na hora e
//                               repassamos para o LiveKit; a resposta volta igual para o OBS.
//   PATCH  /api/whip/<sessão>   ICE (repassado).
//   DELETE /api/whip/<sessão>   OBS parou de transmitir (repassado).
//   POST   /api/obs/key         quem está na sala (com o token do LiveKit) pede a chave.
//
// Chave de quem entrou com o Discord: segue a call em que a pessoa estiver na hora em que o OBS
// conecta (vale 1 ano). Chave de sala por link: presa àquela sala (vale 30 dias).
//
// No LiveKit o OBS aparece como um participante à parte, "<nome> (OBS)", com os atributos
// obs=1 e obsOf=<id do Discord>. O site mostra a câmera dele como tela e o microfone como o som
// da tela (o LiveKit marca o que chega por WHIP como câmera + microfone).

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DISCORD_KEY_TTL_MS = 365 * 24 * 3600_000;
const ROOM_KEY_TTL_MS = 30 * 24 * 3600_000;
/** O JWT só é conferido na hora de conectar/desligar; a transmissão continua depois. */
const JWT_TTL = '10m';
const MAX_SDP_BYTES = 64 * 1024;
/** O OBS desiste depois de 8 s; não adianta esperar o LiveKit mais que isso. */
const LIVEKIT_TIMEOUT_MS = 7000;

export class ObsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * opts:
 *  - livekitHttpUrl, AccessToken, TrackSource, apiKey, apiSecret
 *  - secret: Buffer | null (null = aleatória, e as chaves morrem quando o servidor reinicia)
 *  - callRoom(discordId): { room, name } da call em que a pessoa está agora, ou null
 *  - verifyRoomToken(jwt): claims do token do LiveKit (para quem pede a chave)
 */
export function createObs(opts) {
  const secret = opts.secret ?? randomBytes(32);
  const base = opts.livekitHttpUrl.replace(/\/$/, '');
  /** sessão do LiveKit (PA_...) -> { room, identity, owner } para repassar PATCH/DELETE */
  const sessions = new Map();

  const mac = (body) => createHmac('sha256', secret).update(`obs:${body}`).digest('base64url');

  function sealKey(data) {
    const body = Buffer.from(JSON.stringify(data)).toString('base64url');
    return `${body}.${mac(body)}`;
  }

  function openKey(raw) {
    if (typeof raw !== 'string' || raw.length > 1000) return null;
    const [body, sig] = raw.split('.');
    if (!body || !sig) return null;
    const want = Buffer.from(mac(body));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString());
      return typeof data.exp === 'number' && data.exp > Date.now() && typeof data.n === 'string' ? data : null;
    } catch {
      return null;
    }
  }

  function bearer(req) {
    const auth = String(req.headers.authorization ?? '');
    return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  }

  /** Dono da chave, para conferir que PATCH/DELETE vêm do mesmo OBS que conectou. */
  const ownerOf = (key) => (key.d !== undefined ? `d:${key.d}` : `r:${key.r}:${key.n}`);

  /** POST /api/obs/key — precisa do token do LiveKit de quem está na sala. */
  async function issueKey(req) {
    const claims = await opts.verifyRoomToken(bearer(req)).catch(() => null);
    const room = claims?.video?.room;
    if (room === undefined || claims.attributes?.obs === '1') throw new ObsError(401, 'Entre numa sala para pegar a chave do OBS.');
    if (claims.attributes?.guest === '1') throw new ObsError(403, 'Quem entrou por convite não pode transmitir pelo OBS.');
    const name = String(claims.name || String(claims.sub ?? '').split('#')[0] || 'alguém').slice(0, 24);
    const discordId = claims.attributes?.discordId;
    const followsCall = typeof discordId === 'string' && discordId !== '' && opts.callRoom !== null && room.startsWith('d_');
    const key = followsCall
      ? sealKey({ d: discordId, n: name, exp: Date.now() + DISCORD_KEY_TTL_MS })
      : sealKey({ r: room, n: name, exp: Date.now() + ROOM_KEY_TTL_MS });
    return { token: key, followsCall, expiresAt: Date.now() + (followsCall ? DISCORD_KEY_TTL_MS : ROOM_KEY_TTL_MS), path: '/api/whip' };
  }

  async function roomOf(key) {
    if (key.d === undefined) return key.r;
    const call = await opts.callRoom(key.d);
    if (call === null) throw new ObsError(409, 'Entre numa call do Discord antes de iniciar a transmissão no OBS.');
    return call.room;
  }

  function identityOf(key) {
    // Fixa por dono: se o OBS reconectar, a sessão nova substitui a antiga (sem tela fantasma).
    return `obs-${createHash('sha256').update(ownerOf(key)).digest('base64url').slice(0, 10)}`;
  }

  async function jwtFor(room, identity, key) {
    const at = new opts.AccessToken(opts.apiKey, opts.apiSecret, {
      identity,
      name: `${key.n} (OBS)`,
      ttl: JWT_TTL,
      attributes: { obs: '1', obsName: key.n, ...(key.d !== undefined ? { obsOf: key.d } : {}) },
    });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: false,
      canPublishData: false,
      canPublishSources: [opts.TrackSource.CAMERA, opts.TrackSource.MICROPHONE],
    });
    return at.toJwt();
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_SDP_BYTES) reject(new ObsError(413, 'SDP grande demais.'));
        else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      req.on('error', reject);
    });
  }

  function cors(res) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', 'POST, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-expose-headers', 'Location, Link, ETag');
  }

  async function livekit(method, path, jwt, headers, body) {
    return fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, ...headers },
      body,
      signal: AbortSignal.timeout(LIVEKIT_TIMEOUT_MS),
    });
  }

  async function create(req, res) {
    const key = openKey(bearer(req));
    if (key === null) throw new ObsError(401, 'Chave do OBS inválida ou vencida. Pegue outra no site.');
    if (!String(req.headers['content-type'] ?? '').startsWith('application/sdp')) throw new ObsError(415, 'Esperava application/sdp.');
    const offer = await readBody(req);
    const room = await roomOf(key);
    const identity = identityOf(key);
    const r = await livekit('POST', '/whip/v1', await jwtFor(room, identity, key), { 'content-type': 'application/sdp' }, offer);
    const answer = await r.text();
    if (r.status !== 201) {
      console.error(`[obs] LiveKit recusou a transmissão de ${key.n}: ${r.status} ${answer.slice(0, 200)}`);
      throw new ObsError(r.status >= 500 ? 502 : r.status, `O LiveKit recusou: ${answer.slice(0, 200) || r.status}`);
    }
    const location = r.headers.get('location') ?? '';
    const session = location.slice(location.lastIndexOf('/') + 1);
    if (session === '') throw new ObsError(502, 'O LiveKit não devolveu a sessão.');
    sessions.set(session, { room, identity, owner: ownerOf(key), key, at: Date.now() });
    console.log(`[obs] ${key.n} começou a transmitir pelo OBS (${session})`);
    cors(res);
    const headers = { 'content-type': 'application/sdp', location: `/api/whip/${session}` };
    const etag = r.headers.get('etag');
    if (etag) headers.etag = etag;
    // Servidores STUN/TURN que o LiveKit sugere (Link: <...>; rel="ice-server").
    const links = r.headers.get('link');
    if (links) headers.link = links;
    res.writeHead(201, headers);
    res.end(answer);
  }

  async function resource(req, res, session) {
    const key = openKey(bearer(req));
    const s = sessions.get(session);
    if (key === null || s === undefined || s.owner !== ownerOf(key)) throw new ObsError(404, 'Sessão do OBS não encontrada.');
    const headers = {};
    for (const h of ['content-type', 'if-match']) if (req.headers[h]) headers[h] = String(req.headers[h]);
    const body = req.method === 'PATCH' ? await readBody(req) : undefined;
    const r = await livekit(req.method, `/whip/v1/${session}`, await jwtFor(s.room, s.identity, s.key), headers, body);
    if (req.method === 'DELETE') {
      sessions.delete(session);
      console.log(`[obs] ${s.key.n} parou de transmitir pelo OBS`);
    }
    cors(res);
    const out = {};
    for (const h of ['content-type', 'etag']) if (r.headers.get(h)) out[h] = r.headers.get(h);
    res.writeHead(r.status, out);
    res.end(Buffer.from(await r.arrayBuffer()));
  }

  /** Atende /api/whip e /api/whip/<sessão>. Devolve false se o caminho não é daqui. */
  async function route(req, res, path) {
    if (path !== '/api/whip' && !path.startsWith('/api/whip/')) return false;
    try {
      if (req.method === 'OPTIONS') {
        cors(res);
        res.setHeader('accept-post', 'application/sdp');
        res.writeHead(204);
        res.end();
      } else if (path === '/api/whip' && req.method === 'POST') {
        await create(req, res);
      } else if (path === '/api/whip' && req.method === 'GET') {
        res.writeHead(204);
        res.end();
      } else {
        const session = path.slice('/api/whip/'.length);
        if (!/^[\w-]{1,64}$/.test(session) || (req.method !== 'PATCH' && req.method !== 'DELETE')) {
          throw new ObsError(405, 'Método não suportado.');
        }
        await resource(req, res, session);
      }
    } catch (e) {
      const known = e instanceof ObsError;
      if (!known) console.error('[obs]', e);
      if (!res.headersSent) {
        cors(res);
        res.writeHead(known ? e.status : 502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(known ? e.message : 'Não foi possível falar com o LiveKit.');
      }
    }
    return true;
  }

  /** Limpeza: sessões antigas (OBS fechado sem DELETE) somem depois de 2 dias. */
  setInterval(() => {
    const old = Date.now() - 2 * 24 * 3600_000;
    for (const [id, s] of sessions) if (s.at < old) sessions.delete(id);
  }, 3600_000).unref();

  return { issueKey, route, openKey, sealKey };
}
