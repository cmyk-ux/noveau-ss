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
 * Canto de baixo à esquerda do palco: a foto de cada pessoa com a tela aberta. Clicar põe a tela
 * dela em foco; parar o mouse em cima mostra uma prévia ao vivo (na cópia menor, só enquanto o
 * mouse está ali, para não gastar banda nem processador à toa).
 */
@Component({
  selector: 'cen-live-strip',
  imports: [PixelIcon],
  template: `
    @if (faces().length > 0) {
      <div class="rail" role="toolbar" aria-label="Quem está com a tela aberta">
        <span class="legend mono" aria-hidden="true"><span class="led live"></span>no ar</span>
        @for (f of faces(); track f.share.id) {
          <button type="button" class="face" [class.focused]="f.share.id === focusedId()" [class.hidden]="f.share.hidden"
            [class.mine]="f.share.isLocal" [attr.aria-label]="label(f)" [attr.aria-pressed]="f.share.id === focusedId()"
            [title]="isMobile ? label(f) : ''"
            (click)="pick(f)" (pointerenter)="hover(f, $event)" (pointerleave)="leave()" (focus)="hover(f, $event)" (blur)="leave()">
            @if (f.avatar) { <img [src]="f.avatar" alt="" width="34" height="34" draggable="false" /> }
            @else if (f.share.obs || f.share.isIngress) { <span class="glyph"><cen-pixel [name]="f.icon" [size]="18" /></span> }
            @else { <b>{{ initial(f.name) }}</b> }
            <span class="src" aria-hidden="true"><cen-pixel [name]="f.icon" [size]="9" /></span>
            <span class="lamp led live" aria-hidden="true"></span>
          </button>
        }
      </div>
    }
    @if (preview(); as p) {
      <div class="card panel-surface" role="tooltip" [style.left.px]="p.x" (pointerenter)="overCard = true; keep()"
        (pointerleave)="overCard = false; leave()" (focusin)="keep()" (focusout)="leave()">
        <div class="head">
          <span class="onair mono" [class.mine]="p.face.share.isLocal">{{ p.face.share.isLocal ? 'enviando' : 'ao vivo' }}</span>
          <strong>{{ p.face.share.isLocal ? 'Sua tela' : p.face.name }}</strong>
        </div>
        <div class="screen" (click)="pick(p.face)">
          <video #pv autoplay playsinline muted (playing)="tuned.set(true)" (loadeddata)="tuned.set(true)"></video>
          @if (!tuned()) { <div class="snow" aria-hidden="true"><span class="mono">sintonizando</span></div> }
        </div>
        <div class="act">
          <cen-pixel [name]="p.face.icon" [size]="11" />
          <span class="what">{{ p.face.line || (p.face.share.kind === 'camera' ? 'câmera' : 'tela') }}</span>
          @if (p.face.share.hidden) { <span class="tag">escondida</span> }
        </div>
        @if (p.face.share.id !== focusedId()) {
          <p class="foot mono">clique para assistir</p>
        }
      </div>
    }
  `,
  styles: `
    :host { position: absolute; left: 1rem; bottom: 1rem; z-index: 7; display: block; pointer-events: none; }
    .rail, .card { pointer-events: auto; }

    /* Régua de metal com uma foto por tela aberta, como as teclas de canal de uma mesa de corte. */
    .rail { display: flex; align-items: center; gap: 6px; padding: 5px 7px 7px; border-radius: 3px;
      background: rgb(22 22 23 / 0.88); border: 1px solid #0b0b0c;
      box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.05), 0 6px 18px -8px #000; animation: rail-in 260ms steps(5) both; }
    .legend { display: inline-flex; align-items: center; gap: 0.35rem; margin-right: 2px; font-size: 0.56rem;
      letter-spacing: 0.18em; text-transform: uppercase; color: var(--faint); writing-mode: vertical-rl; rotate: 180deg; }
    .legend .led { width: 5px; height: 5px; }

    /* Foto numa tecla: sobe com aresta, afunda quando é a tela em foco. */
    .face { position: relative; width: 42px; height: 42px; padding: 3px; border-radius: 2px; border: 1px solid #0b0b0c;
      background: var(--plate); box-shadow: var(--key-shadow); display: grid; place-items: center; color: var(--muted);
      transition: transform 60ms linear, box-shadow 60ms linear, background 120ms; animation: face-in 380ms var(--ease) both; }
    .face:hover { background: var(--plate-hi); }
    .face:active { transform: translateY(2px); box-shadow: var(--key-pressed); }
    .face.focused { transform: translateY(2px); box-shadow: var(--key-pressed); background: #2f2f30; }
    .face img, .face b, .face .glyph { width: 34px; height: 34px; border-radius: 1px; object-fit: cover; display: grid; place-items: center;
      background: var(--well); }
    .face b { font: 500 0.9rem/1 var(--mono); text-transform: uppercase; color: var(--text); }
    .face.focused img, .face.focused b, .face.focused .glyph { outline: 1px solid var(--accent-hi); outline-offset: 1px; }
    .face.hidden img, .face.hidden b { filter: grayscale(1); opacity: 0.45; }
    .face.hidden .lamp { background: var(--led-off); box-shadow: inset 0 1px 1px #000a; animation: none; }
    /* Lâmpada de "no ar" no canto e o selo da fonte (tela, janela, aba) embaixo. */
    .lamp { position: absolute; top: 3px; right: 3px; width: 5px; height: 5px; }
    .mine .lamp { background: var(--accent-hi); box-shadow: 0 0 0 1px #0008, 0 0 4px var(--accent-glow); }
    .src { position: absolute; right: -3px; bottom: -3px; width: 15px; height: 15px; display: grid; place-items: center;
      border-radius: 1px; background: #111110; border: 1px solid #0b0b0c; color: var(--text); }

    /* Prévia: janela que abre em degraus (Win98) e "sintoniza" antes da imagem chegar. */
    .card { position: absolute; bottom: calc(100% + 8px); width: 272px; padding: 0.5rem 0.55rem 0.55rem;
      animation: win-zoom 150ms steps(4) both; transform-origin: bottom left; }
    .head { display: flex; align-items: center; gap: 0.45rem; margin-bottom: 0.4rem; min-width: 0; }
    .head strong { font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .onair { font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.14em; color: #fff; background: var(--danger);
      padding: 2px 5px; border-radius: 1px; flex-shrink: 0; }
    .onair.mine { background: var(--accent); }
    .screen { position: relative; aspect-ratio: 16 / 9; background: #000; border-radius: 2px; overflow: hidden; cursor: pointer;
      box-shadow: 0 0 0 1px #0b0b0c, inset 0 0 0 1px rgb(255 255 255 / 0.04); }
    .screen video { width: 100%; height: 100%; object-fit: contain; display: block; animation: crt-on 320ms var(--ease) both; }
    .snow { position: absolute; inset: 0; display: grid; place-items: center; background-color: #1a1a1b;
      background-image: var(--grain), var(--grain); background-size: 120px 120px, 77px 77px; animation: snow 240ms steps(4) infinite; }
    .snow span { font-size: 0.6rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--muted); background: rgb(0 0 0 / 0.6);
      padding: 2px 6px; animation: blink 1.2s steps(1) infinite; }
    .act { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.45rem; color: var(--accent-hi); min-width: 0; }
    .what { font: 500 0.72rem/1.2 var(--mono); letter-spacing: 0.04em; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .foot { margin: 0.35rem 0 0; font-size: 0.6rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint); }

    /* Régua entra como uma gaveta saindo do painel, em degraus. */
    @keyframes rail-in { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
    /* Foto nova: acende como um monitor de tubo. */
    @keyframes face-in { 0% { filter: brightness(2.5); transform: scale(1, 0.1); } 50% { transform: scale(1, 0.1); } 100% { filter: none; transform: none; } }
    @keyframes snow { 0% { background-position: 0 0, 0 0; } 25% { background-position: 37px 11px, -23px 41px; }
      50% { background-position: -19px 53px, 61px -7px; } 75% { background-position: 71px -29px, 13px 19px; } 100% { background-position: 0 0, 0 0; } }

    @media (hover: none) {
      :host { left: 0.6rem; bottom: 0.6rem; }
      .face { width: 46px; height: 46px; }
    }
  `,
})
export class LiveStrip {
  protected readonly store = inject(RoomStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly isMobile = IS_MOBILE;

  protected readonly focusedId = computed(() => this.store.focused()?.id ?? null);

  /** Todas as telas abertas (inclusive as escondidas, apagadas), a minha por último. */
  protected readonly faces = computed<Face[]>(() => {
    const people = new Map(this.store.participants().map((p) => [p.identity, p]));
    const all = [...this.store.shares(), ...this.store.hiddenShares()];
    all.sort((a, b) => Number(a.isLocal) - Number(b.isLocal));
    return all.map((s) => ({
      share: s,
      name: s.ownerName,
      avatar: s.obs || s.isIngress ? null : (people.get(s.ownerIdentity)?.avatar ?? null),
      icon: iconFor(s),
      line: activityLine(s.activity),
    }));
  });

  private readonly hoverId = signal<{ id: string; x: number } | null>(null);
  /** A prévia segue os dados da tela (atividade, escondida) enquanto está aberta. */
  protected readonly preview = computed(() => {
    const h = this.hoverId();
    const face = h === null ? undefined : this.faces().find((f) => f.share.id === h.id);
    return face === undefined || h === null ? null : { face, x: h.x };
  });
  protected readonly tuned = signal(false);
  private readonly pv = viewChild<ElementRef<HTMLVideoElement>>('pv');
  private attached: { id: string; el: HTMLVideoElement; track: string } | null = null;
  private openTimer?: number;
  private closeTimer?: number;

  constructor() {
    // Liga a prévia quando o vídeo aparece; troca se o mouse passou para outra foto.
    effect(() => {
      const p = this.preview();
      const el = this.pv()?.nativeElement;
      const want = p === null || el === undefined ? null : { id: p.face.share.id, el, track: p.face.share.trackSid };
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
    const who = f.share.isLocal ? 'Sua tela' : `${f.share.kind === 'camera' ? 'Câmera' : 'Tela'} de ${f.name}`;
    return `${who}${f.line ? ' · ' + f.line : ''}${f.share.hidden ? ' (escondida)' : ''}`;
  }

  pick(f: Face) {
    window.clearTimeout(this.openTimer);
    if (f.share.hidden) this.store.showShare(f.share.id);
    this.store.focusShare(f.share.id);
    this.overCard = false;
    this.hoverId.set(null);
  }

  hover(f: Face, e: Event) {
    if (this.isMobile) return;
    window.clearTimeout(this.closeTimer);
    window.clearTimeout(this.openTimer);
    const btn = e.currentTarget as HTMLElement;
    const x = btn.getBoundingClientRect().left - this.host.nativeElement.getBoundingClientRect().left;
    const open = () => {
      this.hoverId.set({ id: f.share.id, x: Math.max(0, x - 8) });
    };
    // Já tem uma prévia aberta: troca na hora, como passar o dedo pelos canais.
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
    }, CLOSE_MS);
  }

}
