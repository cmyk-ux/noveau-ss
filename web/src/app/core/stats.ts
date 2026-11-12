// Leitura de getStats(): o que está sendo enviado/recebido e se o navegador
// está segurando a qualidade por causa de CPU ou rede.

export type Limitation = 'none' | 'cpu' | 'bandwidth' | 'other';

export interface ShareHealth {
  reason: Limitation;
  width: number;
  height: number;
  fps: number;
  sustained: boolean;
  /** Quadros por segundo que a captura do navegador entrega (antes do codificador), média recente. */
  captureFps: number;
  /** Quadros por segundo pedidos agora (o escolhido, ou o degrau do "Ceder"). */
  wantFps: number;
  /**
   * O que está segurando os quadros, de forma sustentada e com a imagem mexendo:
   * 'capture' = a captura entrega bem menos do que o pedido (jogo ocupando a placa de vídeo ou o
   * processador; ver CaptureShortfall); 'encoder' = a captura entrega, o codificador perde quadros.
   */
  short: Shortfall;
}

/**
 * 'encoder' = a captura entrega e o codificador perde quadros. (Havia também 'capture', a captura
 * abaixo do pedido, que culpava um jogo; mas a captura do navegador só entrega quando a tela muda, e
 * numa área de trabalho comum ela fica em 30-40 fps sem nada de errado. Acusava à toa.)
 */
export type Shortfall = 'encoder' | null;

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

/** Uma leitura de getStats a cada 2 s, repartida por todos os vigias de quem transmite. */
const FEED_EVERY_MS = 2000;
const SUSTAINED_SHARE = 0.6;
const IDLE: ShareHealth = { reason: 'none', width: 0, height: 0, fps: 0, sustained: false, captureFps: 0, wantFps: 0, short: null };
type Durations = Record<Limitation, number>;
const ZERO: Durations = { none: 0, cpu: 0, bandwidth: 0, other: 0 };

function num(o: any, key: string): number {
  const v = o[key];
  return typeof v === 'number' ? v : 0;
}

function captureFpsOf(report: RTCStatsReport, id: unknown): number {
  const src = typeof id === 'string' ? (report.get(id) as any) : undefined;
  return src === undefined ? 0 : Math.round(num(src, 'framesPerSecond'));
}

function captureSizeOf(report: RTCStatsReport, id: unknown): string {
  const src = typeof id === 'string' ? (report.get(id) as any) : undefined;
  return src === undefined || !(num(src, 'width') > 0) ? '?' : `${num(src, 'width')}x${num(src, 'height')}`;
}

