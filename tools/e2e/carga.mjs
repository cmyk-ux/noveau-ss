// Teste de carga e estabilidade da sala: N pessoas com microfone falando e parando, por vários
// minutos, medindo o que cada uma recebe das outras (perda, jitter, fila de chegada, som
// "inventado" para tapar buracos), quedas de conexão e se alguém deixa de ouvir alguém.
//
// TELAS=k faz as k primeiras pessoas compartilharem a tela (1080p falso) e cada pessoa assistir à
// tela de alguém, o pior caso para o servidor.
//
// Uso: BASE=https://noveau.riajuu.net N=8 MIN=10 node tools/e2e/carga.mjs [rótulo]
//      (BASE padrão http://127.0.0.1:3001; sai com 1 se alguém deixou de ouvir alguém ou caiu)
// Saída: uma linha por intervalo (INTERVALO=15 s) e um resumo; JSON=arquivo grava tudo.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { browserArgs, fakeMonitor } from './voz.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE ?? 'http://127.0.0.1:3001';
const N = Number(process.env.N ?? 8);
const MIN = Number(process.env.MIN ?? 10);
const TELAS = Number(process.env.TELAS ?? 0);
const STEP = Number(process.env.INTERVALO ?? 15) * 1000;
const KEY = process.env.KEY ?? 'carga' + Date.now().toString(36).padEnd(14, 'x');
const label = process.argv[2] ?? 'carga';
const NAMES = Array.from({ length: N }, (_, i) => 'bot' + String.fromCharCode(65 + i));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(5) + 's';

// Um navegador para cada 4 pessoas: o som de todas num processo só pode engasgar o próprio teste.
const browsers = [];
async function browserFor(i) {
  const b = Math.floor(i / 4);
  if (!browsers[b]) browsers[b] = await chromium.launch({ args: browserArgs() });
  return browsers[b];
}

function watchConnection() {
  // Guarda cada mudança de estado da sala (reconectando, desconectado) com a hora.
  window.__carga = { states: [], since: Date.now() };
  const tick = setInterval(() => {
    const room = window.__noveau?.room;
    if (!room) return;
    clearInterval(tick);
    room.on('connectionStateChanged', (s) => window.__carga.states.push([Date.now(), s]));
    room.on('reconnecting', () => window.__carga.states.push([Date.now(), 'reconnecting!']));
    room.on('signalReconnecting', () => window.__carga.states.push([Date.now(), 'signalReconnecting!']));
    room.on('reconnected', () => window.__carga.states.push([Date.now(), 'reconnected!']));
    room.on('disconnected', (r) => window.__carga.states.push([Date.now(), 'disconnected:' + r]));
  }, 100);
}

const people = [];
async function join(name, i) {
  const browser = await browserFor(i);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('cenaculum:volume-hint', 'yes');
      localStorage.setItem('noveau:e2e', '1');
    } catch {}
  });
  await ctx.addInitScript(fakeMonitor, { width: 1920, height: 1080 });
  await ctx.addInitScript(watchConnection);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200));
  });
  await page.goto(`${BASE}/room/carga#${KEY}`);
  await page.fill('#nickname', name);
  const tJoin = Date.now();
  await page.click('button[type=submit]');
  await page.waitForFunction(() => window.__noveau?.room?.state === 'connected', undefined, { timeout: 30000 });
  const joinMs = Date.now() - tJoin;
  await page.waitForFunction(() => window.__noveau.session && !document.querySelector('button[title="Ligar microfone"]:disabled'), undefined, { timeout: 20000 }).catch(() => undefined);
  await page.locator('button[title="Ligar microfone"]').first().click({ timeout: 15000 });
  await page.waitForFunction(() => window.__noveau.room.localParticipant.isMicrophoneEnabled, undefined, { timeout: 15000 });
  const p = { name, page, ctx, errors, joinMs, last: null };
  people.push(p);
  return p;
}

