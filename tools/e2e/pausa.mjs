// "Transmissão pausada" (janela minimizada / alt-tab) e a prévia da barra que carrega sozinha com o
// mouse em cima. Uso: BASE=http://127.0.0.1:3001 [SHOTS=pasta] node tools/e2e/pausa.mjs
//
// A captura é a de verdade (fonte falsa do Chromium), só que a faixa diz que é uma janela
// (displaySurface 'window') e o contador de quadros (track.stats) pode ser congelado pelo teste:
// é o que o Chrome faz no Windows quando a janela capturada é minimizada (0 Hz: nenhum quadro novo).
// Sai com código 1 se algo falhar.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { browserArgs, fakeMonitor } from './voz.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const SHOTS = process.env.SHOTS ?? '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const KEY = 'pausa' + Date.now().toString(36).padEnd(12, 'x');
const browser = await chromium.launch({ args: browserArgs() });
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(`${cond ? 'OK  ' : 'FALHOU'} ${name}${extra ? ' — ' + extra : ''}`);
  console.log(results.at(-1));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A faixa da tela diz que é janela e o teste controla o contador de quadros. */
function fakeWindow() {
  const md = navigator.mediaDevices;
  const capture = md.getDisplayMedia.bind(md);
  const desc = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'stats');
  window.__surface = 'window';
  window.__freeze = false;
  window.__extra = 0;
  window.__slow = false;
  // Quadros chegando com a imagem congelada (R6 com alt-tab): grabFrame devolve sempre a mesma.
  window.__still = false;
  const grab = ImageCapture.prototype.grabFrame;
  let stillBitmap = null;
  ImageCapture.prototype.grabFrame = async function () {
    const b = await grab.call(this);
    if (!window.__still) return b;
    if (stillBitmap === null) stillBitmap = await createImageBitmap(b);
    b.close();
    return createImageBitmap(stillBitmap);
  };
  md.getDisplayMedia = async (c) => {
    const s = await capture(c);
    for (const t of s.getVideoTracks()) {
      const settings = t.getSettings.bind(t);
      t.getSettings = () => ({ ...settings(), displaySurface: window.__surface });
      let frozenAt = null;
      let slowAt = 0;
      Object.defineProperty(t, 'stats', {
        get() {
          const real = desc.get.call(t);
          if (real === null || real === undefined) return real;
          if (window.__freeze || window.__slow) {
            if (frozenAt === null) { frozenAt = real.totalFrames; slowAt = performance.now(); }
          } else frozenAt = null;
          // __slow: ~6 fps chegando (R6 com alt-tab manda ~8 fps com a imagem parada).
          const slow = window.__slow && frozenAt !== null ? Math.floor((performance.now() - slowAt) / 170) : 0;
          const n = (frozenAt ?? real.totalFrames) + slow + window.__extra;
          return { totalFrames: n, deliveredFrames: n, discardedFrames: 0 };
        },
      });
    }
    return s;
  };
}

const people = {};
async function join(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(() => { try { localStorage.setItem('noveau:voice', 'cru'); localStorage.setItem('cenaculum:volume-hint', 'yes'); localStorage.setItem('noveau:e2e', '1'); } catch {} });
  await ctx.addInitScript(fakeMonitor, { width: 1920, height: 1080 });
  await ctx.addInitScript(fakeWindow);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${BASE}/room/pausa#${KEY}`);
  await page.fill('#nickname', name);
  await page.click('button[type=submit]');
  await page.waitForSelector('footer.dock', { timeout: 20000 });
  people[name] = { page, errors };
  return people[name];
}
const until = async (p, fn, arg, ms = 15000) => { try { await p.page.waitForFunction(fn, arg, { timeout: ms }); return true; } catch { return false; } };
const never = async (p, fn, arg, ms) => !(await until(p, fn, arg, ms));
const click = (p, title) => p.page.locator(`button[title="${title}"]`).first().click({ timeout: 10000 });
const shot = async (p, name, clip) => { if (SHOTS) await p.page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'allow', ...(clip ? { clip } : {}) }); };
const DOCK = { x: 240, y: 430, width: 800, height: 370 };
const set = (p, v) => p.page.evaluate((v) => Object.assign(window, v), v);
const playing = (sel) => { const v = document.querySelector(sel); return v !== null && v.videoWidth > 0 && !v.paused; };
const stagePaused = () => document.querySelector('main.stage-area .paused') !== null;

const A = await join('Vitória');
const B = await join('Rhenan');

