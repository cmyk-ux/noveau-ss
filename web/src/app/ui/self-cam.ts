import { Component, ElementRef, HostListener, computed, effect, inject, signal, viewChild } from '@angular/core';
import { CamPrefs } from '../core/cam-prefs';
import { PreviewSize } from '../core/room-session';
import { RoomStore } from '../core/room-store';
import { Icon } from './icon';

const MIN_W = 112;
const MAX_W = 720;

/**
 * Retorno da própria câmera: um monitorzinho no canto de cima do palco, para você se ver.
 * - No formato da câmera de verdade (4:3, 16:9, celular em pé), sem cortar nada.
 * - Puxe o canto com as listrinhas para aumentar; clique para ver em tela cheia (clique de novo, ou Esc, volta).
 * - A cópia acompanha o tamanho: pequena 360p 15 fps, maior 720p 30 fps, tela cheia até 1080p 30 fps.
 * - "Parar de ver" desliga a cópia de verdade (nada é decodificado nem desenhado). Fica guardado.
 */
@Component({
  selector: 'cen-self-cam',
  imports: [Icon],
  host: { '[class.full]': 'full()', '[class.sizing]': 'sizing()' },
  template: `
    <!-- Com a sua tela em foco no palco, a sua câmera já aparece na janelinha dela. -->
    @if (!mineFocused() && store.selfCam(); as me) {
      @if (prefs.selfView()) {
        <div class="win" role="button" tabindex="0" [style.width.px]="full() ? null : width()"
          [style.aspect-ratio]="full() ? null : aspect()"
          [attr.aria-label]="full() ? 'Sua câmera em tela cheia. Clique para voltar.' : 'Sua câmera. Clique para ver em tela cheia.'"
          [title]="full() ? 'Clique para voltar ao cantinho' : 'Clique para ver em tela cheia'"
          (click)="toggleFull()" (keydown.enter)="toggleFull()">
          <video #v autoplay playsinline muted [class.mirror]="me.mirror" (playing)="tuned.set(true)" (resize)="readAspect()"></video>
          @if (!tuned()) {
            <span class="snow" aria-hidden="true"><span class="mono">sintonizando</span></span>
          }
          <div class="plate" (click)="$event.stopPropagation()">
            <span class="led accent" aria-hidden="true"></span>
            <span class="mono">você{{ me.fromPhone ? ' · celular' : '' }}</span>
            @if (full()) {
              <button type="button" class="key" title="Voltar ao cantinho (Esc)" (click)="full.set(false)">
                <cen-icon name="fullscreenExit" [size]="12" />
              </button>
            }
            <button type="button" class="key" [class.lit]="prefs.mirror()"
              [title]="prefs.mirror() ? 'Espelhado, como num espelho. Clique para ver como os outros veem.' : 'Como os outros veem. Clique para espelhar.'"
              [attr.aria-pressed]="prefs.mirror()" (click)="prefs.setMirror(!prefs.mirror())">
              <cen-icon name="mirror" [size]="12" />
            </button>
            <button type="button" class="key" title="Parar de ver a sua câmera (não pesa no PC; quem assiste continua vendo)"
              (click)="stop()">
              <cen-icon name="eyeOff" [size]="12" />
            </button>
          </div>
          @if (!full()) {
            <span class="grip" title="Arraste para mudar o tamanho" (click)="$event.stopPropagation()"
              (pointerdown)="onGrip($event)" (pointermove)="onMove($event)" (pointerup)="onUp($event)" (pointercancel)="onUp($event)"></span>
          }
        </div>
      } @else {
        <button type="button" class="btn small chip" title="Ver a sua câmera (cópia leve, só para você)" (click)="prefs.setSelfView(true)">
          <cen-icon name="camera" [size]="14" /> você
        </button>
      }
    }
  `,
  styles: `
    :host { position: absolute; left: 1rem; top: 1rem; z-index: 4; display: block; }
    /* Tela cheia: ocupa o palco todo, como a câmera de outra pessoa quando você clica nela. */
    :host(.full) { inset: 0; z-index: 7; background: #000; }
    .win { position: relative; background: #000; border-radius: 2px; overflow: hidden; cursor: zoom-in;
      box-shadow: 0 0 0 1px #0b0b0c, 0 0 0 3px #2a2a2b, 0 0 0 4px #0b0b0c, 0 10px 24px -10px #000;
      animation: crt-on 420ms var(--ease) both; }
    :host(.full) .win { width: 100%; height: 100%; border-radius: 0; box-shadow: none; cursor: zoom-out; animation: win-zoom 180ms steps(5) both; }
    :host(.sizing) .win { cursor: nwse-resize; }
    video { width: 100%; height: 100%; object-fit: contain; display: block; pointer-events: none; }
    video.mirror { transform: scaleX(-1); }
    .snow { position: absolute; inset: 0; display: grid; place-items: center;
      background: repeating-linear-gradient(0deg, #1a1a1b 0 2px, #0e0e0f 2px 4px); }
    .snow .mono { font-size: 0.58rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--faint);
      animation: blink 1.2s steps(1) infinite; }
    /* Plaqueta com o nome, como nos monitores da grade; os botões aparecem com o mouse em cima. */
    .plate { position: absolute; left: 5px; bottom: 5px; display: flex; align-items: center; gap: 0.35rem; padding: 2px 3px 2px 6px;
      border-radius: 3px; background: rgb(8 7 11 / 0.82); border: 1px solid rgb(255 255 255 / 0.08); cursor: default;
      font-size: 0.6rem; letter-spacing: 0.1em; text-transform: uppercase; }
    :host(.full) .plate { left: 12px; bottom: 12px; font-size: 0.68rem; }
    .plate .led { width: 6px; height: 6px; }
    .key { width: 18px; height: 16px; display: none; place-items: center; padding: 0; border: 1px solid #0b0b0c; border-radius: 2px;
      background: var(--plate); color: var(--muted); box-shadow: var(--key-shadow); cursor: pointer; }
    .key:hover { background: var(--plate-hi); color: var(--text); }
    .key.lit { color: var(--accent); }
    .key:active { transform: translateY(1px); box-shadow: var(--key-pressed); }
    .win:hover .key, .win:focus-within .key, :host(.full) .key { display: grid; }
    /* Canto de puxar do Windows 98, embaixo à direita (o de cima à esquerda fica parado). */
    .grip { position: absolute; right: 1px; bottom: 1px; width: 16px; height: 16px; cursor: nwse-resize; touch-action: none;
      opacity: 0; transition: opacity 120ms;
      background:
        linear-gradient(135deg, transparent 0 45%, #d8d3c6 45% 52%, #0b0b0c 52% 59%, transparent 59% 100%),
        linear-gradient(135deg, transparent 0 65%, #d8d3c6 65% 72%, #0b0b0c 72% 79%, transparent 79% 100%),
        linear-gradient(135deg, transparent 0 85%, #d8d3c6 85% 92%, #0b0b0c 92% 99%, transparent 99% 100%); }
    .win:hover .grip, :host(.sizing) .grip { opacity: 1; }
    .chip { box-shadow: var(--key-shadow), 0 6px 14px -8px #000; animation: win-zoom 160ms steps(4) both; }
    @media (hover: none) { .key { display: grid; width: 26px; height: 22px; } .grip { opacity: 1; width: 24px; height: 24px; } }
    @media (max-width: 640px) { :host { left: 0.5rem; top: 0.5rem; } }
  `,
})
export class SelfCam {
  protected readonly store = inject(RoomStore);
  protected readonly prefs = inject(CamPrefs);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly tuned = signal(false);
  protected readonly full = signal(false);
  protected readonly mineFocused = computed(() => this.store.focused()?.isLocal === true && this.store.focused()?.cam !== null);
  protected readonly sizing = signal(false);
  private readonly ratio = signal(16 / 9);
  protected readonly aspect = computed(() => String(this.ratio()));
  /** Largura enquanto puxa o canto (antes de guardar). */
  private readonly dragW = signal<number | null>(null);
  protected readonly width = computed(() => this.clampW(this.dragW() ?? this.prefs.selfWidth()));
  private readonly v = viewChild<ElementRef<HTMLVideoElement>>('v');
  private grip: { id: number; x: number; w: number } | null = null;