function layersOf(report: RTCStatsReport): string[] {
  const out: { h: number; text: string }[] = [];
  for (const s of report.values() as Iterable<any>) {
    if (s.type !== 'outbound-rtp' || s.kind !== 'video') continue;
    // Sem rid = uma camada só (a tela, sem simulcast).
    const rid = typeof s.rid === 'string' ? s.rid : 'única';
    const h = num(s, 'frameHeight');
    const text =
      s.active === false
        ? `${rid} pausada`
        : `${rid} ${num(s, 'frameWidth')}x${h} ${Math.round(num(s, 'framesPerSecond'))}fps ${asLimitation(s.qualityLimitationReason) === 'none' ? '' : shortLimitation(asLimitation(s.qualityLimitationReason))}`.trim();
    out.push({ h, text });
  }
  return out.sort((a, b) => b.h - a.h).map((x) => x.text);
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

type Reader = (report: RTCStatsReport) => void | Promise<void>;

/**
 * Lê o getStats de quem transmite uma vez a cada 2 s e entrega a mesma leitura a todos os vigias
 * (saúde do envio, perda na subida, codificador na placa). Antes cada um tinha o seu relógio e a
 * sua leitura: três getStats onde uma basta. Para sozinho quando ninguém mais quer leituras.
 */
export class StatsFeed {
  private timer?: number;
  private busy = false;
  private readonly readers = new Set<Reader>();

  constructor(private readonly sender: () => RTCRtpSender | undefined) {}

  /** Passa a receber as leituras. Devolve como parar. */
  add(fn: Reader): () => void {
    this.readers.add(fn);
    this.timer ??= window.setInterval(() => void this.tick(), FEED_EVERY_MS);
    return () => {
      this.readers.delete(fn);
      if (this.readers.size > 0) return;
      window.clearInterval(this.timer);
      this.timer = undefined;
    };
  }

  private async tick() {
    const sender = this.sender();
    if (this.busy || sender === undefined) return;
    this.busy = true;
    try {
      const report = await sender.getStats();
      for (const fn of [...this.readers]) {
        try {
          await fn(report);
        } catch {
          /* um vigia com problema não derruba os outros */
        }
      }
    } catch {
      /* conexão fechando */
    } finally {
      this.busy = false;
    }
  }
}

/** Quantas leituras (de 2 s) olhar para dizer que a captura está curta: ~10 s. */
const SHORT_WINDOW = 5;
/** Leituras curtas dentro da janela para acusar (todas) e no máximo esta quantidade para limpar. */
const SHORT_ON = 5;
const SHORT_OFF = 2;
/** Abaixo disto do pedido conta como curta. */
const SHORT_RATIO = 0.8;
/**
 * Com menos bits que isso a imagem está quase parada (o navegador só captura o que muda). Sozinho não
 * basta: com poucos quadros o codificador gasta a sobra refinando a imagem parada (medido: VP8 a
 * 2 fps com um relógio mudando mandou ~3,4 Mbps por uns 8 s), por isso também o piso de quadros.
 */
const MOVING_BPS = 1.5e6;
interface ShortSample {
  capture: number;
  sent: number;
  want: number;
  moving: boolean;
}

/**
 * Codificador perdendo quadros: a tela está mexendo, a captura entrega o pedido e saem bem menos
 * quadros do que ela entrega, por ~10 s (GPU ocupada por um jogo, por exemplo).
 *
 * O aviso de "captura curta" (menos quadros capturados que o pedido) saiu em 12/11/2026: o navegador
 * só captura quando a tela muda, então área de trabalho, navegador ou vídeo dão naturalmente 30-40 fps
 * num pedido de 60, e o aviso culpava um jogo que nem estava aberto. O número capturado continua no
 * painel de estatísticas e no /teste, que mede com uma animação na tela.
 */
export class CaptureShortfall {
  private samples: ShortSample[] = [];
  private state: Shortfall = null;

  /** Uma leitura. Devolve o estado depois dela. */
  push(x: ShortSample): Shortfall {
    this.samples = [...this.samples, x].slice(-SHORT_WINDOW);
    const encoder = this.samples.filter(
      (s) => s.moving && s.want >= 30 && s.capture >= s.want * SHORT_RATIO && s.sent < s.capture * SHORT_RATIO,
    );
    if (encoder.length >= SHORT_ON) this.state = 'encoder';
    else if (this.state === 'encoder' && encoder.length <= SHORT_OFF) this.state = null;
    return this.state;
  }

  /** Média dos quadros capturados na janela (o número que aparece para as pessoas). */
  captureFps(): number {
    if (this.samples.length === 0) return 0;
    return Math.round(this.samples.reduce((a, s) => a + s.capture, 0) / this.samples.length);
  }
}

/** Teto de quadros da cópia menor da tela (simulcast, share.ts): acima disso ela não manda por desenho. */
export const LOW_LAYER_MAX_FPS = 60;
/** Ordem das camadas do LiveKit, da menor para a maior. */
const RIDS = ['q', 'h', 'f'];

/** Vigia o encoder da tela e avisa quando ele passa a reduzir a qualidade de forma sustentada. */
export class ShareWatch {
  private readonly onChange: (h: ShareHealth) => void;
  /** Quadros por segundo pedidos agora (muda com o degrau do "Ceder"). */
  private readonly want: () => number;
  private off: (() => void) | null = null;
  private durations: Durations | null = null;
  private last = IDLE;
  private bytes: { sent: number; at: number } | null = null;
  private readonly shortfall = new CaptureShortfall();

  constructor(
    opts: { onChange: (h: ShareHealth) => void; want: () => number },
    private readonly feed: StatsFeed,
  ) {
    this.onChange = opts.onChange;
    this.want = opts.want;
  }

  start() {
    this.stop();
    this.off = this.feed.add((r) => this.read(r));
  }

  stop() {
    this.off?.();
    this.off = null;
  }

  health() {
    return this.last;
  }

  private read(report: RTCStatsReport) {
    const s = largestOutboundVideo(report);
    if (s === null) return;
    const now = durationsOf(s);
    const lasting = this.durations === null ? 'none' : dominant(this.durations, now);
    this.durations = now;
    const fps = Math.round(num(s, 'framesPerSecond'));
    const want = this.want();
    // Bits de todas as camadas: com a imagem parada o navegador quase não manda nada. E os quadros da
    // camada ativa que mais entrega: o LiveKit pausa as camadas que ninguém está vendo (dynacast), e uma
    // camada pausada não é o codificador perdendo quadros. A cópia menor tem teto próprio (60 fps):
    // ela é medida contra o que deveria mandar, para 120 pedidos com todos na cópia menor não acusar.
    const capture = captureFpsOf(report, s.mediaSourceId);
    const layers = [...report.values()].filter((r) => r.type === 'outbound-rtp' && r.kind === 'video');
    const rank = (r: any) => (typeof r.rid === 'string' ? RIDS.indexOf(r.rid) : RIDS.length);
    const top = Math.max(-1, ...layers.map(rank));
    let sent = 0;
    let sentFps = -1;
    for (const r of layers) {
      sent += num(r, 'bytesSent');
      if (r.active === false) continue;
      const expected = rank(r) < top ? Math.min(capture, LOW_LAYER_MAX_FPS) : capture;
      const fps = num(r, 'framesPerSecond');
      sentFps = Math.max(sentFps, expected > 0 ? (fps / expected) * capture : fps);
    }
    const at = num(s, 'timestamp');
    const bps = this.bytes === null || at <= this.bytes.at ? 0 : ((sent - this.bytes.sent) * 8 * 1e3) / (at - this.bytes.at);
    this.bytes = { sent, at };
    // A captura pode passar do pedido (divisor do monitor, monitor.ts): o codificador só deve mandar o pedido.
    const usable = Math.min(capture, want);
    const short = this.shortfall.push({ capture: usable, sent: sentFps < 0 ? usable : Math.min(sentFps, usable), want, moving: bps >= MOVING_BPS });
    const next: ShareHealth = {
      reason: lasting === 'none' ? asLimitation(s.qualityLimitationReason) : lasting,
      width: num(s, 'frameWidth'),
      height: num(s, 'frameHeight'),
      fps,
      sustained: lasting !== 'none',
      captureFps: this.shortfall.captureFps(),
      wantFps: want,
      short,
    };
    const changed =
      next.sustained !== this.last.sustained ||
      next.reason !== this.last.reason ||
      next.width !== this.last.width ||
      next.height !== this.last.height ||
      next.fps !== this.last.fps ||
      next.short !== this.last.short ||
      next.captureFps !== this.last.captureFps ||
      next.wantFps !== this.last.wantFps;
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
  /** Quadros por segundo que a captura do navegador está entregando (antes do encoder). */
  captureFps: number;
  /** Tamanho que a captura entrega ao codificador (media-source), ex. "2560x1440". */
  captureSize: string;
  /** Cada camada que sai: "h 1920x1080 60fps", "q pausada"... */
  layers: string[];
  scalabilityMode: string;
  limitation: Limitation;
  resolutionChanges: number;
  /** Quadros 2,5x maiores que a média (mudança brusca de cena: menu, tela preta). */
  hugeFrames: number;
  /** Pedidos de quadro-chave de quem assiste (perdeu pacote e precisou recomeçar). */
  keyRequests: number;
  keyFrames: number;
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
  keyRequests: number;
  jitterMs: number;
  /** Pacotes recebidos (para a perda em %). */
  packetsReceived: number;
  /** Pedidos de reenvio feitos e reenvios que chegaram. */
  nacks: number;
  recovered: number;
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
      captureFps: captureFpsOf(report, s.mediaSourceId),
      captureSize: captureSizeOf(report, s.mediaSourceId),
      layers: layersOf(report),
      encodeMs: num(s, 'framesEncoded') > 0 ? Math.round((num(s, 'totalEncodeTime') / num(s, 'framesEncoded')) * 1e4) / 10 : 0,
      scalabilityMode: text(s, 'scalabilityMode'),
      limitation: asLimitation(s.qualityLimitationReason),
      resolutionChanges: num(s, 'qualityLimitationResolutionChanges'),
      hugeFrames: num(s, 'hugeFramesSent'),
      keyRequests: num(s, 'pliCount') + num(s, 'firCount'),
      keyFrames: num(s, 'keyFramesEncoded'),
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
        keyRequests: num(s, 'pliCount') + num(s, 'firCount'),
        jitterMs: Math.round(num(s, 'jitter') * 1e3),
        packetsReceived: num(s, 'packetsReceived'),
        nacks: num(s, 'nackCount'),
        recovered: num(s, 'retransmittedPacketsReceived'),
      };
    }
    return null;
  }
}
