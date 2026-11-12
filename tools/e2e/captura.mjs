// Captura curta (jogo ocupando a placa de vídeo) e o "Ceder quando o PC apertar".
//
// A fonte da tela é sintética (canvas que muda todo quadro) no lugar do getDisplayMedia, com o fps
// que a "captura" entrega controlado aqui. Num PC de verdade, com o jogo usando a placa inteira, o
// Chrome entrega bem menos quadros do que o pedido (ver docs/DESEMPENHO.md, "Quinta rodada").
//
// Partes (cada uma numa sala nova, A transmite e B assiste):
//   curta   captura a 18 fps com 60 pedidos: A vê o aviso na tecla "prévia", B vê "captura de A".
//   cheia   captura a 60 fps: nenhum aviso.
//   video   captura firme a 30 fps (vídeo, jogo travado em 30): nenhum aviso.
//   sessenta 120 pedidos, conteúdo de 60 (área de trabalho com vídeo, ou monitor de 60 Hz): nenhum aviso.
//   parada  tela parada (o navegador quase não manda nada): nenhum aviso.
//   ceder   "Ceder" ligado; processador "serious" (75-90%) não mexe; "critical" baixa o fps; volta.
//   encolhe o getStats de A finge o que o Chrome contou com H.264 na NVIDIA (320x180, "bandwidth", 7,3 Mbps
//           de alvo) enquanto a tela estiver em "manter fluidez": o vigia (shrink-guard.ts) passa para
//           "manter resolução". (O OpenH264 daqui não encolhe sozinho nem com 2 Mbps: não dá para provocar.)
// Uso: BASE=http://127.0.0.1:3001 node tools/e2e/captura.mjs [partes separadas por vírgula]
// Sai com 1 se alguma conferência falhar.
import { createRequire } from 'node:module';
import { browserArgs } from './voz.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const ONLY = (process.argv[2] ?? 'curta,cheia,video,sessenta,parada,ceder,encolhe').split(',');
const browser = await chromium.launch({ args: browserArgs() });
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FALHOU'} ${what}`);
  if (!ok) failures++;
}

async function person(room, key, name, opts) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(
    ({ sender, fps, still, adapt, maxBitrate, codec, fakeShrink, want }) => {
      try {
        localStorage.setItem('noveau:e2e', '1');
        localStorage.setItem('noveau:voice', 'cru');
        localStorage.setItem('cenaculum:volume-hint', 'yes');
        localStorage.setItem('cenaculum:audio', 'no');
        localStorage.setItem('cenaculum:adapt-load', adapt ? 'yes' : 'no');
        localStorage.setItem('cenaculum:stream3', JSON.stringify({ resolution: 'source', frameRate: want, maxBitrate }));
        if (codec) localStorage.setItem('cenaculum:codec', codec);
      } catch {}
      if (!sender) return;
      if (fakeShrink) {
        const orig = RTCRtpSender.prototype.getStats;
        RTCRtpSender.prototype.getStats = async function () {
          const rep = await orig.call(this);
          if (this.track?.kind !== 'video' || this.getParameters().degradationPreference === 'maintain-resolution') return rep;
          const out = new Map();
          rep.forEach((v, k) => {
            out.set(
              k,
              v.type === 'outbound-rtp' && v.kind === 'video'
                ? { ...v, frameWidth: 320, frameHeight: 180, qualityLimitationReason: 'bandwidth', targetBitrate: 7.3e6 }
                : v,
            );
          });
          return out;
        };
      }
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas');
        c.width = 1280;
        c.height = 720;
        const x = c.getContext('2d');
        let n = 0;
        // Muito movimento (blocos coloridos e ruído), como um jogo: o codificador manda muitos bits.
        const draw = () => {
          n++;
          x.fillStyle = `hsl(${(n * 7) % 360},40%,25%)`;
          x.fillRect(0, 0, c.width, c.height);
          for (let i = 0; i < 90; i++) {
            x.fillStyle = `hsl(${(n * 11 + i * 29) % 360},85%,${30 + ((i * 7 + n) % 40)}%)`;
            x.fillRect((i * 151 + n * 37) % c.width, (i * 83 + n * 23) % c.height, 90 + (i % 5) * 20, 60 + (i % 3) * 25);
          }
          x.fillStyle = '#fff';
          x.font = '48px monospace';
          x.fillText(String(n), 30, 70);
        };
        draw();
        // Parada: só um contador pequeno muda 2 vezes por segundo (como uma área de trabalho com o relógio).
        let tick = 0;
        const small = () => {
          tick++;
          x.fillStyle = '#000';
          x.fillRect(c.width - 200, c.height - 70, 190, 60);
          x.fillStyle = '#fff';
          x.font = '40px monospace';
          x.fillText(String(tick), c.width - 190, c.height - 25);
        };
        if (still) setInterval(small, 500);
        else setInterval(draw, 1000 / fps);
        return c.captureStream(60);
      };
    },
    { sender: opts.sender, fps: opts.fps ?? 60, still: opts.still === true, adapt: opts.adapt === true, maxBitrate: opts.maxBitrate ?? 0, codec: opts.codec ?? '', fakeShrink: opts.fakeShrink === true, want: opts.want ?? 60 },
  );
  const page = await ctx.newPage();
  const errors = [];
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/room/${room}#${key}`);
  await page.fill('#nickname', name);
  await page.click('button[type=submit]');
  await page.waitForSelector('footer.dock', { timeout: 20000 });
  return { ctx, page, errors, logs };
}

