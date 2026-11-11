import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { activityLine } from '../core/activity';
import { IS_MOBILE } from '../core/device';
import { ShareView } from '../core/room-session';
import { RoomStore } from '../core/room-store';
import { PixelIcon } from './pixel-icon';

interface Face {
  share: ShareView;
  name: string;
  avatar: string | null;
  icon: string;
  line: string;
}

const OPEN_MS = 220;
const CLOSE_MS = 180;

function iconFor(s: ShareView): string {
  switch (s.activity.surface) {
    case 'window':
      return 'window';
    case 'browser':
      return 'tab';
    case 'camera':
      return 'webcam';
    case 'obs':
      return 'obs';
    default:
      return s.kind === 'camera' ? 'webcam' : 'monitor';
  }
}

/**
 * Teclas de "no ar" na barra de baixo, ao lado do microfone e da tela.
 *
 * - A minha tela: uma tecla "prévia". Fechada por padrão: mostrar a própria tela grande custava
 *   ~0,6 núcleo a mais para quem transmite. Aberta, é uma cópia em 360p a 15 fps (quase de graça).
 * - A tela de cada pessoa: a foto dela. Clicar põe em foco. Parar o mouse mostra o nome e o que
 *   ela está passando, sem vídeo; o vídeo ao vivo (cópia menor) só liga se você pedir.
 */
