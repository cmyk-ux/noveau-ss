// Queda longa: a pessoa (ou o servidor) some por mais tempo do que o LiveKit tenta retomar sozinho
// (~45 s) e a página tem que voltar para a sala sem recarregar, com o microfone ligado e ouvindo
// todo mundo.
//
// 1) A fica sem rede por QUEDA segundos (padrão 70) e volta.
// 2) Com SERVIDOR=1, o LiveKit inteiro para por QUEDA segundos (docker stop/start do contêiner
//    LK_CONTAINER, padrão lk) e todo mundo tem que voltar.
//
// Uso: BASE=http://127.0.0.1:3001 node tools/e2e/volta.mjs   (sai com 1 se algo falhar)
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { browserArgs } from './voz.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE ?? 'http://127.0.0.1:3001';
const QUEDA = Number(process.env.QUEDA ?? 70);
const KEY = 'volta' + Date.now().toString(36).padEnd(14, 'x');
const browser = await chromium.launch({ args: browserArgs() });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
let fails = 0;
function ok(name, cond, extra = '') {
  if (!cond) fails++;
  console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s ${cond ? 'OK    ' : 'FALHOU'} ${name}${extra ? ' — ' + extra : ''}`);
}

async function join(name) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('cenaculum:volume-hint', 'yes');
      localStorage.setItem('noveau:e2e', '1');
    } catch {}
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (/noveau: caiu/.test(m.text())) console.log(`      ${name}: ${m.text()}`);
  });
  await page.goto(`${BASE}/room/volta#${KEY}`);
  await page.fill('#nickname', name);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => window.__noveau?.room?.state === 'connected', undefined, { timeout: 30000 });
  await page.locator('button[title="Ligar microfone"]').first().click({ timeout: 15000 });
  await page.waitForFunction(() => window.__noveau.room.localParticipant.isMicrophoneEnabled, undefined, { timeout: 15000 });
  const cdp = await ctx.newCDPSession(page);
  return { name, page, ctx, cdp };
}

/** Bytes da voz de `who` que chegaram em `p` até agora (null se não recebe). */
const bytesFrom = (p, who) =>
  p.page.evaluate(async (who) => {
    const r = [...window.__noveau.room.remoteParticipants.values()].find((x) => x.name === who);
    const t = r?.getTrackPublication('microphone')?.track;
    if (!t?.receiver) return null;
    let b = 0;
    (await t.receiver.getStats()).forEach((s) => {
      if (s.type === 'inbound-rtp') b += s.bytesReceived ?? 0;
    });
    return b;
  }, who);

async function hears(p, who, ms = 15000) {
  const end = Date.now() + ms;
  let a = await bytesFrom(p, who);
  while (Date.now() < end) {
    await wait(700);
    const b = await bytesFrom(p, who);
    if (a !== null && b !== null && b > a + 300) return true;
    a = b;
  }
  return false;
}

const state = (p) => p.page.evaluate(() => ({ room: window.__noveau.room.state, mic: window.__noveau.room.localParticipant.isMicrophoneEnabled, banner: document.querySelector('.banner .msg')?.textContent ?? '' }));

async function backIn(p, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await state(p);
    if (s.room === 'connected' && s.mic) return true;
    await wait(500);
  }
  return false;
}

const A = await join('A');
const B = await join('B');
const C = await join('C');
ok('início: A ouve B', await hears(A, 'B'));
ok('início: B ouve A', await hears(B, 'A'));

// 1) A sem rede por QUEDA s.
await A.cdp.send('Network.enable');
await A.cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
console.log(`     A sem rede por ${QUEDA} s`);
await wait(QUEDA * 1000);
const during = await state(A);
ok('A, sem rede, mostra que está voltando', /Voltando sozinho/.test(during.banner) || during.room !== 'disconnected', JSON.stringify(during));
await A.cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
const tBack = Date.now();
ok('A voltou para a sala sozinho, com o microfone ligado', await backIn(A, 40000), `em ${((Date.now() - tBack) / 1000).toFixed(1)} s`);
ok('depois da queda: B ouve A', await hears(B, 'A'));
ok('depois da queda: C ouve A', await hears(C, 'A'));
ok('depois da queda: A ouve B', await hears(A, 'B'));
const names = await B.page.evaluate(() => [...window.__noveau.room.remoteParticipants.values()].map((x) => x.name).sort().join(','));
ok('B vê A uma vez só (sem fantasma)', names === 'A,C', names);

// 2) O servidor inteiro cai e volta.
if (process.env.SERVIDOR === '1') {
  const c = process.env.LK_CONTAINER ?? 'lk';
  // B está com a tela no ar quando o servidor cai: ao voltar, avisa que precisa compartilhar de novo.
  await B.page.locator('button[title="Compartilhar tela"]').first().click({ timeout: 10000 });
  await B.page.waitForFunction(() => window.__noveau.room.localParticipant.isScreenShareEnabled, undefined, { timeout: 20000 });
  await wait(1500);
  execSync(`docker stop -t 2 ${c}`);
  console.log(`     LiveKit parado por ${QUEDA} s`);
  await wait(QUEDA * 1000);
  execSync(`docker start ${c}`);
  const tUp = Date.now();
  const back = await Promise.all([A, B, C].map((p) => backIn(p, 60000)));
  ok('servidor de volta: todos voltaram com o microfone ligado', back.every(Boolean), `${back} em ${((Date.now() - tUp) / 1000).toFixed(1)} s`);
  const toast = await B.page.locator('.toast').textContent({ timeout: 5000 }).catch(() => '');
  ok('B foi avisado que a tela caiu junto', /tela caiu/.test(toast ?? ''), toast ?? '');
  ok('servidor de volta: A ouve B', await hears(A, 'B'));
  ok('servidor de volta: B ouve C', await hears(B, 'C'));
  ok('servidor de volta: C ouve A', await hears(C, 'A'));
}

// 3) Sair de propósito não volta sozinho.
await C.page.evaluate(() => window.__noveau.session.disconnect());
await wait(5000);
ok('quem sai de propósito não volta', (await state(C)).room === 'disconnected');

await browser.close();
console.log(fails ? `\n${fails} FALHA(S)` : '\nTudo certo');
process.exit(fails ? 1 : 0);
