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
// parada = 0 quadros (igual a minimizada). No R6 com alt-tab em tela cheia a imagem congela com ~8 fps
// ainda chegando.
//
// A primeira versão também pausava com "imagem quase igual" em qualquer fps e errava muito em jogo:
// menu, tela de carregamento e troca de tela pausavam sem alt-tab, e com quadros mexendo de novo
// continuava pausada. Agora (13/11, depois do teste do Pedro com amigos):
//   - só conta depois de a janela vir mandando bem: ~3 s seguidos a 16 fps ou mais;
//   - pausa com 3 s seguidos de "parado": nenhum quadro, ou poucos quadros (até ~10 fps) com a
//     imagem igual (miniatura de 64x36, menos de 1% mudando). Imagem parada com fps normal (menu)
//     nunca pausa; e a miniatura só é tirada quando o fps já caiu;
//   - volta na hora, na primeira leitura com imagem nova: fps normal, ou qualquer quadro que mude a
//     miniatura (um quadro solto com a imagem velha é o "refresh" que o WebRTC pede, e não conta).
//     Entrar na pausa respeita 2 s desde a última mudança; sair, não.
// Lê `MediaStreamTrack.stats.totalFrames` (contador na própria faixa, sem getStats) a cada 0,5 s, só
// enquanto a fonte for uma janela; a miniatura (ImageCapture.grabFrame, ~0,4 ms na página) só com
// quadros chegando. Muda o estado no máximo a cada 2 s (vai para o atributo "act").

const TICK_MS = 500;
/** Quadros por leitura para contar como "mandando imagem" (16 fps). */
const MOVING_FRAMES = 8;
/** Até quantos quadros por leitura ainda pode ser imagem congelada (~10 fps; o R6 manda ~8). */
const SLOW_FRAMES = 5;
/** Leituras seguidas com imagem antes de parar (3 s). */
const MOVING_TICKS = 6;
/** Leituras seguidas paradas (sem quadro, ou poucos e iguais) para virar pausada (3 s). */
const STILL_TICKS = 6;
/** Miniatura para comparar a imagem (cursor e relógio ficam abaixo de 1% dela). */
const THUMB_W = 64;
const THUMB_H = 36;
/** Diferença (soma de R, G e B, 0-765) para um pixel da miniatura contar como mudado. */
const PIXEL_DIFF = 24;
const GRAB_TIMEOUT_MS = 400;
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
    this.last = n;
    // "Compartilhar esta em vez disso" pode trocar a janela por uma tela inteira no meio.
    if (this.surface() !== 'window') {
      this.moving = 0;
      this.still = 0;
      this.thumb = null;
      this.set(false, true);
      return;
    }
    if (d === 0) {
      this.step(d, true);
      return;
    }
    // Quadros a fps normal: a janela está viva (menu parado a 60 fps não é alt-tab).
    if (d > SLOW_FRAMES) {
      this.thumb = null;
      this.step(d, false);
      return;
    }
    // Chegaram quadros: a imagem mudou de verdade, ou é a mesma imagem congelada (visto no R6 com
    // alt-tab: ~8 fps chegando com o quadro parado)? Uma miniatura de 64x36 responde.
    this.busy = true;
    void this.frozen()
      .then((f) => this.step(d, f))
      .finally(() => (this.busy = false));
  }

  private step(d: number, still: boolean) {
    this.still = still ? this.still + 1 : 0;
    if (this._paused) {
      // Qualquer quadro com imagem nova (ou fps normal) já tira a pausa, sem esperar.
      if (!still && d > 0) {
        this.moving = d >= MOVING_FRAMES ? 1 : 0;
        this.set(false, true);
      }
      return;
    }
    if (still) {
      if (this.still >= STILL_TICKS && this.moving >= MOVING_TICKS) this.set(true);
      return;
    }
    // Um soluço curto (menos de 3 s) não apaga o "vinha mandando imagem".
    if (d >= MOVING_FRAMES) this.moving++;
    else if (d > 0) this.moving = 0;
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
      // Sem miniatura anterior (o fps acabou de cair): ainda não dá para dizer que mudou.
      if (before === null) return true;
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
