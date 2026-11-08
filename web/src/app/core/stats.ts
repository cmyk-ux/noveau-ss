// Leitura de getStats(): o que está sendo enviado/recebido e se o navegador
// está segurando a qualidade por causa de CPU ou rede.
import type { LocalTrack } from 'livekit-client';

export type Limitation = 'none' | 'cpu' | 'bandwidth' | 'other';

export interface ShareHealth {
  reason: Limitation;
  width: number;
  height: number;
  fps: number;
  sustained: boolean;
}

export function asLimitation(v: unknown): Limitation {
  return v === 'cpu' || v === 'bandwidth' || v === 'none' ? v : 'other';
}

export function describeLimitation(l: Limitation): string {
  switch (l) {
    case 'none':
      return 'not limited';
    case 'cpu':
      return 'encoder cannot keep up (CPU)';
    case 'bandwidth':
      return 'network will not take more';
    case 'other':
      return 'the browser did not say';
  }
}

export function shortLimitation(l: Limitation): string {
  switch (l) {
    case 'cpu':
      return 'CPU';
    case 'bandwidth':
      return 'connection';
    default:
      return 'unknown';
  }
}

export function lackOf(l: Limitation): string {
  switch (l) {
    case 'cpu':
      return 'the CPU keeping up';
    case 'bandwidth':
      return 'the connection keeping up';
    default:
      return 'headroom';
  }
}

const HEALTH_EVERY_MS = 2500;
const SUSTAINED_SHARE = 0.6;
const IDLE: ShareHealth = { reason: 'none', width: 0, height: 0, fps: 0, sustained: false };
type Durations = Record<Limitation, number>;
const ZERO: Durations = { none: 0, cpu: 0, bandwidth: 0, other: 0 };

function num(o: any, key: string): number {
  const v = o[key];
  return typeof v === 'number' ? v : 0;
}

function largestOutboundVideo(report: RTCStatsReport): any | null {
  let best: any = null;
  for (const s of report.values()) {
    if (s.type !== 'outbound-rtp' || s.kind !== 'video') continue;
    if (best === null || num(s, 'frameHeight') > num(best, 'frameHeight')) best = s;
  }
  return best;
}

function durationsOf(s: any): Durations {
  const d = s.qualityLimitationDurations;
  if (typeof d !== 'object' || d === null) return ZERO;
  return { none: num(d, 'none'), cpu: num(d, 'cpu'), bandwidth: num(d, 'bandwidth'), other: num(d, 'other') };
}

function dominant(before: Durations, after: Durations): Limitation {
  const delta: Durations = {
    none: after.none - before.none,
    cpu: after.cpu - before.cpu,
    bandwidth: after.bandwidth - before.bandwidth,
    other: after.other - before.other,
  };
  const total = delta.none + delta.cpu + delta.bandwidth + delta.other;
  if (total <= 0) return 'none';
  let top: Limitation = 'cpu';
  for (const k of ['bandwidth', 'other'] as Limitation[]) if (delta[k] > delta[top]) top = k;
  return delta[top] / total >= SUSTAINED_SHARE ? top : 'none';
}

/** Vigia o encoder da tela e avisa quando ele passa a reduzir a qualidade de forma sustentada. */
export class ShareWatch {
  private readonly track: LocalTrack;
  private readonly onChange: (h: ShareHealth) => void;
  private timer?: number;
  private durations: Durations | null = null;
  private last = IDLE;

  constructor(opts: { track: LocalTrack; onChange: (h: ShareHealth) => void }) {
    this.track = opts.track;
    this.onChange = opts.onChange;
  }

  start() {
    this.stop();
    this.timer = window.setInterval(() => void this.tick(), HEALTH_EVERY_MS);
  }

  stop() {
    window.clearInterval(this.timer);
    this.timer = undefined;
  }

  health() {
    return this.last;
  }

  private async tick() {
    const sender = this.track.sender;
    if (sender === undefined) return;
    let report: RTCStatsReport;
    try {
      report = await sender.getStats();
    } catch {
      return;
    }
    const s = largestOutboundVideo(report);
    if (s === null) return;
    const now = durationsOf(s);
    const lasting = this.durations === null ? 'none' : dominant(this.durations, now);
    this.durations = now;
    const next: ShareHealth = {
      reason: lasting === 'none' ? asLimitation(s.qualityLimitationReason) : lasting,
      width: num(s, 'frameWidth'),
      height: num(s, 'frameHeight'),
      fps: Math.round(num(s, 'framesPerSecond')),
      sustained: lasting !== 'none',
    };
    const changed =
      next.sustained !== this.last.sustained ||
      next.reason !== this.last.reason ||
      next.width !== this.last.width ||
      next.height !== this.last.height ||
      next.fps !== this.last.fps;
    this.last = next;
    if (changed) this.onChange(next);
  }
}

function text(o: any, key: string): string {
  const v = o[key];
  return typeof v === 'string' ? v : '?';
}

