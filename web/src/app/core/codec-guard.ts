import { LocalVideoTrack } from 'livekit-client';
import { Codec, encoderProbes } from './stream';

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

const EVERY_MS = 3000;
/** Duas leituras seguidas no processador (6 s) antes de trocar: evita trocar por um soluço. */
const STRIKES = 2;
const MAX_SWITCHES = 2;

export interface CodecGuardEvent {
  /** Codec que estava no processador. */
  from: Codec;
  /** Implementação que o navegador contou (ex.: OpenH264, libvpx, libaom). */
  encoder: string;
}

interface SenderInfo {
  sender: RTCRtpSender;
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
  private timer?: number;
  private strikes = 0;
  private switches = 0;
  private frames = new Map<string, number>();
  private busy = false;

  constructor(
    private readonly track: LocalVideoTrack,
    private readonly codec: () => Codec,
    /** Troca o codec principal (republica a mesma captura). Devolve o codec novo, ou null. */
    private readonly fix: (e: CodecGuardEvent) => Promise<Codec | null>,
  ) {}

  start() {
    this.stop();
    this.timer = window.setInterval(() => void this.tick(), EVERY_MS);
  }

  stop() {
    window.clearInterval(this.timer);
    this.timer = undefined;
  }

  private senders(): SenderInfo[] {
    const out: SenderInfo[] = [];
    const main = this.track.sender;
    if (main !== undefined) out.push({ sender: main, codec: this.codec() });
    // Reservas (backupCodec) ficam num sender separado.
    const extra = (this.track as unknown as { simulcastCodecs?: Map<string, { sender?: RTCRtpSender }> }).simulcastCodecs;
    for (const [name, info] of extra ?? []) {
      const c = codecOfMime(`video/${name}`);
      if (info.sender !== undefined && c !== null) out.push({ sender: info.sender, codec: c });
    }
    return out;
  }

  private async tick() {
    if (this.busy || this.switches >= MAX_SWITCHES) return;
    let soft: CodecGuardEvent | null = null;
    for (const { sender, codec } of this.senders()) {
      let report: RTCStatsReport;
      try {
        report = await sender.getStats();
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
