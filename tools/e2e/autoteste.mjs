// Confere a página /teste (o autoteste da transmissão que qualquer pessoa roda sozinha).
//
// A tela é sintética (canvas mudando todo quadro, do tamanho pedido) no lugar do getDisplayMedia. A
// página abre uma sala só dela, transmite, assiste pela segunda conexão e mostra o veredito.
//   inteira  1920x1080 a 60 fps, ajustes da sala no Auto: "Tudo certo" e quem assiste recebe 1920x1080.
//   lenta    a "captura" só entrega 20 fps: o veredito acusa e diz que é a captura, não a rede.
//   monitor144 os quadros de animação fingem um monitor de 144 Hz: a captura é pedida a 72 (divisor do
//            monitor, monitor.ts), o codificador fica em 60, e a varredura mede 60, 72 e 144.
// Uso: BASE=http://127.0.0.1:3001 node tools/e2e/autoteste.mjs [partes separadas por vírgula]
// Sai com 1 se alguma conferência falhar.
import { createRequire } from 'node:module';
import { browserArgs } from './voz.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const ONLY = (process.argv[2] ?? 'inteira,lenta,monitor144').split(',');
const browser = await chromium.launch({ args: browserArgs() });
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FALHOU'} ${what}`);
  if (!ok) failures++;
}

async function run(label, { fps, width, height, codec = 'h264', fakeHz = 0 }) {
  console.log(`\n[${label}] tela ${width}x${height}, captura a ${fps} fps, codec ${codec}`);
  // Com permissão de microfone o Chrome mostra os endereços de verdade no ICE. Aqui o LiveKit só escuta
  // em 127.0.0.1 e sem ela a conexão não fecha; num servidor de verdade (endereço público) fecha.
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(
    ({ fps, width, height, codec, fakeHz }) => {
      if (fakeHz > 0) {
        // Monitor falso: os quadros de animação chegam com horário de um monitor de fakeHz.
        let t = performance.now();
        window.requestAnimationFrame = (cb) => setTimeout(() => cb((t += 1000 / fakeHz)), 1000 / fakeHz);
      }
      try {
        localStorage.setItem('cenaculum:stream3', JSON.stringify({ resolution: 'auto', frameRate: 60, maxBitrate: 0 }));
        localStorage.setItem('cenaculum:codec', codec);
      } catch {}
      navigator.mediaDevices.getDisplayMedia = async (opts) => {
        window.__gdm = opts;
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const x = c.getContext('2d');
        let n = 0;
        const draw = () => {
          n++;
          x.fillStyle = `hsl(${(n * 7) % 360},40%,25%)`;
          x.fillRect(0, 0, c.width, c.height);
          for (let i = 0; i < 60; i++) {
            x.fillStyle = `hsl(${(n * 11 + i * 29) % 360},85%,${30 + ((i * 7 + n) % 40)}%)`;
            x.fillRect((i * 151 + n * 37) % c.width, (i * 83 + n * 23) % c.height, 120, 80);
          }
          x.fillStyle = '#fff';
          x.font = '48px monospace';
          x.fillText(String(n), 30, 70);
        };
        draw();
        setInterval(draw, 1000 / fps);
        return c.captureStream(fps);
      };
    },
    { fps, width, height, codec, fakeHz },
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/teste`);
  await page.getByRole('button', { name: 'Começar o teste' }).click();
  await page.waitForSelector('.verdict', { timeout: 90000 });
  const verdict = (await page.textContent('.verdict'))?.trim() ?? '';
  const rows = Object.fromEntries(
    await page.$$eval('table.rows tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? ''))),
  );
  const notes = await page.$$eval('.hint', (ps) => ps.map((p) => p.textContent?.trim() ?? ''));
  console.log('  veredito:', verdict);
  for (const [k, v] of Object.entries(rows)) console.log(`    ${k}: ${v}`);
  for (const n of notes) console.log('  nota:', n);
  // Depois do teste a sala some (sem transmissão sobrando).
  const asked = await page.evaluate(() => window.__gdm?.video?.frameRate ?? null);
  const leftover = await page.evaluate(() => [...document.querySelectorAll('video')].some((v) => v.srcObject?.getVideoTracks?.().some((t) => t.readyState === 'live')));
  check(errors.length === 0, `sem erro na página${errors.length ? ': ' + errors.join(' | ').slice(0, 300) : ''}`);
  await ctx.close();
  return { verdict, rows, notes, leftover, asked };
}

if (ONLY.includes('inteira')) {
  const r = await run('inteira', { fps: 60, width: 1920, height: 1080 });
  check(r.verdict === 'Tudo certo', `veredito "Tudo certo" (${r.verdict})`);
  check(/^1920x1080 a (5\d|6\d) fps$/.test(r.rows['quem assiste recebe'] ?? ''), `quem assiste recebe 1920x1080 a ~60 fps (${r.rows['quem assiste recebe']})`);
  check(/^1920x1080 a /.test(r.rows['seu PC manda'] ?? ''), `o PC manda no tamanho da captura (${r.rows['seu PC manda']})`);
  check(!r.leftover, 'a transmissão do teste termina com ele');
}

if (ONLY.includes('lenta')) {
  const r = await run('lenta', { fps: 20, width: 1920, height: 1080 });
  check(r.verdict === 'Algo segurou a qualidade', `veredito acusa (${r.verdict})`);
  check(/^1920x1080 /.test(r.rows['quem assiste recebe'] ?? ''), `o tamanho continua inteiro (${r.rows['quem assiste recebe']})`);
  check(r.notes.some((n) => /A captura entregou só (1\d|2\d) fps/.test(n)), 'a nota aponta a captura (não a rede)');
}

if (ONLY.includes('monitor144')) {
  const r = await run('monitor144', { fps: 60, width: 1920, height: 1080, fakeHz: 144 });
  check(r.asked === 72, `a captura é pedida a 72 fps num monitor de 144 Hz (${r.asked})`);
  check(r.rows['monitor'] === '144 Hz', `o monitor é medido (${r.rows['monitor']})`);
  check(r.rows['captura pedida'] === '72 fps', `a página mostra a captura pedida (${r.rows['captura pedida']})`);
  check(['captura pedindo 60', 'captura pedindo 72', 'captura pedindo 144'].every((k) => k in r.rows), 'a varredura mede 60, 72 e 144');
  check(/ a (5\d|6\d) fps$/.test(r.rows['quem assiste recebe'] ?? ''), `quem assiste recebe ~60 fps (o codificador corta o excesso) (${r.rows['quem assiste recebe']})`);
}

await browser.close();
console.log(failures === 0 ? '\ntudo certo' : `\n${failures} conferência(s) falharam`);
process.exit(failures === 0 ? 0 : 1);
