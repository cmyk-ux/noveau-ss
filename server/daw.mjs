// Plugin de DAW: o som sai do plugin (VST3/AU) direto para este servidor, sem compressão, e é
// repassado para quem está na sala ouvindo. Não passa pelo navegador de quem toca, então funciona
// com ASIO, com a DAW em tela cheia e com o site fechado.
//
// Dois jeitos de ligar o plugin:
//  - Conta do Discord (o jeito fácil): o plugin pede um pedido de conexão, abre o navegador em
//    /plugin?c=CÓDIGO e a pessoa (logada com o Discord) confirma. Daí em diante o plugin guarda
//    uma chave assinada no PC e segue a call do Discord em que a pessoa estiver, sozinho.
//  - Código da sala (salas fora do Discord): alguém na sala pede um código (POST /api/daw/pair) e
//    digita no plugin.
// As chaves que o plugin guarda são assinadas (HMAC), então valem mesmo depois de reiniciar o
// servidor. A do Discord vale 1 ano e a da sala 24 h, renovadas a cada conexão.
//
// WebSockets (o Caddy repassa sem configuração extra):
//   /api/daw/send    o plugin manda {"t":"hello", "code"|"resume"|"link":true, "instance"} e depois
//                    pacotes de áudio. Recebe {"t":"link",code}, {"t":"ok",name,resume,mode},
//                    {"t":"room",call,listeners}, {"t":"listeners",n} e {"t":"error",message}.
//   /api/daw/listen  o navegador manda {"t":"auth","token":<token do LiveKit>} e recebe:
//                    texto {"t":"on",id,name,rate?,format?,channels?} / {"t":"off",id}
//                    ("on" sai ao entrar na sala, sem formato, e de novo com o formato no 1º pacote)
//                    binário [1 byte tamanho do id][id][pacote do plugin, como chegou]
//
// Pacote de áudio (cabeçalho de 16 bytes, little-endian, amostras intercaladas L R):
//   0 'S' | 1 versão 2 | 2 formato (16 = int16, 24 = int24, 32 = float32) | 3 canais (1 ou 2)
//   4..7 número de sequência | 8..9 frames | 10..11 livre | 12..15 taxa de amostragem (Hz)

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

export const HEADER = 16;
const RATES = new Set([44100, 48000, 88200, 96000, 176400, 192000]);
const FORMATS = new Set([16, 24, 32]);
const CODE_TTL_MS = 10 * 60_000;
const ROOM_KEY_TTL_MS = 24 * 60 * 60_000;
const USER_KEY_TTL_MS = 365 * 24 * 60 * 60_000;
/** De quanto em quanto tempo o servidor confere em qual call do Discord a pessoa está. */
const FOLLOW_MS = 3000;
/** Teto por plugin: 192 kHz float estéreo dá 1,5 MB/s; folga para rajadas depois de um engasgo. */
const MAX_BYTES_PER_SEC = 4 * 1024 * 1024;
/** Se um ouvinte acumulou isso sem conseguir receber (rede ruim), pula pacotes só para ele. */
const LISTENER_BACKLOG = 2 * 1024 * 1024;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** código -> { room, name, owner, expiresAt } */
const codes = new Map();
/** pedido de conexão pelo Discord -> { expiresAt, done(user) } (só enquanto o plugin espera) */
const links = new Map();
/** sala -> { senders: Map<id, {ws, info}>, listeners: Set<ws> } */
const rooms = new Map();

/** Chave para assinar o que o plugin guarda. attachDaw troca pela do .env (SESSION_SECRET). */
let secret = randomBytes(32);

export class DawError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function mac(body) {
  return createHmac('sha256', secret).update(`daw:${body}`).digest('base64url');
}

