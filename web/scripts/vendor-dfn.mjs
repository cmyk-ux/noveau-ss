// Baixa o DeepFilterNet 3 (a redução de ruído "IA forte") para web/vendor/dfn/, de onde o build
// copia para /voz/dfn/ no site. Os arquivos (14 MB de wasm + 8 MB do modelo) não vão para o git.
//
// Vêm do pacote @workadventure/noise-suppression 0.2.0 (MIT), que compila o libDF do DeepFilterNet
// (MIT/Apache-2.0, github.com/Rikorose/DeepFilterNet) para wasm. Só os dois arquivos são usados: a
// ponte JS foi reescrita em src/app/core/voice.worker.ts. O pacote inteiro tem dependências pesadas
// (onnxruntime), por isso é baixado com `npm pack` (só o .tgz, sem dependências) e conferido pelo
// hash publicado no registro do npm.
//
// Sem internet o build segue: a opção "IA forte" avisa que não carregou e volta para a leve.
//
// Uso: node scripts/vendor-dfn.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gunzipSync, gzipSync } from 'node:zlib';

const PKG = '@workadventure/noise-suppression@0.2.0';
const INTEGRITY = 'sha512-lNHmmOiMnWaLWK6hKBsYi/dC/L7lFspYMitWAhk2SXS7QFgHtizeT+4hTDvFDd3MHW+cvSb+Y4nhtQs7xQ5hrw==';
const FILES = {
  'package/dist/assets/deepfilternet/df_bg.wasm': {
    name: 'df_bg.wasm',
    sha256: '8ebf2b217b80fc128505b993c8d7d7d892df5a845ab7a2516fed74b76e7fe708',
    // O wasm comprime bem (14 MB -> ~2.7 MB): a versão pronta vai junto e o precompress não refaz.
    compress: true,
  },
  'package/dist/assets/deepfilternet/DeepFilterNet3_onnx.tar.gz': {
    name: 'DeepFilterNet3_onnx.tar.gz',
    sha256: 'c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616',
    compress: false,
  },
  'package/LICENSE': { name: 'LICENSE-noise-suppression.txt', sha256: null, compress: false },
};

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'vendor', 'dfn');
mkdirSync(out, { recursive: true });

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const ready = Object.values(FILES).every((f) => {
  const p = join(out, f.name);
  return existsSync(p) && (f.sha256 === null || sha256(readFileSync(p)) === f.sha256) && (!f.compress || existsSync(p + '.br'));
});
if (ready) {
  console.log('vendor-dfn: DeepFilterNet já está em vendor/dfn');
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'noveau-dfn-'));
try {
  console.log(`vendor-dfn: baixando ${PKG} (~53 MB, só desta vez)…`);
  // No Windows o npm é um .cmd, que o Node só roda pelo shell (e aí o caminho vai entre aspas).
  const win = process.platform === 'win32';
  execFileSync(win ? 'npm.cmd' : 'npm', ['pack', PKG, '--pack-destination', win ? `"${tmp}"` : tmp, '--silent'], { stdio: ['ignore', 'ignore', 'inherit'], shell: win });
  const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (tgz === undefined) throw new Error('o npm pack não gerou o .tgz');
  const raw = readFileSync(join(tmp, tgz));
  const got = 'sha512-' + createHash('sha512').update(raw).digest('base64');
  if (got !== INTEGRITY) throw new Error(`hash diferente do publicado no npm (${got})`);

  for (const [path, data] of untar(gunzipSync(raw))) {
    const f = FILES[path];
    if (f === undefined) continue;
    if (f.sha256 !== null && sha256(data) !== f.sha256) throw new Error(`${f.name} com hash diferente`);
    const dest = join(out, f.name);
    writeFileSync(dest, data);
    if (f.compress) {
      writeFileSync(dest + '.br', brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }));
      writeFileSync(dest + '.gz', gzipSync(data, { level: 9 }));
    }
  }
  for (const f of Object.values(FILES)) if (!existsSync(join(out, f.name))) throw new Error(`${f.name} não está no pacote`);
  console.log('vendor-dfn: pronto em vendor/dfn');
} catch (e) {
  console.warn(`vendor-dfn: não foi possível baixar o DeepFilterNet (${e instanceof Error ? e.message : e}). O site funciona; a "IA forte" fica indisponível.`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/** Lê um .tar (ustar) sem dependências: devolve [caminho, conteúdo] de cada arquivo. */
function* untar(buf) {
  let at = 0;
  while (at + 512 <= buf.length) {
    const head = buf.subarray(at, at + 512);
    if (head.every((b) => b === 0)) break;
    const str = (from, len) => head.subarray(from, from + len).toString('utf8').replace(/\0.*$/s, '');
    const prefix = str(345, 155);
    const name = (prefix === '' ? '' : prefix + '/') + str(0, 100);
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(head[156] || 48);
    at += 512;
    if (type === '0') yield [name, buf.subarray(at, at + size)];
    at += Math.ceil(size / 512) * 512;
  }
}
