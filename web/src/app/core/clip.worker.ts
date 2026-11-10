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
/** A placa de vídeo falhou: daqui em diante codifica no processador (até a próxima fonte). */
let softwareOnly = false;
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
  let config: VideoEncoderConfig = { ...base, hardwareAcceleration: softwareOnly ? 'prefer-software' : 'prefer-hardware' };
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
    // A placa de vídeo pode recusar no meio (ex.: limite de sessões de codificação, que a própria
    // transmissão também usa). O codificador fecha e nunca mais aceita quadros: sem isto, a
    // gravação parava até recarregar a página. Reabre no processador no próximo quadro.
    error: (e) => {
      if (gen !== generation || video !== enc) return;
      video = null;
      if (config.hardwareAcceleration === 'prefer-hardware') softwareOnly = true;
      post({ type: 'error', message: `Codificador de vídeo reiniciado: ${e.message}` });
    },
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
    // Falhou: tenta abrir de novo no próximo bloco de som.
    error: () => {
      if (gen !== generation) return;
      audio = null;
      audioFormat = null;
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
      // Descarta os quadros que ainda estavam na fila (senão o navegador reclama e pode travar a captura).
      void reader.cancel().catch(() => undefined);
      return;
    }
    offset ??= performance.now() * 1000 - frame.timestamp;
    const at = frame.timestamp + offset;
    if (at - lastFrame < minGap || (video !== null && video.encodeQueueSize > 3)) {
      frame.close();
      continue;
    }
    lastFrame = at;
    let want = fit(frame.displayWidth, frame.displayHeight, opts!.maxWidth, opts!.maxHeight);
    let input: VideoFrame | null = null;
    try {
      if (video !== null && video.state === 'closed') video = null;
      // A tela de outra pessoa muda de resolução o tempo todo (a rede sobe e desce a qualidade).
      // Reabrir o codificador apagava o que já estava guardado; agora só reabre se o formato da
      // imagem mudou, ou se melhorou logo no começo. Senão, redimensiona para o tamanho atual.
      if (video !== null && (want.width !== size.width || want.height !== size.height)) {
        const sameShape = Math.abs(want.width / want.height - size.width / size.height) < 0.02;
        const better = want.width * want.height > size.width * size.height;
        if (sameShape && !(better && buffered() < 15)) want = size;
      }
      if (video === null || want.width !== size.width || want.height !== size.height) await openVideo(want.width, want.height);
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
    } catch (e) {
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      // Quadro não fechado trava a captura do navegador (o estoque de quadros é pequeno).
      input?.close();
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
      void reader.cancel().catch(() => undefined);
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
  try {
    if (video === null || videoConfig === null || frames.length === 0) {
      post({ type: 'clip-error', message: 'Ainda não tem nada gravado. Espere alguns segundos.' });
      return;
    }
    // Sem flush(): no Windows, o codificador H.264 da placa de vídeo pode demorar (ou nunca
    // responder) para esvaziar enquanto continua recebendo quadros. Usa o que já saiu dele,
    // o que só deixa de fora os últimos milissegundos.
    const vids = frames.slice();
    const start = vids[0].at;
    const end = vids.at(-1)!.at;
    const snd = audioConfig !== null && audioFormat !== null ? monotonic(sounds.filter((s) => s.at >= start && s.at <= end)) : [];
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: size.width, height: size.height, frameRate: opts!.fps },
      audio: snd.length > 0 ? { codec: audioCodec, numberOfChannels: audioFormat!.channels, sampleRate: audioFormat!.sampleRate } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'cross-track-offset',
    });
    // O codificador da placa de vídeo no Windows entrega pedaços sem duração (null), e o MP4
    // exige uma: usa a distância até o próximo pedaço (o último fica com a do quadro/bloco).
    const add = <C extends EncodedVideoChunk | EncodedAudioChunk>(
      list: Stored<C>[],
      fallback: number,
      put: (data: Uint8Array, c: C, at: number, dur: number, i: number) => void,
    ) =>
      list.forEach((s, i) => {
        const data = new Uint8Array(s.chunk.byteLength);
        s.chunk.copyTo(data);
        const next = list[i + 1]?.at;
        const own = s.chunk.duration;
        const dur = next !== undefined ? next - s.at : own !== null && own > 0 ? own : fallback;
        put(data, s.chunk, s.at - start, Math.max(0, dur), i);
      });
    add(vids, 1e6 / opts!.fps, (data, c, at, dur, i) =>
      muxer.addVideoChunkRaw(data, c.type, at, dur, i === 0 ? { decoderConfig: videoConfig! } : undefined),
    );
    add(snd, (1e6 * 1024) / (audioFormat?.sampleRate ?? 48000), (data, c, at, dur, i) =>
      muxer.addAudioChunkRaw(data, c.type, at, dur, i === 0 ? { decoderConfig: audioConfig! } : undefined),
    );
    muxer.finalize();
    const buffer = muxer.target.buffer;
    post({ type: 'clip', buffer, seconds: (end - start) / 1e6, width: size.width, height: size.height }, [buffer]);
  } catch (e) {
    // Nunca deixa o clipe preso em "montando": devolve o motivo para aparecer no cartão.
    post({ type: 'clip-error', message: `Não consegui montar o vídeo: ${e instanceof Error ? e.message : String(e)}` });
  }
}

/** O MP4 exige tempos sempre crescentes; descarta pedaços de som fora de ordem. */
function monotonic<T extends { at: number }>(list: T[]): T[] {
  const out: T[] = [];
  for (const s of list) if (out.length === 0 || s.at > out.at(-1)!.at) out.push(s);
  return out;
}

function stop() {
  generation++;
  softwareOnly = false;
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