async function room(label, opts) {
  const key = ('captura' + label + Date.now().toString(36)).padEnd(20, 'x');
  const A = await person(`captura-${label}`, key, 'A', { sender: true, ...opts });
  const B = await person(`captura-${label}`, key, 'B', { sender: false });
  await A.page.locator('button[title="Compartilhar tela"]').first().click({ timeout: 10000 });
  await B.page.waitForFunction(() => (document.querySelector('cen-stage video')?.videoWidth ?? 0) > 0, undefined, { timeout: 25000 });
  return { A, B };
}

const health = (p) => p.page.evaluate(() => window.__noveau?.store?.health() ?? null);
const load = (p) => p.page.evaluate(() => window.__noveau?.store?.load() ?? null);
const keyText = (p) => p.page.evaluate(() => document.querySelector('cen-live-strip .mine-key .fps')?.textContent?.trim() ?? '');
const noteText = (p) => p.page.evaluate(() => document.querySelector('.now .sender-note')?.textContent?.trim() ?? '');

/** Espera até `ms` por algo verdadeiro (ou olha por `ms` que nada aparece); devolve o último valor lido. */
async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  let v = await fn();
  while (!v && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000));
    v = await fn();
  }
  return v;
}

async function done(r) {
  const errs = [...r.A.errors, ...r.B.errors];
  check(errs.length === 0, `sem erro no console${errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''}`);
  await r.A.ctx.close();
  await r.B.ctx.close();
}

if (ONLY.includes('curta')) {
  console.log('\n[curta] captura a 18 fps, 60 pedidos');
  const r = await room('curta', { fps: 18 });
  // O registro vai para o servidor (a cada 15 s), com os números do envio: escuta desde já para não perder o envio.
  const sending = r.A.page
    .waitForRequest((q) => q.url().endsWith('/api/diag') && (q.postData() ?? '').includes('my-capture'), { timeout: 80000 })
    .then((q) => JSON.parse(q.postData()).events.find((e) => e.cause === 'my-capture'))
    .catch(() => null);
  const key = await waitFor(() => keyText(r.A), 35000);
  const h = await health(r.A);
  console.log('  saúde de A:', JSON.stringify(h));
  check(h?.short === 'capture', 'A acusa captura curta');
  check(/^(15|20)\/60fps$/.test(key), `tecla "prévia" de A mostra os quadros (${key || 'nada'})`);
  const note = await waitFor(() => noteText(r.B), 15000);
  check(/captura de A: ~(15|20) de 60 fps/.test(note), `B vê o motivo na faixa de cima (${note || 'nada'})`);
  const diary = await r.A.page.evaluate(() => window.__noveau.store.diag.events().map((e) => e.cause));
  check(diary.includes('my-capture'), `diário de A registra a captura curta (${diary.join(',') || 'vazio'})`);
  const sent = await sending;
  console.log('  enviado ao servidor:', JSON.stringify(sent?.metrics ?? null));
  check(sent?.metrics?.fpsPedidos === 60 && sent?.metrics?.fpsCapturados > 0, 'o registro chega ao servidor com os quadros');
  await done(r);
}

if (ONLY.includes('cheia')) {
  console.log('\n[cheia] captura a 60 fps');
  const r = await room('cheia', { fps: 60 });
  const key = await waitFor(() => keyText(r.A), 30000);
  const h = await health(r.A);
  console.log('  saúde de A:', JSON.stringify(h));
  check(key === '' && h?.short !== 'capture', `sem aviso de captura (${key || 'nada'})`);
  const st = await r.A.page.evaluate(async () => {
    const s = await window.__noveau.store.sendingStats();
    return s ? { captura: s.captureSize, camadas: s.layers } : null;
  });
  console.log('  painel de A:', JSON.stringify(st));
  check(st?.captura === '1280x720' && st.camadas.length > 0, 'o painel mostra o tamanho da captura e as camadas');
  await done(r);
}

if (ONLY.includes('video')) {
  console.log('\n[video] captura firme a 30 fps (conteúdo de 30)');
  const r = await room('video', { fps: 30 });
  const key = await waitFor(() => keyText(r.A), 30000);
  const h = await health(r.A);
  console.log('  saúde de A:', JSON.stringify(h));
  check(key === '' && h?.short !== 'capture', `vídeo de 30 fps não acusa (${key || 'nada'})`);
  await done(r);
}

