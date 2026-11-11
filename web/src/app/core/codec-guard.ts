import { LocalVideoTrack } from 'livekit-client';
import { Codec, encoderProbes } from './stream';
import type { StatsFeed } from './stats';

// Vigia do codificador de quem transmite.
//
// O navegador diz antes de começar se um codec "roda na placa de vídeo" (Media Capabilities), mas
// quem decide de verdade é outro pedaço do Chrome, e ele pode codificar no processador mesmo assim:
// - H.264 "Constrained Baseline" (42e01f) no Windows vai para o OpenH264, no processador, mesmo
//   com placa; os outros perfis vão para a placa.
// - AV1 já foi visto saindo no libaom (processador) numa placa que codifica AV1.
// - A placa pode falhar no meio (driver, sessões ocupadas) e o Chrome troca para o processador
//   sem avisar ninguém.
// - A reserva (backup) que o LiveKit liga quando alguém não decodifica o codec principal é VP8,
//   que nenhuma placa codifica.
// Em todos esses casos o jogo de quem transmite perde FPS "do nada". Aqui olhamos o que o
// navegador conta depois que começou (getStats: powerEfficientEncoder e encoderImplementation)
// e, se estiver no processador, trocamos para um codec que a placa codifique de verdade.

/** Três leituras seguidas no processador (6 s, uma a cada 2 s) antes de trocar: evita trocar por um soluço. */
const STRIKES = 3;
const MAX_SWITCHES = 2;

export interface CodecGuardEvent {
  /** Codec que estava no processador. */
  from: Codec;
  /** Implementação que o navegador contou (ex.: OpenH264, libvpx, libaom). */
  encoder: string;
}

interface SenderInfo {
  report: () => Promise<RTCStatsReport>;
  codec: Codec;
}

function codecOfMime(mime: string): Codec | null {
  const m = mime.toLowerCase();
  if (m.endsWith('/h264')) return 'h264';
  if (m.endsWith('/h265')) return 'h265';
  if (m.endsWith('/vp8')) return 'vp8';
  if (m.endsWith('/vp9')) return 'vp9';
  if (m.endsWith('/av1')) return 'av1';
  return null;
}

export class CodecGuard {
  private off: (() => void) | null = null;
  private strikes = 0;
  private switches = 0;
  private frames = new Map<string, number>();
  private busy = false;

  constructor(
    private readonly track: LocalVideoTrack,
    private readonly codec: () => Codec,
    /** Troca o codec principal (republica a mesma captura). Devolve o codec novo, ou null. */
    private readonly fix: (e: CodecGuardEvent) => Promise<Codec | null>,
    private readonly feed: StatsFeed,
  ) {}

  start() {
    this.stop();
    this.off = this.feed.add((r) => this.read(r));
  }

  stop() {
    this.off?.();
    this.off = null;
  }

  /** O principal usa a leitura que já veio; as reservas (backupCodec, raras) leem a sua. */
  private senders(main: RTCStatsReport): SenderInfo[] {
    const out: SenderInfo[] = [{ report: () => Promise.resolve(main), codec: this.codec() }];
    const extra = (this.track as unknown as { simulcastCodecs?: Map<string, { sender?: RTCRtpSender }> }).simulcastCodecs;
    for (const [name, info] of extra ?? []) {
      const c = codecOfMime(`video/${name}`);
      const sender = info.sender;
      if (sender !== undefined && c !== null) out.push({ report: () => sender.getStats(), codec: c });
    }
    return out;
  }

  private async read(main: RTCStatsReport) {
    if (this.busy || this.switches >= MAX_SWITCHES) return;
    let soft: CodecGuardEvent | null = null;
    for (const { report: get, codec } of this.senders(main)) {
      let report: RTCStatsReport;
      try {
        report = await get();
      } catch {
        continue;
      }
      report.forEach((s: any) => {
        if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
        // Só conta camada que está codificando agora (as desligadas não pesam).
        const key = `${codec}:${s.id}`;
        const frames = typeof s.framesEncoded === 'number' ? s.framesEncoded : 0;
        const before = this.frames.get(key) ?? frames;
        this.frames.set(key, frames);
        if (frames - before <= 0) return;
        if (s.powerEfficientEncoder === false && soft === null) {
          soft = { from: codec, encoder: typeof s.encoderImplementation === 'string' ? s.encoderImplementation : '?' };
        }
      });
    }
    if (soft === null) {
      this.strikes = 0;
      return;
    }
    // Sem nenhum codec na placa (PC sem placa de vídeo): não tem para onde trocar.
    const probes = encoderProbes();
    if (!(['h264', 'av1', 'vp9', 'h265'] as Codec[]).some((c) => probes[c]?.gpu === true)) return;
    if (++this.strikes < STRIKES) return;
    this.strikes = 0;
    this.busy = true;
    this.switches++;
    try {
      await this.fix(soft);
      this.frames.clear();
    } finally {
      this.busy = false;
    }
  }
}
