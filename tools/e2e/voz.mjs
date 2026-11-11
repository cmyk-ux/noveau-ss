// Gera um "microfone falso" que fala e para: 1,7 s de som e 1,3 s de silêncio, em repetição.
// O Chromium toca esse arquivo no lugar do microfone (--use-file-for-fake-audio-capture), e o
// "falando" de cada pessoa liga e desliga como numa conversa de verdade.
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function fakeVoice() {
  const file = join(tmpdir(), 'noveau-voz-falsa.wav');
  if (existsSync(file)) return file;
  const rate = 48000;
  const n = rate * 20;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let x = 0.001 * (Math.random() - 0.5);
    if (t % 3 < 1.7) {
      x = 0.35 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 660 * t) + 0.05 * (Math.random() - 0.5);
      x *= 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t);
    }
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x)) * 32767), 44 + i * 2);
  }
  writeFileSync(file, buf);
  return file;
}

/** Chromium com câmera, microfone e tela falsos, sem perguntar nada. */
export function browserArgs() {
  return [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--auto-accept-this-tab-capture',
    '--autoplay-policy=no-user-gesture-required',
    '--auto-select-desktop-capture-source=Entire screen',
    `--use-file-for-fake-audio-capture=${fakeVoice()}`,
  ];
}
