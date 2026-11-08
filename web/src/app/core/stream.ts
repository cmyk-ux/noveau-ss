// Presets de transmissão de tela: resolução, fps, codec e bitrate.
// Recuperado do bundle deployado (chunk-CzevgFlM.js).

export type Resolution = 'p720' | 'p1080' | 'p1440' | 'source';
export type StreamMode = 'gaming' | 'movie' | 'screenshare' | 'custom';
export type Codec = 'av1' | 'h265' | 'vp9' | 'h264' | 'vp8';
export type CodecChoice = Codec | 'auto';
export type Degradation = 'maintain-framerate' | 'maintain-resolution';

export interface StreamSettings {
  mode: StreamMode;
  resolution: Resolution;
  frameRate: number;
}

export interface StreamPlan {
  resolution: Resolution;
  frameRate: number;
  contentHint: 'motion' | 'detail';
  degradation: Degradation;
}

export interface Size {
  width: number;
  height: number;
}

export const LADDER: Record<string, { width: number; height: number; baseBitrate: number }> = {
  p240: { width: 426, height: 240, baseBitrate: 5e5 },
  p480: { width: 854, height: 480, baseBitrate: 2e6 },
  p720: { width: 1280, height: 720, baseBitrate: 6e6 },
  p1080: { width: 1920, height: 1080, baseBitrate: 14e6 },
  p1440: { width: 2560, height: 1440, baseBitrate: 24e6 },
  p2160: { width: 3840, height: 2160, baseBitrate: 5e7 },
  p4320: { width: 7680, height: 4320, baseBitrate: 1e8 },
};

const FPS_MULTIPLIERS = [
  { fps: 15, multiplier: 0.65 },
  { fps: 30, multiplier: 1 },
  { fps: 60, multiplier: 1.6 },
];

// Banda não é problema (cabo): o teto é alto e o WebRTC baixa sozinho se a rede não aguentar.
const MAX_BITRATE = 12e7;

function fpsMultiplier(fps: number): number {
  let best = FPS_MULTIPLIERS[0];
  for (const m of FPS_MULTIPLIERS) if (Math.abs(m.fps - fps) < Math.abs(best.fps - fps)) best = m;
  return best.multiplier;
}

export const RESOLUTIONS: { id: Resolution; label: string }[] = [
  { id: 'p720', label: '720p' },
  { id: 'p1080', label: '1080p' },
  { id: 'p1440', label: '1440p' },
  { id: 'source', label: 'Source' },
];

export const FRAME_RATES = [15, 30, 60];

export const MODES: { id: StreamMode; label: string; description: string }[] = [
  { id: 'gaming', label: 'Games', description: 'Tela original a 60fps; cede quando o PC aperta' },
  { id: 'movie', label: 'Film', description: 'Pixels first (1080p, 30fps)' },
  { id: 'screenshare', label: 'Code', description: 'Sharp text, never rescaled (Source, 15fps)' },
  { id: 'custom', label: 'Custom', description: 'Pick resolution and frame rate' },
];

export function planFor(s: StreamSettings): StreamPlan {
  if (s.mode === 'gaming')
    return { resolution: 'source', frameRate: 60, contentHint: 'motion', degradation: 'maintain-framerate' };
  if (s.mode === 'screenshare')
    return { resolution: 'source', frameRate: 15, contentHint: 'detail', degradation: 'maintain-resolution' };
  if (s.mode === 'movie')
    return { resolution: 'p1080', frameRate: 30, contentHint: 'motion', degradation: 'maintain-resolution' };
  const still = s.frameRate <= 15;
  return {
    resolution: s.resolution,
    frameRate: s.frameRate,
    contentHint: still ? 'detail' : 'motion',
    degradation: still || s.resolution === 'source' ? 'maintain-resolution' : 'maintain-framerate',
  };
}

export function screenSize(): Size {
  const dpr = window.devicePixelRatio || 1;
  const w = window.screen.width || window.innerWidth || 1920;
  const h = window.screen.height || window.innerHeight || 1080;
  return { width: Math.round(w * dpr), height: Math.round(h * dpr) };
}

function screenKnown(): boolean {
  return window.screen.width > 0 && window.screen.height > 0;
}

export function planSize(plan: { resolution: Resolution }): Size {
  if (plan.resolution === 'source') return screenSize();
  const r = LADDER[plan.resolution];
  return { width: r.width, height: r.height };
}

export function resolutionLabel(r: Resolution): string {
  if (r !== 'source') return `${LADDER[r].height}p`;
  if (!screenKnown()) return 'Source';
  const { width, height } = screenSize();
  return `Source (${width}x${height})`;
}

/** Codecs que o Chrome só oferece com encoder de hardware (não tem versão por software). */
const HARDWARE_ONLY = new Set<string>(['h265']);
export function hardwareOnly(codec: string): boolean {
  return HARDWARE_ONLY.has(codec);
}

const SVC_CODECS = new Set<string>(['av1', 'vp9']);
export function isSvc(codec: string): boolean {
  return SVC_CODECS.has(codec);
}