/** Chave que o plugin guarda: os dados + assinatura. */
function sealKey(data) {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${body}.${mac(body)}`;
}

function openKey(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  const [body, sig] = raw.split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    return typeof data.exp === 'number' && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function newCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function normalizeCode(code) {
  const raw = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : '';
}

function roomState(room) {
  let r = rooms.get(room);
  if (r === undefined) {
    r = { senders: new Map(), listeners: new Set() };
    rooms.set(room, r);
  }
  return r;
}

function maybeDrop(room) {
  const r = rooms.get(room);
  if (r !== undefined && r.senders.size === 0 && r.listeners.size === 0) rooms.delete(room);
}

function sendJson(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}

function listenerCount(room) {
  return rooms.get(room)?.listeners.size ?? 0;
}

function tellSenders(room) {
  const r = rooms.get(room);
  if (r === undefined) return;
  for (const s of r.senders.values()) sendJson(s.ws, { t: 'listeners', n: r.listeners.size });
}

/** Alguém na sala pede um código para digitar no plugin. */
export function createPairCode(room, owner, name) {
  const now = Date.now();
  for (const [c, v] of codes) if (v.expiresAt < now) codes.delete(c);
  // Um código por pessoa por vez: pedir de novo invalida o anterior.
  for (const [c, v] of codes) if (v.owner === owner) codes.delete(c);
  let code = newCode();
  while (codes.has(code)) code = newCode();
  const expiresAt = now + CODE_TTL_MS;
  codes.set(code, { room, owner, name: String(name || 'alguém').slice(0, 40), expiresAt });
  return { code, expiresAt };
}

/** Pacote do plugin é válido? Devolve a descrição do formato ou null. */
export function parsePacket(buf) {
  if (buf.length < HEADER || buf[0] !== 0x53 || buf[1] !== 2) return null;
  const format = buf[2];
  const channels = buf[3];
  const frames = buf.readUInt16LE(8);
  const rate = buf.readUInt32LE(12);
  if (!FORMATS.has(format) || channels < 1 || channels > 2 || !RATES.has(rate) || frames === 0 || frames > 9600) return null;
  if (buf.length !== HEADER + frames * channels * (format / 8)) return null;
  return { format, channels, rate, frames };
}

/** Id do fluxo: o mesmo para a mesma cópia do plugin (reconectar substitui), outro para outra cópia. */
function streamId(base, instance) {
  const inst = typeof instance === 'string' && instance !== '' ? instance.slice(0, 64) : randomBytes(6).toString('hex');
  return `daw-${createHash('sha256').update(`${base}:${inst}`).digest('hex').slice(0, 12)}`;
}

/**
 * Alguém logado no site confirmou o pedido de conexão que o plugin abriu no navegador.
 * user = { id, name } do Discord.
 */
export function confirmLink(code, user) {
  const c = normalizeCode(code);
  const l = links.get(c);
  if (l === undefined || l.expiresAt < Date.now()) {
    throw new DawError(404, 'Esse pedido venceu ou já foi usado. Clique em "Conectar" no plugin de novo.');
  }
  links.delete(c);
  l.done(user);
  return { ok: true };
}

function handleSender(ws, callRoom) {
  /** { kind: 'user'|'room', id, name, uid?, owner?, base, room, call } depois do hello. */
  let session = null;
  let budget = MAX_BYTES_PER_SEC;
  let budgetAt = Date.now();
  let lastFormat = '';
  let follow = null;
  let linkCode = null;
  let linkTimer = null;
  const hello = setTimeout(() => ws.close(4001, 'sem hello'), 10_000);

  const fail = (message) => {
    sendJson(ws, { t: 'error', message });
    ws.close(4003, 'recusado');
  };

  /** Sai da sala atual (avisa quem ouvia). */
  const leave = () => {
    if (session?.room == null) return;
    const room = session.room;
    session.room = null;
    const r = rooms.get(room);
    if (r?.senders.get(session.id)?.ws === ws) {
      r.senders.delete(session.id);
      for (const l of r.listeners) sendJson(l, { t: 'off', id: session.id });
    }
    maybeDrop(room);
  };

  /** Passa a mandar o som para outra sala (ou para nenhuma, fora de call). */
  const moveTo = (room, call) => {
    if (session.room === room && session.call === call) return;
    if (session.room !== room) {
      leave();
      lastFormat = '';
      if (room !== null) {
        const r = roomState(room);
        // A mesma cópia do plugin reconectando: derruba a conexão antiga.
        const old = r.senders.get(session.id);
        if (old !== undefined && old.ws !== ws) old.ws.close(4000, 'substituído');
        // Avisa na hora quem ouve, mesmo sem som ainda (DAW parada não chama o plugin): os
        // controles aparecem e ficam até o plugin sair da master ou a DAW fechar ('off').
        const info = { t: 'on', id: session.id, name: session.name };
        r.senders.set(session.id, { ws, info });
        for (const l of r.listeners) sendJson(l, info);
        session.room = room;
      }
    }
    session.call = call;
    sendJson(ws, { t: 'room', call, listeners: room === null ? 0 : listenerCount(room) });
  };

  const followCall = async () => {
    let c;
    try {
      c = await callRoom(session.uid);
    } catch {
      return; // Discord fora do ar: fica onde está e tenta de novo
    }
    if (ws.readyState !== ws.OPEN) return;
    moveTo(c?.room ?? null, c?.name ?? null);
  };

  /** Libera o plugin: manda a chave nova (renovada) e começa a tocar. */
  const begin = (grant, instance) => {
    const now = Date.now();
    if (grant.k === 'user') {
      const exp = now + USER_KEY_TTL_MS;
      session = { kind: 'user', uid: grant.uid, name: grant.name, id: streamId(`u:${grant.uid}`, instance), room: null, call: null };
      sendJson(ws, { t: 'ok', mode: 'discord', name: grant.name, resume: sealKey({ k: 'user', uid: grant.uid, name: grant.name, exp }), expiresAt: exp });
      console.log(`[daw] plugin de ${grant.name} conectou pela conta do Discord (${session.id})`);
      void followCall();
      follow = setInterval(() => void followCall(), FOLLOW_MS);
    } else {
      const exp = now + ROOM_KEY_TTL_MS;
      session = { kind: 'room', name: grant.name, owner: grant.owner, id: streamId(`r:${grant.base}`, instance), room: null, call: null };
      const key = sealKey({ k: 'room', base: grant.base, room: grant.room, owner: grant.owner, name: grant.name, exp });
      sendJson(ws, { t: 'ok', mode: 'room', name: grant.name, resume: key, expiresAt: exp });
      console.log(`[daw] plugin de ${grant.name} conectou com código (${session.id})`);
      moveTo(grant.room, null);
    }
  };

  const onHello = (msg) => {
    clearTimeout(hello);
    const now = Date.now();
    const instance = typeof msg.instance === 'string' ? msg.instance : '';
    const resume = typeof msg.resume === 'string' ? msg.resume : '';
    if (resume !== '') {
      const k = openKey(resume);
      if (k?.k === 'user' && typeof k.uid === 'string' && callRoom !== null) return begin(k, instance);
      if (k?.k === 'room' && typeof k.room === 'string') return begin(k, instance);
      if (msg.code === undefined && msg.link !== true) {
        return fail('A conexão venceu. Conecte o plugin de novo.');
      }
    }
    if (msg.link === true) {
      if (callRoom === null) return fail('Este servidor não tem login com Discord. Use o código da sala.');
      for (const [c, v] of links) if (v.expiresAt < now) links.delete(c);
      let code = newCode();
      while (links.has(code) || codes.has(code)) code = newCode();
      linkCode = code;
      links.set(code, { expiresAt: now + CODE_TTL_MS, done: (user) => begin({ k: 'user', uid: user.id, name: String(user.name || 'alguém').slice(0, 40) }, instance) });
      linkTimer = setTimeout(() => fail('O tempo para confirmar no site acabou. Clique em "Conectar com o Discord" de novo.'), CODE_TTL_MS);
      sendJson(ws, { t: 'link', code, expiresAt: now + CODE_TTL_MS });
      return;
    }
    const code = normalizeCode(msg.code);
    const c = codes.get(code);
    if (c === undefined || c.expiresAt <= now) return fail('Código inválido ou vencido. Gere outro no site.');
    codes.delete(code);
    begin({ k: 'room', base: randomBytes(8).toString('hex'), room: c.room, owner: c.owner, name: c.name }, instance);
  };

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg?.t === 'hello' && session === null && linkCode === null) onHello(msg);
      return;
    }
    if (session?.room == null) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
    const now = Date.now();
    budget = Math.min(MAX_BYTES_PER_SEC, budget + ((now - budgetAt) / 1000) * MAX_BYTES_PER_SEC);
    budgetAt = now;
    if (buf.length > budget) return; // acima do teto: descarta
    budget -= buf.length;
    const p = parsePacket(buf);
    if (p === null) return;
    const r = rooms.get(session.room);
    if (r === undefined) return;
    const me = r.senders.get(session.id);
    if (me === undefined || me.ws !== ws) return;
    const fmt = `${p.rate}/${p.format}/${p.channels}`;
    if (fmt !== lastFormat) {
      lastFormat = fmt;
      me.info = { t: 'on', id: session.id, name: session.name, rate: p.rate, format: p.format, channels: p.channels };
      for (const l of r.listeners) sendJson(l, me.info);
    }
    if (r.listeners.size === 0) return;
    const id = Buffer.from(session.id);
    const frame = Buffer.concat([Buffer.from([id.length]), id, buf]);
    for (const l of r.listeners) {
      if (l.readyState === l.OPEN && l.bufferedAmount < LISTENER_BACKLOG) l.send(frame);
    }
  });

  ws.on('close', () => {
    clearTimeout(hello);
    clearTimeout(linkTimer);
    clearInterval(follow);
    if (linkCode !== null && session === null) links.delete(linkCode);
    if (session === null) return;
    leave();
    console.log(`[daw] plugin de ${session.name} desconectou (${session.id})`);
  });
}

function handleListener(ws, verify) {
  let room = null;
  const auth = setTimeout(() => ws.close(4001, 'sem auth'), 10_000);
  ws.on('message', async (data, isBinary) => {
    if (isBinary || room !== null) return;
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg?.t !== 'auth') return;
    clearTimeout(auth);
    const claims = await verify(String(msg.token ?? '')).catch(() => null);
    const r0 = claims?.video?.room;
    if (typeof r0 !== 'string' || r0 === '') {
      sendJson(ws, { t: 'error', message: 'Sessão da sala expirou.' });
      ws.close(4003, 'token');
      return;
    }
    room = r0;
    const r = roomState(room);
    r.listeners.add(ws);
    for (const s of r.senders.values()) if (s.info !== null) sendJson(ws, s.info);
    tellSenders(room);
  });
  ws.on('close', () => {
    clearTimeout(auth);
    if (room === null) return;
    rooms.get(room)?.listeners.delete(ws);
    tellSenders(room);
    maybeDrop(room);
  });
}

/**
 * Liga os WebSockets do plugin no servidor HTTP.
 *  - verify(token): confere um token do LiveKit e devolve as claims (a sala de quem vai ouvir).
 *  - options.secret: chave para assinar o que o plugin guarda (sem ela, vale só até reiniciar).
 *  - options.callRoom(discordId): { room, name } da call em que a pessoa está, ou null. Sem isso,
 *    só o código da sala funciona.
 */
export function attachDaw(server, verify, options = {}) {
  if (options.secret) secret = options.secret;
  const callRoom = options.callRoom ?? null;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path !== '/api/daw/send' && path !== '/api/daw/listen') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));
      ws.on('error', () => undefined);
      if (path === '/api/daw/send') handleSender(ws, callRoom);
      else handleListener(ws, verify);
    });
  });
  // Derruba conexões mortas (Wi-Fi caiu sem fechar) para o plugin perceber e reconectar.
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15_000).unref();
}

export { listenerCount };
