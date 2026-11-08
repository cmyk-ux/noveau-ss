// Presets de transmissão de tela: resolução, fps, codec e bitrate.
// Recuperado do bundle deployado (chunk-CzevgFlM.js).

export type Resolution = 'p720' | 'p1080' | 'p1440' | 'source';
export type StreamMode = 'gaming' | 'movie' | 'screenshare' | 'custom';
export type Codec = 'av1' | 'vp9' | 'h264' | 'vp8';
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
  p720: { width: 1280, height: 720, baseBitrate: 44e5 },
  p1080: { width: 1920, height: 1080, baseBitrate: 1e7 },
  p1440: { width: 2560, height: 1440, baseBitrate: 177e5 },
  p2160: { width: 3840, height: 2160, baseBitrate: 4e7 },
};

const FPS_MULTIPLIERS = [
  { fps: 15, multiplier: 0.65 },
  { fps: 30, multiplier: 1 },
  { fps: 60, multiplier: 1.6 },
];

const MAX_BITRATE = 1e8;

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
  { id: 'gaming', label: 'Games', description: 'Frames first (1440p, 60fps)' },
  { id: 'movie', label: 'Film', description: 'Pixels first (1080p, 30fps)' },
  { id: 'screenshare', label: 'Code', description: 'Sharp text, never rescaled (Source, 15fps)' },
  { id: 'custom', label: 'Custom', description: 'Pick resolution and frame rate' },
];

export function planFor(s: StreamSettings): StreamPlan {
  if (s.mode === 'gaming')
    return { resolution: 'p1440', frameRate: 60, contentHint: 'motion', degradation: 'maintain-framerate' };
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
  return (['av1', 'vp9', 'h264', 'vp8'] as Codec[]).filter((c) => have.has(`video/${c}`));
}

export function pickCodec(choice: CodecChoice): Codec {
  const ok = supportedCodecs();
  if (choice !== 'auto' && ok.includes(choice)) return choice;
  for (const c of ['vp9', 'h264', 'vp8'] as Codec[]) if (ok.includes(c)) return c;
  return ok[0] ?? 'vp8';
}

function codecCeiling(codec: Codec): number {
  return codec === 'h264' ? 2e7 : codec === 'av1' || codec === 'vp9' ? 4e7 : MAX_BITRATE;
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
