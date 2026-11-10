// Teste de ponta a ponta: servidor de verdade (server/server.mjs) + o código de rede do plugin
// (stream_test) + um ouvinte que decodifica como o site. Não precisa de LiveKit nem de DAW.
//
//   cmake -B build -DNOVEAU_TESTS=ON && cmake --build build --target stream_test packet_test
//   node plugin/Tests/e2e.mjs build/stream_test_artefacts/Release/stream_test [build/packet_test]
// Testa o código de sala e a conta do Discord (com um Discord falso).
import { spawn, execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(join(root, 'server/package.json'));
const { WebSocket } = require('ws');
const { AccessToken } = require('livekit-server-sdk');
const { parsePacket, HEADER } = await import(join(root, 'server/daw.mjs'));

const streamTest = process.argv[2];
const packetTest = process.argv[3];
const PORT = 3997;
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok ' : 'ERRO'} ${what}`);
  if (!ok) failed = true;
};

/** Igual a decode() em web/src/app/core/studio.ts. */
function decode(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const bits = v.getUint8(2), ch = v.getUint8(3), frames = v.getUint16(8, true);
  const out = new Float32Array(frames * 2);
  let o = HEADER;
  for (let i = 0, j = 0; i < frames * ch; i++, j += 2 / ch) {
    let x;
    if (bits === 16) { x = v.getInt16(o, true) / 0x8000; o += 2; }
    else if (bits === 24) { x = (v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) / 0x800000; o += 3; }
    else { x = v.getFloat32(o, true); o += 4; }
    out[j] = x;
    if (ch === 1) out[j + 1] = x;
  }
  return out;
}

// 1) Pacotes gravados pelo packet_test (C++) passam no servidor e decodificam certo.
if (packetTest) {
  const dir = mkdtempSync(join(tmpdir(), 'noveau-pk-'));
  execFileSync(packetTest, [dir]);
  const want = [0, 1, -1, 0.5, -0.25, 1.5, -2, 0.123456789, 3e-6, -0.999999].map(Math.fround);
  for (const [name, tol] of [['16', 1 / 32768], ['24', 1 / 8388608], ['32', 0]]) {
    const b = readFileSync(join(dir, `packet-${name}.bin`));
    const p = parsePacket(b);
    check(p !== null && p.rate === 44100 && p.format === Number(name), `pacote ${name}-bit aceito pelo servidor`);
    const got = decode(b);
    const clip = (x) => (name === '32' ? x : Math.max(-1, Math.min(1 - 2 * tol, x)));
    check(want.every((w, i) => Math.abs(got[i] - clip(w)) <= tol), `pacote ${name}-bit decodifica igual (tolerância ${tol})`);
  }
  const mono = readFileSync(join(dir, 'packet-mono.bin'));
  const m = decode(mono);
  check(parsePacket(mono)?.channels === 1 && m[0] === m[1] && m[2] === Math.fround(1) && m[3] === m[2], 'mono vira L = R');
}

