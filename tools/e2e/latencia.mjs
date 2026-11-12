// Mede o atraso da voz de A até B: do som entrando na trilha do microfone de A até o som decodificado
// saindo da fila de chegada (jitter buffer) de B. Inclui o tratamento, o quadro do Opus, o
// codificador, o servidor e a fila de chegada; não inclui a captura do microfone de verdade nem a
// placa de som (iguais em qualquer versão do site).
//
// A fala é sintética: uma "sílaba" (vogal com harmônicos) de 250 ms a cada 600 ms, gerada no
// navegador de A no lugar do microfone. O começo de cada sílaba é marcado na trilha de A e
// procurado no som que chega em B; os dois navegadores usam o mesmo relógio.
//
// Uso: node tools/e2e/latencia.mjs [rótulo]   (site em BASE, padrão http://127.0.0.1:3000)
// VOZ='{"denoise":"leve"}' muda o tratamento (site novo); MODO=ia|navegador|cru (site antigo).
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const SECONDS = Number(process.env.SECONDS ?? 20);
const KEY = 'latencia' + Date.now().toString(36).padEnd(12, 'x');
const label = process.argv[2] ?? 'run';

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

function synthMic() {
  // Troca o microfone por uma voz sintética com começo bem marcado.
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  let dest = null;
  const make = () => {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    const len = Math.round(0.6 * 48000);
    const buf = ctx.createBuffer(1, len, 48000);
    const x = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const t = i / 48000;
      let v = (Math.random() - 0.5) * 0.004;
      if (t < 0.25) {
        const env = Math.min(1, t / 0.003) * Math.min(1, (0.25 - t) / 0.02);
        let s = 0;
        for (let k = 1; k <= 24; k++) {
          const f = 140 * k;
          // Formantes de um "a": 700 Hz e 1200 Hz.
          const g = Math.exp(-(((f - 700) / 250) ** 2)) + 0.6 * Math.exp(-(((f - 1200) / 300) ** 2)) + 0.08;
          s += g * Math.sin(2 * Math.PI * f * t);
        }
        v += 0.12 * env * s;
      }
      x[i] = v;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    dest = ctx.createMediaStreamDestination();
    src.connect(dest);
    src.start();
    window.__synth = dest.stream.getAudioTracks()[0];
  };
  navigator.mediaDevices.getUserMedia = async (c) => {
    if (!c?.audio) return real(c);
    if (dest === null) make();
    const stream = new MediaStream([window.__synth.clone()]);
    if (c.video) for (const v of (await real({ video: c.video })).getVideoTracks()) stream.addTrack(v);
    return stream;
  };
}

/** Marca o começo de cada sílaba que passa por esta trilha (relógio absoluto, ms). */
function tapOnsets(track, into) {
  const rd = new MediaStreamTrackProcessor({ track }).readable.getReader();
  let quiet = 0;
  void (async () => {
    for (;;) {
      const { value: ad, done } = await rd.read();
      if (done) return;
      const now = performance.timeOrigin + performance.now();
      const n = ad.numberOfFrames;
      const x = new Float32Array(n);
      ad.copyTo(x, { planeIndex: 0, format: 'f32-planar' });
      const rate = ad.sampleRate;
      ad.close();
      for (let i = 0; i < n; i++) {
        if (Math.abs(x[i]) > 0.04) {
          if (quiet > 0.2 * rate) into.push(now - ((n - i) / rate) * 1000);
          quiet = 0;
        } else quiet++;
      }
    }
  })();
}

const people = {};
for (const name of ['A', 'B']) {
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(
    ({ voz, modo }) => {
      try {
        localStorage.setItem('cenaculum:volume-hint', 'yes');
        localStorage.setItem('noveau:e2e', '1');
        if (modo) localStorage.setItem('noveau:voice', modo);
        if (voz) {
          const base = { echo: 'site', agc: true, denoise: 'leve', strength: 24, gate: 'off', gateDb: -50, eqOn: false, eq: [], outDb: 0 };
          localStorage.setItem('noveau:voz2', JSON.stringify({ ...base, ...JSON.parse(voz) }));
        }
      } catch {}
    },
    { voz: process.env.VOZ ?? '', modo: process.env.MODO ?? '' },
  );
  if (name === 'A') await ctx.addInitScript(synthMic);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/room/latencia#${KEY}`);
  await page.fill('#nickname', name);
  await page.click('button[type=submit]');
  await page.waitForSelector('footer.dock', { timeout: 20000 });
  people[name] = page;
}
const { A, B } = people;
await A.locator('button[title="Ligar microfone"]').first().click();
await A.waitForFunction(() => window.__synth !== undefined, undefined, { timeout: 15000 });
await B.waitForFunction(
  () => [...(window.__noveau?.room.remoteParticipants.values() ?? [])][0]?.getTrackPublication('microphone')?.track?.mediaStreamTrack !== undefined,
  undefined,
  { timeout: 20000 },
);
await A.evaluate(`(${tapOnsets.toString()})(window.__synth, (window.__src = []))`);
await B.evaluate(`(${tapOnsets.toString()})([...window.__noveau.room.remoteParticipants.values()][0].getTrackPublication('microphone').track.mediaStreamTrack, (window.__dst = []))`);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
const src = await A.evaluate(() => window.__src);
const dst = await B.evaluate(() => window.__dst);
const jb = await B.evaluate(async () => {
  const t = [...window.__noveau.room.remoteParticipants.values()][0].getTrackPublication('microphone').track;
  let out = null;
  (await t.receiver.getStats()).forEach((v) => {
    if (v.type === 'inbound-rtp') out = { jitterMs: ((v.jitterBufferDelay ?? 0) / Math.max(1, v.jitterBufferEmittedCount ?? 1)) * 1000, targetMs: ((v.jitterBufferTargetDelay ?? 0) / Math.max(1, v.jitterBufferEmittedCount ?? 1)) * 1000, packets: v.packetsReceived };
  });
  return out;
});
const lat = [];
for (const d of dst) {
  const s = src.filter((x) => x <= d && d - x < 400).pop();
  if (s !== undefined) lat.push(d - s);
}
lat.sort((a, b) => a - b);
const q = (p) => (lat.length === 0 ? NaN : lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]);
console.log(
  JSON.stringify({
    label,
    silabas: { enviadas: src.length, chegaram: dst.length, pareadas: lat.length },
    atrasoMs: { mediana: +q(0.5).toFixed(1), p10: +q(0.1).toFixed(1), p90: +q(0.9).toFixed(1) },
    filaDeChegadaMs: jb && { media: +jb.jitterMs.toFixed(1), alvo: +jb.targetMs.toFixed(1) },
  }),
);
await browser.close();