// --- A transmite uma janela que vinha mandando imagem e foi minimizada (os quadros param).
await click(A, 'Compartilhar tela');
ok('B vê a janela de A no palco', await until(B, playing, 'cen-stage video'));
await wait(5000);
ok('janela mandando imagem: sem aviso', !(await B.page.evaluate(stagePaused)));
const t0 = Date.now();
await set(A, { __freeze: true });
ok('A minimizou: B vê "Transmissão pausada" no palco', await until(B, () => {
  const el = document.querySelector('main.stage-area .paused');
  return el !== null && el.textContent.includes('Transmissão pausada') && el.querySelector('.tv-static') !== null;
}, undefined, 8000), `${((Date.now() - t0) / 1000).toFixed(1)} s`);
ok('o aviso diz quem saiu da janela', (await B.page.locator('main.stage-area .paused').textContent()).includes('Vitória'));
ok('A vê "Sua transmissão está pausada"', await until(A, () => document.body.innerText.includes('Sua transmissão está pausada.')));
await wait(600);
await shot(B, '1-pausada-palco');
await shot(A, '2-pausada-quem-transmite');
// Um quadro solto (refresh do WebRTC quando alguém pede quadro-chave) não tira a pausa.
await set(A, { __extra: 1 });
ok('um quadro solto não tira a pausa', await never(B, () => document.querySelector('main.stage-area .paused') === null, undefined, 3000));
// Pessoas: a linha de A diz que está pausada.
await B.page.locator('button.people-top').click();
ok('painel de pessoas: "pausada · em outra janela"', await until(B, () => document.body.innerText.includes('pausada · em outra janela'), undefined, 4000));
await shot(B, '3-pessoas-pausada');
await B.page.locator('button.people-top').click();
// Voltou para a janela.
const t1 = Date.now();
await set(A, { __freeze: false });
ok('A voltou: o aviso some para B', await until(B, () => document.querySelector('main.stage-area .paused') === null, undefined, 6000), `${((Date.now() - t1) / 1000).toFixed(1)} s`);
ok('A volta a ver "Sua tela está no ar."', await until(A, () => document.body.innerText.includes('Sua tela está no ar.')));
ok('vídeo de A segue tocando para B', await until(B, playing, 'cen-stage video', 5000));

// --- Soluço curto (menos de 1,5 s sem quadro): nada.
await wait(4000);
await set(A, { __freeze: true });
await wait(900);
await set(A, { __freeze: false });
ok('soluço de 0,9 s: sem aviso', await never(B, stagePaused, undefined, 4000));

// --- Quadros chegando a fps normal com a imagem parada (menu de jogo, tela de carregamento): nada.
await wait(4000);
await set(A, { __still: true });
ok('imagem parada com fps normal (menu): sem aviso', await never(B, stagePaused, undefined, 6000));
// --- Poucos quadros com a imagem congelada (R6 com alt-tab, ~8 fps): pausa.
const t2 = Date.now();
await set(A, { __slow: true });
ok('poucos quadros com a imagem congelada: B vê "Transmissão pausada"', await until(B, stagePaused, undefined, 8000), `${((Date.now() - t2) / 1000).toFixed(1)} s`);
// Os quadros voltam a fps normal (mesmo com a imagem parecida): a pausa sai na hora.
const t3 = Date.now();
await set(A, { __slow: false });
ok('quadros voltam: o aviso some logo', await until(B, () => document.querySelector('main.stage-area .paused') === null, undefined, 4000), `${((Date.now() - t3) / 1000).toFixed(1)} s`);
await set(A, { __still: false });
await wait(4000);
ok('janela mexendo normal: sem aviso', !(await B.page.evaluate(stagePaused)));
// --- Pausada sem quadros, e a imagem volta mudando a poucos fps: sai na hora.
await set(A, { __freeze: true });
ok('pausa de novo (sem quadros)', await until(B, stagePaused, undefined, 8000));
await set(A, { __freeze: false, __slow: true });
ok('poucos quadros mas com imagem nova: o aviso some', await until(B, () => document.querySelector('main.stage-area .paused') === null, undefined, 4000));
await set(A, { __slow: false });
await wait(4000);

// --- Tela inteira parada: não é janela, nunca avisa.
await set(A, { __surface: 'monitor' });
await wait(1500);
await set(A, { __freeze: true });
ok('tela inteira parada: sem aviso', await never(B, stagePaused, undefined, 5000));
await set(A, { __freeze: false, __surface: 'window' });
await wait(1000);

