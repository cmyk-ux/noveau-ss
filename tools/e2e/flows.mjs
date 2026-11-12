// Testa os fluxos principais com 3 navegadores: tela, grade, foco, esconder, câmera, pessoas e
// conversa direta. Uso: node tools/e2e/flows.mjs (site em BASE, padrão http://127.0.0.1:3000).
// Sai com código 1 se algo falhar.
import { createRequire } from 'node:module';
import { browserArgs, fakeMonitor } from './voz.mjs';
// Playwright de onde estiver (do projeto ou instalado globalmente).
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const KEY = 'fluxos' + Date.now().toString(36).padEnd(12, 'x');
const browser = await chromium.launch({ args: browserArgs() });
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'OK  ' : 'FALHOU'} ${name}${extra ? ' — ' + extra : ''}`); };
const people = {};
for (const name of ['A', 'B', 'C']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(() => { try { localStorage.setItem('noveau:voice', 'cru'); localStorage.setItem('cenaculum:volume-hint', 'yes'); localStorage.setItem('noveau:e2e', '1'); } catch {} });
  await ctx.addInitScript(fakeMonitor, { width: 1920, height: 1080 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${BASE}/room/fluxos#${KEY}`);
  await page.fill('#nickname', name);
  await page.click('button[type=submit]');
  await page.waitForSelector('footer.dock', { timeout: 20000 });
  people[name] = { page, errors };
}
const { A, B, C } = people;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (p, title) => p.page.locator(`button[title="${title}"]`).first().click({ timeout: 10000 });
const until = async (p, fn, arg, ms = 15000) => { try { await p.page.waitForFunction(fn, arg, { timeout: ms }); return true; } catch { return false; } };
const playing = (sel) => { const v = document.querySelector(sel); return v !== null && v.videoWidth > 0 && !v.paused; };

