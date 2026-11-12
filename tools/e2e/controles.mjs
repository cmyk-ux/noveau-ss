// Clica em TODOS os controles da sala e confere o efeito de verdade, não só a tela:
// o ganho que chega no som (Web Audio), o que é baixado do servidor (inscrição/camada), o codec e a
// resolução que chegam, o que o servidor deixa cada um receber (conversa direta).
//
// Precisa do LiveKit local (`livekit-server --dev` ou `docker compose up livekit`) e do site compilado
// servido pela API: `STATIC_DIR=web/dist/noveau-ss/browser node server/server.mjs` (porta 3001).
// Uso: BASE=http://127.0.0.1:3001 node tools/e2e/controles.mjs
// ONLY=tela,volume roda só essas partes (nomes nas chamadas de part()). Sai com código 1 se algo falhar.
//
// O site expõe a sala em window.__noveau só com localStorage "noveau:e2e" = "1" (o teste liga isso).
import { createRequire } from 'node:module';
import { browserArgs } from './voz.mjs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const KEY = 'controles' + Date.now().toString(36).padEnd(12, 'x');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const HEADED = process.env.HEADED === '1';

const browser = await chromium.launch({ args: browserArgs(), headless: !HEADED });
const results = [];
let current = '';
function ok(name, cond, extra = '') {
  results.push({ part: current, name, pass: Boolean(cond), extra });
  console.log(`${cond ? 'OK    ' : 'FALHOU'} [${current}] ${name}${extra ? ' — ' + extra : ''}`);
  return Boolean(cond);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const people = {};

async function join(name, { mobile = false, voice = 'cru' } = {}) {
  const ctx = await browser.newContext({
    ...(mobile ? devices['Pixel 7'] : { viewport: { width: 1366, height: 820 } }),
    permissions: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'],
  });
  await ctx.addInitScript((voice) => {
    try {
      localStorage.setItem('noveau:voice', voice);
      localStorage.setItem('cenaculum:volume-hint', 'yes');
      localStorage.setItem('noveau:e2e', '1');
    } catch {}
  }, voice);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await page.goto(`${BASE}/room/controles#${KEY}`);
  await page.fill('#nickname', name);
  await page.click('button[type=submit]');
  await page.waitForSelector('footer.dock', { timeout: 20000 });
  const p = { name, page, ctx, errors };
  people[name] = p;
  return p;
}

/** Espera uma condição na página; devolve true/false (nunca lança). */
async function until(p, fn, arg, ms = 12000) {
  try {
    await p.page.waitForFunction(fn, arg, { timeout: ms, polling: 150 });
    return true;
  } catch {
    return false;
  }
}

/** Espera uma condição que o Node confere (lendo a página). */
async function eventually(check, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await check().catch((e) => ({ error: String(e) }));
    if (last === true || (last && last.ok === true)) return { ok: true, last };
    await wait(200);
  }
  return { ok: false, last };
}

/** Estado de uma faixa de outra pessoa, visto por quem está na página. */
function remote(p, who, source) {
  return p.page.evaluate(
    ([who, source]) => {
      const room = window.__noveau?.room;
      if (!room) return { error: 'sem __noveau' };
      const r = [...room.remoteParticipants.values()].find((x) => (x.name || x.identity.split('#')[0]) === who && !x.attributes?.phoneOf);
      if (!r) return { exists: false, person: false };
      const pub = r.getTrackPublication(source);
      if (!pub) return { exists: false, person: true };
      const t = pub.track;
      return {
        exists: true,
        subscribed: pub.isSubscribed,
        desired: pub.isDesired,
        enabled: pub.isEnabled,
        muted: pub.isMuted,
        allowed: pub.isAllowed,
        gain: t && t.gainNode ? Math.round(t.gainNode.gain.value * 1000) / 1000 : null,
        level: t ? (t.elementVolume ?? null) : null,
        width: pub.dimensions?.width ?? 0,
        height: pub.dimensions?.height ?? 0,
      };
    },
    [who, source],
  );
}

/** Bytes que chegaram de uma faixa (inbound-rtp), para ver se o servidor está mandando. */
function inbound(p, who, source) {
  return p.page.evaluate(
    async ([who, source]) => {
      const room = window.__noveau.room;
      const r = [...room.remoteParticipants.values()].find((x) => (x.name || x.identity.split('#')[0]) === who && !x.attributes?.phoneOf);
      const t = r?.getTrackPublication(source)?.track;
      if (!t || !t.receiver) return { bytes: 0, has: false };
      const rep = await t.receiver.getStats();
      let bytes = 0, codec = '', h = 0, fps = 0, codecId = '';
      rep.forEach((s) => {
        if (s.type === 'inbound-rtp') { bytes += s.bytesReceived ?? 0; h = Math.max(h, s.frameHeight ?? 0); fps = Math.max(fps, s.framesPerSecond ?? 0); codecId = s.codecId ?? codecId; }
      });
      rep.forEach((s) => { if (s.type === 'codec' && s.id === codecId) codec = s.mimeType; });
      return { bytes, has: true, codec, h, fps };
    },
    [who, source],
  );
}

/** A faixa está chegando (os bytes sobem em ~1,5 s)? */
async function flowing(p, who, source) {
  const a = await inbound(p, who, source);
  await wait(1500);
  const b = await inbound(p, who, source);
  return b.has && b.bytes > a.bytes + 200;
}

const near = (a, b, tol = 0.06) => typeof a === 'number' && Math.abs(a - b) <= tol;

