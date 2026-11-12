// Testa a voz de ponta a ponta com 2 navegadores: o tratamento no worker (IA leve, equalizador),
// o Opus em quadros de 10 ms passando pelo LiveKit, a janela "sua voz", a IA forte (DeepFilterNet)
// e a troca da qualidade de áudio da sala. Grava fotos da janela em SHOTS (padrão: não grava).
// Uso: node tools/e2e/voz-teste.mjs (site em BASE, padrão http://127.0.0.1:3000).
// Sai com código 1 se algo falhar.
import { createRequire } from 'node:module';
import { browserArgs } from './voz.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const SHOTS = process.env.SHOTS ?? '';
const KEY = 'vozteste' + Date.now().toString(36).padEnd(12, 'x');
const browser = await chromium.launch({ args: browserArgs() });
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'OK  ' : 'FALHOU'} ${name}${extra ? ' — ' + extra : ''}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const people = {};
for (const name of ['A', 'B']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone', 'camera'] });
  // Sem 'noveau:voice': cada um começa com o tratamento padrão (IA leve + equalizador "Natural").
  await ctx.addInitScript(() => { try { localStorage.setItem('cenaculum:volume-hint', 'yes'); localStorage.setItem('noveau:e2e', '1'); } catch {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${BASE}/room/voz#${KEY}`);
  await page.fill('#nickname', name);
  await page.click('button[type=submit]');
  await page.waitForSelector('footer.dock', { timeout: 20000 });
  people[name] = { page, errors };
}
const { A, B } = people;
const until = async (p, fn, arg, ms = 15000) => { try { await p.page.waitForFunction(fn, arg, { timeout: ms }); return true; } catch { return false; } };
const shot = async (p, file) => { if (SHOTS !== '') await p.page.locator('cen-voice-panel').screenshot({ path: `${SHOTS}/${file}` }); };

/** Pacotes/s do microfone de A, em janelas de 1 s: o pico é com a voz falsa "falando". */
const peakPps = (p, seconds = 6) =>
  p.page.evaluate(async (seconds) => {
    const sender = window.__noveau.room.localParticipant.getTrackPublication('microphone')?.track?.sender;
    if (!sender) return 0;
    const read = async () => { let n = 0; (await sender.getStats()).forEach((v) => { if (v.type === 'outbound-rtp') n = v.packetsSent; }); return n; };
    let peak = 0;
    let prev = await read();
    for (let i = 0; i < seconds; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const now = await read();
      peak = Math.max(peak, now - prev);
      prev = now;
    }
    return peak;
  }, seconds);

await A.page.locator('button[title="Ligar microfone"]').first().click();
ok('A: microfone passa pelo worker da voz', await until(A, () => window.__noveau?.session.voiceRunning === true));
await until(A, () => window.__noveau.room.localParticipant.getTrackPublication('microphone')?.track?.sender !== undefined);
const pps = await peakPps(A);
ok('A: Opus em quadros de 10 ms pela sala (~100 pacotes/s falando)', pps >= 90, `${pps} pacotes/s`);
ok(
  'B ouve A (nível de áudio chegando)',
  await until(B, () => {
    const a = [...window.__noveau.room.remoteParticipants.values()][0]?.getTrackPublication('microphone')?.track;
    if (!a?.receiver) return false;
    window.__lvl ??= 0;
    void a.receiver.getStats().then((r) => r.forEach((v) => { if (v.type === 'inbound-rtp') window.__lvl = Math.max(window.__lvl, v.audioLevel ?? 0); }));
    return window.__lvl > 0.01;
  }, undefined, 20000),
);

// Janela "sua voz" pelo submenu do microfone.
await A.page.locator('button[aria-label="Escolher microfone"]').click();
await A.page.getByRole('button', { name: 'Equalizador, ruído, eco e sala' }).click();
ok('A: janela "sua voz" abre', await until(A, () => document.querySelector('cen-voice-panel') !== null));
ok('A: submenu do microfone fecha', await until(A, () => document.querySelector('.pop') === null));
await wait(1500);
ok('A: medidor de entrada e saída andando', await until(A, () => [...document.querySelectorAll('cen-voice-panel .meters i')].every((i) => parseFloat(i.style.width) > 1)));
await shot(A, 'voz-equalizador.png');

// Pro-Q: botão "me ouvir" no topo, clique no vazio cria banda, solo da banda e EQ dinâmico.
/** RMS (dB) de uma trilha por ms milissegundos. which: 'out' (sala) ou 'monitor' (sua escuta). */
const rms = (p, which, ms = 1500) => p.page.evaluate(async ({ which, ms }) => {
  const s = window.__noveau.session;
  const t = which === 'out' ? s.micTracks().out : s.voiceProc?.monitorTrack;
  if (!t) return null;
  const rd = new MediaStreamTrackProcessor({ track: t }).readable.getReader();
  let sum = 0, n = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const { value, done } = await rd.read();
    if (done) break;
    const x = new Float32Array(value.numberOfFrames);
    value.copyTo(x, { planeIndex: 0, format: 'f32-planar' });
    value.close();
    for (const v of x) { sum += v * v; n++; }
  }
  rd.cancel().catch(() => {});
  return n === 0 ? null : 10 * Math.log10(sum / n + 1e-12);
}, { which, ms });
/** Frequência mais forte do som de saída (para pôr a banda em cima dela). */
const peakHz = await A.page.evaluate(async () => {
  const t = window.__noveau.session.micTracks().out;
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 8192;
  ctx.createMediaStreamSource(new MediaStream([t])).connect(an);
  const d = new Float32Array(an.frequencyBinCount);
  const best = new Float32Array(an.frequencyBinCount).fill(-200);
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 100)); an.getFloatFrequencyData(d); d.forEach((v, k) => { if (v > best[k]) best[k] = v; }); }
  let k = 1; best.forEach((v, i) => { if (i > 2 && v > best[k]) k = i; });
  void ctx.close();
  return (k * ctx.sampleRate) / an.fftSize;
});
results.push(`INFO tom do microfone falso: ${Math.round(peakHz)} Hz`);

