// Gravador de clipes, numa thread separada para continuar gravando com a aba em segundo plano
// (quem transmite está no jogo, com o site escondido).
//
// Um worker por tela. Recebe os quadros crus (MediaStreamTrackProcessor), codifica em H.264 na
// placa de vídeo e guarda só os últimos N segundos, começando sempre num quadro-chave. Ao clipar,
// monta um MP4.
//
// O tamanho do vídeo é fixo desde o começo (a resolução de quem transmite, até 1080p): a imagem
// que chega menor (rede ruim, tela fora de foco na grade) é ampliada, e a de outro formato ganha
// faixas pretas. Assim nada obriga a reabrir o codificador e apagar o que já estava guardado.

import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

interface Start {
  type: 'start';
  /** Mesma tela, trilha nova: troca a entrada e mantém o que já foi guardado. */
  keep: boolean;
  target: { width: number; height: number } | null;
  video: ReadableStream<VideoFrame>;
  audio: ReadableStream<AudioData> | null;
  seconds: number;
  maxWidth: number;
  maxHeight: number;
  fps: number;
  bitrate: number;
}
type Incoming = Start | { type: 'clip'; id: string } | { type: 'stop' } | { type: 'pause'; on: boolean };

interface Stored<C> {
  chunk: C;
  /** Microssegundos no relógio do worker (performance.now). */
  at: number;
}

const KEY_EVERY_US = 2_000_000;
const HARDWARE_RETRY_US = 30_000_000;
/** Sem quadro novo por tanto tempo (tela fora de foco, janela escondida): fecha o codificador. */
const IDLE_US = 10_000_000;
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
/** Formato do som que está guardado (fica mesmo com o codificador fechado). */
let soundFormat: { channels: number; sampleRate: number } | null = null;
let lastReady = false;
let size = { width: 0, height: 0 };
let frames: Stored<EncodedVideoChunk>[] = [];
let sounds: Stored<EncodedAudioChunk>[] = [];
let lastKey = -Infinity;
let lastFrame = -Infinity;
let canvas: OffscreenCanvas | null = null;
/**
 * Só grava na placa de vídeo. Codificar 1080p60 no processador custava cerca de um núcleo inteiro
 * por tela e travava o jogo de quem transmite; sem placa (ou com ela recusando), o vídeo do clipe
 * espera em vez de cair para o processador.
 */
let hardwareBackAt = 0;
/** O PC está apertado (aviso do navegador): não grava vídeo até aliviar. */
let paused = false;
let draw: OffscreenCanvasRenderingContext2D | null = null;