  /** Tamanho da cópia pelo tamanho na tela: só pede mais pixels quando vai mostrar mais pixels. */
  private readonly size = computed<PreviewSize>(() => {
    if (this.full()) return 'full';
    // Pela largura guardada (não a do meio do arraste, para não refazer a cópia a cada pixel).
    const shown = this.clampW(this.prefs.selfWidth());
    const h = (shown / this.ratio()) * (window.devicePixelRatio || 1);
    const w = shown * (window.devicePixelRatio || 1);
    return Math.min(w, h) <= 400 ? 'small' : Math.min(w, h) <= 800 ? 'medium' : 'full';
  });
  /** Muda só quando a câmera que sai muda (outra câmera, PC ↔ celular), não a cada atualização da sala. */
  private readonly key = computed(() => {
    const m = this.store.myShare();
    const c = this.store.selfCam();
    if (m === null || c === null) return '';
    return `${c.fromPhone}|${m.kind === 'camera' ? m.trackSid : (m.cam?.trackSid ?? '')}`;
  });

  constructor() {
    effect((onCleanup) => {
      const el = this.v()?.nativeElement;
      const size = this.size();
      if (el === undefined || this.key() === '') return;
      this.tuned.set(false);
      onCleanup(this.store.startLocalPreview(el, 'cam', size));
    });
    // A câmera desligou: sai da tela cheia.
    effect(() => {
      if (this.store.selfCam() === null || !this.prefs.selfView()) this.full.set(false);
    });
  }

  @HostListener('document:keydown.escape')
  protected esc() {
    this.full.set(false);
  }

  protected toggleFull() {
    if (this.grip !== null) return;
    this.full.update((f) => !f);
  }

  protected stop() {
    this.full.set(false);
    this.prefs.setSelfView(false);
  }

  protected readAspect() {
    const v = this.v()?.nativeElement;
    if (v !== undefined && v.videoWidth > 0 && v.videoHeight > 0) this.ratio.set(v.videoWidth / v.videoHeight);
  }

  private clampW(w: number) {
    const area = this.host.parentElement;
    const maxW = area === null ? MAX_W : Math.min(MAX_W, area.clientWidth * 0.6, area.clientHeight * 0.8 * this.ratio());
    return Math.round(Math.max(MIN_W, Math.min(Math.max(MIN_W, maxW), w)));
  }

  protected onGrip(e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.grip = { id: e.pointerId, x: e.clientX, w: this.width() };
    this.sizing.set(true);
  }

  protected onMove(e: PointerEvent) {
    const g = this.grip;
    if (g === null || g.id !== e.pointerId) return;
    this.dragW.set(this.clampW(g.w + e.clientX - g.x));
  }

  protected onUp(e: PointerEvent) {
    const g = this.grip;
    if (g === null || g.id !== e.pointerId) return;
    const w = this.dragW();
    if (w !== null) this.prefs.setSelfWidth(w);
    this.dragW.set(null);
    this.sizing.set(false);
    // O clique que vem logo depois de soltar não abre a tela cheia.
    window.setTimeout(() => (this.grip = null));
  }
}
