// Mede o custo da sala no navegador: 3 pessoas (A transmite a tela, todos com um microfone falso
// que fala e para, ligando e desligando o "falando" como numa conversa), B e C assistem.
// Uso: node tools/e2e/measure.mjs <rótulo>   (site em BASE, padrão http://127.0.0.1:3000; LiveKit local em --dev)
// Opções: SECONDS=30 PANEL=1 (painel de pessoas aberto) CAM=1 (B liga a câmera: grade) SHOT=arquivo (fotos)
import { createRequire } from 'node:module';
import { browserArgs } from './voz.mjs';
// Playwright de onde estiver (do projeto ou instalado globalmente).
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const KEY = process.env.KEY ?? 'medicao' + Date.now().toString(36).padEnd(12, 'x');
const SECONDS = Number(process.env.SECONDS ?? 30);
const label = process.argv[2] ?? 'run';
const PEOPLE = (process.env.PEOPLE ?? 'A,B,C').split(',');

const browser = await chromium.launch({ args: process.env.VOICE === '0' ? browserArgs().slice(0, -1) : browserArgs() });

const people = [];
for (const name of PEOPLE) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(() => { try { localStorage.setItem('noveau:voice', 'cru'); localStorage.setItem('cenaculum:volume-hint', 'yes'); } catch {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Network.enable');
  const ws = { frames: 0, bytes: 0, sent: 0, kinds: {}, inKinds: {} };
  cdp.on('Network.webSocketFrameReceived', (e) => {
    ws.frames++;
    ws.bytes += e.response.payloadData.length;
    if (e.response.opcode === 2) { const b = Buffer.from(e.response.payloadData, 'base64'); const k = b[0] >> 3 === 16 || b[0] & 0x80 ? (b[0] & 0x7f) >> 3 | (b[1] << 4) : b[0] >> 3; ws.inKinds[k] = (ws.inKinds[k] ?? 0) + 1; }
  });
  cdp.on('Network.webSocketFrameSent', (e) => {
    ws.sent++;
    if (e.response.opcode === 2) { const b = Buffer.from(e.response.payloadData, 'base64'); const k = b[0] & 0x80 ? ((b[0] & 0x7f) >> 3) | (b[1] << 4) : b[0] >> 3; ws.kinds[k] = (ws.kinds[k] ?? 0) + 1; }
  });
  await page.goto(`${BASE}/room/medicao#${KEY}`);
  await page.fill('#nickname', name);
  await page.click('button[type=submit]');
  await page.waitForSelector('footer.dock', { timeout: 20000 });
  people.push({ name, page, cdp, ws, errors });
}

async function click(p, title) {
  await p.page.locator(`button[title="${title}"]`).first().click({ timeout: 10000 });
}

// Todo mundo com microfone aberto (o falso apita: "falando" liga e desliga).
for (const p of people) await click(p, 'Ligar microfone').catch((e) => p.errors.push('mic: ' + e.message));
// A transmite a tela.
await click(people[0], 'Compartilhar tela').catch((e) => people[0].errors.push('tela: ' + e.message));
if (process.env.CAM === '1') await click(people[1], 'Ligar câmera').catch((e) => people[1].errors.push('cam: ' + e.message));
if (process.env.PANEL === '1') for (const p of people) await p.page.locator('button.people-top').click().catch((e) => p.errors.push('painel: ' + e.message));
for (const p of people)
  await p.page.evaluate(() => {
    window.__flips = 0;
  }).catch(() => undefined);
await new Promise((r) => setTimeout(r, 12000));

async function metrics(p) {
  const { metrics } = await p.cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  const flips = await p.page.evaluate(() => window.__flips ?? 0);
  return { ...m, flips, frames: p.ws.frames, wsBytes: p.ws.bytes, wsSent: p.ws.sent };
}
for (const p of people)
  await p.page.evaluate(() => {
    window.__flips = 0;
    new MutationObserver((list) => {
      for (const m of list) if (m.attributeName === 'class' && m.target.classList?.contains('strip')) window.__flips++;
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
const before = await Promise.all(people.map(metrics));
await new Promise((r) => setTimeout(r, SECONDS * 1000));
const after = await Promise.all(people.map(metrics));

const rows = people.map((p, i) => {
  const a = after[i];
  const b = before[i];
  const d = (k) => a[k] - b[k];
  return {
    who: p.name,
    scriptMsPerS: +((d('ScriptDuration') * 1000) / SECONDS).toFixed(2),
    taskMsPerS: +((d('TaskDuration') * 1000) / SECONDS).toFixed(2),
    layoutsPerS: +(d('LayoutCount') / SECONDS).toFixed(2),
    stylesPerS: +(d('RecalcStyleCount') / SECONDS).toFixed(2),
    wsInPerS: +(d('frames') / SECONDS).toFixed(2),
    wsOutPerS: +(d('wsSent') / SECONDS).toFixed(2),
    heapMB: +(a.JSHeapUsedSize / 1e6).toFixed(1),
    nodes: a.Nodes,
    stripFlipsPerS: +(d('flips') / SECONDS).toFixed(2),
  };
});
console.log(JSON.stringify({ label, seconds: SECONDS, rows }, null, 0));
for (const r of rows) console.log(label, r.who, `script ${r.scriptMsPerS} ms/s`, `task ${r.taskMsPerS} ms/s`, `layout ${r.layoutsPerS}/s`, `style ${r.stylesPerS}/s`, `ws in ${r.wsInPerS}/s out ${r.wsOutPerS}/s`, `heap ${r.heapMB} MB`, `nodes ${r.nodes}`, `flips ${r.stripFlipsPerS}/s`);
for (const p of people) console.log(p.name, 'ws out por tipo', JSON.stringify(p.ws.kinds), 'ws in por tipo', JSON.stringify(p.ws.inKinds));
for (const p of people) if (p.errors.length) console.log(p.name, 'erros:', p.errors.slice(0, 5).join(' | '));
if (process.env.SHOT) for (const p of people) await p.page.screenshot({ path: `${process.env.SHOT}-${p.name}.png` });
await browser.close();
