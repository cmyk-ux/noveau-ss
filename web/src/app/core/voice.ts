import type { AudioCaptureOptions, AudioProcessorOptions, TrackProcessor, TrackPublishOptions, Track } from 'livekit-client';
import { EqBand, RoomAudioPreset, VoiceSettings, isRawChain } from './voice-dsp';
import type { VoiceMeter, VoiceWorkerIn, VoiceWorkerOut } from './voice.worker';

/**
 * Microfone do PC: o que o navegador faz na captura (eco, ganho, filtro de ruído clássico) e o
 * que o nosso worker faz depois (IA, portão, equalizador). Veja docs/VOZ.md.
 *
 * O eco é sempre do navegador (AEC3 do WebRTC): ele precisa saber o que está saindo na caixa de
 * som, e só o navegador sabe. 'pc' pede ao Chrome 141+ para usar como referência tudo que o PC
 * toca (jogo, Spotify, Discord), não só o som do site; no Linux ele volta sozinho para 'site'.
 */
export function voiceCapture(s: VoiceSettings): AudioCaptureOptions {
  return {
    echoCancellation: (s.echo === 'off' ? false : s.echo === 'pc' ? 'all' : true) as boolean,
    noiseSuppression: s.denoise === 'navegador',
    autoGainControl: s.agc,
    // Isolamento de voz do sistema (ChromeOS/macOS): só com o filtro do navegador, para não somar com a IA.
    voiceIsolation: s.denoise === 'navegador',
    channelCount: 1,
    sampleRate: 48000,
  };
}

/** O que a captura entregou de fato (o Chrome cai para o eco só do site onde 'pc' não existe). */
export interface CaptureFacts {
  echo: 'off' | 'site' | 'pc';
  /** O sistema oferece cancelar o eco de tudo que o PC toca. */
  echoAllAvailable: boolean;
  sampleRate: number;
}
export function captureFacts(track: MediaStreamTrack): CaptureFacts {
  const caps = (track.getCapabilities?.() ?? {}) as { echoCancellation?: unknown[] };
  const set = track.getSettings() as { echoCancellation?: unknown; sampleRate?: number };
  const ec = set.echoCancellation;
  return {
    echo: ec === 'all' ? 'pc' : ec === false ? 'off' : 'site',
    echoAllAvailable: Array.isArray(caps.echoCancellation) && caps.echoCancellation.includes('all'),
    sampleRate: set.sampleRate ?? 0,
  };
}

/** Opus da voz conforme a qualidade escolhida para a sala. */
export function voicePublish(p: RoomAudioPreset): TrackPublishOptions {
  return { audioPreset: { maxBitrate: p.kbps * 1000 }, dtx: p.dtx, red: p.red };
}

/** Caminho rápido (Worker, sem AudioContext): Chrome, Edge, Brave, Opera. */
export function voiceWorkerSupported(): boolean {
  const g = globalThis as unknown as Record<string, unknown>;
  return typeof g['MediaStreamTrackProcessor'] === 'function' && typeof g['MediaStreamTrackGenerator'] === 'function' && typeof g['AudioData'] === 'function';
}

/** Precisa do worker para este tratamento? */
export function needsWorker(s: VoiceSettings): boolean {
  return !isRawChain(s) && voiceWorkerSupported();
}

interface ProcessorCtor {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): { readable: ReadableStream<AudioData> };
}
interface GeneratorCtor {
  new (init: { kind: 'audio' }): MediaStreamTrack & { writable: WritableStream<AudioData> };
}

/** Um worker da voz com a sua trilha de saída. */
class Lane {
  readonly worker: Worker;
  readonly generator: MediaStreamTrack & { writable: WritableStream<AudioData> };
  constructor(onMessage: (m: VoiceWorkerOut) => void) {
    const G = (globalThis as unknown as { MediaStreamTrackGenerator: GeneratorCtor }).MediaStreamTrackGenerator;
    this.worker = new Worker(new URL('./voice.worker', import.meta.url), { type: 'module', name: 'voz' });
    this.worker.onmessage = (e: MessageEvent<VoiceWorkerOut>) => onMessage(e.data);
    this.generator = new G({ kind: 'audio' });
    this.send({ type: 'output', writable: this.generator.writable }, [this.generator.writable]);
  }
  send(m: VoiceWorkerIn, transfer: Transferable[] = []) {
    this.worker.postMessage(m, transfer);
  }
  input(track: MediaStreamTrack) {
    const P = (globalThis as unknown as { MediaStreamTrackProcessor: ProcessorCtor }).MediaStreamTrackProcessor;
    // Fila curta: se a thread engasgar, perde um pedaço em vez de acumular atraso.
    const proc = new P({ track, maxBufferSize: 4 });
    this.send({ type: 'input', readable: proc.readable }, [proc.readable]);
  }
  /** Trilha só para você se ouvir (com o solo de banda, se houver). */
  monitor: (MediaStreamTrack & { writable: WritableStream<AudioData> }) | null = null;
  openMonitor(): MediaStreamTrack {
    if (this.monitor === null) {
      const G = (globalThis as unknown as { MediaStreamTrackGenerator: GeneratorCtor }).MediaStreamTrackGenerator;
      this.monitor = new G({ kind: 'audio' });
      this.send({ type: 'monitor', writable: this.monitor.writable }, [this.monitor.writable]);
    }
    return this.monitor;
  }
  closeMonitor() {
    if (this.monitor === null) return;
    this.send({ type: 'monitor', writable: null });
    this.monitor.stop();
    this.monitor = null;
  }
  close() {
    this.closeMonitor();
    this.send({ type: 'stop' });
    const w = this.worker;
    // Dá tempo de o worker fechar a trilha antes de terminar.
    setTimeout(() => w.terminate(), 500);
    this.generator.stop();
  }
}

