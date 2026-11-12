// Confere o que a tela realmente manda: codec, perfil do H.264, tamanho de cada camada e o que
// quem assiste recebe. A tela é uma fonte sintética (canvas 2560x1440 a 60 fps, mudando todo
// quadro) no lugar do getDisplayMedia.
// Uso: BASE=http://127.0.0.1:3001 node tools/e2e/qualidade.mjs [codec] [resolução] [segundos]
//   codec: auto | h264 | vp8 | vp9 | av1 | h265      resolução: auto | source | p1440 | p1080 | p720
//   FALHA_OFERTA=1: o primeiro createOffer de quem transmite falha como no Chrome com a lista de codecs
//   recusada ("Duplicate payload type"); confere que a tela abre mesmo assim (h264.ts).
import { createRequire } from 'node:module';
import { browserArgs } from './voz.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const [CODEC = 'h264', RES = 'auto', SECS = '20'] = process.argv.slice(2);
const KEY = 'qualidade' + Date.now().toString(36).padEnd(12, 'x');
const browser = await chromium.launch({ args: browserArgs() });

async function person(name, sender) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(
    ({ sender, codec, res, failOffer }) => {
      try {
        localStorage.setItem('noveau:voice', 'cru');
        localStorage.setItem('cenaculum:volume-hint', 'yes');
        localStorage.setItem('cenaculum:audio', 'no');
        localStorage.setItem('cenaculum:codec', codec);
        localStorage.setItem('cenaculum:stream3', JSON.stringify({ resolution: res, frameRate: 60, maxBitrate: 0 }));
      } catch {}
      // Guarda as conexões para ler as estatísticas de fora.
      const PC = window.RTCPeerConnection;
      window.__pcs = [];
      window.RTCPeerConnection = function (...a) {
        const pc = new PC(...a);
        window.__pcs.push(pc);
        return pc;
      };
      window.RTCPeerConnection.prototype = PC.prototype;
      Object.setPrototypeOf(window.RTCPeerConnection, PC);
      if (!sender) return;
      if (failOffer) {
        const offer = PC.prototype.createOffer;
        let failed = false;
        PC.prototype.createOffer = function (...a) {
          const ours = this.getTransceivers().some((t) => t.sender.track?.kind === 'video');
          if (ours && !failed) {
            failed = true;
            return Promise.reject(new DOMException('Duplicate payload type in codec list', 'InvalidAccessError'));
          }
          return offer.apply(this, a);
        };
      }
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas');
        c.width = 2560;
        c.height = 1440;
        const x = c.getContext('2d');
        let n = 0;
        const draw = () => {
          n++;
          x.fillStyle = `hsl(${n % 360},40%,20%)`;
          x.fillRect(0, 0, c.width, c.height);
          for (let i = 0; i < 60; i++) {
            x.fillStyle = `hsl(${(n * 5 + i * 13) % 360},80%,55%)`;
            x.fillRect((i * 211 + n * 17) % c.width, (i * 97 + n * 9) % c.height, 180, 120);
          }
          x.fillStyle = '#fff';
          x.font = '64px monospace';
          x.fillText(String(n), 40, 100);
        };
        setInterval(draw, 1000 / 60);
        draw();
        return c.captureStream(60);
      };
    },
    { sender, codec: CODEC, res: RES, failOffer: process.env.FALHA_OFERTA === '1' },
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (/\[h264\]/.test(m.text())) console.log(`[${name}]`, m.text().slice(0, 160)); });
  await page.goto(`${BASE}/room/qualidade#${KEY}`);
  await page.fill('#nickname', name);
  await page.click('button[type=submit]');
  await page.waitForSelector('footer.dock', { timeout: 20000 });
  return { page, errors };
}

const A = await person('A', true);
const B = await person('B', false);
await A.page.locator('button[title="Compartilhar tela"]').first().click({ timeout: 10000 });
await B.page.waitForFunction(() => (document.querySelector('cen-stage video')?.videoWidth ?? 0) > 0, undefined, { timeout: 20000 });

const readSend = () =>
  A.page.evaluate(async () => {
    const out = [];
    for (const pc of window.__pcs) {
      if (pc.connectionState === 'closed') continue;
      const r = await pc.getStats();
      for (const s of r.values()) {
        if (s.type !== 'outbound-rtp' || s.kind !== 'video') continue;
        const c = r.get(s.codecId);
        const sender = pc.getSenders().find((x) => x.track?.kind === 'video' && x.getParameters().encodings?.some((e) => (e.rid ?? '') === (s.rid ?? '')));
        const enc = sender?.getParameters().encodings?.find((e) => (e.rid ?? '') === (s.rid ?? ''));
        out.push({
          rid: s.rid ?? '-',
          codec: `${c?.mimeType ?? '?'} ${(/profile-level-id=([0-9a-f]{6})/i.exec(c?.sdpFmtpLine ?? '') ?? [])[1] ?? ''}`.trim(),
          size: `${s.frameWidth ?? 0}x${s.frameHeight ?? 0}`,
          fps: s.framesPerSecond ?? 0,
          active: s.active,
          scale: enc?.scaleResolutionDownBy ?? null,
          limit: s.qualityLimitationReason,
          impl: s.encoderImplementation ?? '?',
        });
      }
    }
    return out;
  });
const readRecv = () =>
  B.page.evaluate(async () => {
    for (const pc of window.__pcs) {
      const r = await pc.getStats();
      for (const s of r.values()) {
        if (s.type !== 'inbound-rtp' || s.kind !== 'video' || !(s.framesDecoded > 0)) continue;
        const c = r.get(s.codecId);
        return { codec: c?.mimeType ?? '?', size: `${s.frameWidth}x${s.frameHeight}`, fps: s.framesPerSecond ?? 0, freezes: s.freezeCount ?? 0 };
      }
    }
    return null;
  });

const t0 = Date.now();
const seen = new Map();
while (Date.now() - t0 < Number(SECS) * 1000) {
  await new Promise((r) => setTimeout(r, 2000));
  const rv = await readRecv();
  if (rv !== null) seen.set(rv.size, (seen.get(rv.size) ?? 0) + 1);
}
const capture = await A.page.evaluate(() => {
  for (const pc of window.__pcs) for (const s of pc.getSenders()) if (s.track?.kind === 'video') { const st = s.track.getSettings(); return `${st.width}x${st.height}`; }
  return '?';
});
console.log(`codec pedido: ${CODEC}, resolução: ${RES}, captura: ${capture}`);
for (const s of await readSend()) console.log('enviando', JSON.stringify(s));
console.log('recebendo (B)', JSON.stringify(await readRecv()));
console.log('tamanhos que B recebeu (leituras a cada 2 s):', JSON.stringify(Object.fromEntries(seen)));
const errs = [...A.errors, ...B.errors];
if (errs.length > 0) console.log('erros:', errs.join(' | '));
await browser.close();
