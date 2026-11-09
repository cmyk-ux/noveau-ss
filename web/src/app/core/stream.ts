// Presets de transmissão de tela: resolução, fps, codec e bitrate.
// Recuperado do bundle deployado (chunk-CzevgFlM.js).

export type Resolution = 'p720' | 'p1080' | 'p1440' | 'source' | 'auto';
export type Codec = 'av1' | 'h265' | 'vp9' | 'h264' | 'vp8';
export type CodecChoice = Codec | 'auto';
export type Degradation = 'maintain-framerate' | 'maintain-resolution' | 'balanced';

/** Padrão: a tela original. Cada um pode limitar resolução, fps e bitrate se quiser. */
export interface StreamSettings {
  /** Teto de resolução ('source' = sem teto). */
  resolution: Resolution;
  frameRate: number;
  /** Teto de bitrate em bps; 0 = automático. */
  maxBitrate: number;
}

export interface StreamPlan {
  resolution: Resolution;
  frameRate: number;
  contentHint: 'motion' | 'detail';
  degradation: Degradation;
  maxBitrate: number;
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
  { fps: 90, multiplier: 2.1 },
  { fps: 120, multiplier: 2.5 },
];

// Banda não é problema (cabo): o teto é alto e o WebRTC baixa sozinho se a rede não aguentar.
const MAX_BITRATE = 12e7;

function fpsMultiplier(fps: number): number {
  let best = FPS_MULTIPLIERS[0];
  for (const m of FPS_MULTIPLIERS) if (Math.abs(m.fps - fps) < Math.abs(best.fps - fps)) best = m;
  return best.multiplier;
}

export const RESOLUTIONS: { id: Resolution; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'source', label: 'Original' },
  { id: 'p1440', label: '1440p' },
  { id: 'p1080', label: '1080p' },
  { id: 'p720', label: '720p' },
];

/**
 * 120 é o teto do próprio Chrome para captura de tela (kMaxScreenCastFrameRate no Chromium).
 * Acima disso o navegador não captura, mesmo que o jogo rode a 200+.
 */
export const FRAME_RATES = [30, 60, 90, 120];

export const BITRATE_LIMITS: { bps: number; label: string }[] = [
  { bps: 0, label: 'Auto' },
  { bps: 50e6, label: '50 Mbps' },
  { bps: 25e6, label: '25 Mbps' },
  { bps: 12e6, label: '12 Mbps' },
  { bps: 6e6, label: '6 Mbps' },
];

/**
 * Auto: a tela original até 60 fps; acima disso, 1080p.
 * O Chrome copia cada quadro da placa de vídeo para a memória e converte a cor numa thread só, e
 * limita essa cópia a meio núcleo (desktop_capture_device.cc: espera o dobro do tempo que a captura
 * levou). Em 1440p cada quadro tem 78% mais pixels que em 1080p e a 120 fps não sobra tempo:
 * a captura engasga. Em 1080p ela fecha.
 */
export const AUTO_HIGH_FPS = 60;
export function autoResolution(frameRate: number): Resolution {
  return frameRate > AUTO_HIGH_FPS ? 'p1080' : 'source';
}

export function planFor(s: StreamSettings): StreamPlan {
  return {
    resolution: s.resolution === 'auto' ? autoResolution(s.frameRate) : s.resolution,
    frameRate: s.frameRate,
    contentHint: 'motion',
    // Fluidez primeiro: se faltar CPU ou rede, o navegador baixa a resolução, nunca os quadros.
    // ("balanced" derrubava o fps primeiro, e é isso que mais se nota em jogo.)
    degradation: 'maintain-framerate',
    maxBitrate: s.maxBitrate,
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
  if (plan.resolution === 'source' || plan.resolution === 'auto') return screenSize();
  const r = LADDER[plan.resolution];
  return { width: r.width, height: r.height };
}

export function resolutionLabel(r: Resolution): string {
  if (r === 'auto') return 'Auto';
  if (r !== 'source') return `${LADDER[r].height}p`;
  if (!screenKnown()) return 'Original';
  const { width, height } = screenSize();
  return `Original (${width}x${height})`;
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

/**
 * Preferência entre os codecs de GPU. AV1 primeiro: tem camadas de tempo (o servidor pode mandar
 * menos quadros só para quem não aguenta) e quase todo navegador decodifica, inclusive o Firefox.
 * H.265 só toca em Chrome/Edge com decodificador de hardware; quem não tem recebe a reserva (VP8).
 */
const GPU_ORDER: Codec[] = ['av1', 'h265', 'vp9', 'h264'];

export function pickCodec(choice: CodecChoice): Codec {
  const ok = supportedCodecs();
  if (choice !== 'auto' && ok.includes(choice)) return choice;
  // Automático: o primeiro que a placa de vídeo codifica. Assim quem transmite quase não perde FPS.
  for (const c of GPU_ORDER) if (ok.includes(c) && probed[c]?.gpu === true) return c;
  // Sem placa de vídeo: VP8. No Chrome do Windows o H.264 do LiveKit sai no OpenH264 (uma thread só)
  // e o VP9 por software pesa muito; o VP8 usa vários núcleos e todo navegador toca.
  for (const c of ['vp8', 'vp9', 'h264'] as Codec[]) if (ok.includes(c)) return c;
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

/** Bitrate para o tamanho real, respeitando o teto escolhido pela pessoa. */
export function cappedBitrate(size: Size, plan: StreamPlan, codec: Codec): number {
  const b = bitrateFor(size, plan.frameRate, codec);
  return plan.maxBitrate > 0 ? Math.min(b, plan.maxBitrate) : b;
}

export function planBitrate(plan: StreamPlan, codec: Codec): number {
  return cappedBitrate(planSize(plan), plan, codec);
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

export const DEFAULT_STREAM: StreamSettings = { resolution: 'auto', frameRate: 60, maxBitrate: 0 };
