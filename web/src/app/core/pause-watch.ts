// "Transmissão pausada": a janela transmitida parou de mandar imagem.
//
// No Windows o Chrome captura janelas pelo Windows.Graphics.Capture com "0 Hz" ligado
// (desktop_capture_device.cc: set_allow_wgc_zero_hertz para TYPE_WINDOW): quadro igual ao anterior
// não é entregue. Janela minimizada (alt-tab num jogo em tela cheia) não desenha mais nada, então a
// faixa simplesmente para de receber quadros (wgc_capture_session.cc devolve o último quadro sem
// "região mudada", e o 0 Hz descarta). Jogo que para de desenhar fora de foco dá no mesmo. Para quem
// assiste, a imagem congela sem explicação.
//
// Medido no Windows 11 + Brave 1.99 (Chromium 157), janela animada a ~32 fps: minimizada = 0 quadros
// em 0,5 s; coberta por outra janela = continua mandando (não dá para saber do navegador); imagem
// parada = 0 quadros (igual a minimizada). E no R6 com alt-tab em tela cheia a imagem congela com
// ~8 fps ainda chegando (quadros quase iguais). Por isso dois sinais:
//   - nenhum quadro por 1,5 s, ou
//   - quadros chegando com a imagem igual por 2 s (miniatura de 64x36 a cada 0,5 s, menos de 1%
//     dela mudando: o cursor ou um contador de fps não contam).
// E só depois de a janela vir mandando imagem sem parar (jogo, vídeo): ~3 s seguidos acima de
// ~10 fps. Documento parado desde o começo não avisa.
// Volta quando a imagem muda de novo com pelo menos 3 quadros em 1 s (um quadro solto é o "refresh"
// que o WebRTC pede quando alguém entra, e repete a imagem velha).
//
// Lê `MediaStreamTrack.stats.totalFrames` (contador na própria faixa, sem getStats) a cada 0,5 s, só
// enquanto a fonte for uma janela; a miniatura (ImageCapture.grabFrame, ~0,4 ms na página) só com
// quadros chegando. Muda o estado no máximo a cada 2 s (vai para o atributo "act").

const TICK_MS = 500;
/** Quadros por leitura para contar como "mandando imagem" (~10 fps). */
const MOVING_FRAMES = 5;
/** Leituras seguidas com imagem antes de parar (3 s). */
const MOVING_TICKS = 6;
/** Leituras sem nenhum quadro para virar pausada (1,5 s). */
const STOPPED_TICKS = 3;
/** Leituras com quadros chegando mas a imagem igual para virar pausada (2 s). */
const FROZEN_TICKS = 4;
/** Miniatura para comparar a imagem (cursor e relógio ficam abaixo de 1% dela). */
const THUMB_W = 64;
const THUMB_H = 36;
/** Diferença (soma de R, G e B, 0-765) para um pixel da miniatura contar como mudado. */
const PIXEL_DIFF = 24;
const GRAB_TIMEOUT_MS = 400;
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

  private busy = false;
  private grabber: ImageCapture | null | undefined;
  private thumb: Uint8ClampedArray | null = null;
  private canvas: OffscreenCanvas | null = null;
  private still = 0;

  private tick() {
    if (this.busy) return;
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
      this.still = 0;
      this.thumb = null;
      this.set(false, true);
      return;
    }
    if (d === 0) {
      this.step(d, prev, true);
      return;
    }
    // Chegaram quadros: a imagem mudou de verdade, ou é a mesma imagem congelada (visto no R6 com
    // alt-tab: ~8 fps chegando com o quadro parado)? Uma miniatura de 64x36 responde.
    this.busy = true;
    void this.frozen()
      .then((f) => this.step(d, prev, f))
      .finally(() => (this.busy = false));
  }

  private step(d: number, prev: number, frozen: boolean) {
    this.still = frozen ? this.still + 1 : 0;
    if (this._paused) {
      if (!frozen && d + prev >= BACK_FRAMES) {
        this.moving = d >= MOVING_FRAMES ? 1 : 0;
        this.set(false);
      }
      return;
    }
    // Sem quadro nenhum: 1,5 s. Quadros chegando com a imagem parada: 2 s (menos certeza).
    const needed = d === 0 ? STOPPED_TICKS : FROZEN_TICKS;
    if (frozen) {
      if (this.still >= needed && this.moving >= MOVING_TICKS) this.set(true);
      return;
    }
    // Um soluço curto não apaga o "vinha mandando imagem".
    this.moving = d >= MOVING_FRAMES ? this.moving + 1 : 0;
  }

  /** O quadro que está chegando é praticamente igual ao anterior (menos de 1% da miniatura mudou). */
  private async frozen(): Promise<boolean> {
    if (this.grabber === undefined) {
      const IC = (window as { ImageCapture?: typeof ImageCapture }).ImageCapture;
      this.grabber = IC === undefined ? null : new IC(this.track);
      this.canvas = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(THUMB_W, THUMB_H);
    }
    const g = this.canvas?.getContext('2d', { willReadFrequently: true }) ?? null;
    if (this.grabber === null || g === null) return false;
    let bitmap: ImageBitmap | null = null;
    try {
      const grab = this.grabber.grabFrame();
      bitmap = await Promise.race([grab, new Promise<null>((r) => window.setTimeout(() => r(null), GRAB_TIMEOUT_MS))]);
      if (bitmap === null) {
        // Sem quadro em 0,4 s: os quadros pararam no meio do caminho (conta como parada). O que
        // chegar depois é fechado na hora.
        grab.then((b) => b.close()).catch(() => undefined);
        return true;
      }
      g.drawImage(bitmap, 0, 0, THUMB_W, THUMB_H);
      const px = g.getImageData(0, 0, THUMB_W, THUMB_H).data;
      const before = this.thumb;
      this.thumb = px;
      if (before === null) return false;
      let changed = 0;
      for (let i = 0; i < px.length; i += 4) {
        const dl = Math.abs(px[i] - before[i]) + Math.abs(px[i + 1] - before[i + 1]) + Math.abs(px[i + 2] - before[i + 2]);
        if (dl > PIXEL_DIFF) changed++;
      }
      return changed <= (THUMB_W * THUMB_H) / 100;
    } catch {
      return false;
    } finally {
      bitmap?.close();
    }
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