@Component({
  selector: 'cen-live-strip',
  imports: [PixelIcon],
  host: { '[class.empty]': 'mine() === null && faces().length === 0' },
  template: `
    @if (mine(); as m) {
      <button type="button" class="btn mine-key" [class.on]="mineOpen()" [attr.aria-expanded]="mineOpen()"
        [title]="mineOpen() ? 'Fechar a prévia da sua tela' : 'Ver a prévia da sua tela (leve: 360p a 15 fps)'"
        (click)="toggleMine()">
        <span class="led accent" aria-hidden="true"></span>
        <cen-pixel [name]="m.kind === 'camera' ? 'webcam' : 'monitor'" [size]="16" />
        <span class="mono word">prévia</span>
      </button>
    }
    @if (faces().length > 0 && showFaces()) {
      <div class="rail" role="toolbar" aria-label="Quem está com a tela aberta">
        @for (f of faces(); track f.share.id) {
          <button type="button" class="face" [class.focused]="f.share.id === focusedId()" [class.hidden]="f.share.hidden"
            [attr.aria-label]="label(f)" [attr.aria-pressed]="f.share.id === focusedId()" [title]="isMobile ? label(f) : ''"
            (click)="pick(f)" (pointerenter)="hover(f, $event)" (pointerleave)="leave()" (focus)="hover(f, $event)" (blur)="leave()">
            @if (f.avatar) { <img [src]="f.avatar" alt="" width="26" height="26" draggable="false" /> }
            @else if (f.share.obs || f.share.isIngress) { <span class="glyph"><cen-pixel [name]="f.icon" [size]="16" /></span> }
            @else { <b>{{ initial(f.name) }}</b> }
            <span class="src" aria-hidden="true"><cen-pixel [name]="f.icon" [size]="8" /></span>
            <span class="lamp led bad" aria-hidden="true"></span>
          </button>
        }
      </div>
    }

    @if (mineOpen() && mine(); as m) {
      <div class="card panel-surface" role="dialog" aria-label="Prévia da sua tela" [style.left.px]="0">
        <div class="head">
          <span class="onair mono mine">enviando</span>
          <strong>{{ m.kind === 'camera' ? 'Sua câmera' : 'Sua tela' }}</strong>
          <button type="button" class="close" title="Fechar" (click)="mineOpen.set(false)">×</button>
        </div>
        <div class="screen">
          <video #mv autoplay playsinline muted [class.mirror]="m.mirror" (playing)="mineTuned.set(true)"></video>
          @if (!mineTuned()) { <div class="snow" aria-hidden="true"><span class="mono">sintonizando</span></div> }
        </div>
        <div class="swap">
          <button type="button" class="btn small" [class.on]="store.myOnStage()" [attr.aria-pressed]="store.myOnStage()"
            title="Mostrar a sua tela grande no palco, como as dos outros (pesa um pouco mais no seu PC)"
            (click)="toggleStage()">{{ store.myOnStage() ? 'tirar do palco' : 'ver grande no palco' }}</button>
        </div>
        <p class="foot">Prévia leve, só para você conferir. Quem assiste recebe na qualidade cheia.
          @if (m.cam !== null) { A sua câmera fica no cantinho <b>você</b> do palco. }</p>
      </div>
    }

    @if (preview(); as p) {
      <div class="card panel-surface" role="tooltip" [style.left.px]="p.x" (pointerenter)="overCard = true; keep()"
        (pointerleave)="overCard = false; leave()" (focusin)="keep()" (focusout)="leave()">
        <div class="head">
          <span class="onair mono">ao vivo</span>
          <strong>{{ p.face.name }}</strong>
        </div>
        @if (live()) {
          <div class="screen" (click)="pick(p.face)">
            <video #pv autoplay playsinline muted (playing)="tuned.set(true)" (loadeddata)="tuned.set(true)"></video>
            @if (!tuned()) { <div class="snow" aria-hidden="true"><span class="mono">sintonizando</span></div> }
          </div>
        }
        <div class="act">
          <cen-pixel [name]="p.face.icon" [size]="11" />
          <span class="what">{{ p.face.line || (p.face.share.kind === 'camera' ? 'câmera' : 'tela') }}</span>
          @if (p.face.share.hidden) { <span class="tag">escondida</span> }
        </div>
        <div class="row">
          @if (!live() && p.face.share.id !== focusedId() && !p.face.share.hidden) {
            <button type="button" class="btn small" (click)="live.set(true)">▶ prévia ao vivo</button>
          }
          @if (p.face.share.id !== focusedId()) {
            <button type="button" class="btn small primary" (click)="pick(p.face)">assistir</button>
          }
        </div>
      </div>
    }
  `,
  styles: `
    :host { position: relative; display: inline-flex; align-items: center; gap: 0.5rem; }
    :host(.empty) { display: none; }

    .mine-key { gap: 0.4rem; padding: 0 0.6rem; }
    .mine-key .led { width: 6px; height: 6px; }
    .mine-key .word { font-size: 0.66rem; letter-spacing: 0.12em; text-transform: uppercase; }

    /* Fotos como teclas de canal de uma mesa de corte, embutidas na barra. */
    .rail { display: flex; align-items: center; gap: 4px; }
    .face { position: relative; width: 34px; height: 34px; padding: 3px; border-radius: 2px; border: 1px solid #0b0b0c;
      background: var(--plate); box-shadow: var(--key-shadow); display: grid; place-items: center; color: var(--muted);
      transition: transform 60ms linear, box-shadow 60ms linear, background 120ms; }
    .face:hover { background: var(--plate-hi); }
    .face:active { transform: translateY(2px); box-shadow: var(--key-pressed); }
    .face.focused { transform: translateY(2px); box-shadow: var(--key-pressed); background: #2f2f30; }
    .face img, .face b, .face .glyph { width: 26px; height: 26px; border-radius: 1px; object-fit: cover; display: grid; place-items: center;
      background: var(--well); }
    .face b { font: 500 0.8rem/1 var(--mono); text-transform: uppercase; color: var(--text); }
    .face.focused img, .face.focused b, .face.focused .glyph { outline: 1px solid var(--accent-hi); outline-offset: 1px; }
    .face.hidden img, .face.hidden b { filter: grayscale(1); opacity: 0.45; }
    .face.hidden .lamp { background: var(--led-off); box-shadow: inset 0 1px 1px #000a; }
    /* Lâmpada fixa (sem piscar: animação infinita acorda a página à toa). */
    .lamp { position: absolute; top: 2px; right: 2px; width: 4px; height: 4px; }
    .src { position: absolute; right: -3px; bottom: -3px; width: 13px; height: 13px; display: grid; place-items: center;
      border-radius: 1px; background: #111110; border: 1px solid #0b0b0c; color: var(--text); }

    /* Janelinha que abre da barra em degraus (Win98). */
    .card { position: absolute; bottom: calc(100% + 14px); width: 272px; padding: 0.5rem 0.55rem 0.55rem; z-index: 25;
      animation: win-zoom 150ms steps(4) both; transform-origin: bottom left; }
    .head { display: flex; align-items: center; gap: 0.45rem; margin-bottom: 0.4rem; min-width: 0; }
    .head strong { font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .head .close { background: none; border: 0; color: var(--muted); font-size: 1rem; line-height: 1; padding: 2px 4px; cursor: pointer; }
    .head .close:hover { color: var(--text); }
    .onair { font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.14em; color: #fff; background: var(--danger);
      padding: 2px 5px; border-radius: 1px; flex-shrink: 0; }
    .onair.mine { background: var(--accent); }
    .screen { position: relative; aspect-ratio: 16 / 9; background: #000; border-radius: 2px; overflow: hidden; cursor: pointer;
      box-shadow: 0 0 0 1px #0b0b0c, inset 0 0 0 1px rgb(255 255 255 / 0.04); }
    .screen video { width: 100%; height: 100%; object-fit: contain; display: block; animation: crt-on 320ms var(--ease) both; }
    .screen video.mirror { transform: scaleX(-1); }
    /* Chuvisco parado (uma imagem só) enquanto o vídeo não chega. */
    .snow { position: absolute; inset: 0; display: grid; place-items: center; background-color: #1a1a1b;
      background-image: var(--grain), var(--grain); background-size: 120px 120px, 77px 77px; }
    .snow span { font-size: 0.6rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--muted); background: rgb(0 0 0 / 0.6);
      padding: 2px 6px; }
    .act { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.45rem; color: var(--accent-hi); min-width: 0; }
    .what { font: 500 0.72rem/1.2 var(--mono); letter-spacing: 0.04em; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row { display: flex; gap: 0.35rem; margin-top: 0.45rem; }
    .row:empty { display: none; }
    .swap { display: flex; gap: 0.35rem; margin-top: 0.45rem; }
    .foot { margin: 0.4rem 0 0; font-size: 0.72rem; color: var(--faint); line-height: 1.3; }

    @media (hover: none) {
      .face { width: 44px; height: 44px; }
      .face img, .face b, .face .glyph { width: 36px; height: 36px; }
      .mine-key { height: 48px; }
      .mine-key .word { display: none; }
      .card { position: fixed; left: 0.5rem !important; right: 0.5rem; width: auto; bottom: calc(4.6rem + env(safe-area-inset-bottom)); }
    }
  `,
})
export class LiveStrip {
  protected readonly store = inject(RoomStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly isMobile = IS_MOBILE;

  protected readonly focusedId = computed(() => this.store.focused()?.id ?? null);
  protected readonly mine = this.store.myShare;

  /** Telas dos outros (inclusive as escondidas, apagadas). A minha tem a tecla "prévia". */
  protected readonly faces = computed<Face[]>(() => {
    // Só as fotos (não muda quando alguém começa a falar).
    const avatars = this.store.avatars();
    const all = [...this.store.stageShares(), ...this.store.hiddenShares()].filter((s) => !s.isLocal);
    return all.map((s) => ({
      share: s,
      name: s.ownerName,
      avatar: s.obs || s.isIngress ? null : (avatars.get(s.ownerIdentity) ?? null),
      icon: iconFor(s),
      line: activityLine(s.activity),
    }));
  });
  /** Uma tela só, já em foco: a foto não acrescenta nada. */
  protected readonly showFaces = computed(() => {
    const f = this.faces();
    return !(f.length === 1 && f[0].share.id === this.focusedId() && !f[0].share.hidden);
  });

  // ---------- prévia da minha tela
  protected readonly mineOpen = signal(false);
  protected readonly mineTuned = signal(false);
  private readonly mv = viewChild<ElementRef<HTMLVideoElement>>('mv');

  // ---------- cartão de quem está no ar
  private readonly hoverId = signal<{ id: string; x: number } | null>(null);
  protected readonly preview = computed(() => {
    const h = this.hoverId();
    const face = h === null ? undefined : this.faces().find((f) => f.share.id === h.id);
    return face === undefined || h === null ? null : { face, x: h.x };
  });
  /** O vídeo ao vivo no cartão só liga quando a pessoa pede. */
  protected readonly live = signal(false);
  protected readonly tuned = signal(false);
  private readonly pv = viewChild<ElementRef<HTMLVideoElement>>('pv');
  private attached: { id: string; el: HTMLVideoElement; track: string } | null = null;
  private openTimer?: number;
  private closeTimer?: number;

  constructor() {
    // Minha prévia: liga a cópia leve quando a janelinha abre, desliga ao fechar.
    effect((onCleanup) => {
      const el = this.mv()?.nativeElement;
      const m = this.mine();
      if (el === undefined || m === null || !this.mineOpen()) return;
      const which = 'main';
      void m.trackSid;
      this.mineTuned.set(false);
      const stop = this.store.startLocalPreview(el, which);
      onCleanup(stop);
    });
    // Parou de transmitir: a janelinha fecha.
    effect(() => {
      if (this.mine() === null) this.mineOpen.set(false);
    });
    // Vídeo ao vivo de outra pessoa, só com o pedido.
    effect(() => {
      const p = this.preview();
      const el = this.pv()?.nativeElement;
      const want =
        p === null || el === undefined || !this.live() || !p.face.share.ready ? null : { id: p.face.share.id, el, track: p.face.share.trackSid };
      const cur = this.attached;
      if (cur !== null && want !== null && cur.id === want.id && cur.el === want.el && cur.track === want.track) return;
      if (cur !== null) this.store.stopPreview(cur.id, cur.el);
      this.attached = null;
      if (want === null) return;
      this.tuned.set(false);
      if (this.store.startPreview(want.id, want.el)) this.attached = want;
    });
    inject(DestroyRef).onDestroy(() => {
      window.clearTimeout(this.openTimer);
      window.clearTimeout(this.closeTimer);
      if (this.attached !== null) this.store.stopPreview(this.attached.id, this.attached.el);
    });
  }

  initial(name: string): string {
    return [...name.trim()][0] ?? '?';
  }

  label(f: Face): string {
    const who = `${f.share.kind === 'camera' ? 'Câmera' : 'Tela'} de ${f.name}`;
    return `${who}${f.line ? ' · ' + f.line : ''}${f.share.hidden ? ' (escondida)' : ''}`;
  }

  toggleStage() {
    const on = !this.store.myOnStage();
    this.store.setMyOnStage(on);
    // No palco, a prévia pequena não precisa ficar aberta também.
    if (on) {
      this.mineOpen.set(false);
      const m = this.mine();
      if (m !== null) this.store.focusShare(m.id);
    }
  }

  toggleMine() {
    this.hoverId.set(null);
    this.mineOpen.update((v) => !v);
  }

  pick(f: Face) {
    window.clearTimeout(this.openTimer);
    if (f.share.hidden) this.store.showShare(f.share.id);
    this.store.focusShare(f.share.id);
    this.overCard = false;
    this.hoverId.set(null);
    this.live.set(false);
  }

  hover(f: Face, e: Event) {
    if (this.isMobile) return;
    window.clearTimeout(this.closeTimer);
    window.clearTimeout(this.openTimer);
    const btn = e.currentTarget as HTMLElement;
    const x = btn.getBoundingClientRect().left - this.host.nativeElement.getBoundingClientRect().left;
    const open = () => {
      if (this.hoverId()?.id !== f.share.id) this.live.set(false);
      this.mineOpen.set(false);
      this.hoverId.set({ id: f.share.id, x: Math.max(-120, x - 8) });
    };
    if (this.hoverId() !== null) open();
    else this.openTimer = window.setTimeout(open, OPEN_MS);
  }

  protected overCard = false;

  keep() {
    window.clearTimeout(this.closeTimer);
  }

  leave() {
    window.clearTimeout(this.openTimer);
    window.clearTimeout(this.closeTimer);
    this.closeTimer = window.setTimeout(() => {
      if (this.overCard) return;
      this.hoverId.set(null);
      this.live.set(false);
    }, CLOSE_MS);
  }
}
