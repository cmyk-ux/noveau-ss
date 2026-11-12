// Depois do build: grava ao lado de cada arquivo de texto do site uma versão .br (Brotli) e uma .gz.
// O servidor manda a versão pronta para quem aceita (veja serveStatic em server/server.mjs), e o
// Caddy não precisa comprimir nada no processador da VPS a cada visita. O Brotli no máximo (11)
// comprime ~15-20% melhor que o gzip, mas é lento: por isso é feito aqui, uma vez, e não por pedido.
//
// Uso: node scripts/precompress.mjs dist/noveau-ss/browser
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = process.argv[2] ?? 'dist/noveau-ss/browser';
// woff2, png e afins já vêm comprimidos: não ganham nada.
const TEXT = new Set(['.js', '.css', '.html', '.svg', '.wasm', '.json', '.webmanifest', '.ico', '.txt', '.woff']);
const MIN_BYTES = 1024;

let files = 0;
let before = 0;
let after = 0;
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }
    if (!TEXT.has(extname(entry.name)) || statSync(file).size < MIN_BYTES) continue;
    // Já veio comprimido (o DeepFilterNet, feito uma vez no scripts/vendor-dfn.mjs).
    if (existsSync(file + '.br')) continue;
    const raw = readFileSync(file);
    const br = brotliCompressSync(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    });
    const gz = gzipSync(raw, { level: 9 });
    // Só vale a pena se ficar bem menor (senão o servidor manda o original).
    if (br.length < raw.length * 0.9) writeFileSync(file + '.br', br);
    if (gz.length < raw.length * 0.9) writeFileSync(file + '.gz', gz);
    files++;
    before += raw.length;
    after += Math.min(br.length, raw.length);
  }
}
walk(root);
console.log(`precompress: ${files} arquivos, ${(before / 1024).toFixed(0)} kB -> ${(after / 1024).toFixed(0)} kB (brotli)`);