function post(msg: unknown, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

function fit(w: number, h: number, maxW: number, maxH: number) {
  const k = Math.min(1, maxW / w, maxH / h);
  const even = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { width: even(w), height: even(h) };
}

function nowUs() {
  return performance.now() * 1000;
}

/** Joga fora o que passou da janela. Pelo relógio, não pelo último quadro: sem vídeo chegando, o antigo também vence. */
function trim() {
  if (opts === null) return;
  const oldest = nowUs() - opts.seconds * 1e6;
  if (frames.length === 0 || frames.at(-1)!.at < oldest) {
    frames = [];
    sounds = [];
    return;
  }
  // Corta do começo até o próximo quadro-chave que ainda esteja dentro da janela.
  for (;;) {
    const next = frames.findIndex((f, i) => i > 0 && f.chunk.type === 'key');
    if (next <= 0 || frames[next].at > oldest) break;
    frames = frames.slice(next);
  }
  const start = frames[0].at;
  while (sounds.length > 0 && sounds[0].at < start) sounds.shift();
}

function buffered() {
  return frames.length < 2 ? 0 : (frames.at(-1)!.at - frames[0].at) / 1e6;
}

/** Mesmos parâmetros (SPS/PPS): os pedaços do codificador anterior continuam valendo no mesmo MP4. */
function sameConfig(a: VideoDecoderConfig | AudioDecoderConfig, b: VideoDecoderConfig | AudioDecoderConfig) {
  if (a.codec !== b.codec) return false;
  const num = (c: object, k: string) => (c as Record<string, unknown>)[k];
  for (const k of ['codedWidth', 'codedHeight', 'sampleRate', 'numberOfChannels']) if (num(a, k) !== num(b, k)) return false;
  const bytes = (d: AllowSharedBufferSource | undefined) =>
    d === undefined ? new Uint8Array(0) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
  const x = bytes(a.description);
  const y = bytes(b.description);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Taxa proporcional ao tamanho: 10 Mbps em 1080p, menos em telas menores (e menos memória). */
function bitrateFor(width: number, height: number) {
  return Math.round(Math.min(opts!.bitrate, Math.max(3_000_000, (opts!.bitrate * width * height) / (1920 * 1080))));
}

/** Abre o codificador. O que já está guardado fica, se o novo sair com os mesmos parâmetros. */
async function openVideo(width: number, height: number) {
  if (video !== null && video.state !== 'closed') video.close();
  video = null;
  // O primeiro quadro do codificador novo tem de ser chave.
  lastKey = -Infinity;
  size = { width, height };
  const base: VideoEncoderConfig = {
    // High 5.2: cobre 1080p a 60fps com folga.
    codec: 'avc1.640034',
    width,
    height,
    bitrate: bitrateFor(width, height),
    framerate: opts!.fps,
    bitrateMode: 'variable',
    latencyMode: 'realtime',
    avc: { format: 'avc' },
  };
  const config: VideoEncoderConfig = { ...base, hardwareAcceleration: 'prefer-hardware' };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) {
    // Sem codificador na placa de vídeo: tenta de novo daqui a um tempo (driver, sessões ocupadas).
    hardwareBackAt = nowUs() + HARDWARE_RETRY_US;
    post({ type: 'no-hardware' });
    return;
  }
  const gen = generation;
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      if (gen !== generation) return;
      if (meta?.decoderConfig !== undefined) {
        // Parâmetros diferentes não cabem no mesmo MP4: aí sim recomeça do zero.
        if (videoConfig !== null && !sameConfig(videoConfig, meta.decoderConfig)) {
          frames = [];
          sounds = [];
        }
        videoConfig = meta.decoderConfig;
      }
      frames.push({ chunk, at: chunk.timestamp });
      trim();
    },
    // A placa de vídeo pode recusar no meio (ex.: limite de sessões de codificação, que a própria
    // transmissão também usa). O codificador fecha e nunca mais aceita quadros: sem isto, a
    // gravação parava até recarregar a página. Reabre no processador no próximo quadro.
    error: (e) => {
      if (gen !== generation || video !== enc) return;
      video = null;
      hardwareBackAt = nowUs() + HARDWARE_RETRY_US;
      post({ type: 'error', message: `Codificador de vídeo reiniciado: ${e.message}` });
    },
  });
  enc.configure(config);
  video = enc;
  post({ type: 'size', width, height, hardware: config.hardwareAcceleration === 'prefer-hardware' });
}

