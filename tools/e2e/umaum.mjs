// 1o1 (conversa a dois / segurar para falar só com uma pessoa) com a sala cheia, muitas vezes seguidas.
//
// Confere, em cada ciclo e para CADA pessoa de fora:
// - durante o 1o1: o servidor não manda a voz de nenhum dos dois (não é só volume no zero);
// - depois de sair: a voz dos dois volta a chegar (bytes subindo), a faixa está viva e ligada, o
//   elemento de áudio tocando e o volume de volta ao normal.
// Varia quem puxa, quem sai, segurar x travar, gente entrando no meio e apertar/soltar rápido.
//
// Precisa do LiveKit local e do site servido pela API (veja controles.mjs).
// Uso: BASE=http://127.0.0.1:3001 N=6 CICLOS=3 node tools/e2e/umaum.mjs   (sai com 1 se algo falhar)
import { createRequire } from 'node:module';
import { browserArgs } from './voz.mjs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE ?? 'http://127.0.0.1:3001';
const N = Number(process.env.N ?? 6);
const CICLOS = Number(process.env.CICLOS ?? 3);
const KEY = 'umaum' + Date.now().toString(36).padEnd(14, 'x');
const NAMES = 'ABCDEFGHIJ'.split('').slice(0, N);

const browser = await chromium.launch({ args: browserArgs() });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
let checks = 0;
let step = '';
function ok(name, cond, extra = '') {
  checks++;
  if (!cond) fails++;
  console.log(`${new Date().toISOString().slice(11, 23)} ${cond ? 'OK    ' : 'FALHOU'} [${step}] ${name}${extra ? ' — ' + extra : ''}`);
  return Boolean(cond);
}

const people = {};
async function join(name) {
  // F entra pelo celular (Android): outro caminho de tela e de som.
  const ctx = await browser.newContext({ ...(name === 'F' ? devices['Pixel 7'] : { viewport: { width: 1100, height: 700 } }), permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('noveau:voice', 'cru');
      localStorage.setItem('cenaculum:volume-hint', 'yes');
      localStorage.setItem('noveau:e2e', '1');
    } catch {}
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await page.goto(`${BASE}/room/umaum#${KEY}`);
  await page.fill('#nickname', name);
  await page.click('button[type=submit]');
  await page.waitForSelector('footer.dock', { timeout: 30000 });
  await page.waitForFunction(() => window.__noveau?.room?.state === 'connected', undefined, { timeout: 20000 });
  const p = { name, page, ctx, errors };
  people[name] = p;
  return p;
}

async function micOn(p) {
  await p.page.waitForFunction(() => !window.__noveau.store.busy(), undefined, { timeout: 20000 }).catch(() => undefined);
  if ((await p.page.locator('button[title="Ligar microfone"]').count()) > 0) await p.page.locator('button[title="Ligar microfone"]').first().click();
  await p.page.waitForFunction(() => window.__noveau.room.localParticipant.isMicrophoneEnabled, undefined, { timeout: 15000 });
}

const idOf = (p) => p.page.evaluate(() => window.__noveau.room.localParticipant.identity);

/** O que `p` recebe da voz de `who`: servidor, faixa, elemento e volume. */
function hearing(p, who) {
  return p.page.evaluate(async (who) => {
    const room = window.__noveau.room;
    const r = [...room.remoteParticipants.values()].find((x) => (x.name || x.identity.split('#')[0]) === who && !x.attributes?.phoneOf);
    if (!r) return { person: false };
    const pub = r.getTrackPublication('microphone');
    if (!pub) return { person: true, pub: false };
    const t = pub.track;
    let bytes = 0;
    if (t?.receiver) (await t.receiver.getStats()).forEach((s) => { if (s.type === 'inbound-rtp') bytes += s.bytesReceived ?? 0; });
    const els = t?.attachedElements ?? [];
    const vol = t?.gainNode ? t.gainNode.gain.value : els.length > 0 ? Math.max(...els.map((e) => (e.muted ? 0 : e.volume))) : null;
    return {
      person: true,
      pub: true,
      subscribed: pub.isSubscribed,
      allowed: pub.isAllowed,
      live: t?.mediaStreamTrack?.readyState === 'live',
      enabled: t?.mediaStreamTrack?.enabled === true,
      playing: els.some((e) => !e.paused),
      els: els.length,
      gain: vol === null ? null : Math.round(vol * 1000) / 1000,
      attr: r.attributes?.direct ?? '',
      bytes,
    };
  }, who);
}

/** `p` ouve `who` de verdade: bytes subindo, faixa viva, tocando e volume normal. */
async function hears(p, who, ms = 12000) {
  const t0 = Date.now();
  const end = t0 + ms;
  let a = await hearing(p, who);
  let last = a;
  while (Date.now() < end) {
    await wait(700);
    const b = await hearing(p, who);
    last = b;
    if (b.subscribed && b.live && b.enabled && b.playing && b.gain !== null && b.gain > 0.5 && b.bytes > (a.bytes ?? 0) + 150) return { ok: true, last, ms: Date.now() - t0 };
    a = b;
  }
  return { ok: false, last };
}

/** O servidor não manda a voz de `who` para `p` (cortado na inscrição, não só no volume). */
async function cut(p, who, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await hearing(p, who);
    if (last.pub && (last.subscribed === false || last.allowed === false)) {
      // E continua sem chegar nada (bytes parados).
      const a = last.bytes;
      await wait(800);
      const b = await hearing(p, who);
      if (!b.subscribed || b.bytes === a) return { ok: true, last: b };
    }
    await wait(200);
  }
  return { ok: false, last };
}