function codecName(report: RTCStatsReport, id: string | undefined): string {
  if (id === undefined) return '?';
  return (report.get(id) as any)?.mimeType?.replace(/^(video|audio)\//, '').toUpperCase() ?? '?';
}

function channelsOf(report: RTCStatsReport, id: string | undefined): number {
  if (id === undefined) return 0;
  const c = report.get(id) as any;
  return typeof c?.channels === 'number' ? c.channels : 0;
}

export function sourceAudioLevel(report: RTCStatsReport): number {
  for (const s of report.values()) if (s.type === 'media-source' && s.kind === 'audio') return num(s, 'audioLevel');
  return 0;
}

interface Sample {
  bytes: number;
  timestamp: number;
}

function rate(prev: Sample | undefined, bytes: number, ts: number): number {
  return prev === undefined || ts <= prev.timestamp ? 0 : Math.round(((bytes - prev.bytes) * 8 * 1e3) / (ts - prev.timestamp));
}

export interface OutboundVideo {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  targetBitrate: number;
  codec: string;
  encoder: string;
  /** true = encoder de hardware (placa de vídeo). */
  gpu: boolean | null;
  /** Tempo médio para codificar um quadro (ms). */
  encodeMs: number;
  scalabilityMode: string;
  limitation: Limitation;
  resolutionChanges: number;
}
export interface InboundVideo {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  codec: string;
  decoder: string;
  gpu: boolean | null;
  packetsLost: number;
  framesDropped: number;
  freezeCount: number;
  freezeSeconds: number;
  jitterMs: number;
}
export interface AudioReading {
  bitrate: number;
  codec: string;
  channels: number;
  level: number;
  packetsLost?: number;
}

/** Transforma relatórios de getStats() em números, guardando a amostra anterior para calcular bitrate. */
export class StatsSampler {
  private readonly outbound = new Map<string, Sample>();
  private readonly inbound = new Map<string, Sample>();
  private readonly outboundAudio = new Map<string, Sample>();
  private readonly inboundAudio = new Map<string, Sample>();

  readOutbound(report: RTCStatsReport): OutboundVideo | null {
    const s = largestOutboundVideo(report);
    if (s === null) return null;
    const id = String(s.id);
    const bytes = num(s, 'bytesSent');
    const bitrate = rate(this.outbound.get(id), bytes, s.timestamp);
    this.outbound.set(id, { bytes, timestamp: s.timestamp });
    return {
      width: num(s, 'frameWidth'),
      height: num(s, 'frameHeight'),
      fps: Math.round(num(s, 'framesPerSecond')),
      bitrate,
      targetBitrate: Math.round(num(s, 'targetBitrate')),
      codec: codecName(report, s.codecId),
      encoder: text(s, 'encoderImplementation'),
      gpu: typeof s.powerEfficientEncoder === 'boolean' ? s.powerEfficientEncoder : null,
      encodeMs: num(s, 'framesEncoded') > 0 ? Math.round((num(s, 'totalEncodeTime') / num(s, 'framesEncoded')) * 1e4) / 10 : 0,
      scalabilityMode: text(s, 'scalabilityMode'),
      limitation: asLimitation(s.qualityLimitationReason),
      resolutionChanges: num(s, 'qualityLimitationResolutionChanges'),
    };
  }

  readOutboundAudio(report: RTCStatsReport): AudioReading | null {
    for (const s of report.values() as Iterable<any>) {
      if (s.type !== 'outbound-rtp' || s.kind !== 'audio') continue;
      const id = String(s.id);
      const bytes = num(s, 'bytesSent');
      const bitrate = rate(this.outboundAudio.get(id), bytes, s.timestamp);
      this.outboundAudio.set(id, { bytes, timestamp: s.timestamp });
      return { bitrate, codec: codecName(report, s.codecId), channels: channelsOf(report, s.codecId), level: sourceAudioLevel(report) };
    }
    return null;
  }

  readInboundAudio(report: RTCStatsReport): AudioReading | null {
    for (const s of report.values() as Iterable<any>) {
      if (s.type !== 'inbound-rtp' || s.kind !== 'audio') continue;
      const id = String(s.id);
      const bytes = num(s, 'bytesReceived');
      const bitrate = rate(this.inboundAudio.get(id), bytes, s.timestamp);
      this.inboundAudio.set(id, { bytes, timestamp: s.timestamp });
      return {
        bitrate,
        codec: codecName(report, s.codecId),
        channels: channelsOf(report, s.codecId),
        level: num(s, 'audioLevel'),
        packetsLost: num(s, 'packetsLost'),
      };
    }
    return null;
  }

  readInbound(report: RTCStatsReport): InboundVideo | null {
    for (const s of report.values() as Iterable<any>) {
      if (s.type !== 'inbound-rtp' || s.kind !== 'video') continue;
      const id = String(s.id);
      const bytes = num(s, 'bytesReceived');
      const bitrate = rate(this.inbound.get(id), bytes, s.timestamp);
      this.inbound.set(id, { bytes, timestamp: s.timestamp });
      return {
        width: num(s, 'frameWidth'),
        height: num(s, 'frameHeight'),
        fps: Math.round(num(s, 'framesPerSecond')),
        bitrate,
        codec: codecName(report, s.codecId),
        decoder: text(s, 'decoderImplementation'),
        gpu: typeof s.powerEfficientDecoder === 'boolean' ? s.powerEfficientDecoder : null,
        packetsLost: num(s, 'packetsLost'),
        framesDropped: num(s, 'framesDropped'),
        freezeCount: num(s, 'freezeCount'),
        freezeSeconds: Math.round(num(s, 'totalFreezesDuration') * 10) / 10,
        jitterMs: Math.round(num(s, 'jitter') * 1e3),
      };
    }
    return null;
  }
}
