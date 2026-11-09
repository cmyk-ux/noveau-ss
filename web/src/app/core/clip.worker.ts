// Gravador de clipes, numa thread separada para continuar gravando com a aba em segundo plano
// (quem transmite está no jogo, com o site escondido).
//
// Recebe os quadros crus (MediaStreamTrackProcessor), codifica em H.264 na placa de vídeo e
// guarda só os últimos N segundos, começando sempre num quadro-chave. Ao clipar, monta um MP4.

import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

interface Start {
  type: 'start';
  video: ReadableStream<VideoFrame>;
  audio: ReadableStream<AudioData> | null;
  seconds: number;
  maxWidth: number;
  maxHeight: number;
  fps: number;
  bitrate: number;
}
type Incoming = Start | { type: 'clip' } | { type: 'stop' };

interface Stored<C> {
  chunk: C;
  /** Microssegundos no relógio do worker (performance.now). */
  at: number;
}

const KEY_EVERY_US = 2_000_000;
const ctx = self as unknown as {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<Incoming>) => void) | null;
};

let generation = 0;
let opts: Start | null = null;
let video: VideoEncoder | null = null;
let audio: AudioEncoder | null = null;
let videoConfig: VideoDecoderConfig | null = null;
let audioConfig: AudioDecoderConfig | null = null;
let audioCodec: 'aac' | 'opus' = 'aac';
let audioFormat: { channels: number; sampleRate: number } | null = null;
let size = { width: 0, height: 0 };
let frames: Stored<EncodedVideoChunk>[] = [];
let sounds: Stored<EncodedAudioChunk>[] = [];
let lastKey = -Infinity;
let lastFrame = -Infinity;
let canvas: OffscreenCanvas | null = null;
let draw: OffscreenCanvasRenderingContext2D | null = null;

function post(msg: unknown, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

function fit(w: number, h: number, maxW: number, maxH: number) {
  const k = Math.min(1, maxW / w, maxH / h);
  const even = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { width: even(w), height: even(h) };
}

function trim() {
  const newest = frames.at(-1)?.at;
  if (newest === undefined || opts === null) return;
  const span = opts.seconds * 1e6;
  // Corta do começo até o próximo quadro-chave, enquanto ainda sobrar a janela inteira depois dele.
  for (;;) {
    const next = frames.findIndex((f, i) => i > 0 && f.chunk.type === 'key');
    if (next <= 0 || newest - frames[next].at < span) break;
    frames = frames.slice(next);
  }
  const start = frames[0]?.at ?? newest;
  while (sounds.length > 0 && sounds[0].at < start) sounds.shift();
}

function buffered() {
  return frames.length < 2 ? 0 : (frames.at(-1)!.at - frames[0].at) / 1e6;
}

async function openVideo(width: number, height: number) {
  video?.close();
  frames = [];
  sounds = [];
  lastKey = -Infinity;
  videoConfig = null;
  size = { width, height };
  const base: VideoEncoderConfig = {
    // High 5.2: cobre 1080p a 60fps com folga.
    codec: 'avc1.640034',
    width,
    height,
    bitrate: opts!.bitrate,
    framerate: opts!.fps,
    bitrateMode: 'variable',
    latencyMode: 'realtime',
    avc: { format: 'avc' },
  };
  let config: VideoEncoderConfig = { ...base, hardwareAcceleration: 'prefer-hardware' };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) config = { ...base, hardwareAcceleration: 'no-preference' };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) throw new Error('Este navegador não codifica H.264.');
  const gen = generation;
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      if (gen !== generation) return;
      if (meta?.decoderConfig !== undefined) videoConfig = meta.decoderConfig;
      frames.push({ chunk, at: chunk.timestamp });
      trim();
    },
    error: (e) => post({ type: 'error', message: `Codificador de vídeo: ${e.message}` }),
  });
  enc.configure(config);
  video = enc;
  post({ type: 'size', width, height, hardware: config.hardwareAcceleration === 'prefer-hardware' });
}

async function openAudio(first: AudioData) {
  audioFormat = { channels: Math.min(2, first.numberOfChannels), sampleRate: first.sampleRate };
  const base = { numberOfChannels: audioFormat.channels, sampleRate: audioFormat.sampleRate, bitrate: 192_000 };
  // AAC toca em qualquer lugar (Windows, celular, Discord); Opus fica de reserva.
  let config: AudioEncoderConfig = { ...base, codec: 'mp4a.40.2' };
  audioCodec = 'aac';
  if (!(await AudioEncoder.isConfigSupported(config)).supported) {
    config = { ...base, codec: 'opus' };
    audioCodec = 'opus';
  }
  if (!(await AudioEncoder.isConfigSupported(config)).supported) return null;
  const gen = generation;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      if (gen !== generation) return;
      if (meta?.decoderConfig !== undefined) audioConfig = meta.decoderConfig;
      sounds.push({ chunk, at: chunk.timestamp + audioShift });
    },
    error: () => {
      audio = null;
    },
  });
  enc.configure(config);
  return enc;
}

