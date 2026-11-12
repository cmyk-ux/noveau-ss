import { LocalVideoTrack } from 'livekit-client';
import type { StatsFeed } from './stats';

// Vigia do "encolhimento" da tela pelo próprio navegador.
//
// Com 'maintain-framerate' o WebRTC liga o controle de qualidade do codificador (QualityScaler): se o
// QP (o quanto ele está comprimindo) fica alto, reduz a resolução em degraus de 3/5 até o piso de
// 320x180. Ele só liga quando sai uma camada só (sem simulcast, ou com o LiveKit pausando as outras:
// `is_quality_scaling_allowed` em webrtc_video_engine.cc), e para o H.264 vale o limiar de QP 24..37
// (QualityScalingExperiment, ligado por padrão). Em stats isso aparece como "bandwidth"
// (send_statistics_proxy.cc: adaptação por qualidade conta como banda), mesmo com banda sobrando.
//
// Visto em 12/11/2026 (H.264 na NVIDIA): a tela saindo a 320x180 com 7,3 Mbps de alvo para a camada.
// Para uma imagem desse tamanho isso é ~2 bits por pixel por quadro; uma redução de verdade por falta
// de banda deixa ~0,05-0,15. Então: imagem bem menor que a planejada, "bandwidth" e bits de sobra
// para o tamanho que saiu = o controle de qualidade errou. A correção é trocar para
// 'maintain-resolution': o WebRTC tira na hora o limite de pixels (FilterRestrictionsByDegradationPreference
// em video_stream_adapter.cc) e desliga o QualityScaler. Se depois faltar banda de verdade, ele corta
// quadros em vez de resolução (a cópia menor do simulcast e o vigia da subida continuam valendo).

/** Leituras seguidas (uma a cada 2 s) com a imagem encolhida antes de agir: 6 s. */
const STRIKES = 3;
/** Encolhida = altura abaixo disto da planejada para a camada. */
const SHRUNK = 0.5;
/** Bits por pixel por quadro que o alvo da camada dá para o tamanho que saiu: acima disto, é sobra. */
const SPARE_BPP = 0.3;

export interface ShrinkEvent {
  /** Tamanho que estava saindo. */
  width: number;
  height: number;
  /** Altura planejada para a camada. */
  expected: number;
  /** Alvo do codificador para a camada (bps). */
  target: number;
}

export class ShrinkGuard {
  private off: (() => void) | null = null;
  private strikes = 0;
  /** Sender que já foi trocado (depois de trocar de codec o sender muda e o vigia volta a olhar). */
  private fixed: RTCRtpSender | null = null;

  constructor(
    private readonly track: LocalVideoTrack,
    private readonly onFix: (e: ShrinkEvent) => void,
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

  private read(report: RTCStatsReport) {
    const sender = this.track.sender;
    if (sender === undefined || sender === this.fixed) return;
    const e = shrunkLayer(report, sender.getParameters().encodings ?? []);
    this.strikes = e === null ? 0 : this.strikes + 1;
    if (e === null || this.strikes < STRIKES) return;
    this.strikes = 0;
    this.fixed = sender;
    console.info(`[tela] o navegador encolheu a tela para ${e.width}x${e.height} (planejado ${e.expected}p, alvo ${Math.round(e.target / 1e5) / 10} Mbps): mantendo a resolução`);
    void this.track.setDegradationPreference('maintain-resolution').catch(() => undefined);
    this.onFix(e);
  }
}

/** A camada ativa que o controle de qualidade encolheu sem falta de bits, ou null. */
export function shrunkLayer(report: RTCStatsReport, encodings: RTCRtpEncodingParameters[]): ShrinkEvent | null {
  let sourceHeight = 0;
  for (const s of report.values()) if (s.type === 'media-source' && s.kind === 'video') sourceHeight = Math.max(sourceHeight, n(s.height));
  if (sourceHeight === 0) return null;
  for (const s of report.values()) {
    if (s.type !== 'outbound-rtp' || s.kind !== 'video' || s.active === false) continue;
    if (s.qualityLimitationReason !== 'bandwidth') continue;
    const w = n(s.frameWidth);
    const h = n(s.frameHeight);
    if (w === 0 || h === 0) continue;
    const enc = encodings.find((x) => x.rid === s.rid) ?? (encodings.length === 1 ? encodings[0] : undefined);
    const expected = Math.round(sourceHeight / Math.max(1, enc?.scaleResolutionDownBy ?? 1));
    const target = n(s.targetBitrate);
    const fps = Math.max(30, n(s.framesPerSecond));
    if (h < expected * SHRUNK && target / (w * h * fps) > SPARE_BPP) return { width: w, height: h, expected, target };
  }
  return null;
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