// 2) Servidor + plugin + ouvinte. O Discord é falso (DISCORD_API_URL): diz em qual call cada um está.
const GUILD = 'g1';
const SECRET = 'segredo-de-teste';
const DISCORD_PORT = PORT - 1;
const voice = new Map(); // id do Discord -> id do canal
const fakeDiscord = createServer((req, res) => {
  const vs = /^\/guilds\/g1\/voice-states\/(\w+)$/.exec(req.url);
  const ch = /^\/channels\/(\w+)$/.exec(req.url);
  res.setHeader('content-type', 'application/json');
  if (vs && voice.has(vs[1])) return res.end(JSON.stringify({ channel_id: voice.get(vs[1]) }));
  if (ch) return res.end(JSON.stringify({ name: `sala-${ch[1]}` }));
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((r) => fakeDiscord.listen(DISCORD_PORT, '127.0.0.1', r));

const env = {
  ...process.env,
  PORT: String(PORT),
  SESSION_SECRET: SECRET,
  DISCORD_CLIENT_ID: 'c',
  DISCORD_CLIENT_SECRET: 's',
  DISCORD_BOT_TOKEN: 'x',
  DISCORD_GUILD_ID: GUILD,
  DISCORD_API_URL: `http://127.0.0.1:${DISCORD_PORT}`,
};
let server = null;
async function startServer() {
  server = spawn(process.execPath, [join(root, 'server/server.mjs')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('API do Noveau') && r()));
}
const base = `http://127.0.0.1:${PORT}`;
const callRoom = (channel) => 'd_' + createHash('sha256').update(`${GUILD}:${channel}`).digest('hex').slice(0, 32);
/** Cookie de login igual ao do discord.mjs (assinado com SESSION_SECRET). */
function sessionCookie(id, name) {
  const body = Buffer.from(JSON.stringify({ id, name, avatar: null, exp: Date.now() + 3600e3 })).toString('base64url');
  return `noveau_session=${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}
const jwt = async (identity, name, room = 'c_e2e') => {
  const t = new AccessToken(process.env.LIVEKIT_API_KEY ?? 'devkey', process.env.LIVEKIT_API_SECRET ?? 'secret', { identity, name });
  t.addGrant({ room, roomJoin: true });
  return t.toJwt();
};

/** Ouvinte como o site: guarda "on"/"off" e os pacotes que chegam. */
async function listen(room) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/daw/listen`);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'auth', token: await jwt(`ouvinte-${room}`, 'Ana', room) }));
  const l = { ws, on: null, off: false, packets: [] };
  ws.on('message', (d, bin) => {
    if (!bin) {
      const m = JSON.parse(String(d));
      if (m.t === 'on') l.on = m;
      if (m.t === 'off') l.off = true;
      return;
    }
    l.packets.push(d.subarray(1 + d[0]));
  });
  await new Promise((r) => setTimeout(r, 200));
  return l;
}

/** Roda o stream_test; onLine recebe cada linha (para confirmar o pedido de conexão no meio). */
function runPlugin(args, onLine = () => undefined) {
  return new Promise((resolve) => {
    const p = spawn(streamTest, [base, ...args.map(String)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    let pending = '';
    p.stdout.on('data', (d) => {
      out += d;
      pending += d;
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        onLine(pending.slice(0, i));
        pending = pending.slice(i + 1);
      }
    });
    const timer = setTimeout(() => p.kill(), 30_000);
    p.on('close', (code) => {
      clearTimeout(timer);
      process.stdout.write(out.trimEnd().replace(/^/gm, '   plugin: ') + '\n');
      resolve({ code, out });
    });
  });
}

/** O seno de 1 kHz do stream_test chegou inteiro e sem erro? */
function checkAudio(label, packets, rate, fmt, seconds) {
  const frames = packets.reduce((s, p) => s + parsePacket(p).frames, 0);
  check(Math.abs(frames - rate * seconds) <= rate / 100, `${label}: chegaram ${frames} de ${rate * seconds} frames`);
  const seqs = packets.map((p) => p.readUInt32LE(4));
  check(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), `${label}: sequência sem buracos (${seqs.length} pacotes)`);
  let n = 0, worst = 0, exact = 0;
  for (const p of packets) {
    const pcm = decode(p);
    for (let i = 0; i < pcm.length; i += 2, n++) {
      const want = Math.fround(0.5 * Math.fround(Math.sin((2 * Math.PI * 1000 * n) / rate)));
      worst = Math.max(worst, Math.abs(pcm[i] - want), Math.abs(pcm[i + 1] + want));
      if (pcm[i] === want && pcm[i + 1] === -want) exact++;
    }
  }
  const tol = fmt === 32 ? 1e-7 : 1 / 2 ** (fmt - 1);
  check(worst <= tol, `${label}: maior erro ${worst.toExponential(2)} (limite ${tol.toExponential(2)})${fmt === 32 ? `, ${((exact / n) * 100).toFixed(2)}% idênticas bit a bit` : ''}`);
}