async function pumpVideo(reader: ReadableStreamDefaultReader<VideoFrame>, gen: number) {
  const minGap = 1e6 / opts!.fps - 2000;
  // Leva o relógio do quadro para o relógio do worker, o mesmo do áudio.
  let offset: number | null = null;
  for (;;) {
    const { value: frame, done } = await reader.read();
    if (done || gen !== generation) {
      frame?.close();
      return;
    }
    offset ??= performance.now() * 1000 - frame.timestamp;
    const at = frame.timestamp + offset;
    if (at - lastFrame < minGap || (video !== null && video.encodeQueueSize > 3)) {
      frame.close();
      continue;
    }
    lastFrame = at;
    const want = fit(frame.displayWidth, frame.displayHeight, opts!.maxWidth, opts!.maxHeight);
    try {
      if (video === null || want.width !== size.width || want.height !== size.height) await openVideo(want.width, want.height);
      let input = frame;
      if (frame.displayWidth !== want.width || frame.displayHeight !== want.height) {
        if (canvas === null || canvas.width !== want.width || canvas.height !== want.height) {
          canvas = new OffscreenCanvas(want.width, want.height);
          draw = canvas.getContext('2d', { alpha: false, desynchronized: true });
        }
        draw!.drawImage(frame, 0, 0, want.width, want.height);
        input = new VideoFrame(canvas, { timestamp: at });
      } else {
        input = new VideoFrame(frame, { timestamp: at });
      }
      const key = at - lastKey >= KEY_EVERY_US;
      if (key) lastKey = at;
      video!.encode(input, { keyFrame: key });
      input.close();
    } catch (e) {
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      frame.close();
    }
  }
}

async function pumpAudio(reader: ReadableStreamDefaultReader<AudioData>, gen: number) {
  let offset: number | null = null;
  for (;;) {
    const { value: data, done } = await reader.read();
    if (done || gen !== generation) {
      data?.close();
      return;
    }
    try {
      if (audio === null && audioFormat === null) audio = await openAudio(data);
      if (audio !== null && data.numberOfChannels <= 2) {
        if (offset === null) {
          offset = performance.now() * 1000 - data.timestamp;
          // O codificador mantém o tempo do próprio dado; o deslocamento leva para o relógio do vídeo.
          audioShift = offset;
        }
        audio.encode(data);
      }
    } catch {
      /* som é opcional */
    } finally {
      data.close();
    }
  }
}
let audioShift = 0;

async function clip() {
  if (video === null || videoConfig === null || frames.length === 0) {
    post({ type: 'clip-error', message: 'Ainda não tem nada gravado. Espere alguns segundos.' });
    return;
  }
  await video.flush().catch(() => undefined);
  await audio?.flush().catch(() => undefined);
  const vids = frames.slice();
  const start = vids[0].at;
  const snd = audioConfig !== null && audioFormat !== null ? sounds.filter((s) => s.at >= start) : [];
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: size.width, height: size.height, frameRate: opts!.fps },
    audio: snd.length > 0 ? { codec: audioCodec, numberOfChannels: audioFormat!.channels, sampleRate: audioFormat!.sampleRate } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'cross-track-offset',
  });
  vids.forEach((f, i) => muxer.addVideoChunk(f.chunk, i === 0 ? { decoderConfig: videoConfig! } : undefined, f.at - start));
  snd.forEach((s, i) => muxer.addAudioChunk(s.chunk, i === 0 ? { decoderConfig: audioConfig! } : undefined, s.at - start));
  muxer.finalize();
  const buffer = muxer.target.buffer;
  post({ type: 'clip', buffer, seconds: (vids.at(-1)!.at - start) / 1e6, width: size.width, height: size.height }, [buffer]);
}

function stop() {
  generation++;
  video?.close();
  audio?.close();
  video = null;
  audio = null;
  audioFormat = null;
  audioConfig = null;
  videoConfig = null;
  frames = [];
  sounds = [];
  audioShift = 0;
  lastFrame = -Infinity;
  size = { width: 0, height: 0 };
}

ctx.onmessage = (e: MessageEvent<Incoming>) => {
  const msg = e.data;
  if (msg.type === 'start') {
    stop();
    opts = msg;
    const gen = generation;
    void pumpVideo(msg.video.getReader(), gen);
    if (msg.audio !== null) void pumpAudio(msg.audio.getReader(), gen);
  } else if (msg.type === 'clip') {
    void clip();
  } else {
    stop();
  }
};

// Avisa quanto já tem guardado, para o botão mostrar.
setInterval(() => post({ type: 'buffered', seconds: buffered() }), 1000);
