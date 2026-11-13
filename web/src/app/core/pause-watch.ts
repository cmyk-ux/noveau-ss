// "Transmissão pausada": a janela transmitida parou de mandar imagem.
//
// No Windows o Chrome captura janelas pelo Windows.Graphics.Capture com "0 Hz" ligado
// (desktop_capture_device.cc: set_allow_wgc_zero_hertz para TYPE_WINDOW): quadro igual ao anterior
// não é entregue. Janela minimizada (alt-tab num jogo em tela cheia) não desenha mais nada, então a
// faixa simplesmente para de receber quadros (wgc_capture_session.cc devolve o último quadro sem
// "região mudada", e o 0 Hz descarta). Jogo que para de desenhar fora de foco dá no mesmo. Para quem
// assiste, a imagem congela sem explicação.
//
// O navegador não conta se a janela está minimizada, só que os quadros pararam. Uma janela parada
// de verdade (documento, editor) também não manda quadros, então só vale como "pausada" quando a
// janela vinha mandando imagem sem parar (jogo, vídeo) e de repente parou de vez:
//   - pelo menos ~3 s seguidos acima de ~10 fps logo antes, e
//   - 1,5 s sem nenhum quadro.
// Volta quando chegam quadros de novo (pelo menos 3 em 1 s: um quadro solto é o "refresh" que o
// WebRTC pede quando alguém entra ou pede quadro-chave, e repete a imagem velha).
//
// Lê `MediaStreamTrack.stats.totalFrames` (contador na própria faixa, sem getStats) a cada 0,5 s, só
// enquanto a fonte for uma janela. Muda o estado no máximo a cada 2 s (vai para o atributo "act").

const TICK_MS = 500;
/** Quadros por leitura para contar como "mandando imagem" (~10 fps). */
const MOVING_FRAMES = 5;
/** Leituras seguidas com imagem antes de parar (3 s). */
const MOVING_TICKS = 6;
/** Leituras sem nenhum quadro para virar pausada (1,5 s). */
const STOPPED_TICKS = 3;
/** Quadros na última 1 s para voltar. */
const BACK_FRAMES = 3;
/** Intervalo mínimo entre mudanças (o atributo vai para a sala inteira). */
const MIN_CHANGE_MS = 2000;

interface TrackStats {
  totalFrames?: number;
  deliveredFrames?: number;
}

function frameCount(track: MediaStreamTrack): number | null {
  const s = (track as MediaStreamTrack & { stats?: TrackStats }).stats;
  if (s === undefined || s === null) return null;
  const n = s.totalFrames ?? s.deliveredFrames;
  return typeof n === 'number' ? n : null;
}

export class PauseWatch {
  private timer?: number;
  private last: number | null = null;
  private moving = 0;
  private stopped = 0;
  private prev = 0;
  private changedAt = 0;
  private _paused = false;

  constructor(
    private readonly track: MediaStreamTrack,
    private readonly onChange: (paused: boolean) => void,
  ) {}

  get paused(): boolean {
    return this._paused;
  }

  start() {
    // Navegador sem o contador na faixa: sem aviso (melhor nada que um aviso errado).
    if (this.timer !== undefined || frameCount(this.track) === null) return;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    window.clearInterval(this.timer);
    this.timer = undefined;
  }

  private surface(): string {
    return (this.track.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface ?? '';
  }

  private tick() {
    if (this.track.readyState !== 'live') {
      this.stop();
      return;
    }
    const n = frameCount(this.track);
    if (n === null) return;
    const d = this.last === null ? 0 : Math.max(0, n - this.last);
    const prev = this.prev;
    this.last = n;
    this.prev = d;
    // "Compartilhar esta em vez disso" pode trocar a janela por uma tela inteira no meio.
    if (this.surface() !== 'window') {
      this.moving = 0;
      this.stopped = 0;
      this.set(false, true);
      return;
    }
    if (this._paused) {
      if (d + prev >= BACK_FRAMES) {
        this.moving = d >= MOVING_FRAMES ? 1 : 0;
        this.stopped = 0;
        this.set(false);
      }
      return;
    }
    if (d === 0) {
      this.stopped++;
      if (this.stopped >= STOPPED_TICKS && this.moving >= MOVING_TICKS) this.set(true);
      return;
    }
    // Um soluço curto (menos de 1,5 s sem quadro) não apaga o "vinha mandando imagem".
    this.stopped = 0;
    this.moving = d >= MOVING_FRAMES ? this.moving + 1 : 0;
  }

  private set(paused: boolean, now = false) {
    if (paused === this._paused) return;
    const t = performance.now();
    // Volta na hora quando a fonte deixa de ser janela; o resto respeita o intervalo mínimo
    // (a próxima leitura tenta de novo, a condição continua valendo).
    if (!now && t - this.changedAt < MIN_CHANGE_MS) return;
    this.changedAt = t;
    this._paused = paused;
    this.onChange(paused);
  }
}
