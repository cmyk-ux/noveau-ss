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

for (const [name, p] of Object.entries(people)) ok(`${name} sem erros no console`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
console.log(results.join('\n'));
await browser.close();
process.exit(results.some((r) => r.startsWith('FALHOU')) ? 1 : 0);