if (ONLY.includes('sessenta')) {
  console.log('\n[sessenta] 120 pedidos, conteúdo de 60');
  const r = await room('sessenta', { fps: 60, want: 120 });
  const key = await waitFor(() => keyText(r.A), 30000);
  const h = await health(r.A);
  console.log('  saúde de A:', JSON.stringify(h));
  check(key === '' && h?.short !== 'capture' && h?.wantFps === 120, `conteúdo de 60 com 120 pedidos não acusa (${key || 'nada'})`);
  await done(r);
}

if (ONLY.includes('parada')) {
  console.log('\n[parada] tela parada');
  const r = await room('parada', { still: true });
  const key = await waitFor(() => keyText(r.A), 25000);
  const h = await health(r.A);
  console.log('  saúde de A:', JSON.stringify(h));
  check(key === '' && h?.short !== 'capture', `tela parada não acusa (${key || 'nada'})`);
  await done(r);
}

if (ONLY.includes('ceder')) {
  console.log('\n[ceder] "Ceder" ligado, processador simulado');
  const r = await room('ceder', { fps: 60, adapt: true });
  const cdp = await r.A.ctx.newCDPSession(r.A.page);
  await cdp.send('Emulation.setPressureSourceOverrideEnabled', { enabled: true, source: 'cpu' });
  // O vigia nasceu antes do override: a transmissão recomeça para ele ler a fonte simulada.
  await r.A.page.evaluate(() => window.__noveau.store.restartShare());
  await r.B.page.waitForFunction(() => (document.querySelector('cen-stage video')?.videoWidth ?? 0) > 0, undefined, { timeout: 25000 });
  await cdp.send('Emulation.setPressureStateOverride', { source: 'cpu', state: 'serious' });
  await new Promise((res) => setTimeout(res, 14000));
  let l = await load(r.A);
  console.log('  com "serious" (75-90%):', JSON.stringify(l));
  check(l?.pressure === 'serious' && l?.step === 0 && l?.fps === 60, 'uso normal de jogo não baixa o fps');
  await cdp.send('Emulation.setPressureStateOverride', { source: 'cpu', state: 'critical' });
  l = await waitFor(async () => {
    const x = await load(r.A);
    return x?.step > 0 ? x : null;
  }, 12000);
  console.log('  com "critical" (90%+):', JSON.stringify(l));
  check(l?.step === 1 && l?.fps === 45, 'no limite, desce um degrau (60 -> 45 fps)');
  const h = await health(r.A);
  check(h?.wantFps === 45, `o pedido que a captura curta usa acompanha o degrau (${h?.wantFps})`);
  await cdp.send('Emulation.setPressureStateOverride', { source: 'cpu', state: 'fair' });
  l = await waitFor(async () => {
    const x = await load(r.A);
    return x?.step === 0 ? x : null;
  }, 30000);
  console.log('  com "fair" depois de ~20 s:', JSON.stringify(l));
  check(l?.step === 0 && l?.fps === 60, 'quando alivia, volta à qualidade total');
  await done(r);
}

if (ONLY.includes('encolhe')) {
  console.log('\n[encolhe] o navegador encolhe a tela com bits de sobra');
  const r = await room('encolhe', { fps: 60, fakeShrink: true });
  const pref = () =>
    r.A.page.evaluate(() => {
      const s = window.__noveau?.room?.localParticipant?.getTrackPublication('screen_share')?.track?.sender;
      return s ? (s.getParameters().degradationPreference ?? '(nenhum)') : null;
    });
  console.log('  no começo:', await pref());
  const fixed = await waitFor(async () => r.A.logs.find((l) => l.includes('encolheu a tela')) ?? null, 30000);
  console.log('  vigia:', fixed ?? 'não agiu');
  check(fixed !== null && /320x180/.test(fixed), 'o vigia percebe o encolhimento (320x180 com 7,3 Mbps de alvo)');
  const now = await waitFor(async () => ((await pref()) === 'maintain-resolution' ? 'maintain-resolution' : null), 5000);
  check(now === 'maintain-resolution', `a tela passa para "manter resolução" (${now ?? (await pref())})`);
  const diary = await r.A.page.evaluate(() => window.__noveau.store.diag.events().map((e) => e.cause));
  check(diary.includes('my-shrink'), `diário registra (${diary.join(',') || 'vazio'})`);
  const panel = await r.A.page.evaluate(async () => (await window.__noveau.store.sendingStats())?.height ?? 0);
  check(panel >= 700, `depois, o tamanho real volta a aparecer (${panel}p)`);
  await done(r);
}

await browser.close();
console.log(failures === 0 ? '\ntudo certo' : `\n${failures} conferência(s) falharam`);
process.exit(failures === 0 ? 0 : 1);