function isFirefox(): boolean {
  return navigator.userAgent.toLowerCase().includes('firefox');
}

export function supportedCodecs(): Codec[] {
  if (isFirefox()) return ['vp8'];
  const caps = RTCRtpSender.getCapabilities('video');
  if (caps === null) return ['vp8'];
  const have = new Set(caps.codecs.map((c) => c.mimeType.toLowerCase()));
  return (['av1', 'h265', 'vp9', 'h264', 'vp8'] as Codec[]).filter((c) => have.has(`video/${c}`));
}

export interface EncoderProbe {
  /** O navegador diz que codifica isso na placa de vídeo (powerEfficient). */
  gpu: boolean;
  smooth: boolean;
}

const MIME: Record<Codec, string> = {
  av1: 'video/AV1',
  h265: 'video/H265',
  vp9: 'video/VP9',
  h264: 'video/H264',
  vp8: 'video/VP8',
};

/** Resultado da última sondagem: qual codec roda na GPU neste PC, no tamanho e fps pedidos. */
let probed: Partial<Record<Codec, EncoderProbe>> = {};

export function encoderProbes(): Partial<Record<Codec, EncoderProbe>> {
  return probed;
}

/**
 * Pergunta ao navegador (Media Capabilities, tipo "webrtc") quais codecs ele codifica na placa
 * de vídeo neste tamanho e fps. Encoder de GPU (NVENC/AMF/QuickSync) quase não rouba FPS do jogo;
 * encoder por software (libvpx/libaom) come vários núcleos do processador.
 */
export async function probeEncoders(size: Size, fps: number): Promise<Partial<Record<Codec, EncoderProbe>>> {
  const mc = navigator.mediaCapabilities as MediaCapabilities | undefined;
  const out: Partial<Record<Codec, EncoderProbe>> = {};
  const bitrate = bitrateFor(size, fps, 'h264');
  await Promise.all(
    supportedCodecs().map(async (c) => {
      if (mc === undefined) return;
      try {
        const info = await mc.encodingInfo({
          type: 'webrtc',
          video: {
            contentType: MIME[c],
            width: size.width,
            height: size.height,
            framerate: fps,
            bitrate,
            // O livekit-client publica tela em AV1/VP9 com L1T3; o encoder de GPU precisa aceitar isso.
            ...(isSvc(c) ? { scalabilityMode: 'L1T3' } : {}),
          },
        } as MediaEncodingConfiguration);
        if (info.supported) out[c] = { gpu: info.powerEfficient || hardwareOnly(c), smooth: info.smooth };
      } catch {
        // tipo "webrtc" não suportado aqui: sem informação.
      }
    }),
  );
  probed = out;
  return out;
}

/** Preferência entre os codecs de GPU: AV1 e H.265 dão mais qualidade por bit que H.264. */
const GPU_ORDER: Codec[] = ['av1', 'h265', 'h264', 'vp9', 'vp8'];

export function pickCodec(choice: CodecChoice): Codec {
  const ok = supportedCodecs();
  if (choice !== 'auto' && ok.includes(choice)) return choice;
  // Automático: o primeiro que a placa de vídeo codifica. Assim quem transmite quase não perde FPS.
  for (const c of GPU_ORDER) if (ok.includes(c) && probed[c]?.gpu === true) return c;
  for (const c of ['vp9', 'h264', 'vp8'] as Codec[]) if (ok.includes(c)) return c;
  return ok[0] ?? 'vp8';
}

function codecCeiling(codec: Codec): number {
  // H.264 precisa de mais bits para a mesma qualidade, mas não é o teto que limita, é a rede.
  return codec === 'vp8' ? 6e7 : MAX_BITRATE;
}

export function bitrateFor(size: Size, fps: number, codec: Codec): number {
  const pixels = Math.max(1, size.width * size.height);
  const rungs = Object.values(LADDER);
  const nearest = rungs.reduce((best, r) => {
    const d = Math.abs(best.width * best.height - pixels);
    return Math.abs(r.width * r.height - pixels) < d ? r : best;
  }, rungs[0]);
  const scaled = nearest.baseBitrate * (pixels / (nearest.width * nearest.height));
  const bitrate = Math.round(scaled * fpsMultiplier(fps));
  return Math.min(bitrate, codecCeiling(codec), MAX_BITRATE);
}

export function planBitrate(plan: StreamPlan, codec: Codec): number {
  return bitrateFor(planSize(plan), plan.frameRate, codec);
}

export function formatBitrate(bps: number): string {
  return bps <= 0
    ? '-'
    : bps >= 1e7
      ? `${Math.round(bps / 1e6)} Mbps`
      : bps >= 1e6
        ? `${(bps / 1e6).toFixed(1)} Mbps`
        : `${Math.round(bps / 1e3)} kbps`;
}

export const DEFAULT_STREAM: StreamSettings = { mode: 'gaming', resolution: 'p1080', frameRate: 30 };
