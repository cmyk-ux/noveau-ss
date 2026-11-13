// Tira uma foto de cada tela e de cada menu do site, para comparar antes/depois de mexer no visual.
//
// Precisa do LiveKit local e do site compilado servido pela API (porta 3001), como os outros testes.
// Uso: BASE=http://127.0.0.1:3001 OUT=/caminho/da/pasta node tools/e2e/telas.mjs
// MOBILE=1 tira também as do celular (Pixel 7).
import { mkdirSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { createRequire } from 'node:module';
import { browserArgs, fakeMonitor } from './voz.mjs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE ?? 'http://127.0.0.1:3001';
const OUT = process.env.OUT ?? 'telas';
const KEY = 'telas' + Date.now().toString(36).padEnd(14, 'x');
mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ args: browserArgs() });

async function context(mobile) {
  const ctx = await browser.newContext({
    ...(mobile ? devices['Pixel 7'] : { viewport: { width: 1366, height: 860 }, deviceScaleFactor: 1 }),
    permissions: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'],
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('noveau:voice', 'cru');
      localStorage.setItem('cenaculum:volume-hint', 'yes');
    } catch {}
  });
  await ctx.addInitScript(fakeMonitor, { width: 1920, height: 1080 });
  return ctx;
}

async function shot(page, name) {
  await wait(700); // animações de abrir
  await page.screenshot({ path: pathJoin(OUT, name + '.png') });
  console.log('foto', name);
}

async function join(ctx, name, room = 'telas') {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/room/${room}#${KEY}`);
  await page.waitForSelector('#nickname');
  return {
    page,
    enter: async () => {
      await page.fill('#nickname', name);
      await page.click('button[type=submit]');
      await page.waitForSelector('footer.dock', { timeout: 20000 });
    },
  };
}

/** Abre um menu da dock pelo aria-label da tecla, fotografa e fecha. */
async function menu(page, label, name, scroll = false) {
  await page.click(`footer.dock [aria-label="${label}"]`);
  await page.waitForSelector('.pop');
  await shot(page, name);
  if (scroll) {
    await page.$eval('.pop', (el) => (el.scrollTop = el.scrollHeight));
    await shot(page, name + '-fim');
  }
  await page.keyboard.press('Escape');
  await wait(300);
}

async function desktop() {
  const home = await (await context(false)).newPage();
  await home.goto(BASE + '/');
  await shot(home, '01-inicio');

  const a = await join(await context(false), 'Pedro');
  await shot(a.page, '02-entrar');
  await a.enter();
  await shot(a.page, '03-sala-vazia');

  const b = await join(await context(false), 'Vitoria');
  await b.enter();
  await wait(1500);

  await menu(a.page, 'Escolher microfone', '04-menu-mic', true);
  await menu(a.page, 'Qualidade da transmissão', '05-menu-tela', true);
  await menu(a.page, 'Escolher câmera', '06-menu-camera', true);
  await menu(a.page, 'Plugin de DAW', '07-menu-daw', true);
  await menu(a.page, 'Transmitir pelo OBS', '08-menu-obs', true);

  await a.page.click('.people-top');
  await a.page.waitForSelector('aside.panel');
  await shot(a.page, '09-pessoas');
  await a.page.click('aside.panel .close');
  await wait(300);

  await a.page.click('.diag-wrap > .btn');
  await shot(a.page, '10-diagnostico');
  await a.page.keyboard.press('Escape');
  await a.page.click('.diag-wrap > .btn').catch(() => {});
  await wait(300);
  await a.page.keyboard.press('Escape');

  // Janela da voz (equalizador, ruído, sala).
  await a.page.click('footer.dock [aria-label="Escolher microfone"]');
  await a.page.click('.pop button:has-text("Equalizador")').catch(() => {});
  await wait(900);
  await shot(a.page, '11-voz');
  for (const tab of await a.page.$$('cen-voice-panel [role=tab]')) {
    const t = (await tab.textContent()).trim().slice(0, 12).replace(/\W+/g, '-');
    await tab.click();
    await shot(a.page, '11-voz-' + t);
  }
  await a.page.keyboard.press('Escape');
  await a.page.locator('cen-voice-panel button[title="Fechar"]').click().catch(() => {});
  await wait(400);

  // Alguém transmitindo: o palco e a barra de quem assiste.
  await b.page.click('footer.dock .split:nth-child(2) > .btn:first-child');
  await wait(4000);
  await shot(a.page, '12-assistindo');
  await shot(b.page, '13-transmitindo');
}

async function mobile() {
  const a = await join(await context(true), 'Pedro', 'telas-cel');
  await a.enter();
  await shot(a.page, 'cel-01-sala-vazia');
  await menu(a.page, 'Escolher microfone', 'cel-02-menu-mic');
  await menu(a.page, 'Escolher câmera', 'cel-03-menu-camera');
}

try {
  await desktop();
  if (process.env.MOBILE === '1') await mobile();
} finally {
  await browser.close();
}