async function allHearAll(label, group) {
  const res = await Promise.all(
    group.flatMap((p) => group.filter((q) => q !== p).map(async (q) => ({ p: p.name, q: q.name, r: await hears(p, q.name) }))),
  );
  const bad = res.filter((x) => !x.r.ok);
  const slow = Math.max(0, ...res.map((x) => x.r.ms ?? 0));
  ok(`${label}: todos ouvem todos (${res.length} pares, o mais lento em ${slow} ms)`, bad.length === 0, bad.map((x) => `${x.p} não ouve ${x.q} ${JSON.stringify(x.r.last)}`).join(' | '));
}

async function outsidersCut(label, pair, group) {
  const outs = group.filter((p) => !pair.includes(p));
  const res = await Promise.all(outs.flatMap((o) => pair.map(async (x) => ({ o: o.name, x: x.name, r: await cut(o, x.name) }))));
  const bad = res.filter((x) => !x.r.ok);
  ok(`${label}: ninguém de fora recebe os dois (${res.length} pares)`, bad.length === 0, bad.map((x) => `${x.o} recebe ${x.x} ${JSON.stringify(x.r.last)}`).join(' | '));
}

async function pairHearsOnlyEachOther(label, a, b, group) {
  ok(`${label}: ${a.name} ouve ${b.name}`, (await hears(a, b.name)).ok);
  ok(`${label}: ${b.name} ouve ${a.name}`, (await hears(b, a.name)).ok);
  for (const x of [a, b]) {
    const others = group.filter((p) => p !== a && p !== b);
    const g = await Promise.all(others.map((o) => hearing(x, o.name)));
    ok(`${label}: ${x.name} não ouve o resto da sala`, g.every((s) => !s.subscribed || s.gain === null || s.gain < 0.01), JSON.stringify(g.map((s) => s.gain)));
  }
}

/** Sons do 1o1 que tocaram em `p` desde a última leitura. */
const cues = (p) => p.page.evaluate(() => window.__noveau.session.cues.splice(0));