/**
 * Processador do LiveKit: microfone → voice.worker → trilha nova que vai para a sala. Ajustes
 * (equalizador, intensidade, portão) valem na hora, sem republicar.
 *
 * A IA forte (DeepFilterNet) leva um ou dois segundos para montar o modelo, e nesse tempo o worker
 * não processa nada: a voz cortaria. Por isso ela carrega num segundo worker, enquanto o primeiro
 * segue com a IA leve; quando fica pronta, a saída troca de trilha no próprio envio (replaceTrack,
 * sem renegociar) e o worker antigo fecha.
 */
export class VoiceProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'noveau-voz';
  processedTrack?: MediaStreamTrack;
  onMeter: ((m: VoiceMeter) => void) | null = null;
  onEvent: ((m: Exclude<VoiceWorkerOut, VoiceMeter | { type: 'ready' }>) => void) | null = null;
  /** Avisa a trilha de saída nova (para pedir quadros de 10 ms nela também). */
  onOutput: ((track: MediaStreamTrack) => void) | null = null;
  private monitoring = false;
  private holding = false;
  private soloBand: EqBand | null = null;
  private lane: Lane | null = null;
  /** Worker carregando a IA forte, ainda sem entrada. */
  private next: Lane | null = null;
  /** O worker atual já tem a IA forte carregada. */
  private forteLoaded = false;
  private metering = false;
  private raw: MediaStreamTrack | null = null;
  private local: AudioProcessorOptions['localTrack'];

  constructor(private settings: VoiceSettings) {}

  async init(opts: AudioProcessorOptions) {
    this.raw = opts.track;
    this.local = opts.localTrack;
    this.lane = this.makeLane();
    this.lane.input(opts.track);
    this.processedTrack = this.lane.generator;
    this.apply();
  }

  /** O LiveKit chama ao trocar de microfone ou religar: a trilha de saída continua a mesma. */
  async restart(opts: AudioProcessorOptions) {
    if (this.lane === null) return this.init(opts);
    this.raw = opts.track;
    this.lane.input(opts.track);
  }

  async destroy() {
    this.next?.close();
    this.next = null;
    this.lane?.close();
    this.lane = null;
    this.processedTrack = undefined;
  }

  update(s: VoiceSettings) {
    this.settings = s;
    this.apply();
  }

  /**
   * Escuta (você se ouvindo): uma saída a mais do worker, que a sala não recebe. Por isso o solo de
   * banda toca só para você. Devolve a trilha para tocar, ou null.
   */
  monitor(on: boolean): MediaStreamTrack | null {
    this.monitoring = on;
    if (!on) {
      this.lane?.closeMonitor();
      return null;
    }
    return this.lane?.openMonitor() ?? null;
  }

  get monitorTrack(): MediaStreamTrack | null {
    return this.lane?.monitor ?? null;
  }

  /** Teste do microfone: a sala recebe silêncio enquanto você se ouve. */
  hold(on: boolean) {
    this.holding = on;
    this.lane?.send({ type: 'hold', on });
  }

  /** Solo de uma banda na escuta (null = escuta normal). */
  solo(band: EqBand | null) {
    this.soloBand = band;
    this.lane?.send({ type: 'solo', band });
  }

  /** Medidores só com a janela da voz aberta. */
  meter(on: boolean) {
    this.metering = on;
    this.lane?.send({ type: 'meter', on });
  }

  private makeLane(): Lane {
    const lane: Lane = new Lane((m) => {
      if (m.type === 'meter') {
        if (lane === this.lane) this.onMeter?.(m);
      } else if (m.type === 'ready') {
        if (lane === this.next) void this.promote(lane);
      } else if (lane === this.next && m.type === 'engine-failed') {
        this.next = null;
        lane.close();
        this.onEvent?.(m);
      } else if (lane === this.lane) this.onEvent?.(m);
    });
    return lane;
  }

  private apply() {
    const lane = this.lane;
    if (lane === null) return;
    const s = this.settings;
    const wantsForte = s.denoise === 'forte';
    if (wantsForte && !this.forteLoaded) {
      // Enquanto a forte carrega ao lado, este segue com a leve.
      lane.send({ type: 'settings', settings: { ...s, denoise: 'leve' } });
      if (this.next === null) {
        this.next = this.makeLane();
        this.next.send({ type: 'settings', settings: s });
      } else this.next.send({ type: 'settings', settings: s });
    } else {
      if (!wantsForte && this.next !== null) {
        this.next.close();
        this.next = null;
      }
      lane.send({ type: 'settings', settings: s });
    }
    lane.send({ type: 'meter', on: this.metering });
    lane.send({ type: 'hold', on: this.holding });
  }

  /** A IA forte ficou pronta no worker novo: ele passa a ser a saída. */
  private async promote(lane: Lane) {
    if (this.lane === null || this.raw === null || this.settings.denoise !== 'forte') {
      if (this.next === lane) this.next = null;
      lane.close();
      return;
    }
    this.next = null;
    lane.send({ type: 'settings', settings: this.settings });
    lane.send({ type: 'meter', on: this.metering });
    lane.send({ type: 'solo', band: this.soloBand });
    lane.send({ type: 'hold', on: this.holding });
    if (this.monitoring) lane.openMonitor();
    lane.input(this.raw);
    const sender = this.local?.sender;
    try {
      await sender?.replaceTrack(lane.generator);
    } catch {
      lane.close();
      return;
    }
    const old = this.lane;
    this.lane = lane;
    this.forteLoaded = true;
    this.processedTrack = lane.generator;
    old.close();
    this.onOutput?.(lane.generator);
  }
}