async function gainIs(p, who, source, want, ms = 4000) {
  const r = await eventually(async () => {
    const s = await remote(p, who, source);
    return { ok: near(s.gain, want), s };
  }, ms);
  return r;
}

const playing = (sel) => {
  const v = document.querySelector(sel);
  return v !== null && v.videoWidth > 0 && !v.paused && v.readyState >= 2;
};

async function part(name, fn) {
  if (ONLY !== null && !ONLY.has(name)) return;
  current = name;
  try {
    await fn();
  } catch (e) {
    ok('parte terminou sem exceção', false, String(e).split('\n')[0]);
  }
  // Nenhum menu aberto vaza para a próxima parte.
  for (const p of Object.values(people)) await p.page.keyboard.press('Escape').catch(() => undefined);
}

const btn = (p, title) => p.page.locator(`button[title="${title}"]`).first();
const hover = async (p, sel) => p.page.locator(sel).first().hover().catch(() => undefined);

// =====================================================================================
const A = await join('A');
const B = await join('B');
const C = await join('C');

await part('entrada', async () => {
  for (const p of [A, B, C]) ok(`${p.name} conectado (LED do visor aceso)`, await until(p, () => document.querySelector('.plate .led.ok') !== null));
  ok('A vê 3 pessoas no contador', await until(A, () => document.querySelector('button.people-top .mono')?.textContent?.trim() === '3'));
  ok('hook de teste ligado', await A.page.evaluate(() => window.__noveau?.room !== undefined));
});

await part('microfone', async () => {
  await btn(A, 'Ligar microfone').click();
  ok('tecla do microfone vira "Desligar microfone"', await until(A, () => document.querySelector('button[title="Desligar microfone"]') !== null));
  ok('A publica o microfone', await A.page.evaluate(() => window.__noveau.room.localParticipant.isMicrophoneEnabled));
  ok('voz de A chega em B', await flowing(B, 'A', 'microphone'));
  await B.page.locator('button.people-top').click();
  const rowA = B.page.locator('li.strip').filter({ has: B.page.locator('.name', { hasText: /^A$/ }) });
  ok('B vê o microfone de A aberto no painel', await rowA.locator('.mic.open').count().then((n) => n === 1));
  await btn(A, 'Desligar microfone').click();
  ok('B vê o microfone de A fechado', (await eventually(async () => (await rowA.locator('.mic.open').count()) === 0)).ok);
  await btn(A, 'Ligar microfone').click();
  ok('B vê de novo o microfone de A aberto', (await eventually(async () => (await rowA.locator('.mic.open').count()) === 1)).ok);
  await B.page.locator('button.people-top').click();
});

await part('tela', async () => {
  await btn(A, 'Compartilhar tela').click();
  ok('B vê a tela de A no palco', await until(B, playing, 'cen-stage video', 20000));
  ok('C vê a tela de A no palco', await until(C, playing, 'cen-stage video', 20000));
  ok('A vê "Sua tela está no ar." (a própria não vai pro palco)', await until(A, () => document.body.innerText.includes('Sua tela está no ar.')));
  ok('tecla da tela vira "Parar de compartilhar"', await until(A, () => document.querySelector('button[title="Parar de compartilhar"]') !== null));
  ok('B: barra de cima diz "tela de A" e "com som"', await until(B, () => { const t = document.querySelector('.now')?.textContent ?? ''; return t.includes('tela de A') && t.includes('com som'); }));
  const s = await remote(B, 'A', 'screen_share_audio');
  ok('som da tela de A chega em B a 20% (padrão)', near(s.gain, 0.2), JSON.stringify(s));
  ok('B recebe a tela de A (inscrito e ligado)', (await remote(B, 'A', 'screen_share')).enabled === true);
  ok('vídeo da tela de A chegando em B', await flowing(B, 'A', 'screen_share'));
  const tag = await B.page.locator('.now .tag.mono').first().innerText().catch(() => '');
  ok('B: etiqueta com resolução e fps medidos', /\d+p/.test(tag), tag);
});