const keyOf = (out) => /^KEY discord (\S+)$/m.exec(out)?.[1] ?? '';

await startServer();
try {
  // 2a) Código de sala (salas fora do Discord), nas três profundidades.
  for (const [rate, fmt] of [[48000, 24], [96000, 32], [44100, 16]]) {
    const pair = await (await fetch(`${base}/api/daw/pair`, { method: 'POST', headers: { authorization: `Bearer ${await jwt('pedro#1', 'Pedro')}` } })).json();
    const l = await listen('c_e2e');
    await runPlugin([`code:${pair.code}`, rate, fmt]);
    await new Promise((r) => setTimeout(r, 300));
    l.ws.close();
    const label = `código, ${rate} Hz ${fmt}-bit`;
    check(l.on?.name === 'Pedro' && l.on.rate === rate && l.on.format === fmt, `${label}: site recebeu "on" com nome, taxa e formato`);
    checkAudio(label, l.packets, rate, fmt, 2);
  }

  // 2b) Conta do Discord: o plugin pede, a pessoa confirma no site, o som vai para a call dela.
  voice.set('111', 'c1');
  const l1 = await listen(callRoom('c1'));
  let refused = null;
  const linked = await runPlugin(['link', 48000, 24], (line) => {
    const m = /^LINK (\S+)$/.exec(line);
    if (m === null) return;
    void (async () => {
      refused = (await fetch(`${base}/api/daw/link`, { method: 'POST', body: JSON.stringify({ code: m[1] }) })).status;
      const r = await fetch(`${base}/api/daw/link`, { method: 'POST', headers: { cookie: sessionCookie('111', 'Pedro') }, body: JSON.stringify({ code: m[1] }) });
      check(r.ok, `site confirmou o pedido de conexão ${m[1]}`);
    })();
  });
  await new Promise((r) => setTimeout(r, 300));
  check(refused === 401, 'confirmar sem login no Discord é recusado');
  check(/call=sala-c1/.test(linked.out), 'plugin sabe em qual call está');
  check(l1.on?.name === 'Pedro', 'quem está na sala da call recebeu "on" com o nome do Discord');
  checkAudio('Discord', l1.packets, 48000, 24, 2);
  const key = keyOf(linked.out);
  check(key !== '', 'plugin recebeu a chave da conta para guardar');
  l1.ws.close();

  // 2c) A chave vale depois de reiniciar o servidor, e o plugin segue a pessoa de call em call.
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  await startServer();
  const a = await listen(callRoom('c1'));
  const b = await listen(callRoom('c2'));
  setTimeout(() => voice.set('111', 'c2'), 1500);
  const moved = await runPlugin([`key:discord:${key}`, 96000, 32, 4]);
  await new Promise((r) => setTimeout(r, 300));
  check(/estado: 3/.test(moved.out), 'chave guardada funciona depois de reiniciar o servidor');
  check(a.packets.length > 50 && a.off, 'na call antiga: tocou e depois saiu ("off")');
  check(b.on?.rate === 96000 && b.packets.length > 50 && /call=sala-c2/.test(moved.out), `na call nova: chegou o som (${b.packets.length} pacotes)`);
  a.ws.close();
  b.ws.close();

  // 2d) Fora de call: conecta, mas não manda nada (não gasta internet).
  voice.delete('111');
  const idle = await runPlugin([`key:discord:${key}`, 48000, 24, 1.5]);
  check(/estado: 3/.test(idle.out) && /kbps=0 .*call=- ouvintes=0/.test(idle.out), 'fora de call: conectado, 0 kbps');

  // 2e) Chave adulterada: recusa e o plugin esquece a chave.
  const bad = await runPlugin([`key:discord:${key.slice(0, -3)}abc`, 48000, 24]);
  check(bad.code === 1 && /^KEY discord -$/m.test(bad.out), 'chave adulterada é recusada e esquecida');
} finally {
  server.kill();
  fakeDiscord.close();
}
process.exit(failed ? 1 : 0);