// ---------- Opus em quadros de 10 ms
//
// O Chrome escolhe o tamanho do quadro do Opus pelo "a=ptime" da resposta do servidor (testado no
// Chromium 153: com a=ptime:10 sai 100 pacotes/s; sem, 50). O LiveKit não manda ptime, então a
// resposta é ajustada aqui, só na seção do microfone. O menor quadro que o WebRTC aceita é 10 ms.

const wanted = new WeakMap<MediaStreamTrack, number>();
let installed = false;

/** Pede quadros de `ptime` ms para esta trilha na próxima negociação (null volta ao padrão de 20). */
export function wantPtime(track: MediaStreamTrack | undefined, ptime: number | null) {
  if (track === undefined) return;
  if (ptime === null) wanted.delete(track);
  else wanted.set(track, ptime);
  installPtime();
}

function installPtime() {
  if (installed || typeof RTCPeerConnection === 'undefined') return;
  installed = true;
  const original = RTCPeerConnection.prototype.setRemoteDescription;
  RTCPeerConnection.prototype.setRemoteDescription = function (this: RTCPeerConnection, desc?: RTCSessionDescriptionInit, ...rest: unknown[]) {
    if (desc?.type === 'answer' && typeof desc.sdp === 'string') {
      const mids = new Map<string, number>();
      for (const t of this.getTransceivers()) {
        const track = t.sender.track;
        const p = track === null ? undefined : wanted.get(track);
        if (p !== undefined && t.mid !== null) mids.set(t.mid, p);
      }
      if (mids.size > 0) desc = { type: desc.type, sdp: withPtime(desc.sdp, mids) };
    }
    return (original as (...a: unknown[]) => Promise<void>).call(this, desc, ...rest);
  } as typeof original;
}

/** Põe a=ptime nas seções de áudio com esses mids (troca o que já houver). */
export function withPtime(sdp: string, mids: Map<string, number>): string {
  const nl = sdp.includes('\r\n') ? '\r\n' : '\n';
  const parts = sdp.split(/\r?\nm=/);
  return parts
    .map((part, i) => {
      if (i === 0) return part;
      const lines = part.split(/\r?\n/);
      if (!lines[0].startsWith('audio')) return part;
      const mid = lines.find((l) => l.startsWith('a=mid:'))?.slice(6);
      const p = mid === undefined ? undefined : mids.get(mid);
      if (p === undefined) return part;
      const kept = lines.filter((l) => !l.startsWith('a=ptime:'));
      const at = kept.findIndex((l) => l.startsWith('a=mid:'));
      kept.splice(at + 1, 0, `a=ptime:${p}`);
      return kept.join(nl);
    })
    .join(`${nl}m=`);
}