/** O que esta pessoa recebe agora: contadores acumulados por pessoa ouvida + conexão. */
function sample(p) {
  return p.page.evaluate(async () => {
    const room = window.__noveau.room;
    const out = { state: room.state, mics: {}, screens: {}, rtt: null, sendLoss: null, states: window.__carga.states.splice(0) };
    for (const r of room.remoteParticipants.values()) {
      const name = r.name || r.identity.split('#')[0];
      const mic = r.getTrackPublication('microphone');
      const t = mic?.track;
      if (t?.receiver) {
        let s = null;
        (await t.receiver.getStats()).forEach((x) => {
          if (x.type === 'inbound-rtp') s = x;
        });
        if (s)
          out.mics[name] = {
            recv: s.packetsReceived ?? 0,
            lost: Math.max(0, s.packetsLost ?? 0),
            jitter: s.jitter ?? 0,
            conc: s.concealedSamples ?? 0,
            silConc: s.silentConcealedSamples ?? 0,
            samples: s.totalSamplesReceived ?? 0,
            jbDelay: s.jitterBufferDelay ?? 0,
            jbCount: s.jitterBufferEmittedCount ?? 0,
            bytes: s.bytesReceived ?? 0,
          };
        else out.mics[name] = null;
      } else out.mics[name] = mic ? { unsubscribed: true } : null;
      const scr = r.getTrackPublication('screen_share');
      if (scr?.track?.receiver) {
        let s = null;
        (await scr.track.receiver.getStats()).forEach((x) => {
          if (x.type === 'inbound-rtp') s = x;
        });
        if (s) out.screens[name] = { frames: s.framesDecoded ?? 0, fps: s.framesPerSecond ?? 0, w: s.frameWidth ?? 0, freezes: s.freezeCount ?? 0, freezeS: s.totalFreezesDuration ?? 0, lost: s.packetsLost ?? 0, recv: s.packetsReceived ?? 0, bytes: s.bytesReceived ?? 0 };
      }
    }
    // Ida e volta até o servidor e perda no envio do microfone (o que o servidor relata).
    const mine = room.localParticipant.getTrackPublication('microphone')?.track;
    if (mine?.sender) {
      (await mine.sender.getStats()).forEach((x) => {
        if (x.type === 'remote-inbound-rtp') out.sendLoss = x.fractionLost ?? null;
        if (x.type === 'candidate-pair' && x.nominated && x.currentRoundTripTime !== undefined) out.rtt = x.currentRoundTripTime;
      });
    }
    return out;
  });
}

const intervals = [];
const problems = [];
function delta(a, b) {
  // Diferença entre duas leituras acumuladas de uma pessoa ouvida.
  if (!a || !b || a.unsubscribed || b.unsubscribed) return null;
  const d = {};
  for (const k of ['recv', 'lost', 'conc', 'silConc', 'samples', 'jbDelay', 'jbCount', 'bytes']) d[k] = b[k] - a[k];
  d.jitter = b.jitter;
  return d;
}

console.log(`${ts()} ${label}: ${N} pessoas, ${MIN} min, ${TELAS} telas, sala ${KEY} em ${BASE}`);
for (let i = 0; i < N; i++) {
  const p = await join(NAMES[i], i);
  console.log(`${ts()} ${p.name} entrou em ${p.joinMs} ms`);
}

if (TELAS > 0) {
  for (const p of people.slice(0, TELAS)) {
    await p.page.locator('button[title="Compartilhar tela"]').first().click({ timeout: 10000 });
    await p.page.waitForFunction(() => window.__noveau.room.localParticipant.isScreenShareEnabled, undefined, { timeout: 20000 });
    // Um "jogo" que mexe: a tela falsa do Chromium já se mexe (contador e bolinha).
  }
  await wait(3000);
  // Cada pessoa assiste à tela de alguém (a de quem vem depois na lista, entre quem compartilha).
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    const target = people[(i + 1) % TELAS === i ? (i + 2) % TELAS : (i + 1) % TELAS];
    const id = await target.page.evaluate(() => window.__noveau.room.localParticipant.identity);
    if (target !== p) await p.page.evaluate((id) => window.__noveau.session.focusShare(id), id).catch((e) => p.errors.push('foco: ' + e.message));
    p.watching = target === p ? null : target.name;
  }
  console.log(`${ts()} ${TELAS} telas no ar; cada um assiste a uma`);
}