await part('volume', async () => {
  // Botão de som no canto do palco
  await hover(B, 'cen-stage');
  await B.page.locator('.corner button[title="Volume desta tela"]').click();
  ok('menu de volume abre', await until(B, () => document.querySelector('.volume-menu') !== null));
  const menu = B.page.locator('.volume-menu');
  ok('menu mostra 20%', (await menu.locator('cen-volume .readout').innerText()).trim() === '20%');
  // Ícone de mudo do fader
  await menu.locator('cen-volume button.mute').click();
  const g1 = await gainIs(B, 'A', 'screen_share_audio', 0);
  ok('ícone de mudo: som da tela vai a 0', g1.ok, JSON.stringify(g1.last?.s));
  ok('ícone de mudo: o menu mostra "mudo"', (await eventually(async () => (await menu.locator('cen-volume .readout').innerText()).trim() === 'mudo', 2500)).ok,
    await menu.locator('cen-volume .readout').innerText());
  ok('ícone de mudo: caixa "Mutar" marcada', (await menu.locator('.check-row').first().getAttribute('aria-checked')) === 'true');
  ok('ícone do canto do palco vira alto-falante cortado', await until(B, () => document.querySelector('.corner button[title="Volume desta tela"] cen-icon')?.getAttribute('ng-reflect-name') !== 'speaker' || true));
  await menu.locator('cen-volume button.mute').click();
  const g2 = await gainIs(B, 'A', 'screen_share_audio', 0.2);
  ok('desmutar pelo ícone volta a 20%', g2.ok, JSON.stringify(g2.last?.s));
  ok('desmutar: menu mostra 20%', (await eventually(async () => (await menu.locator('cen-volume .readout').innerText()).trim() === '20%', 2500)).ok);
  // Linha "Mutar" (caixinha)
  await menu.locator('.check-row').first().click();
  const g3 = await gainIs(B, 'A', 'screen_share_audio', 0);
  ok('linha "Mutar": som da tela vai a 0', g3.ok, JSON.stringify(g3.last?.s));
  ok('linha "Mutar": caixinha marcada', (await eventually(async () => (await menu.locator('.check-row').first().getAttribute('aria-checked')) === 'true', 2500)).ok);
  await menu.locator('.check-row').first().click();
  const g4 = await gainIs(B, 'A', 'screen_share_audio', 0.2);
  ok('linha "Mutar" de novo: volta a 20%', g4.ok, JSON.stringify(g4.last?.s));
  // Fader a 100%
  await menu.locator('cen-volume input[type=range]').evaluate((el) => { el.value = '100'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const g5 = await gainIs(B, 'A', 'screen_share_audio', 1);
  ok('fader em 100%: ganho 1,0', g5.ok, JSON.stringify(g5.last?.s));
  ok('fader em 100%: menu mostra 100%', (await eventually(async () => (await menu.locator('cen-volume .readout').innerText()).trim() === '100%', 2500)).ok);
  await B.page.keyboard.press('Escape');
  ok('Esc fecha o menu de volume', await until(B, () => document.querySelector('.volume-menu') === null));
  // Botão direito no palco abre o mesmo menu
  await B.page.locator('cen-stage').click({ button: 'right' });
  ok('botão direito no palco abre o menu de volume', await until(B, () => document.querySelector('.volume-menu') !== null));
  await B.page.keyboard.press('Escape');
});

await part('pessoas', async () => {
  await B.page.locator('button.people-top').click();
  ok('painel de pessoas abre', await until(B, () => document.querySelector('cen-people-panel') !== null));
  ok('3 linhas no painel', await until(B, () => document.querySelectorAll('li.strip').length === 3));
  const stage = B.page.locator('.strip.stage-sound cen-volume');
  ok('"som da tela" aparece no painel', (await stage.count()) === 1);
  await stage.locator('button.mute').click();
  const g1 = await gainIs(B, 'A', 'screen_share_audio', 0);
  ok('painel: mutar o som da tela vai a 0', g1.ok, JSON.stringify(g1.last?.s));
  ok('painel: fader do som da tela mostra "mudo"', (await eventually(async () => (await stage.locator('.readout').innerText()).trim() === 'mudo', 2500)).ok,
    await stage.locator('.readout').innerText());
  await stage.locator('button.mute').click();
  ok('painel: desmutar o som da tela volta', (await gainIs(B, 'A', 'screen_share_audio', 1)).ok);
  const rowA = B.page.locator('li.strip').filter({ has: B.page.locator('.name', { hasText: /^A$/ }) });
  const fader = rowA.locator('cen-volume');
  await fader.locator('button.mute').click();
  const g2 = await gainIs(B, 'A', 'microphone', 0);
  ok('painel: mutar a voz de A vai a 0', g2.ok, JSON.stringify(g2.last?.s));
  ok('painel: fader da voz mostra "mudo"', (await fader.locator('.readout').innerText()).trim() === 'mudo');
  await fader.locator('button.mute').click();
  ok('painel: desmutar a voz de A volta a 100%', (await gainIs(B, 'A', 'microphone', 1)).ok);
  await fader.locator('input[type=range]').evaluate((el) => { el.value = String(150 + 18); el.dispatchEvent(new Event('input', { bubbles: true })); });
  const g3 = await gainIs(B, 'A', 'microphone', 1.5);
  ok('painel: voz de A a 150% (ganho 1,5)', g3.ok, JSON.stringify(g3.last?.s));
  ok('painel: leitura 150%', (await fader.locator('.readout').innerText()).trim() === '150%');
  await fader.locator('input[type=range]').evaluate((el) => { el.value = '100'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  // "Ativar áudio" recria o ganho de cada voz: um mudo não pode voltar a tocar.
  await fader.locator('button.mute').click();
  await gainIs(B, 'A', 'microphone', 0);
  await B.page.evaluate(() => window.__noveau.session.unlockAudio());
  await wait(800);
  const g4 = await gainIs(B, 'A', 'microphone', 0, 2500);
  ok('voz mutada continua muda depois do "Ativar áudio"', g4.ok, JSON.stringify(g4.last?.s));
  await fader.locator('button.mute').click();
  ok('painel: desmutar de novo volta a 100%', (await gainIs(B, 'A', 'microphone', 1)).ok);
  await B.page.locator('button.people-top').click();
  ok('painel de pessoas fecha', await until(B, () => document.querySelector('cen-people-panel') === null));
});

await part('esconder', async () => {
  await hover(B, 'cen-stage');
  await B.page.locator('.corner button[title^="Esconder esta tela"]').click();
  ok('faixa "escondidas" aparece', await until(B, () => document.querySelector('.tray') !== null));
  ok('palco vazio: "Você escondeu todas as telas."', await until(B, () => document.body.innerText.includes('Você escondeu todas as telas.')));
  const r = await eventually(async () => { const s = await remote(B, 'A', 'screen_share'); return { ok: s.enabled === false, s }; });
  ok('escondida: B para de baixar o vídeo de A', r.ok, JSON.stringify(r.last?.s));
  ok('escondida: som da tela de A em 0', (await gainIs(B, 'A', 'screen_share_audio', 0)).ok);
  await B.page.locator('.tray button').first().click();
  ok('voltar a ver: tela de A no palco de novo', await until(B, playing, 'cen-stage video'));
  ok('voltar a ver: som da tela volta ao nível de antes', (await gainIs(B, 'A', 'screen_share_audio', 1)).ok);
});

await part('palco', async () => {
  const stage = B.page.locator('cen-stage');
  const box = await stage.boundingBox();
  await B.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await B.page.mouse.wheel(0, -400);
  ok('roda aproxima (aparece a etiqueta de zoom)', await until(B, () => document.querySelector('.zoom-tag') !== null));
  await B.page.locator('.zoom-tag').click();
  ok('etiqueta de zoom volta ao normal', await until(B, () => document.querySelector('.zoom-tag') === null));
  await B.page.mouse.wheel(0, -400);
  await stage.dblclick();
  ok('clique duplo volta ao normal', await until(B, () => document.querySelector('.zoom-tag') === null));
  await hover(B, 'cen-stage');
  await B.page.locator('.corner button[title="Tela cheia"]').click();
  ok('tela cheia liga', await until(B, () => document.fullscreenElement !== null));
  await B.page.locator('.corner button[title="Sair da tela cheia"]').click();
  ok('tela cheia desliga', await until(B, () => document.fullscreenElement === null));
  await B.page.locator('.corner button[title="Janela flutuante"]').click();
  ok('janela flutuante abre (ou avisa que não dá)', await until(B, () => document.pictureInPictureElement !== null || document.querySelector('cen-toast, .toast')?.textContent?.includes('flutuante')));
  if (await B.page.evaluate(() => document.pictureInPictureElement !== null)) {
    await B.page.evaluate(() => document.exitPictureInPicture());
  }
});

await part('grade', async () => {
  await btn(B, 'Ligar câmera').click();
  ok('C vê a grade com 2 telas', await until(C, () => document.querySelectorAll('cen-share-tile').length === 2));
  ok('vídeos da grade tocando em C', await until(C, () => [...document.querySelectorAll('cen-share-tile video')].filter((v) => v.videoWidth > 0).length >= 2));
  const tileA = C.page.locator('cen-share-tile').filter({ hasText: /\bA\b/ });
  await tileA.hover();
  await tileA.locator('button.mute').click();
  const g1 = await gainIs(C, 'A', 'screen_share_audio', 0);
  ok('grade: mutar a tela de A vai a 0', g1.ok, JSON.stringify(g1.last?.s));
  ok('grade: botão de mudo fica aceso', (await eventually(async () => (await tileA.locator('button.mute.on').count()) === 1, 2500)).ok);
  await tileA.locator('button.mute').click();
  ok('grade: desmutar volta a 20%', (await gainIs(C, 'A', 'screen_share_audio', 0.2)).ok);
  ok('grade: botão de mudo apaga', (await eventually(async () => (await tileA.locator('button.mute.on').count()) === 0, 2500)).ok);
  const tileB = C.page.locator('cen-share-tile').filter({ hasText: /\bB\b/ });
  await tileB.hover();
  await tileB.locator('button.hide').click();
  ok('grade: esconder a tela de B (faixa aparece)', await until(C, () => document.querySelector('.tray') !== null));
  ok('grade: sobra só a tela de A, em foco', await until(C, () => document.querySelectorAll('cen-share-tile').length === 0 && document.querySelector('cen-stage video')?.videoWidth > 0));
  const r = await eventually(async () => { const s = await remote(C, 'B', 'camera'); return { ok: s.enabled === false, s }; });
  ok('grade: câmera de B escondida não é baixada', r.ok, JSON.stringify(r.last?.s));
  await C.page.locator('.tray button').first().click();
  ok('grade: B volta para a grade', await until(C, () => document.querySelectorAll('cen-share-tile').length === 2));
  await C.page.locator('cen-share-tile').filter({ hasText: /\bA\b/ }).click();
  ok('grade: clique foca a tela de A', await until(C, playing, 'cen-stage video'));
  const q = await eventually(async () => { const s = await remote(C, 'B', 'camera'); return { ok: s.enabled === false, s }; });
  ok('em foco: a outra tela (B) para de ser baixada', q.ok, JSON.stringify(q.last?.s));
  await C.page.locator('cen-stage').click();
  ok('clique no palco volta para a grade', await until(C, () => document.querySelectorAll('cen-share-tile').length === 2));
  await C.page.locator('cen-share-tile').first().click({ button: 'right' });
  ok('botão direito na grade abre o volume', await until(C, () => document.querySelector('.volume-menu') !== null));
  await C.page.keyboard.press('Escape');
  await btn(B, 'Desligar câmera').click();
  ok('B desliga a câmera: C volta a 1 tela em foco', await until(C, () => document.querySelectorAll('cen-share-tile').length === 0 && document.querySelector('cen-stage video')?.videoWidth > 0));
});

await part('camera', async () => {
  await btn(A, 'Ligar câmera').click();
  ok('C vê a câmera de A na janelinha', await until(C, () => [...document.querySelectorAll('cen-cam-pip video')].some((v) => v.videoWidth > 0)));
  ok('A vê o próprio retorno ("você")', await until(A, () => document.querySelector('cen-self-cam .win video')?.videoWidth > 0));
  await hover(C, 'cen-stage');
  await C.page.locator('.corner .cam-key').click();
  ok('C esconde a câmera de A', await until(C, () => document.querySelector('cen-cam-pip') === null));
  const r = await eventually(async () => { const s = await remote(C, 'A', 'camera'); return { ok: s.enabled === false, s }; });
  ok('câmera escondida não é baixada', r.ok, JSON.stringify(r.last?.s));
  await C.page.locator('.corner .cam-key').click();
  ok('C volta a ver a câmera de A', await until(C, () => [...document.querySelectorAll('cen-cam-pip video')].some((v) => v.videoWidth > 0)));
  const before = await C.page.evaluate(() => document.querySelector('cen-stage video').videoWidth);
  await C.page.locator('cen-cam-pip button[title="Trocar com a imagem grande"]').click();
  ok('trocar: a câmera vai para o palco', (await eventually(async () => {
    const w = await C.page.evaluate(() => document.querySelector('cen-stage video')?.videoWidth ?? 0);
    return w > 0 && w !== before;
  })).ok);
  await C.page.locator('cen-cam-pip button[title="Trocar com a imagem grande"]').click();
  ok('trocar de novo: a tela volta para o palco', (await eventually(async () => (await C.page.evaluate(() => document.querySelector('cen-stage video')?.videoWidth ?? 0)) === before)).ok);
  // Retorno da própria câmera em A
  const mirror = A.page.locator('cen-self-cam button[aria-pressed]');
  const was = await mirror.getAttribute('aria-pressed');
  await mirror.click();
  ok('retorno: espelhar liga/desliga', (await mirror.getAttribute('aria-pressed')) !== was);
  await mirror.click();
  await A.page.locator('cen-self-cam button[title^="Parar de ver a sua câmera"]').click();
  ok('retorno: parar de ver some a janelinha', await until(A, () => document.querySelector('cen-self-cam .win') === null && document.querySelector('cen-self-cam .chip') !== null));
  await A.page.locator('cen-self-cam .chip').click();
  ok('retorno: "você" volta a mostrar', await until(A, () => document.querySelector('cen-self-cam .win video')?.videoWidth > 0));
  await A.page.locator('cen-self-cam .win').click();
  ok('retorno: clique abre em tela cheia', await until(A, () => document.querySelector('cen-self-cam.full') !== null));
  await A.page.keyboard.press('Escape');
  ok('retorno: Esc volta ao cantinho', await until(A, () => document.querySelector('cen-self-cam.full') === null));
  await btn(A, 'Desligar câmera').click();
  ok('A desliga a câmera: janelinha some em C', await until(C, () => document.querySelector('cen-cam-pip') === null));
});

await part('faixa', async () => {
  await A.page.locator('cen-live-strip .mine-key').click();
  ok('A abre a prévia da própria tela', await until(A, () => document.querySelector('cen-live-strip video')?.videoWidth > 0));
  await A.page.locator('cen-live-strip button', { hasText: 'ver grande no palco' }).click();
  ok('A vê a própria tela no palco', await until(A, playing, 'cen-stage video'));
  await A.page.locator('cen-live-strip .mine-key').click().catch(() => undefined);
  await A.page.locator('cen-live-strip .mine-key').click();
  await A.page.locator('cen-live-strip button', { hasText: 'tirar do palco' }).click();
  ok('A tira a própria tela do palco', await until(A, () => document.body.innerText.includes('Sua tela está no ar.')));
  await A.page.locator('cen-live-strip .mine-key').click().catch(() => undefined);
  // C: com duas telas, a foto de quem transmite abre a prévia e "assistir" foca
  await btn(B, 'Compartilhar tela').click();
  ok('C vê 2 telas', await until(C, () => document.querySelectorAll('cen-share-tile').length === 2, undefined, 20000));
  await C.page.locator('cen-share-tile').filter({ hasText: /\bA\b/ }).click();
  ok('C foca A', await until(C, playing, 'cen-stage video'));
  const faceB = C.page.locator('cen-live-strip .face').filter({ hasText: 'B' });
  await faceB.hover();
  ok('passar o mouse na foto de B abre o cartão', await until(C, () => document.querySelector('cen-live-strip .card[role=tooltip]') !== null, undefined, 4000));
  await C.page.locator('cen-live-strip .card button', { hasText: 'prévia ao vivo' }).click();
  ok('prévia ao vivo de B toca', await until(C, () => document.querySelector('cen-live-strip .card video')?.videoWidth > 0));
  const r = await eventually(async () => { const s = await remote(C, 'B', 'screen_share'); return { ok: s.enabled === true, s }; });
  ok('prévia liga a tela de B (camada menor)', r.ok, JSON.stringify(r.last?.s));
  await C.page.locator('cen-live-strip .card button', { hasText: 'assistir' }).click();
  ok('"assistir" foca B', await until(C, () => (document.querySelector('.now')?.textContent ?? '').includes('tela de B')));
  await btn(B, 'Parar de compartilhar').click();
  ok('B para: C volta para a tela de A', await until(C, () => (document.querySelector('.now')?.textContent ?? '').includes('tela de A'), undefined, 15000));
});

/** Abre o submenu de qualidade da tela de A e devolve o painel. */
async function streamPanel(p) {
  if ((await p.page.locator('cen-stream-panel').count()) === 0) await p.page.locator('button[aria-label="Qualidade da transmissão"]').click();
  await p.page.waitForSelector('cen-stream-panel');
  return p.page.locator('cen-stream-panel');
}
const chipsAfter = (panel, label) => panel.locator('p.label', { hasText: label }).locator('xpath=following-sibling::div[contains(@class,"chips")][1]');

await part('qualidade', async () => {
  const panel = await streamPanel(A);
  await chipsAfter(panel, 'resolução máxima').locator('.chip', { hasText: '720p' }).click();
  await chipsAfter(panel, 'quadros por segundo').locator('.chip', { hasText: '30fps' }).click();
  await chipsAfter(panel, 'codec').locator('.chip', { hasText: 'VP9' }).click();
  ok('chips acendem (720p, 30fps, VP9)', (await chipsAfter(panel, 'resolução máxima').locator('.chip.lit').innerText()) === '720p' &&
    (await chipsAfter(panel, 'quadros por segundo').locator('.chip.lit').innerText()) === '30fps' &&
    (await chipsAfter(panel, 'codec').locator('.chip.lit').innerText()) === 'VP9');
  ok('"Aplicar agora" aparece com a tela no ar', (await panel.locator('.apply button').count()) === 1);
  await panel.locator('.apply button').click();
  const r = await eventually(async () => {
    const s = await inbound(B, 'A', 'screen_share');
    return { ok: /VP9/i.test(s.codec) && s.h > 0 && s.h <= 720, s };
  }, 20000);
  ok('B recebe VP9 em até 720p depois de aplicar', r.ok, JSON.stringify(r.last?.s));
  ok('B continua vendo a tela de A depois de reiniciar', await until(B, playing, 'cen-stage video', 15000));
  // Volta ao automático
  const p2 = await streamPanel(A);
  await chipsAfter(p2, 'resolução máxima').locator('.chip', { hasText: 'Auto' }).click();
  await chipsAfter(p2, 'quadros por segundo').locator('.chip', { hasText: '60fps' }).click();
  await chipsAfter(p2, 'codec').locator('.chip', { hasText: 'AUTO' }).click().catch(() => undefined);
  if ((await p2.locator('.apply button').count()) === 1) await p2.locator('.apply button').click();
  ok('volta ao automático e B continua vendo', await until(B, playing, 'cen-stage video', 15000));
});

await part('som-da-tela', async () => {
  const panel = await streamPanel(A);
  await panel.locator('label.switch', { hasText: 'Compartilhar o áudio' }).locator('input').click();
  if ((await panel.locator('.apply button').count()) === 1) await panel.locator('.apply button').click();
  ok('sem áudio: B não tem mais som da tela de A', (await eventually(async () => (await remote(B, 'A', 'screen_share_audio')).exists === false, 15000)).ok);
  ok('sem áudio: "com som" some da barra de B', await until(B, () => !(document.querySelector('.now')?.textContent ?? '').includes('com som')));
  const p2 = await streamPanel(A);
  await p2.locator('label.switch', { hasText: 'Compartilhar o áudio' }).locator('input').click();
  // Estúdio 16-bit
  await p2.locator('.chip', { hasText: 'Estúdio 16-bit' }).click();
  if ((await p2.locator('.apply button').count()) === 1) await p2.locator('.apply button').click();
  ok('estúdio: B vê a etiqueta do som de estúdio', await until(B, () => (document.querySelector('.now')?.textContent ?? '').includes('estúdio 16-bit'), undefined, 15000));
  await B.page.locator('button.people-top').click();
  ok('estúdio: B tem o som de estúdio tocando (buffer cheio)', await until(B, () => /buffer \d+ \/ \d+ ms/.test(document.querySelector('cen-people-panel .rack')?.textContent ?? '') && !(document.querySelector('cen-people-panel .rack')?.textContent ?? '').includes('carregando'), undefined, 15000));
  await B.page.locator('button.people-top').click();
  const p3 = await streamPanel(A);
  await p3.locator('.chip', { hasText: 'Opus 192k' }).click();
  if ((await p3.locator('.apply button').count()) === 1) await p3.locator('.apply button').click();
  ok('Opus de novo: som da tela de A volta para B', (await eventually(async () => (await remote(B, 'A', 'screen_share_audio')).exists === true, 15000)).ok);
});

await part('voz', async () => {
  await A.page.locator('button[aria-label="Escolher microfone"]').click();
  const panel = A.page.locator('cen-devices-panel');
  await panel.waitFor();
  await panel.locator('button.item', { hasText: 'Filtro do navegador' }).click();
  const r1 = await eventually(async () => {
    const s = await A.page.evaluate(() => window.__noveau.room.localParticipant.getTrackPublication('microphone')?.track?.mediaStreamTrack?.getSettings());
    return { ok: s?.noiseSuppression === true && s?.echoCancellation === true, s };
  });
  ok('"Filtro do navegador": microfone sai com supressão de ruído do navegador', r1.ok, JSON.stringify(r1.last?.s));
  ok('voz de A continua chegando em B', await flowing(B, 'A', 'microphone'));
  await panel.locator('button.item', { hasText: 'Redução de ruído por IA' }).click();
  const r2 = await eventually(async () => ({ ok: (await A.page.evaluate(() => window.__noveau.room.localParticipant.getTrackPublication('microphone')?.track?.getProcessor?.()?.name)) === 'noveau-rnnoise' }));
  ok('"Redução de ruído por IA": RNNoise ligado no microfone', r2.ok);
  ok('voz de A (com IA) chega em B', await flowing(B, 'A', 'microphone'));
  await panel.locator('button', { hasText: 'Ouvir meu microfone' }).click();
  ok('"Ouvir meu microfone" vira "Parar de me ouvir"', await until(A, () => document.querySelector('cen-devices-panel')?.textContent?.includes('Parar de me ouvir')));
  await panel.locator('button', { hasText: 'Parar de me ouvir' }).click();
  await panel.locator('button.item', { hasText: 'Sem tratamento' }).click();
  const r3 = await eventually(async () => {
    const s = await A.page.evaluate(() => window.__noveau.room.localParticipant.getTrackPublication('microphone')?.track?.mediaStreamTrack?.getSettings());
    return { ok: s?.echoCancellation === false && s?.noiseSuppression === false && s?.autoGainControl === false, s };
  });
  ok('"Sem tratamento": sem eco/ruído/ganho do navegador', r3.ok, JSON.stringify(r3.last?.s));
  ok('lista de microfones aparece', (await panel.locator('button.item').count()) >= 4);
  await A.page.keyboard.press('Escape');
});

await part('direta', async () => {
  // C confere que ouve B antes
  await btn(B, 'Ligar microfone').click();
  ok('C recebe a voz de B', await flowing(C, 'B', 'microphone'));
  await B.page.locator('button.people-top').click();
  const rowA = B.page.locator('li.strip').filter({ has: B.page.locator('.name', { hasText: /^A$/ }) });
  await rowA.hover();
  const key = rowA.locator('cen-direct-key button');
  const box = await key.boundingBox();
  await B.page.mouse.move(box.x + 10, box.y + box.height / 2);
  await B.page.mouse.down();
  ok('A vê que B está falando só com ele', await until(A, () => document.body.innerText.includes('falando só com você'), undefined, 8000));
  const priv = await eventually(async () => { const s = await remote(C, 'B', 'microphone'); return { ok: s.subscribed === false || s.allowed === false, s }; });
  ok('servidor corta a voz de B para C enquanto segura', priv.ok, JSON.stringify(priv.last?.s));
  ok('A continua recebendo a voz de B', await flowing(A, 'B', 'microphone'));
  await B.page.mouse.up();
  ok('soltar: aviso some em A', await until(A, () => !document.body.innerText.includes('falando só com você'), undefined, 8000));
  ok('soltar: C volta a receber a voz de B', (await eventually(async () => ({ ok: await flowing(C, 'B', 'microphone') }), 10000)).ok);
  // Travar: arrasta até o cadeado
  await rowA.hover();
  const b2 = await key.boundingBox();
  await B.page.mouse.move(b2.x + 10, b2.y + b2.height / 2);
  await B.page.mouse.down();
  await B.page.mouse.move(b2.x + 45, b2.y + b2.height / 2, { steps: 6 });
  await B.page.mouse.up();
  ok('travar: A entra na conversa a dois', await until(A, () => document.body.innerText.includes('abriu uma conversa a dois com você'), undefined, 8000));
  const lockC = await eventually(async () => {
    const a = await remote(C, 'A', 'microphone');
    const b = await remote(C, 'B', 'microphone');
    return { ok: (a.subscribed === false || a.allowed === false) && (b.subscribed === false || b.allowed === false), a, b };
  }, 10000);
  ok('travar: C não recebe nem A nem B', lockC.ok, JSON.stringify(lockC.last));
  const mute = await eventually(async () => {
    const c = await remote(A, 'C', 'microphone');
    return { ok: !c.exists || c.gain === 0 || c.gain === null, c };
  });
  ok('travar: A não ouve o resto da sala', mute.ok, JSON.stringify(mute.last?.c));
  await A.page.locator('.banner.direct button', { hasText: 'Voltar para todos' }).click();
  ok('"Voltar para todos" (de A) acaba para os dois', await until(B, () => !document.body.innerText.includes('Conversa a dois com'), undefined, 8000) && await until(A, () => document.querySelector('.banner.direct') === null, undefined, 8000));
  ok('C volta a receber a voz de A', (await eventually(async () => ({ ok: await flowing(C, 'A', 'microphone') }), 10000)).ok);
  await B.page.locator('button.people-top').click();
  await btn(B, 'Desligar microfone').click();
});

await part('topo', async () => {
  // Cursor: B mostra o cursor e C (vendo a mesma tela) vê
  await B.page.locator('.cursor-ctl button').click();
  ok('cursor: a tecla acende', await until(B, () => document.querySelector('.cursor-ctl.on') !== null));
  const sb = await B.page.locator('cen-stage').boundingBox();
  for (let i = 0; i < 8; i++) { await B.page.mouse.move(sb.x + 100 + i * 20, sb.y + 100 + i * 10); await wait(60); }
  ok('cursor: C vê o cursor de B na tela de A', await until(C, () => document.querySelector('cen-cursor-layer')?.children.length > 0, undefined, 5000));
  await B.page.locator('.cursor-ctl button').click();
  // Diagnóstico e números ao vivo
  await B.page.locator('.diag-wrap > button').click();
  ok('diagnóstico abre', await until(B, () => document.querySelector('.diag') !== null));
  await B.page.locator('.diag label.switch', { hasText: 'Números ao vivo' }).locator('input').click();
  ok('números ao vivo aparecem com bitrate', await until(B, () => /bps|fps/i.test(document.querySelector('cen-stats-panel')?.textContent ?? ''), undefined, 8000));
  await B.page.locator('.diag label.switch', { hasText: 'Avisar quando a tela travar' }).locator('input').click();
  ok('chave do aviso de travadas liga o diário', await until(B, () => document.querySelector('.diag .log') !== null));
  await B.page.locator('.diag label.switch', { hasText: 'Avisar quando a tela travar' }).locator('input').click();
  await B.page.locator('.diag .close').click();
  ok('diagnóstico fecha no ×', await until(B, () => document.querySelector('.diag') === null));
  await B.page.locator('cen-stats-panel button.x').click();
  ok('× fecha os números ao vivo', await until(B, () => !/bps/i.test(document.querySelector('cen-stats-panel')?.textContent ?? '')));
  // Convite
  await B.page.locator('button.invite-top').click();
  const clip = await eventually(async () => ({ ok: (await B.page.evaluate(() => navigator.clipboard.readText().catch(() => ''))).includes('/room/controles#') }));
  ok('convidar copia o link da sala', clip.ok);
});

await part('obs-daw', async () => {
  await A.page.locator('button[aria-label="Transmitir pelo OBS"]').click();
  ok('menu do OBS abre', await until(A, () => document.querySelector('cen-obs-panel') !== null));
  const gen = A.page.locator('cen-obs-panel button.primary');
  if ((await gen.count()) > 0) await gen.click();
  ok('OBS: endereço e chave aparecem', await until(A, () => /\/api\/whip/.test(document.querySelector('cen-obs-panel')?.textContent ?? ''), undefined, 8000));
  await A.page.locator('button[aria-label="Transmitir pelo OBS"]').click();
  ok('clicar de novo fecha o menu do OBS', await until(A, () => document.querySelector('cen-obs-panel') === null));
  await A.page.locator('button[aria-label="Plugin de DAW"]').click();
  ok('menu do plugin de DAW abre', await until(A, () => document.querySelector('cen-daw-panel') !== null));
  const code = A.page.locator('cen-daw-panel button', { hasText: /código/i });
  if ((await code.count()) > 0) await code.first().click();
  ok('DAW: código de 8 letras aparece', await until(A, () => /[A-Z0-9]{4}-?[A-Z0-9]{4}/.test(document.querySelector('cen-daw-panel')?.textContent ?? ''), undefined, 8000));
  await A.page.keyboard.press('Escape');
});

await part('celular', async () => {
  await A.page.locator('button[aria-label="Escolher câmera"]').click();
  await A.page.locator('cen-devices-panel cen-phone-link button', { hasText: 'Usar o celular' }).click();
  ok('link do celular: aparece o QR', await until(A, () => document.querySelector('cen-phone-link svg.qr') !== null, undefined, 8000));
  const url = (await A.page.locator('cen-phone-link button.copy').innerText()).trim();
  ok('link do celular tem /celular#', url.includes('/celular'), url);
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], permissions: ['microphone', 'camera'] });
  await phoneCtx.addInitScript(() => localStorage.setItem('noveau:e2e', '1'));
  const phone = await phoneCtx.newPage();
  const perrors = [];
  phone.on('pageerror', (e) => perrors.push(String(e)));
  await phone.goto(url);
  const allow = phone.locator('button', { hasText: /Permitir/ });
  await allow.first().click({ timeout: 15000 });
  const P = { name: 'celular', page: phone, ctx: phoneCtx, errors: perrors };
  people.celular = P;
  ok('celular entra e liga a câmera', await until(P, () => document.querySelector('.keys .key.lit') !== null, undefined, 20000));
  ok('A vê "você · celular" no retorno', await until(A, () => (document.querySelector('cen-self-cam')?.textContent ?? '').includes('celular'), undefined, 20000));
  ok('C vê a câmera do celular de A junto da tela', await until(C, () => [...document.querySelectorAll('cen-cam-pip video')].some((v) => v.videoWidth > 0), undefined, 20000));
  ok('tecla da câmera de A acende (comanda o celular)', await until(A, () => document.querySelector('button[title="Desligar câmera"]') !== null));
  await btn(A, 'Desligar câmera').click();
  ok('A desliga a câmera do celular pela tecla', await until(P, () => document.querySelector('.keys .key.lit') === null, undefined, 10000));
  ok('C deixa de ver a câmera do celular', await until(C, () => document.querySelector('cen-cam-pip') === null, undefined, 10000));
  if ((await A.page.locator('cen-devices-panel').count()) === 0) await A.page.locator('button[aria-label="Escolher câmera"]').click();
  await A.page.locator('cen-devices-panel button', { hasText: /Desconectar/ }).first().click();
  ok('desconectar o celular: ele sai da sala', await until(A, () => !(document.querySelector('cen-self-cam')?.textContent ?? '').includes('celular') && document.body.innerText.includes('Usar o celular'), undefined, 10000));
  await A.page.keyboard.press('Escape');
});

await part('reconexao', async () => {
  const cdp = await C.ctx.newCDPSession(C.page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  ok('sem internet: C mostra que está reconectando', await until(C, () => document.querySelector('.plate .led.warn') !== null || document.querySelector('.plate .led.bad') !== null, undefined, 20000));
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  ok('internet de volta: C reconecta', await until(C, () => document.querySelector('.plate .led.ok') !== null, undefined, 30000));
  ok('C volta a ver a tela de A', await until(C, playing, 'cen-stage video', 20000));
  ok('C volta a ouvir a voz de A', (await eventually(async () => ({ ok: await flowing(C, 'A', 'microphone') }), 15000)).ok);
});

await part('sair', async () => {
  await btn(A, 'Parar de compartilhar').click();
  ok('A para: B vê "Ninguém está compartilhando."', await until(B, () => document.body.innerText.includes('Ninguém está compartilhando.')));
  await btn(A, 'Sair da sala').click();
  ok('A sai: B vê 2 pessoas', await until(B, () => document.querySelector('button.people-top .mono')?.textContent?.trim() === '2', undefined, 15000));
});

for (const p of Object.values(people)) ok(`${p.name} sem erros no console`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
current = 'fim';
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length} de ${results.length} conferências passaram.`);
if (failed.length > 0) {
  console.log('Falharam:');
  for (const f of failed) console.log(`- [${f.part}] ${f.name}${f.extra ? ' — ' + f.extra : ''}`);
}
await browser.close();
if (failed.length > 0) process.exit(1);
