// Teste de ponta a ponta: servidor de verdade (server/server.mjs) + o código de rede do plugin
// (stream_test) + um ouvinte que decodifica como o site. Não precisa de LiveKit nem de DAW.
//
//   cmake -B build -DNOVEAU_TESTS=ON && cmake --build build --target stream_test packet_test
//   node plugin/Tests/e2e.mjs build/stream_test_artefacts/Release/stream_test [build/packet_test]
import { spawn, execFileSync } from 'node:child_process';
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

// 2) Servidor + plugin + ouvinte.
const server = spawn(process.execPath, [join(root, 'server/server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('API do Noveau') && r()));
const jwt = async (identity, name) => {
  const t = new AccessToken(process.env.LIVEKIT_API_KEY ?? 'devkey', process.env.LIVEKIT_API_SECRET ?? 'secret', { identity, name });
  t.addGrant({ room: 'c_e2e', roomJoin: true });
  return t.toJwt();
};

try {
  for (const [rate, fmt] of [[48000, 24], [96000, 32], [44100, 16]]) {
    const pair = await (await fetch(`http://127.0.0.1:${PORT}/api/daw/pair`, { method: 'POST', headers: { authorization: `Bearer ${await jwt('pedro#1', 'Pedro')}` } })).json();
    const listener = new WebSocket(`ws://127.0.0.1:${PORT}/api/daw/listen`);
    await new Promise((r) => listener.on('open', r));
    listener.send(JSON.stringify({ t: 'auth', token: await jwt('ana#2', 'Ana') }));
    const packets = [];
    let on = null;
    listener.on('message', (d, bin) => {
      if (!bin) {
        const m = JSON.parse(String(d));
        if (m.t === 'on') on = m;
        return;
      }
      packets.push(d.subarray(1 + d[0]));
    });
    await new Promise((r) => setTimeout(r, 200));
    const out = execFileSync(streamTest, [`http://127.0.0.1:${PORT}`, pair.code, String(rate), String(fmt)], { encoding: 'utf8', timeout: 20_000 });
    process.stdout.write(out.trimEnd().replace(/^/gm, '   plugin: ') + '\n');
    await new Promise((r) => setTimeout(r, 300));
    listener.close();

    const label = `${rate} Hz ${fmt}-bit`;
    check(on?.name === 'Pedro' && on.rate === rate && on.format === fmt, `${label}: site recebeu "on" com nome, taxa e formato`);
    const frames = packets.reduce((s, p) => s + parsePacket(p).frames, 0);
    check(Math.abs(frames - rate * 2) <= rate / 100, `${label}: chegaram ${frames} de ${rate * 2} frames`);
    const seqs = packets.map((p) => p.readUInt32LE(4));
    check(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), `${label}: sequência sem buracos (${seqs.length} pacotes)`);
    // O seno de 1 kHz que o stream_test gera, amostra por amostra.
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
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