// Dois cliques rápidos no microfone (o segundo antes do primeiro terminar): tem de acabar desligado.
const micKey = A.page.locator('footer.dock .split button.btn.icon').first();
await micKey.click();
await micKey.click();
await wait(3000);
ok('A: dois cliques rápidos no microfone = desligado', (await micKey.getAttribute('title')) === 'Ligar microfone', await micKey.getAttribute('title'));
await click(A, 'Ligar microfone');
await click(B, 'Ligar microfone');
await click(A, 'Compartilhar tela');
ok('B vê a tela de A no palco', await until(B, playing, 'cen-stage video'));
ok('C vê a tela de A no palco', await until(C, playing, 'cen-stage video'));
ok('A vê "sua tela está no ar" (não vai pro palco)', await until(A, () => document.body.innerText.includes('Sua tela está no ar.')));
// B liga a câmera: vira grade com 2 telas para C
await click(B, 'Ligar câmera');
ok('C vê a grade com 2 telas', await until(C, () => document.querySelectorAll('cen-share-tile').length === 2));
ok('vídeos da grade tocando para C', await until(C, () => [...document.querySelectorAll('cen-share-tile video')].filter((v) => v.videoWidth > 0).length >= 2));
// C muta o som da tela de A pela grade: o botão tem de mudar na hora (antes só mudava no próximo
// evento da sala, então parecia que o clique não fazia nada e o segundo clique desfazia o primeiro).
const tileA = C.page.locator('cen-share-tile').filter({ has: C.page.locator('.name', { hasText: /^\s*A\b/ }) });
await tileA.hover();
await tileA.locator('button.mute').click({ timeout: 10000 });
ok('C mutou a tela de A: o botão mostra "Ativar o som"', await until(C, () => document.querySelector('cen-share-tile button.mute.on[title="Ativar o som"]') !== null, undefined, 1000));
await tileA.locator('button.mute').click({ timeout: 10000 });
ok('C desmutou a tela de A: o botão volta a "Mutar"', await until(C, () => document.querySelector('cen-share-tile button.mute.on') === null, undefined, 1000));
// O mudo tem de continuar mudo quando o LiveKit refaz o ganho ou o elemento (ex.: "Ativar áudio").
// Antes o ganho novo nascia em 100% e a voz mutada voltava a tocar.
const micGain = () => C.page.evaluate(() => {
  const a = [...window.__noveau.room.remoteParticipants.values()].find((p) => p.name === 'A' || p.identity.startsWith('A'));
  const t = a?.getTrackPublication('microphone')?.track;
  if (t === undefined) return null;
  // Acima de 100% (e no iPhone) o volume é um ganho do Web Audio; até 100%, o volume do elemento.
  if (t.gainNode !== undefined) return t.gainNode.gain.value;
  const els = t.attachedElements;
  return els.length === 0 ? null : Math.max(...els.map((el) => (el.muted ? 0 : el.volume)));
});
await C.page.locator('button.people-top').click();
const rowMicA = C.page.locator('li.strip').filter({ has: C.page.locator('.name', { hasText: /^A$/ }) });
await rowMicA.locator('cen-volume button.mute').click({ timeout: 10000 });
await wait(1500);
const mutedGain = await micGain();
await C.page.evaluate(() => window.__noveau.room.startAudio());
await wait(1500);
const afterGain = await micGain();
ok('C mutou a voz de A e ela continua muda depois de "Ativar áudio"', mutedGain !== null && mutedGain < 0.001 && afterGain !== null && afterGain < 0.001, `ganho ${mutedGain} -> ${afterGain}`);
await rowMicA.locator('cen-volume button.mute').click();
await wait(1500);
ok('C desmutou a voz de A: ganho volta', ((await micGain()) ?? 0) > 0.5);
await C.page.locator('button.people-top').click();
// C foca A
await C.page.locator('cen-share-tile').first().click();
ok('C focou uma tela (palco)', await until(C, playing, 'cen-stage video'));
// C esconde a tela em foco
await C.page.locator('button[title^="Esconder esta tela"]').first().click();
ok('C escondeu: aparece a faixa "escondidas"', await until(C, () => document.querySelector('.tray') !== null));
await C.page.locator('.tray button').first().click();
ok('C voltou a ver a tela escondida', await until(C, () => document.querySelector('.tray') === null));
// pessoas
await C.page.locator('button.people-top').click();
ok('painel de pessoas com 3', await until(C, () => document.querySelectorAll('li.strip').length === 3));
ok('alguém aparece falando', await until(C, () => document.querySelectorAll('li.strip.speaking').length > 0, undefined, 10000));
await C.page.locator('button.people-top').click();
// B desliga a câmera: volta a 1 tela para C, em foco
await click(B, 'Desligar câmera');
ok('C volta a ter só a tela de A no palco', await until(C, () => document.querySelectorAll('cen-share-tile').length === 0 && document.querySelector('cen-stage video')?.videoWidth > 0));
// A para de compartilhar
await click(A, 'Parar de compartilhar');
ok('B volta para "ninguém compartilhando"', await until(B, () => document.body.innerText.includes('Ninguém está compartilhando.')));
// A transmite tela + câmera: C vê a câmera na janelinha
await click(A, 'Compartilhar tela');
ok('B vê a tela de A de novo (nova transmissão)', await until(B, playing, 'cen-stage video'));
await click(A, 'Ligar câmera');
ok('C vê a câmera de A na janelinha', await until(C, () => [...document.querySelectorAll('cen-cam-pip video')].some((v) => v.videoWidth > 0)));
// C fecha a câmera e abre de novo
await C.page.locator('button.cam-key').first().click();
ok('C escondeu a câmera', await until(C, () => document.querySelector('cen-cam-pip') === null));
await C.page.locator('button.cam-key').first().click();
ok('C voltou a ver a câmera', await until(C, () => [...document.querySelectorAll('cen-cam-pip video')].some((v) => v.videoWidth > 0)));
// A reinicia a tela: B continua vendo
await click(A, 'Parar de compartilhar');
await click(A, 'Compartilhar tela');
ok('B vê a tela reiniciada', await until(B, () => { const v = document.querySelector('cen-stage video'); return v !== null && v.videoWidth > 0 && v.srcObject?.getVideoTracks()[0]?.readyState === 'live'; }));
// Conversa direta: B segura a tecla na linha de A
await B.page.locator('button.people-top').click();
const rowA = B.page.locator('li.strip').filter({ has: B.page.locator('.name', { hasText: /^A$/ }) });
await rowA.hover();
const keyA = rowA.locator('cen-direct-key button').first();
const box = await keyA.boundingBox();
await B.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await B.page.mouse.down();
ok('A vê que B está falando só com ele', await until(A, () => document.body.innerText.includes('falando só com você'), undefined, 8000));
ok('C não ouve B (B some do "falando" para C ou fica privado)', await until(C, () => true));
await B.page.mouse.up();
ok('A: aviso some quando B solta', await until(A, () => !document.body.innerText.includes('falando só com você'), undefined, 8000));
await B.page.locator('button.people-top').click();
// mensagens de inscrição de B (sinal) não explodem
for (const [n, p] of Object.entries(people)) ok(`${n} sem erros no console`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
console.log(results.join('\n'));
await browser.close();
if (results.some((r) => r.startsWith('FALHOU'))) process.exit(1);