async function openAudio(first: AudioData) {
  audioFormat = { channels: Math.min(2, first.numberOfChannels), sampleRate: first.sampleRate };
  const format = audioFormat;
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
      if (meta?.decoderConfig !== undefined) {
        if (audioConfig !== null && !sameConfig(audioConfig, meta.decoderConfig)) sounds = [];
        audioConfig = meta.decoderConfig;
        soundFormat = format;
      }
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
    offset ??= nowUs() - frame.timestamp;
    let at = frame.timestamp + offset;
    // Depois de um tempo sem vídeo (fora de foco), o relógio do quadro pode ter se afastado: reacerta.
    if (Math.abs(at - nowUs()) > 1e6) {
      offset = nowUs() - frame.timestamp;
      at = Math.max(nowUs(), lastFrame + minGap + 1);
    }
    if (paused || nowUs() < hardwareBackAt || at - lastFrame < minGap || (video !== null && video.encodeQueueSize > 3)) {
      frame.close();
      continue;
    }
    lastFrame = at;
    let input: VideoFrame | null = null;
    try {
      // O tamanho fica fixo: a resolução de quem transmite (até 1080p) ou, sem ela, a do primeiro quadro.
      if (size.width === 0) {
        const t = opts!.target ?? { width: frame.displayWidth, height: frame.displayHeight };
        size = fit(t.width, t.height, opts!.maxWidth, opts!.maxHeight);
      }
      if (video !== null && video.state === 'closed') video = null;
      if (video === null) await openVideo(size.width, size.height);
      if (video === null) continue;
      // Mesmo formato (só o tamanho muda: 1440p para 1080p, cópia menor da rede): o próprio
      // codificador reduz ou amplia, na placa de vídeo. Passar por um canvas aqui custava quase um
      // núcleo a mais a 60 fps (copia o quadro inteiro para a memória e de volta).
      const sameShape = Math.abs(frame.displayWidth * size.height - frame.displayHeight * size.width) <= size.width * size.height * 0.01;
      if (!sameShape) {
        if (canvas === null || canvas.width !== size.width || canvas.height !== size.height) {
          canvas = new OffscreenCanvas(size.width, size.height);
          draw = canvas.getContext('2d', { alpha: false, desynchronized: true });
          draw!.imageSmoothingQuality = 'high';
        }
        // Amplia ou reduz mantendo o formato; sobra vira faixa preta.
        const k = Math.min(size.width / frame.displayWidth, size.height / frame.displayHeight);
        const w = Math.round(frame.displayWidth * k);
        const h = Math.round(frame.displayHeight * k);
        if (w !== size.width || h !== size.height) {
          draw!.fillStyle = '#000';
          draw!.fillRect(0, 0, size.width, size.height);
        }
        draw!.drawImage(frame, (size.width - w) / 2, (size.height - h) / 2, w, h);
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

async function clip(id: string) {
  try {
    trim();
    if (videoConfig === null || frames.length === 0) {
      post({ type: 'clip-error', id, message: 'Ainda não tem nada gravado. Espere alguns segundos.' });
      return;
    }
    // Sem flush(): no Windows, o codificador H.264 da placa de vídeo pode demorar (ou nunca
    // responder) para esvaziar enquanto continua recebendo quadros. Usa o que já saiu dele,
    // o que só deixa de fora os últimos milissegundos.
    const vids = frames.slice();
    const start = vids[0].at;
    const end = vids.at(-1)!.at;
    const snd = audioConfig !== null && soundFormat !== null ? monotonic(sounds.filter((s) => s.at >= start && s.at <= end)) : [];
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: size.width, height: size.height, frameRate: opts!.fps },
      audio: snd.length > 0 ? { codec: audioCodec, numberOfChannels: soundFormat!.channels, sampleRate: soundFormat!.sampleRate } : undefined,
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
    add(snd, (1e6 * 1024) / (soundFormat?.sampleRate ?? 48000), (data, c, at, dur, i) =>
      muxer.addAudioChunkRaw(data, c.type, at, dur, i === 0 ? { decoderConfig: audioConfig! } : undefined),
    );
    muxer.finalize();
    const buffer = muxer.target.buffer;
    post({ type: 'clip', id, buffer, seconds: (end - start) / 1e6, width: size.width, height: size.height }, [buffer]);
  } catch (e) {
    // Nunca deixa o clipe preso em "montando": devolve o motivo para aparecer no cartão.
    post({ type: 'clip-error', id, message: `Não consegui montar o vídeo: ${e instanceof Error ? e.message : String(e)}` });
  }
}

/** O MP4 exige tempos sempre crescentes; descarta pedaços de som fora de ordem. */
function monotonic<T extends { at: number }>(list: T[]): T[] {
  const out: T[] = [];
  for (const s of list) if (out.length === 0 || s.at > out.at(-1)!.at) out.push(s);
  return out;
}

/** Fecha os codificadores e as entradas atuais, sem apagar o que está guardado. */
function detach() {
  generation++;
  if (video !== null && video.state !== 'closed') video.close();
  if (audio !== null && audio.state !== 'closed') audio.close();
  video = null;
  audio = null;
  audioFormat = null;
}

function stop() {
  detach();
  hardwareBackAt = 0;
  audioConfig = null;
  videoConfig = null;
  soundFormat = null;
  frames = [];
  sounds = [];
  audioShift = 0;
  lastFrame = -Infinity;
  size = { width: 0, height: 0 };
}

ctx.onmessage = (e: MessageEvent<Incoming>) => {
  const msg = e.data;
  if (msg.type === 'start') {
    // Mesma tela com trilha nova (reconexão, parou e voltou a compartilhar): guarda o que já tem.
    if (msg.keep && opts !== null) detach();
    else stop();
    opts = msg;
    const gen = generation;
    void pumpVideo(msg.video.getReader(), gen);
    if (msg.audio !== null) void pumpAudio(msg.audio.getReader(), gen);
  } else if (msg.type === 'pause') {
    paused = msg.on;
    // Solta o codificador na hora: libera a placa de vídeo para o jogo e para a transmissão.
    if (paused && video !== null && video.state !== 'closed') video.close();
    if (paused) video = null;
  } else if (msg.type === 'clip') {
    void clip(msg.id);
  } else {
    stop();
  }
};

setInterval(() => {
  trim();
  // Tela parada de chegar (fora de foco, janela escondida): solta o codificador, que na placa de
  // vídeo é limitado (a transmissão também usa). Reabre no próximo quadro, sem perder o guardado.
  if (video !== null && nowUs() - lastFrame > IDLE_US) {
    if (video.state !== 'closed') video.close();
    video = null;
  }
  // Só avisa quando muda (tem ou não o que clipar), para não acordar a página à toa.
  const ready = buffered() >= 1;
  if (ready !== lastReady) {
    lastReady = ready;
    post({ type: 'ready', ready });
  }
}, 1000);