const listen = A.page.locator('cen-voice-panel header button.listen');
await listen.click();
ok('A: "me ouvir" no topo da janela liga a escuta', await until(A, () => document.querySelector('cen-voice-panel header button.listen')?.getAttribute('aria-pressed') === 'true'));
ok('A: escuta passa pelo tratamento (trilha da escuta existe)', await until(A, () => window.__noveau.session.voiceProc?.monitorTrack?.readyState === 'live'));
await listen.click();
ok('A: "me ouvir" desliga', await until(A, () => document.querySelector('cen-voice-panel header button.listen')?.getAttribute('aria-pressed') === 'false' && !window.__noveau.session.voiceProc?.monitorTrack));

// Clique num lugar vazio do gráfico: banda nova, já escolhida.
await A.page.selectOption('cen-voice-panel select[aria-label="Preset do equalizador"]', 'natural').catch(() => {});
const nBefore = await A.page.evaluate(() => JSON.parse(localStorage.getItem('noveau:voz2')).eq.length);
const box = await A.page.locator('cen-voice-panel canvas').boundingBox();
// x de uma frequência no gráfico (escala log 20 Hz a 20 kHz)
const xOfHz = (f) => box.x + ((Math.log10(f) - Math.log10(20)) / 3) * box.width;
await A.page.mouse.move(xOfHz(peakHz * 3.1), box.y + box.height * 0.3);
ok('A: leitura de frequência/nota ao passar o mouse', await until(A, () => /Hz · [A-G]#?\d/.test(document.querySelector('cen-voice-panel .readout')?.textContent ?? '')));
await A.page.mouse.down();
await A.page.mouse.move(xOfHz(peakHz), box.y + box.height * 0.5, { steps: 6 });
await A.page.mouse.up();
const made = await A.page.evaluate(() => JSON.parse(localStorage.getItem('noveau:voz2')).eq);
const nb = made[made.length - 1];
ok('A: clique no vazio cria uma banda e arrasta junto', made.length === nBefore + 1 && nb.type === 'bell' && Math.abs(Math.log2(nb.freq / peakHz)) < 0.35, `${nBefore} → ${made.length} bandas, nova em ${nb?.freq} Hz`);
await shot(A, 'voz-nova-banda.png');

// Solo: estreita a banda longe do tom (só um sopro passa) e depois em cima do tom.
const idx = made.length - 1;
const solo = A.page.locator('cen-voice-panel button.solo');
const outBefore = await rms(A, 'out');
await A.page.fill('cen-voice-panel .row.edit label:has-text("Q") input', '8');
await A.page.locator('cen-voice-panel .row.edit label:has-text("Q") input').dispatchEvent('change');
await A.page.fill('cen-voice-panel .row.edit label:has-text("Hz") input', String(Math.round(Math.min(18000, peakHz * 6))));
await A.page.locator('cen-voice-panel .row.edit label:has-text("Hz") input').dispatchEvent('change');
const sb = await solo.boundingBox();
await A.page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
await A.page.mouse.down();
ok('A: segurar o fone da banda põe em solo (escuta liga sozinha)', await until(A, () => window.__noveau.session.voiceProc?.monitorTrack?.readyState === 'live' && document.querySelector('cen-voice-panel button.solo.on') !== null));
await wait(300);
const soloOff = await rms(A, 'monitor');
const outDuring = await rms(A, 'out');
// Arrasta o fone para os lados até o tom: a faixa segue o mouse.
const octs = Math.log2(peakHz / Math.min(18000, peakHz * 6));
await A.page.mouse.move(sb.x + sb.width / 2 + octs * 40, sb.y + sb.height / 2, { steps: 8 });
await wait(400);
const soloOn = await rms(A, 'monitor');
const fNow = await A.page.evaluate((idx) => JSON.parse(localStorage.getItem('noveau:voz2')).eq[idx].freq, idx);
await shot(A, 'voz-solo.png');
await A.page.mouse.up();
ok('A: solo deixa passar só a faixa (fora do tom quase nada, em cima do tom quase tudo)', soloOff !== null && soloOn !== null && soloOn - soloOff > 15, `fora ${soloOff?.toFixed(1)} dB, em cima ${soloOn?.toFixed(1)} dB (banda em ${fNow} Hz)`);
ok('A: arrastar o fone muda a frequência da banda', Math.abs(Math.log2(fNow / peakHz)) < 0.3, `${fNow} Hz`);
ok('A: a sala não ouve o solo', outDuring !== null && outBefore !== null && Math.abs(outDuring - outBefore) < 3, `sala antes ${outBefore?.toFixed(1)} dB, durante ${outDuring?.toFixed(1)} dB`);
ok('A: soltar o fone sai do solo e desliga a escuta que ele ligou', await until(A, () => document.querySelector('cen-voice-panel button.solo.on') === null && !window.__noveau.session.voiceProc?.monitorTrack));

// EQ dinâmico em cima do tom: limiar baixo, alcance -9 dB: a banda abaixa sozinha.
await A.page.fill('cen-voice-panel .row.edit label:has-text("Q") input', '1');
await A.page.locator('cen-voice-panel .row.edit label:has-text("Q") input').dispatchEvent('change');
await A.page.getByRole('button', { name: 'dinâmica', exact: true }).click();
await A.page.fill('cen-voice-panel .dynrow label:has-text("limiar") input', '-70');
await A.page.locator('cen-voice-panel .dynrow label:has-text("limiar") input').dispatchEvent('change');
await A.page.fill('cen-voice-panel .dynrow label:has-text("alcance") input', '-9');
await A.page.locator('cen-voice-panel .dynrow label:has-text("alcance") input').dispatchEvent('change');
ok('A: banda dinâmica age sozinha (medidor desce)', await until(A, (idx) => parseFloat((document.querySelector('cen-voice-panel .dynrow .val')?.textContent ?? '0').replace(',', '.').replace('−', '-')) < -3, idx),
  await A.page.evaluate(() => document.querySelector('cen-voice-panel .dynrow .val')?.textContent ?? ''));
const outDyn = await rms(A, 'out');
ok('A: com a dinâmica o tom sai mais baixo para a sala', outDyn !== null && outBefore !== null && outBefore - outDyn > 2, `antes ${outBefore?.toFixed(1)} dB, agora ${outDyn?.toFixed(1)} dB`);
await shot(A, 'voz-dinamica.png');
// Escala ±30, congelar e pré/pós: só não podem quebrar o desenho.
await A.page.getByRole('button', { name: '±30' }).click();
await A.page.getByRole('button', { name: 'congelar' }).click();
await wait(800);
await shot(A, 'voz-escala-congelar.png');
await A.page.getByRole('button', { name: 'congelar' }).click();
await A.page.getByRole('button', { name: '±12' }).click();
await A.page.locator('cen-voice-panel .row.edit button[title="Apagar banda"]').click();


// Preset pronto e salvar um preset próprio.
await A.page.selectOption('cen-voice-panel select[aria-label="Preset do equalizador"]', 'callout');
ok('A: o seletor mostra o preset escolhido', await until(A, () => document.querySelector('cen-voice-panel select[aria-label="Preset do equalizador"]')?.selectedOptions[0]?.value === 'callout'));
ok('A: preset "Call de jogo" aplicado', await until(A, () => JSON.parse(localStorage.getItem('noveau:voz2') ?? '{}').eq?.length >= 3));
await wait(1200);
await shot(A, 'voz-call-de-jogo.png');
await A.page.getByRole('button', { name: 'Salvar como…' }).click();
await A.page.fill('cen-voice-panel input.txt', 'meu teste');
await A.page.keyboard.press('Enter');
ok('A: preset salvo aparece em "seus"', await until(A, () => [...document.querySelectorAll('cen-voice-panel optgroup[label="seus"] option')].some((o) => o.textContent === 'meu teste')));

// Aba de ruído: intensidade e IA forte.
await A.page.getByRole('tab', { name: 'ruído e eco' }).click();
ok('A: status mostra a IA leve rodando', await until(A, () => document.querySelector('cen-voice-panel')?.textContent?.includes('rodando: IA leve')));
await A.page.locator('cen-voice-panel input[aria-label="Intensidade da redução de ruído"]').fill('12');
ok('A: intensidade salva (12 dB)', await until(A, () => JSON.parse(localStorage.getItem('noveau:voz2') ?? '{}').strength === 12));
await shot(A, 'voz-ruido.png');
// Conta o som que sai do tratamento enquanto a IA forte entra: a troca não pode cortar a voz.
await A.page.evaluate(() => {
  const flow = (window.__flow = { samples: 0, start: performance.now(), tracks: 0 });
  const follow = async () => {
    for (;;) {
      const out = window.__noveau.session.micTracks().out;
      if (out === null || out.readyState !== 'live') { await new Promise((r) => setTimeout(r, 5)); continue; }
      flow.tracks++;
      const rd = new MediaStreamTrackProcessor({ track: out }).readable.getReader();
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        flow.samples += value.numberOfFrames;
        value.close();
        if (window.__noveau.session.micTracks().out !== out) break;
      }
      rd.cancel().catch(() => {});
    }
  };
  void follow();
});
await A.page.getByRole('button', { name: 'IA forte (DeepFilterNet 3)' }).click();
const strong = await until(A, () => (document.body.textContent ?? '').includes('rodando: IA forte ·'), undefined, 60000);
const strongText = await A.page.evaluate(() => document.querySelector('cen-voice-panel p.mono')?.textContent ?? '');
ok('A: IA forte (DeepFilterNet) rodando', strong, strongText.trim());
await wait(3000);
const flow = await A.page.evaluate(() => ({ got: window.__flow.samples / 48000, wall: (performance.now() - window.__flow.start) / 1000, tracks: window.__flow.tracks }));
ok('A: a voz não corta na troca para a IA forte', flow.got >= flow.wall - 0.15, `${flow.got.toFixed(2)} s de som em ${flow.wall.toFixed(2)} s, ${flow.tracks} trilhas`);
const strongLoad = await A.page.evaluate(() => document.querySelector('cen-voice-panel p.mono')?.textContent ?? '');
results.push(`INFO IA forte depois de 3 s: ${strongLoad.trim()}`);
ok('A: sem aviso de PC sem fôlego', !(await A.page.evaluate(() => document.body.textContent.includes('não está dando conta'))));
await A.page.getByRole('button', { name: 'IA leve (RNNoise)' }).click();

// Aba da sala: muda para "Música" e B fica sabendo.
await B.page.locator('button[title="Ligar microfone"]').first().click();
await A.page.getByRole('tab', { name: 'sala e atraso' }).click();
await wait(4500);
await shot(A, 'voz-sala.png');
await A.page.getByRole('button', { name: 'Música', exact: true }).click();
ok('B vê o aviso da troca da qualidade da sala', await until(B, () => document.body.textContent.includes('mudou o áudio da sala para Música')));
ok('A: microfone republicado com quadros de 20 ms', await until(A, () => window.__noveau.room.localParticipant.getTrackPublication('microphone')?.track !== undefined));
await wait(1500);
const pps20 = await peakPps(A);
ok('A: Opus em quadros de 20 ms no modo Música (~50 pacotes/s)', pps20 >= 45 && pps20 <= 60, `${pps20} pacotes/s`);
ok('A: microfone continua no worker depois de republicar', await A.page.evaluate(() => window.__noveau.session.voiceRunning === true));
await A.page.getByRole('button', { name: 'Instantâneo', exact: true }).click();
await wait(3000);

// B põe A em 150%: só essa voz passa pelo Web Audio; de volta a 100%, volta para o elemento.
const route = () => B.page.evaluate(() => {
  const t = [...window.__noveau.room.remoteParticipants.values()][0].getTrackPublication('microphone').track;
  return { ctx: t.audioContext !== undefined, gain: t.gainNode?.gain.value ?? null, els: t.attachedElements.map((e) => (e.muted ? 0 : e.volume)) };
});
await B.page.evaluate(() => { const p = [...window.__noveau.room.remoteParticipants.values()][0]; window.__noveau.session.setVolume('mic', p.identity, 1.5); });
await wait(800);
const boosted = await route();
ok('B: voz de A a 150% passa pelo Web Audio (elemento mudo)', boosted.ctx && boosted.gain > 1.4 && boosted.els.every((v) => v === 0), JSON.stringify(boosted));
await B.page.evaluate(() => { const p = [...window.__noveau.room.remoteParticipants.values()][0]; window.__noveau.session.setVolume('mic', p.identity, 1); });
await wait(800);
const direct = await route();
ok('B: de volta a 100%, toca direto no elemento', !direct.ctx && direct.els.length > 0 && direct.els.every((v) => v === 1), JSON.stringify(direct));

// Fecha a janela: medidores param.
await A.page.locator('cen-voice-panel button.close').click();
ok('A: janela fecha', await until(A, () => document.querySelector('cen-voice-panel') === null));

// O "me ouvir" também está no menu do microfone.
await A.page.locator('button[aria-label="Escolher microfone"]').click();
ok('A: "me ouvir" no menu do microfone', await A.page.locator('.pop button.listen').waitFor({ timeout: 5000 }).then(() => true, () => false));
await A.page.locator('.pop button.listen').click();
ok('A: menu do microfone liga a escuta', await until(A, () => window.__noveau.session.voiceProc?.monitorTrack?.readyState === 'live'));
await A.page.locator('.pop button.listen').click();
ok('A: e desliga', await until(A, () => !window.__noveau.session.voiceProc?.monitorTrack));
await A.page.keyboard.press('Escape');

for (const [name, p] of Object.entries(people)) ok(`${name} sem erros no console`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
console.log(results.join('\n'));
await browser.close();
process.exit(results.some((r) => r.startsWith('FALHOU')) ? 1 : 0);