// --- Janela parada desde o começo (documento aberto, nada mexendo): sem aviso.
await click(A, 'Parar de compartilhar');
await until(B, () => document.querySelector('cen-stage') === null, undefined, 8000);
await set(A, { __freeze: true });
await click(A, 'Compartilhar tela');
ok('B vê a nova tela de A', await until(B, () => document.querySelector('cen-stage') !== null, undefined, 10000));
ok('janela parada desde o começo: sem aviso', await never(B, stagePaused, undefined, 6000));
await set(A, { __freeze: false });
await wait(5000);

// --- Grade: com duas telas, a pausada aparece com chuvisco no monitor dela.
const C = await join('Vitin');
await click(C, 'Compartilhar tela');
ok('B tem a tecla da tela de Vitin na barra', await until(B, () => document.querySelectorAll('cen-live-strip .face').length >= 1, undefined, 10000));
await B.page.evaluate(() => window.__noveau.session.unfocus());
ok('B vê a grade com 2 telas', await until(B, () => document.querySelectorAll('cen-share-tile').length === 2, undefined, 8000));
await set(A, { __freeze: true });
ok('grade: o monitor de A mostra "pausada"', await until(B, () => {
  const t = [...document.querySelectorAll('cen-share-tile')].find((x) => x.querySelector('.name')?.textContent.includes('Vitória'));
  return t?.querySelector('.paused .tv-static') !== null && t?.querySelector('.paused') !== null;
}, undefined, 8000));
await wait(500);
await shot(B, '4-grade-pausada');

// --- Prévia da barra: com o mouse em cima, chuvisco e depois a imagem, sem botão.
// B assiste a tela de Vitin; passa o mouse na tecla de A (pausada) e na de Vitin.
await B.page.locator('cen-share-tile').filter({ has: B.page.locator('.name', { hasText: 'Vitin' }) }).click();
ok('B focou Vitin', await until(B, () => document.querySelector('cen-stage') !== null, undefined, 5000));
const faceOf = (name) => B.page.locator(`cen-live-strip .face[aria-label*="${name}"]`).first();
await faceOf('Vitória').hover();
ok('cartão da tela pausada: chuvisco com "pausada", sem vídeo', await until(B, () => {
  const c = document.querySelector('cen-live-strip .card');
  return c !== null && c.querySelector('.snow .tv-static') !== null && c.textContent.includes('pausada') && c.querySelector('video') === null;
}, undefined, 4000));
ok('sem o botão "prévia ao vivo"', !(await B.page.evaluate(() => document.querySelector('cen-live-strip')?.textContent.includes('prévia ao vivo'))));
await wait(400);
await shot(B, '5-previa-pausada', DOCK);
await set(A, { __freeze: false });
ok('a pausa de A acaba', await until(B, () => !document.querySelector('cen-live-strip .card')?.textContent.includes('pausada'), undefined, 6000));
ok('com o mouse em cima, a prévia de A carrega sozinha', await until(B, () => {
  const v = document.querySelector('cen-live-strip .card video');
  return v !== null && v.videoWidth > 0;
}, undefined, 8000));
ok('o chuvisco sai quando a imagem chega', await until(B, () => document.querySelector('cen-live-strip .card .snow') === null, undefined, 3000));
await shot(B, '6-previa-carregada', DOCK);
// Tirou o mouse: o cartão fecha e a cópia é solta.
await B.page.mouse.move(640, 200);
ok('tirou o mouse: o cartão fecha e o vídeo sai', await until(B, () => document.querySelector('cen-live-strip .card video') === null, undefined, 3000));
// Passando de novo: chuvisco primeiro, depois a imagem.
await faceOf('Vitória').hover();
const sawSnow = await until(B, () => document.querySelector('cen-live-strip .card .snow .tv-static') !== null, undefined, 2000);
ok('ao passar de novo: chuvisco primeiro', sawSnow);
await wait(180);
await shot(B, '7-previa-chuvisco', DOCK);
ok('e depois a imagem', await until(B, () => (document.querySelector('cen-live-strip .card video')?.videoWidth ?? 0) > 0, undefined, 8000));
await B.page.mouse.move(640, 200);

for (const [n, p] of Object.entries(people)) ok(`${n}: sem erro no console`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
await browser.close();
console.log('\n' + results.join('\n'));
process.exit(results.some((r) => r.startsWith('FALHOU')) ? 1 : 0);