const store = (p) => ({
  lock: (id) => p.page.evaluate((id) => window.__noveau.store.directLock(id), id),
  hold: (id) => p.page.evaluate((id) => window.__noveau.store.directHold(id), id),
  release: (id) => p.page.evaluate((id) => window.__noveau.store.directRelease(id), id),
  end: () => p.page.evaluate(() => window.__noveau.store.directEnd()),
});
const inTalk = (p) => p.page.evaluate(() => window.__noveau.store.direct() !== null);
async function untilOut(p, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await inTalk(p))) return true;
    await wait(150);
  }
  return false;
}
async function untilIn(p, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await inTalk(p)) return true;
    await wait(150);
  }
  return false;
}

// ---------------------------------------------------------------- sala
const group = [];
for (const n of NAMES) group.push(await join(n));
for (const p of group) await micOn(p);
const ids = Object.fromEntries(await Promise.all(group.map(async (p) => [p.name, await idOf(p)])));
step = 'início';
// Variedade de quem ouve: C com A acima de 100% (passa pelo Web Audio), D com todos em 80%.
if (group.length > 3) await group[2].page.evaluate((id) => window.__noveau.store.setVolume('mic', id, 1.5), ids.A);
if (group.length > 4) for (const n of NAMES.filter((n) => n !== 'D')) await group[3].page.evaluate((id) => window.__noveau.store.setVolume('mic', id, 0.8), ids[n]);
await allHearAll('sala cheia', group);

const [A, B, C] = group;
for (let i = 1; i <= CICLOS; i++) {
  // 1) A puxa B, A sai.
  step = `ciclo ${i}: A puxa B, A sai`;
  await cues(A);
  await cues(B);
  await store(A).lock(ids.B);
  ok('B entra junto', await untilIn(B));
  ok('som: A ouve "puxei"', JSON.stringify(await cues(A)) === '["pull"]');
  ok('som: B ouve "fui puxado"', JSON.stringify(await cues(B)) === '["pulled"]');
  await outsidersCut('durante', [A, B], group);
  await pairHearsOnlyEachOther('durante', A, B, group);
  await store(A).end();
  ok('A sai', await untilOut(A));
  ok('B sai junto', await untilOut(B));
  ok('som: os dois ouvem "saiu"', JSON.stringify([await cues(A), await cues(B)]) === '[["leave"],["leave"]]');
  ok('som: ninguém de fora ouve nada', (await Promise.all(group.slice(2).map(cues))).every((c) => c.length === 0));
  await allHearAll('depois', group);

  // 2) B puxa A, A (o puxado) sai — o caso do Pedro.
  step = `ciclo ${i}: B puxa A, A sai`;
  await store(B).lock(ids.A);
  ok('A entra junto', await untilIn(A));
  await outsidersCut('durante', [A, B], group);
  await store(A).end();
  ok('A sai', await untilOut(A));
  ok('B sai junto', await untilOut(B));
  await allHearAll('depois', group);

  // 3) Segurar para falar com C (hold) e soltar.
  step = `ciclo ${i}: A segura para C`;
  await cues(A);
  await store(A).hold(ids.C);
  await outsidersCut('segurando', [A], group.filter((p) => p !== C));
  await store(A).release(ids.C);
  ok('som: segurar não toca nada', (await cues(A)).length === 0);
  await allHearAll('soltou', group);

  // 4) Apertar e soltar rápido várias vezes, depois travar e sair rápido.
  step = `ciclo ${i}: rápido`;
  for (let k = 0; k < 4; k++) {
    await store(A).hold(ids.B);
    await wait(40 + k * 30);
    await store(A).release(ids.B);
  }
  await store(A).lock(ids.B);
  await wait(150);
  await store(B).end();
  await wait(100);
  await store(A).end();
  ok('ninguém fica preso numa conversa', (await untilOut(A)) && (await untilOut(B)));
  await allHearAll('depois do rápido', group);
}

