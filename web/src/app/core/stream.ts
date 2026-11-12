// Presets de transmissão de tela: resolução, fps, codec e bitrate.
// Recuperado do bundle deployado (chunk-CzevgFlM.js).
import { h264ContentTypes, h264DecodeTypes } from './h264';

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
 * A captura é sempre no tamanho original (ver share.ts); o 1080p é aplicado no codificador. Acima de
 * 60 fps cada quadro tem metade (ou menos) dos bits, e em 1440p isso já aparece como blocos em
 * movimento rápido. Em 1080p o mesmo bitrate rende mais por pixel e quem assiste decodifica 120 fps
 * com folga.
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
    // Resolução fixa: o navegador nunca encolhe a tela sozinho. Com 'maintain-framerate' o WebRTC liga
    // o controle de qualidade (QualityScaler / BandwidthQualityScaler) numa camada só, e ele encolhe a
    // imagem quando o codificador gasta pouco (tela parada da área de trabalho: 720p e menos) ou na
    // largada, com a estimativa de banda ainda baixa, e numa tela que quase não muda nunca junta
    // amostras para voltar. Visto com H.264 na placa: 320x180, 640x360, 720p numa 3070 sem jogo.
    // Faltando banda de verdade, o navegador corta quadros (não resolução); a CPU apertada idem.
    degradation: 'maintain-resolution',
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
 * Como perguntar ao navegador por um codec. O H.264 precisa do perfil: sem ele o navegador responde
 * pelo "Constrained Baseline" (42e01f), que no Windows e no Mac nunca vai para a placa. Perguntamos
 * pelos perfis que de fato vão ser negociados (ver h264.ts).
 */
function contentTypes(codec: Codec): string[] {
  return codec === 'h264' ? h264ContentTypes() : [MIME[codec]];
}

async function encodeInfo(mc: MediaCapabilities, codec: Codec, size: Size, fps: number, bitrate: number): Promise<EncoderProbe | null> {
  let best: EncoderProbe | null = null;
  for (const contentType of contentTypes(codec)) {
    try {
      const info = await mc.encodingInfo({
        type: 'webrtc',
        video: {
          contentType,
          width: size.width,
          height: size.height,
          framerate: fps,
          bitrate,
          // O livekit-client publica tela em AV1/VP9 com L1T3; o encoder de GPU precisa aceitar isso.
          ...(isSvc(codec) ? { scalabilityMode: 'L1T3' } : {}),
        },
      } as MediaEncodingConfiguration);
      if (!info.supported) continue;
      const probe = { gpu: info.powerEfficient || hardwareOnly(codec), smooth: info.smooth };
      if (probe.gpu) return probe;
      best ??= probe;
    } catch {
      // tipo "webrtc" não suportado aqui: sem informação.
    }
  }
  return best;
}

/** Uma pergunta só, sem mexer na sondagem da tela: este codec roda na placa neste tamanho e fps? */
export async function gpuEncodes(codec: Codec, size: Size, fps: number): Promise<boolean> {
  const mc = navigator.mediaCapabilities as MediaCapabilities | undefined;
  if (mc === undefined || !supportedCodecs().includes(codec)) return false;
  return (await encodeInfo(mc, codec, size, fps, bitrateFor(size, fps, codec)))?.gpu === true;
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
      const probe = await encodeInfo(mc, c, size, fps, bitrate);
      if (probe !== null) out[c] = probe;
    }),
  );
  probed = out;
  return out;
}

/**
 * Automático, em ordem:
 * 1. AV1 da placa, se todo mundo que está na sala decodifica AV1 na placa (atributo "hwdec"). No
 *    Windows o Chrome não usa a placa para AV1 em chamada (kWebRtcAV1HWEncode vem desligado), então
 *    lá isso não acontece.
 * 2. H.264 da placa. Todo navegador decodifica (sem placa, no processador o H.264 é leve), sai com a
 *    cópia menor para quem não aguenta (o H.265 sai sem), e nunca obriga a sala a trocar de codec
 *    quando alguém entra. Com os bits que usamos (22 Mbps em 1080p60) a diferença de imagem para o
 *    H.265 é pequena; quem quiser, escolhe H.265 no menu.
 * 3. Outro codec da placa (H.265, VP9, AV1), com reserva em H.264 para quem não decodifica.
 * 4. Sem placa de vídeo nenhuma: VP8 (vários núcleos; o H.264 por software usa um só).
 *
 * Antes o H.264 nunca era visto como "da placa" (o teste perguntava pelo perfil errado) e o LiveKit
 * negociava o perfil que vai para o processador: num PC sem H.265, ou com alguém na sala sem
 * decodificador de H.265 (a reserva era VP8), tudo caía no VP8 por software em resolução cheia
 * (imagem ruim, fps baixo, travadas). Ver h264.ts.
 */
const GPU_ORDER: Codec[] = ['h264', 'h265', 'vp9', 'av1'];

/**
 * O que cada pessoa decodifica na placa de vídeo (atributo "hwdec", ver publishDecoders). Sem a
 * placa, o navegador de quem assiste decodifica no processador: AV1 ou H.265 em 1440p60 assim come
 * 1 a 2 núcleos e trava o PC dela, mesmo com quem transmite tranquilo.
 */
export function pickCodec(choice: CodecChoice, viewers: ReadonlySet<string>[] = [], exclude: ReadonlySet<Codec> = new Set()): Codec {
  // exclude: codecs que já vimos saindo no processador nesta transmissão (CodecGuard).
  const ok = supportedCodecs().filter((c) => !exclude.has(c));
  if (choice !== 'auto' && ok.includes(choice)) return choice;
  const gpu = (c: Codec) => ok.includes(c) && (probed[c]?.gpu === true || hardwareOnly(c));
  const everyone = (c: Codec) => viewers.every((v) => v.has(c));
  if (gpu('av1') && everyone('av1')) return 'av1';
  for (const c of GPU_ORDER) if (gpu(c)) return c;
  // Sem placa de vídeo: VP8. O H.264 por software (OpenH264) usa uma thread só e o VP9 por
  // software pesa muito; o VP8 usa vários núcleos e todo navegador toca.
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

/**
 * Quais codecs este navegador decodifica na placa de vídeo, numa tela grande a 60 fps
 * (Media Capabilities, tipo "webrtc", powerEfficient). Vai para os outros no atributo "hwdec".
 */
export async function hardwareDecoders(): Promise<Codec[]> {
  const mc = navigator.mediaCapabilities as MediaCapabilities | undefined;
  if (mc === undefined) return [];
  const out: Codec[] = [];
  await Promise.all(
    (Object.keys(MIME) as Codec[]).map(async (c) => {
      // H.264: os perfis que mandamos (High ou Baseline), não só o 42e01f.
      for (const contentType of c === 'h264' ? h264DecodeTypes() : [MIME[c]]) {
        try {
          const info = await mc.decodingInfo({
            type: 'webrtc',
            video: { contentType, width: 2560, height: 1440, framerate: 60, bitrate: 2e7 },
          } as MediaDecodingConfiguration);
          if (info.supported && info.powerEfficient) {
            out.push(c);
            return;
          }
        } catch {
          /* sem informação */
        }
      }
    }),
  );
  return out;
}

export function parseDecoders(attr: string | undefined): Set<string> | null {
  if (attr === undefined) return null;
  return new Set(attr.split(',').filter((x) => x !== ''));
}