// Uns segundos para todo mundo receber todo mundo antes da primeira leitura.
await wait(5000);
for (const p of people) p.last = await sample(p);
let lostHearing = 0;
let drops = 0;
const end = Date.now() + MIN * 60_000;
while (Date.now() < end) {
  await wait(STEP);
  const row = { t: Math.round((Date.now() - t0) / 1000), pairs: 0, missing: [], loss: [], jitter: [], conc: [], jb: [], rtt: [], screens: [], states: [] };
  for (const p of people) {
    const s = await sample(p).catch((e) => ({ error: String(e) }));
    if (s.error) {
      row.missing.push(`${p.name}: página travou (${s.error.slice(0, 80)})`);
      continue;
    }
    for (const st of s.states) row.states.push(`${p.name} ${st[1]}`);
    if (s.state !== 'connected') row.missing.push(`${p.name} está ${s.state}`);
    if (s.rtt !== null) row.rtt.push(s.rtt * 1000);
    for (const q of people) {
      if (q === p) continue;
      const d = delta(p.last.mics[q.name], s.mics[q.name]);
      if (!d) {
        row.missing.push(`${p.name} não recebe ${q.name} (${JSON.stringify(s.mics[q.name])})`);
        continue;
      }
      row.pairs++;
      // Falando ~57% do tempo; no silêncio o Opus do navegador manda pouco (DTX) mas manda.
      if (d.recv < 20) row.missing.push(`${p.name} recebeu só ${d.recv} pacotes de ${q.name}`);
      const tot = d.recv + d.lost;
      if (tot > 0) row.loss.push((100 * d.lost) / tot);
      row.jitter.push(d.jitter * 1000);
      if (d.samples > 0) row.conc.push((100 * (d.conc - d.silConc)) / d.samples);
      if (d.jbCount > 0) row.jb.push((1000 * d.jbDelay) / d.jbCount);
    }
    for (const [who, v] of Object.entries(s.screens)) {
      const a = p.last.screens?.[who];
      if (a) row.screens.push({ p: p.name, who, fps: (v.frames - a.frames) / (STEP / 1000), w: v.w, freezeS: v.freezeS - a.freezeS, mbps: ((v.bytes - a.bytes) * 8) / (STEP / 1000) / 1e6, lost: v.lost - a.lost, recv: v.recv - a.recv });
    }
    p.last = s;
  }
  intervals.push(row);
  lostHearing += row.missing.length;
  drops += row.states.filter((x) => /reconnecting|disconnected/i.test(x)).length;
  for (const m of row.missing) problems.push(`${row.t}s ${m}`);
  for (const m of row.states) problems.push(`${row.t}s ${m}`);
  const max = (a) => (a.length ? Math.max(...a) : 0);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const scr = row.screens.length ? ` | telas ${avg(row.screens.map((x) => x.fps)).toFixed(0)} fps (mín ${Math.min(...row.screens.map((x) => x.fps)).toFixed(0)}), ${avg(row.screens.map((x) => x.mbps)).toFixed(1)} Mbps, travou ${row.screens.reduce((s, x) => s + x.freezeS, 0).toFixed(1)} s` : '';
  console.log(
    `${ts()} pares ${row.pairs}/${N * (N - 1)} | perda média ${avg(row.loss).toFixed(2)}% máx ${max(row.loss).toFixed(2)}% | jitter ${avg(row.jitter).toFixed(1)} ms máx ${max(row.jitter).toFixed(1)} | som tapado ${avg(row.conc).toFixed(2)}% máx ${max(row.conc).toFixed(2)}% | fila ${avg(row.jb).toFixed(0)} ms máx ${max(row.jb).toFixed(0)} | rtt ${avg(row.rtt).toFixed(0)} ms${scr}${row.missing.length ? ' | PROBLEMAS ' + row.missing.length : ''}${row.states.length ? ' | conexão: ' + row.states.join(', ') : ''}`,
  );
}

const all = (k) => intervals.flatMap((r) => r[k]);
const pct = (a, q) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const summary = {
  label,
  N,
  MIN,
  TELAS,
  joinMs: people.map((p) => p.joinMs),
  lossAvg: all('loss').reduce((a, b) => a + b, 0) / Math.max(1, all('loss').length),
  lossP99: pct(all('loss'), 0.99),
  jitterP50: pct(all('jitter'), 0.5),
  jitterP99: pct(all('jitter'), 0.99),
  concP99: pct(all('conc'), 0.99),
  jbP50: pct(all('jb'), 0.5),
  jbP99: pct(all('jb'), 0.99),
  rttP50: pct(all('rtt'), 0.5),
  problems: problems.length,
  drops,
  errors: people.flatMap((p) => p.errors.map((e) => `${p.name}: ${e}`)).slice(0, 30),
};
console.log('\nRESUMO ' + JSON.stringify(summary, null, 1));
if (problems.length) console.log('Problemas:\n' + problems.slice(0, 60).join('\n'));
if (process.env.JSON) writeFileSync(process.env.JSON, JSON.stringify({ summary, intervals }, null, 1));
for (const b of browsers) await b.close();
process.exit(lostHearing > 0 || drops > 0 ? 1 : 0);
