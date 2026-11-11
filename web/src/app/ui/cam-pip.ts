import {
  Component,
  DestroyRef,
  afterNextRender,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { CamPrefs, PipBox } from '../core/cam-prefs';
import { ShareView } from '../core/room-session';
import { RoomStore } from '../core/room-store';

const MIN_W = 112;
const DRAG_SLOP = 4;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Câmera junto da tela, como picture-in-picture dentro do quadro da tela.
 * - Esconder/mostrar: a tecla de câmera na barra do palco (o mesmo lugar sempre).
 * - Clique: troca quem fica grande (a câmera vai para trás, a tela vira a janelinha).
 * - Arrastar: muda de lugar. Puxar o canto com as listrinhas: muda o tamanho, sem perder a proporção.
 * - Posição e tamanho ficam guardados neste navegador; valem só para você.
 */
@Component({
  selector: 'cen-cam-pip',
  imports: [],
  host: {
    '[class.dragging]': 'dragging()',
    '[style.left.px]': 'box().x',
    '[style.top.px]': 'box().y',
    '[style.width.px]': 'box().w',
    '[style.height.px]': 'box().h',
  },
  template: `
      <div
        class="win"
        [class.tuning]="tuning()"
        tabindex="0"
        role="button"
        [attr.aria-label]="
          'Janelinha: ' + inside() + '. Clique para trocar com a imagem grande, arraste para mover.'
        "
        (pointerdown)="onDown($event)"
        (pointermove)="onMove($event)"
        (pointerup)="onUp($event)"
        (pointercancel)="onCancel($event)"
        (keydown.enter)="swap()"
        (keydown.space)="$event.preventDefault(); swap()"
      >
        <video
          #video
          autoplay
          playsinline
          muted
          [class.mirror]="mirror()"
          (resize)="readAspect()"
        ></video>
        <div class="bar">
          <span class="led" [class.live]="!share().isLocal" [class.accent]="share().isLocal"></span>
          <span class="name">{{ inside() }}</span>
          <button
            type="button"
            class="key"
            title="Trocar com a imagem grande"
            (pointerdown)="$event.stopPropagation()"
            (click)="swap()"
          >
            <svg
              viewBox="0 0 24 24"
              width="13"
              height="13"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="square"
            >
              <path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5" />
            </svg>
          </button>
        </div>
        <span
          class="grip"
          [attr.data-corner]="gripCorner()"
          title="Arraste para mudar o tamanho"
          (pointerdown)="onGrip($event)"
          (pointermove)="onMove($event)"
          (pointerup)="onUp($event)"
          (pointercancel)="onCancel($event)"
        ></span>
      </div>
  `,
  styles: `
    :host {
      position: absolute;
      z-index: 4;
      display: block;
      touch-action: none;
    }
    /* Monitorzinho com a mesma moldura dos monitores da grade; liga como tubo de TV. */
    .win {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
      border-radius: 2px;
      background: #000;
      cursor: pointer;
      box-shadow:
        0 0 0 1px #0b0b0c,
        0 0 0 3px #2a2a2b,
        0 0 0 4px #0b0b0c,
        0 10px 24px -10px #000;
      animation: crt-on 420ms var(--ease) both;
      outline: none;
    }
    .win:hover,
    .win:focus-visible {
      box-shadow:
        0 0 0 1px #0b0b0c,
        0 0 0 3px var(--accent),
        0 0 0 4px #0b0b0c,
        0 10px 24px -10px #000;
    }
    :host(.dragging) .win {
      cursor: grabbing;
      box-shadow:
        0 0 0 1px #0b0b0c,
        0 0 0 3px var(--accent-hi),
        0 0 0 4px #0b0b0c,
        0 18px 30px -12px #000;
    }
    video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      pointer-events: none;
    }
    video.mirror {
      transform: scaleX(-1);
    }
    /* Troca de canal: a imagem fecha numa faixa e abre de novo, em degraus, como TV antiga. */
    .win.tuning video {
      animation: tune 300ms steps(6) both;
    }
    @keyframes tune {
      0% {
        clip-path: inset(49% 0 49% 0);
        filter: brightness(2.2) contrast(1.6) grayscale(1);
      }
      55% {
        clip-path: inset(0 0 0 0);
        filter: brightness(1.4) contrast(1.2);
      }
      100% {
        clip-path: inset(0 0 0 0);
        filter: none;
      }
    }
    /* Faixa de cima como barra de título, só com o mouse por cima (para não tapar nada). */
    .bar {
      position: absolute;
      left: 0;
      right: 0;
      top: 0;
      display: flex;
      align-items: center;
      gap: 0.35rem;
      height: 22px;
      padding: 0 3px 0 7px;
      background: rgb(16 16 17 / 0.88);
      border-bottom: 1px solid #0b0b0c;
      opacity: 0;
      transform: translateY(-100%);
      transition:
        opacity 120ms,
        transform 160ms steps(3);
    }
    .win:hover .bar,
    .win:focus-within .bar {
      opacity: 1;
      transform: none;
    }
    :host(.dragging) .bar {
      opacity: 0;
    }
    .bar .led {
      width: 6px;
      height: 6px;
    }
    .name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 500 0.62rem/1 var(--mono);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text);
    }
    .key {
      width: 18px;
      height: 16px;
      display: grid;
      place-items: center;
      padding: 0;
      border: 1px solid #0b0b0c;
      border-radius: 2px;
      background: var(--plate);
      color: var(--muted);
      box-shadow: var(--key-shadow);
      cursor: pointer;
    }
    .key:hover {
      background: var(--plate-hi);
      color: var(--text);
    }
    .key:active {
      transform: translateY(1px);
      box-shadow: var(--key-pressed);
    }
    /* Canto de puxar do Windows 98: três listrinhas na diagonal, virado para o meio da tela. */
    .grip {
      position: absolute;
      width: 16px;
      height: 16px;
      opacity: 0;
      transition: opacity 120ms;
      background:
        linear-gradient(
          135deg,
          transparent 0 45%,
          #d8d3c6 45% 52%,
          #0b0b0c 52% 59%,
          transparent 59% 100%
        ),
        linear-gradient(
          135deg,
          transparent 0 65%,
          #d8d3c6 65% 72%,
          #0b0b0c 72% 79%,
          transparent 79% 100%
        ),
        linear-gradient(
          135deg,
          transparent 0 85%,
          #d8d3c6 85% 92%,
          #0b0b0c 92% 99%,
          transparent 99% 100%
        );
    }
    .grip[data-corner='br'] {
      right: 1px;
      bottom: 1px;
      cursor: nwse-resize;
    }
    .grip[data-corner='tl'] {
      left: 1px;
      top: 23px;
      cursor: nwse-resize;
      transform: rotate(180deg);
    }
    .grip[data-corner='tr'] {
      right: 1px;
      top: 23px;
      cursor: nesw-resize;
      transform: rotate(-90deg);
    }
    .grip[data-corner='bl'] {
      left: 1px;
      bottom: 1px;
      cursor: nesw-resize;
      transform: rotate(90deg);
    }
    .win:hover .grip,
    :host(.dragging) .grip {
      opacity: 1;
    }
    /* Toque: barra e canto sempre à vista, com área de dedo. */
    @media (hover: none) {
      .bar {
        opacity: 1;
        transform: none;
        height: 28px;
      }
      .key {
        width: 26px;
        height: 22px;
      }
      .grip {
        opacity: 1;
        width: 24px;
        height: 24px;
      }
      .grip[data-corner='tl'],
      .grip[data-corner='tr'] {
        top: 29px;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .win.tuning video {
        animation: none;
      }
    }
  `,
})
export class CamPip {
  /** A tela em foco (que tem câmera junto). */
  readonly share = input.required<ShareView>();
  /** Tamanho da imagem grande, para a janelinha ficar dentro do quadro dela (sem as faixas pretas). */
  readonly source = input<{ width: number; height: number }>({ width: 0, height: 0 });

  protected readonly store = inject(RoomStore);
  private readonly prefs = inject(CamPrefs);
  private readonly host = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');

  protected readonly big = this.store.focusedCamBig;
  /** O que aparece na janelinha: a câmera, ou a tela quando a câmera está grande. */
  protected readonly inside = computed(() => {
    const s = this.share();
    const who = s.isLocal ? 'sua' : `de ${s.ownerName}`;
    if (this.big()) return s.isLocal ? 'sua tela' : `tela ${who}`;
    const what = s.cam?.fromPhone ? 'câmera do celular' : 'câmera';
    return s.isLocal ? `sua ${what}` : `${what} ${who}`;
  });
  protected readonly mirror = computed(() => !this.big() && this.share().cam?.mirror === true);

  private readonly area = signal({ w: 0, h: 0 });
  private readonly aspect = signal(16 / 9);
  /** Posição enquanto arrasta (antes de guardar). */
  private readonly live = signal<PipBox | null>(null);
  protected readonly dragging = signal(false);
  protected readonly tuning = signal(false);

  /** O quadro da imagem grande dentro do palco (object-fit: contain). */
  private readonly bounds = computed<Rect>(() => {
    const { w: W, h: H } = this.area();
    const s = this.source();
    if (W === 0 || H === 0) return { x: 0, y: 0, w: W, h: H };
    if (s.width === 0 || s.height === 0) return { x: 0, y: 0, w: W, h: H };
    const k = Math.min(W / s.width, H / s.height);
    const w = s.width * k;
    const h = s.height * k;
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  });

  protected readonly box = computed<Rect>(() => this.place(this.live() ?? this.prefs.pip()));

  /** O canto de puxar fica virado para o meio da tela (o outro canto fica parado). */
  protected readonly gripCorner = computed(() => {
    const b = this.bounds();
    const r = this.box();
    const right = r.x + r.w / 2 < b.x + b.w / 2;
    const bottom = r.y + r.h / 2 < b.y + b.h / 2;
    return `${bottom ? 'b' : 't'}${right ? 'r' : 'l'}`;
  });

  private attached: { el: HTMLVideoElement; key: string } | null = null;
  private gesture: {
    id: number;
    kind: 'move' | 'resize';
    x: number;
    y: number;
    start: Rect;
    moved: boolean;
    anchor?: { x: number; y: number };
  } | null = null;

  constructor() {
    // O palco (elemento pai) só existe depois de desenhar: mede ele e acompanha o tamanho.
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const parent = this.host.parentElement;
      if (parent === null) return;
      const measure = () => this.area.set({ w: parent.clientWidth, h: parent.clientHeight });
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(parent);
      destroyRef.onDestroy(() => ro.disconnect());
    });
    destroyRef.onDestroy(() => this.release());
    // Liga o vídeo certo: a câmera, ou a tela quando a câmera foi para trás.
    effect(() => {
      const s = this.share();
      const big = this.big();
      const el = this.video()?.nativeElement;
      // Ainda não chegou (ou caiu): solta e espera o "pronto" da sala.
      if (el === undefined || s.cam === null || !(big ? s.ready : s.cam.ready)) {
        this.release();
        return;
      }
      const key = `${s.id}|${big ? 'main:' + s.trackSid : 'cam:' + s.cam.trackSid}`;
      if (this.attached?.key === key && this.attached.el === el) return;
      this.release();
      const ok = big ? this.store.attachFocused(el, 'main') : this.store.attachCam(s.id, el);
      if (!ok) return;
      el.muted = true;
      this.attached = { el, key };
    });
  }

  private release() {
    const a = this.attached;
    if (a === null) return;
    this.attached = null;
    const id = this.share().id;
    this.store.detachCam(id, a.el);
    this.store.detachShare(id, a.el);
  }

  readAspect() {
    const v = this.video()?.nativeElement;
    if (v !== undefined && v.videoWidth > 0 && v.videoHeight > 0)
      this.aspect.set(v.videoWidth / v.videoHeight);
  }

  /** Converte a posição guardada (frações do quadro) em pixels, sempre dentro do quadro. */
  private place(p: PipBox): Rect {
    const b = this.bounds();
    const a = this.aspect();
    const maxW = Math.max(MIN_W, Math.min(b.w * 0.75, b.h * 0.85 * a));
    const w = Math.min(maxW, Math.max(MIN_W, p.w * b.w));
    const h = w / a;
    const x = b.x + Math.min(Math.max(0, p.x * b.w), Math.max(0, b.w - w));
    const y = b.y + Math.min(Math.max(0, p.y * b.h), Math.max(0, b.h - h));
    return { x, y, w, h };
  }

  /** O contrário de place(): pixels para frações do quadro. */
  private toBox(r: Rect): PipBox {
    const b = this.bounds();
    const f = (n: number) => Math.min(1, Math.max(0, n));
    return {
      x: f((r.x - b.x) / Math.max(1, b.w)),
      y: f((r.y - b.y) / Math.max(1, b.h)),
      w: f(r.w / Math.max(1, b.w)),
    };
  }

  onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.gesture = {
      id: e.pointerId,
      kind: 'move',
      x: e.clientX,
      y: e.clientY,
      start: this.box(),
      moved: false,
    };
  }

  onGrip(e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const r = this.box();
    const c = this.gripCorner();
    // O canto oposto ao que está sendo puxado fica parado.
    const anchor = { x: c.endsWith('r') ? r.x : r.x + r.w, y: c.startsWith('b') ? r.y : r.y + r.h };
    this.gesture = {
      id: e.pointerId,
      kind: 'resize',
      x: e.clientX,
      y: e.clientY,
      start: r,
      moved: false,
      anchor,
    };
  }

  onMove(e: PointerEvent) {
    const g = this.gesture;
    if (g === null || g.id !== e.pointerId) return;
    e.stopPropagation();
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    g.moved = true;
    this.dragging.set(true);
    if (g.kind === 'move') {
      this.live.set(this.toBox({ ...g.start, x: g.start.x + dx, y: g.start.y + dy }));
      return;
    }
    // Redimensiona pela maior distância (largura ou altura), mantendo a proporção da imagem.
    const a = this.aspect();
    const parent = this.host.parentElement?.getBoundingClientRect();
    const px = e.clientX - (parent?.left ?? 0);
    const py = e.clientY - (parent?.top ?? 0);
    const anchor = g.anchor!;
    const b = this.bounds();
    const room = {
      w: px >= anchor.x ? b.x + b.w - anchor.x : anchor.x - b.x,
      h: py >= anchor.y ? b.y + b.h - anchor.y : anchor.y - b.y,
    };
    const w = Math.max(
      MIN_W,
      Math.min(Math.max(Math.abs(px - anchor.x), Math.abs(py - anchor.y) * a), room.w, room.h * a),
    );
    const h = w / a;
    const x = px >= anchor.x ? anchor.x : anchor.x - w;
    const y = py >= anchor.y ? anchor.y : anchor.y - h;
    this.live.set(this.toBox({ x, y, w, h }));
  }

  onUp(e: PointerEvent) {
    const g = this.gesture;
    if (g === null || g.id !== e.pointerId) return;
    e.stopPropagation();
    this.gesture = null;
    this.dragging.set(false);
    const moved = this.live();
    this.live.set(null);
    if (g.moved && moved !== null && this.bounds().w > 0) this.prefs.setPip(moved);
    else if (!g.moved && g.kind === 'move') this.swap();
  }

  onCancel(e: PointerEvent) {
    if (this.gesture?.id !== e.pointerId) return;
    this.gesture = null;
    this.dragging.set(false);
    this.live.set(null);
  }

  swap() {
    this.tuning.set(true);
    window.setTimeout(() => this.tuning.set(false), 320);
    this.store.setCamBig(this.share().id, !this.big());
  }

}