// 9) "Toc toc": A está num 1o1 com B e C tenta puxar A. Só A ouve o aviso, uma vez; C arrastar de
// novo logo em seguida não toca de novo (20 s por pessoa), nem D logo depois (5 s entre quaisquer).
step = 'toc toc';
await store(A).lock(ids.B);
ok('B entra junto', await untilIn(B));
await Promise.all(group.map(cues));
await store(C).lock(ids.A);
await wait(1500);
ok('A ouve o toc toc', JSON.stringify(await cues(A)) === '["knock"]');
ok('A continua no 1o1 com B', (await A.page.evaluate(() => window.__noveau.store.direct()?.peer)) === ids.B);
ok('C ouve "puxei" e fica esperando', JSON.stringify(await cues(C)) === '["pull"]' && (await C.page.evaluate(() => window.__noveau.store.direct()?.waiting)) === true);
ok('ninguém mais ouve nada', (await Promise.all(group.filter((p) => p !== A && p !== C).map(cues))).every((c) => c.length === 0));
await store(C).end();
await wait(400);
await store(C).lock(ids.A);
await wait(1200);
ok('C insistindo: não toca de novo', (await cues(A)).length === 0);
const D = group[3];
await store(D).lock(ids.A);
await wait(1200);
ok('D logo depois: não toca (5 s entre avisos)', (await cues(A)).length === 0);
await store(D).end();
await store(C).end();
ok('C e D saem', (await untilOut(C)) && (await untilOut(D)));
await store(A).end();
ok('A e B saem', (await untilOut(A)) && (await untilOut(B)));
await wait(5200);
await store(A).lock(ids.B);
ok('B entra junto de novo', await untilIn(B));
await cues(A);
await store(D).lock(ids.A);
await wait(1500);
ok('D depois de 5 s: toca', JSON.stringify(await cues(A)) === '["knock"]');
await store(D).end();
ok('D sai', await untilOut(D));
await store(A).end();
ok('A e B saem', (await untilOut(A)) && (await untilOut(B)));
await allHearAll('depois do toc toc', group);
await Promise.all(group.map(cues));

// 5) Gente entrando e saindo durante o 1o1.
step = 'entra gente no meio';
await store(A).lock(ids.B);
ok('B entra junto', await untilIn(B));
const late = await join('Z');
await micOn(late);
group.push(late);
await outsidersCut('durante (com Z)', [A, B], group);
await store(B).end();
ok('A sai junto', await untilOut(A));
await allHearAll('depois (com Z)', group);

// 8) A voz de A volta para o servidor, mas a faixa se perde no navegador de C (o caso do vitin: um
// de fora continuou sem ouvir os dois). A conferência de C refaz a inscrição sozinha.
step = 'faixa perdida em quem está de fora';
const spurious = await Promise.all(group.map((p) => p.page.evaluate(() => window.__noveau.session.direct.resubscribes)));
ok('até aqui a conferência não precisou refazer nada', spurious.every((n) => n === 0), JSON.stringify(spurious) + ' ' + JSON.stringify(await group[2].page.evaluate(() => window.__noveau.session.direct.resubscribeLog)));
await store(A).lock(ids.B);
ok('B entra junto', await untilIn(B));
await outsidersCut('durante', [A, B], group);
await C.page.evaluate(() => {
  const room = window.__noveau.room;
  for (const r of room.remoteParticipants.values()) {
    if (!['A', 'B'].includes(r.name)) continue;
    const orig = r.addSubscribedMediaTrack.bind(r);
    let dropped = false;
    r.addSubscribedMediaTrack = (track, ...rest) => {
      if (!dropped && track.kind === 'audio') {
        dropped = true;
        return undefined; // some sem avisar ninguém
      }
      return orig(track, ...rest);
    };
  }
});
await store(A).end();
ok('A sai', await untilOut(A));
ok('C volta a ouvir A sozinho', (await hears(C, 'A', 15000)).ok);
ok('C volta a ouvir B sozinho', (await hears(C, 'B', 15000)).ok);
ok('C teve de refazer as inscrições', (await C.page.evaluate(() => window.__noveau.session.direct.resubscribes)) >= 2);
await allHearAll('depois', group);

