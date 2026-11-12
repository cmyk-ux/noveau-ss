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

/**
 * Monitor falso de tamanho comum (ex.: 1920x1080) para a captura de tela.
 *
 * O dispositivo falso do Chromium (--use-fake-device-for-media-stream) só entrega alguns tamanhos
 * fixos e, quando o pedido não traz um tamanho "ideal", cai no menor deles: 96x96. O app pede só um
 * teto (7680x4320) para receber o monitor no tamanho original, que é o que um Chrome de verdade faz;
 * no falso, a tela inteira virava um quadradinho de 96x96 (cursor, cliques e medidas perdiam o
 * sentido). Aqui o teste acrescenta o tamanho do "monitor" como ideal na captura e em cada
 * applyConstraints da faixa de tela (e das cópias dela), sem tirar os tetos que o app pediu.
 * Uso: ctx.addInitScript(fakeMonitor, { width: 1920, height: 1080 }).
 */
export function fakeMonitor({ width, height }) {
  const md = navigator.mediaDevices;
  if (!md || typeof md.getDisplayMedia !== 'function') return;
  const screens = new WeakSet();
  const sized = (v) => {
    const o = v && typeof v === 'object' ? v : {};
    const w = o.width && typeof o.width === 'object' ? o.width : {};
    const h = o.height && typeof o.height === 'object' ? o.height : {};
    return { ...o, width: { ...w, ideal: width }, height: { ...h, ideal: height } };
  };
  const capture = md.getDisplayMedia.bind(md);
  md.getDisplayMedia = async (c = {}) => {
    const s = await capture({ ...c, video: c.video === false ? false : sized(c.video) });
    for (const t of s.getVideoTracks()) screens.add(t);
    // A última captura, para o teste simular o "Parar de compartilhar" do navegador.
    window.__noveauDisplay = s;
    return s;
  };
  const T = MediaStreamTrack.prototype;
  const apply = T.applyConstraints;
  T.applyConstraints = function (c) {
    return apply.call(this, screens.has(this) ? sized(c) : c);
  };
  const clone = T.clone;
  T.clone = function () {
    const t = clone.call(this);
    if (screens.has(this)) screens.add(t);
    return t;
  };
}
