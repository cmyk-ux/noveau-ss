// Plugin de DAW: o som sai do plugin (VST3/AU) direto para este servidor, sem compressão, e é
// repassado para quem está na sala ouvindo. Não passa pelo navegador de quem toca, então funciona
// com ASIO, com a DAW em tela cheia e com o site fechado.
//
// Pareamento: alguém na sala pede um código (POST /api/daw/pair). Digita o código no plugin. O
// plugin troca o código por uma "chave de volta", que ele guarda no projeto da DAW e usa para
// reconectar sozinho por 24 h (se a internet cair, se reabrir o projeto).
//
// WebSockets (o Caddy repassa sem configuração extra):
//   /api/daw/send    o plugin manda {"t":"hello","code"|"resume"} e depois pacotes de áudio.
//   /api/daw/listen  o navegador manda {"t":"auth","token":<token do LiveKit>} e recebe:
//                    texto {"t":"on",id,name,rate,format,channels} / {"t":"off",id}
//                    binário [1 byte tamanho do id][id][pacote do plugin, como chegou]
//
// Pacote de áudio (cabeçalho de 16 bytes, little-endian, amostras intercaladas L R):
//   0 'S' | 1 versão 2 | 2 formato (16 = int16, 24 = int24, 32 = float32) | 3 canais (1 ou 2)
//   4..7 número de sequência | 8..9 frames | 10..11 livre | 12..15 taxa de amostragem (Hz)

import { randomBytes, randomInt } from 'node:crypto';
import { WebSocketServer } from 'ws';

export const HEADER = 16;
const RATES = new Set([44100, 48000, 88200, 96000, 176400, 192000]);
const FORMATS = new Set([16, 24, 32]);
const CODE_TTL_MS = 10 * 60_000;
const RESUME_TTL_MS = 24 * 60 * 60_000;
/** Teto por plugin: 192 kHz float estéreo dá 1,5 MB/s; folga para rajadas depois de um engasgo. */
const MAX_BYTES_PER_SEC = 4 * 1024 * 1024;
/** Se um ouvinte acumulou isso sem conseguir receber (rede ruim), pula pacotes só para ele. */
const LISTENER_BACKLOG = 2 * 1024 * 1024;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** código -> { room, name, owner, expiresAt } */
const codes = new Map();
/** chave de volta -> { id, room, name, owner, expiresAt } */
const resumes = new Map();
/** sala -> { senders: Map<id, {ws, info}>, listeners: Set<ws> } */
const rooms = new Map();

export class DawError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
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

function handleSender(ws) {
  let session = null; // { id, room, name, key }
  let budget = MAX_BYTES_PER_SEC;
  let budgetAt = Date.now();
  let lastFormat = '';
  const hello = setTimeout(() => ws.close(4001, 'sem hello'), 10_000);

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg?.t !== 'hello' || session !== null) return;
      clearTimeout(hello);
      const now = Date.now();
      let grant = null;
      let resume = typeof msg.resume === 'string' ? msg.resume : '';
      if (resume !== '' && resumes.has(resume) && resumes.get(resume).expiresAt > now) {
        grant = resumes.get(resume);
      } else if (msg.code !== undefined) {
        const code = normalizeCode(msg.code);
        const c = codes.get(code);
        if (c !== undefined && c.expiresAt > now) {
          codes.delete(code);
          resume = randomBytes(24).toString('base64url');
          grant = { id: `daw-${randomBytes(5).toString('hex')}`, room: c.room, owner: c.owner, name: c.name };
          resumes.set(resume, grant);
        }
      }
      if (grant === null) {
        sendJson(ws, { t: 'error', message: resume !== '' && msg.code === undefined ? 'Conexão vencida. Gere um código novo no site.' : 'Código inválido ou vencido. Gere outro no site.' });
        ws.close(4003, 'código');
        return;
      }
      grant.expiresAt = now + RESUME_TTL_MS;
      const r = roomState(grant.room);
      // A mesma instância do plugin reconectando: derruba a conexão antiga.
      r.senders.get(grant.id)?.ws.close(4000, 'substituído');
      session = { ...grant, key: resume };
      r.senders.set(grant.id, { ws, info: null });
      sendJson(ws, { t: 'ok', name: grant.name, resume, listeners: r.listeners.size, expiresAt: grant.expiresAt });
      console.log(`[daw] plugin de ${grant.name} conectou (${grant.id})`);
      return;
    }
    if (session === null) return;
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
    if (session === null) return;
    const r = rooms.get(session.room);
    if (r?.senders.get(session.id)?.ws === ws) {
      r.senders.delete(session.id);
      for (const l of r.listeners) sendJson(l, { t: 'off', id: session.id });
      console.log(`[daw] plugin de ${session.name} desconectou (${session.id})`);
    }
    maybeDrop(session.room);
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
 * Liga os WebSockets do plugin no servidor HTTP. `verify(token)` confere um token do LiveKit e
 * devolve as claims (para saber a sala de quem vai ouvir).
 */
export function attachDaw(server, verify) {
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
      if (path === '/api/daw/send') handleSender(ws);
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
    const now = Date.now();
    for (const [k, v] of resumes) if (v.expiresAt < now) resumes.delete(k);
  }, 15_000).unref();
}

export { listenerCount };