// 7) A não pode ficar preso sozinho no 1o1: B entra e sai enquanto A não vê (rede de A caída), e na
// volta A só vê o estado final de B. Antes A ficava "esperando" B para sempre: sem ouvir a sala e
// com a sala sem ouvir A.
step = 'A não vê B entrar e sair';
await store(B).hold(ids.C); // B ocupado: não entra no 1o1 de A ainda
await store(A).lock(ids.B);
await wait(1200);
const cdpA = await A.ctx.newCDPSession(A.page);
await cdpA.send('Network.enable');
await cdpA.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await store(B).release(ids.C);
ok('B entra no 1o1 de A', await untilIn(B));
await wait(500);
await store(B).end();
ok('B sai', await untilOut(B));
await wait(1500);
await cdpA.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
ok('A volta e sai sozinho do 1o1', await untilOut(A, 25000));
await allHearAll('depois', group);
// A queda de rede de A é de propósito: os erros de conexão dela não contam.
A.errors.splice(0);

// 6) Celular de A como microfone: no 1o1 o servidor também corta a voz que vem do celular.
step = 'celular como microfone';
await A.page.evaluate(() => window.__noveau.store.makePhoneLink('mic'));
const code = await A.page.evaluate(async () => {
  for (let i = 0; i < 50; i++) {
    const c = window.__noveau.store.phoneLink().code;
    if (c) return c;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
});
ok('link do celular', code !== null);
const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], permissions: ['microphone', 'camera'] });
await phoneCtx.addInitScript(() => localStorage.setItem('noveau:e2e', '1'));
const phone = await phoneCtx.newPage();
const perrs = [];
phone.on('pageerror', (e) => perrs.push(String(e)));
await phone.goto(`${BASE}/celular?mic#${code}`);
await phone.locator('button', { hasText: /Permitir/ }).first().click({ timeout: 4000 }).catch(() => undefined);
/** O que `p` recebe do microfone do celular de A. */
const fromPhone = (p) => p.page.evaluate(async (owner) => {
  const r = [...window.__noveau.room.remoteParticipants.values()].find((x) => x.attributes?.phoneOf === owner);
  const pub = r?.getTrackPublication('microphone');
  if (!pub) return { pub: false };
  let bytes = 0;
  if (pub.track?.receiver) (await pub.track.receiver.getStats()).forEach((s) => { if (s.type === 'inbound-rtp') bytes += s.bytesReceived ?? 0; });
  return { pub: true, subscribed: pub.isSubscribed, allowed: pub.isAllowed, bytes };
}, ids.A);
async function phoneState(p, want, ms = 12000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    const a = await fromPhone(p);
    await wait(800);
    last = await fromPhone(p);
    const flowing = last.pub && last.subscribed && last.bytes > (a.bytes ?? 0) + 150;
    if (want === 'flowing' ? flowing : last.pub && !flowing && (!last.subscribed || last.allowed === false)) return true;
  }
  console.log('   ', p.name, want, JSON.stringify(last));
  return false;
}
ok('C recebe a voz do celular de A', await phoneState(C, 'flowing', 25000));
await store(A).lock(ids.B);
ok('B entra junto', await untilIn(B));
ok('1o1: B recebe a voz do celular de A', await phoneState(B, 'flowing'));
const outs = group.filter((p) => p !== A && p !== B);
ok('1o1: ninguém de fora recebe a voz do celular de A (servidor)', (await Promise.all(outs.map((p) => phoneState(p, 'cut')))).every(Boolean));
await store(A).end();
ok('A sai', await untilOut(A));
ok('depois: todos voltam a receber a voz do celular de A', (await Promise.all(outs.map((p) => phoneState(p, 'flowing')))).every(Boolean));
ok('celular sem erros', perrs.length === 0, perrs.join(' | '));

const errs = group.flatMap((p) => p.errors.map((e) => `${p.name}: ${e}`));
ok('sem erros no console', errs.length === 0, errs.slice(0, 5).join(' | '));
console.log(`\n${checks - fails}/${checks} ok`);
await browser.close();
process.exit(fails > 0 ? 1 : 0);
