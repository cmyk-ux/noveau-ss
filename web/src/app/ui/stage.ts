import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { RoomStore } from '../core/room-store';
import { Toast } from '../core/toast';
import { CursorLayer } from './cursor-layer';

const QUALITY_EVERY_MS = 2000;

/** O vídeo da tela em foco. */
@Component({
  selector: 'cen-stage',
  imports: [CursorLayer],
  host: {
    '(wheel)': 'onWheel($event)',
    '(pointerdown)': 'onPanStart($event)',
    '(pointermove)': 'onPanMove($event)',
    '(pointerup)': 'onPanEnd($event)',
    '(pointercancel)': 'onPanEnd($event)',
    '(dblclick)': 'resetZoom()',
    '[class.zoomed]': 'zoom() > 1',
    '[class.panning]': 'panning',
  },
  template: `<div class="lens" [style.transform]="lens()">
      <video #video autoplay playsinline muted (resize)="readSource()"></video>
      <cen-cursor-layer [source]="source()" [zoom]="zoom()" />
    </div>
    @if (zoom() > 1) {
      <button type="button" class="zoom-tag" title="Voltar ao tamanho normal (ou clique duplo)" (click)="$event.stopPropagation(); resetZoom()"
        (pointerdown)="$event.stopPropagation()">
        {{ zoom().toFixed(1) }}× <span>· voltar</span>
      </button>
    }`,
  styles: `
    :host { position: absolute; inset: 0; display: block; overflow: hidden; touch-action: none; }
    :host(.zoomed) { cursor: grab; }
    :host(.panning) { cursor: grabbing; }
    .lens { position: absolute; inset: 0; transform-origin: 0 0; will-change: transform; }
    video { width: 100%; height: 100%; object-fit: contain; background: #000; display: block; }
    .zoom-tag { position: absolute; left: 50%; bottom: 0.9rem; translate: -50% 0; z-index: 4; height: 24px; padding: 0 0.6rem;
      border-radius: 3px; border: 1px solid #000; background: var(--plate); color: var(--text);
      font: 500 0.7rem/1 var(--mono); letter-spacing: 0.06em; box-shadow: var(--key-shadow); }
    .zoom-tag span { color: var(--muted); }
  `,
})
export class Stage {
  private readonly _measured = signal<string | null>(null);
  readonly measured = this._measured.asReadonly();
  private readonly _source = signal(
    { width: 0, height: 0 },
    { equal: (a, b) => a.width === b.width && a.height === b.height },
  );
  readonly source = this._source.asReadonly();
  private readonly store = inject(RoomStore);
  private readonly toast = inject(Toast);
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private attachedTrackSid: string | null = null;
  private previousFrames = 0;
  /** Zoom com a roda, no ponto onde o mouse está (1 = normal, até 8x). */
  protected readonly zoom = signal(1);
  private readonly pan = signal({ x: 0, y: 0 });
  protected readonly lens = computed(() => {
    const z = this.zoom();
    const p = this.pan();
    return z === 1 ? 'none' : `translate(${p.x}px, ${p.y}px) scale(${z})`;
  });
  protected panning = false;
  private panFrom: { x: number; y: number; px: number; py: number; id: number } | null = null;
  private moved = false;
  private readonly host = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
  private previousInstant = 0;

  constructor() {
    // Fase de captura: chega antes do clique da sala (que voltaria para a grade).
    this.host.addEventListener('click', (e) => this.swallowClickAfterPan(e), true);
    effect(() => {
      const f = this.store.focused();
      if (f === null) {
        this.attachedTrackSid = null;
        return;
      }
      if (this.attachedTrackSid !== f.trackSid) this.attach(f.trackSid);
    });
    effect((onCleanup) => {
      this.readPlaybackQuality();
      const t = window.setInterval(() => this.readPlaybackQuality(), QUALITY_EVERY_MS);
      onCleanup(() => window.clearInterval(t));
    });
  }

  readSource() {
    const v = this.video().nativeElement;
    this._source.set({ width: v.videoWidth, height: v.videoHeight });
  }

  popout() {
    if (document.pictureInPictureElement !== null) {
      void document.exitPictureInPicture();
      return;
    }
    this.video()
      .nativeElement.requestPictureInPicture()
      .catch(() => this.toast.show('Este navegador não tem janela flutuante.'));
  }

  onWheel(e: WheelEvent) {
    // Roda (e a pinça do touchpad, que chega como Ctrl + roda) aproxima no ponto do mouse.
    e.preventDefault();
    const r = this.host.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1);
    const z = this.zoom();
    const next = Math.min(8, Math.max(1, z * Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0018))));
    if (next === z) return;
    const p = this.pan();
    // O ponto da imagem embaixo do mouse continua embaixo do mouse.
    this.setView(next, mx - ((mx - p.x) * next) / z, my - ((my - p.y) * next) / z);
  }

  onPanStart(e: PointerEvent) {
    if (this.zoom() === 1 || (e.button !== 0 && e.button !== 1)) return;
    this.panFrom = { x: e.clientX, y: e.clientY, px: this.pan().x, py: this.pan().y, id: e.pointerId };
    this.moved = false;
  }

  onPanMove(e: PointerEvent) {
    const f = this.panFrom;
    if (f === null || e.pointerId !== f.id) return;
    const dx = e.clientX - f.x;
    const dy = e.clientY - f.y;
    if (!this.moved && Math.hypot(dx, dy) < 4) return;
    if (!this.moved) {
      this.moved = true;
      this.panning = true;
      this.host.setPointerCapture(e.pointerId);
    }
    this.setView(this.zoom(), f.px + dx, f.py + dy);
  }

  onPanEnd(e: PointerEvent) {
    if (this.panFrom?.id !== e.pointerId) return;
    this.panFrom = null;
    this.panning = false;
  }

  /** Arrastar para mover a imagem não conta como clique (que voltaria para a grade). */
  swallowClickAfterPan(e: MouseEvent) {
    if (!this.moved) return;
    this.moved = false;
    e.stopImmediatePropagation();
  }

  resetZoom() {
    this.setView(1, 0, 0);
  }

  private setView(z: number, x: number, y: number) {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (z <= 1.001) {
      this.zoom.set(1);
      this.pan.set({ x: 0, y: 0 });
      return;
    }
    this.zoom.set(z);
    // Não deixa a imagem sair da área: as bordas param nas bordas.
    this.pan.set({ x: Math.min(0, Math.max(w - w * z, x)), y: Math.min(0, Math.max(h - h * z, y)) });
  }

  private attach(trackSid: string) {
    this.resetZoom();
    const v = this.video().nativeElement;
    if (!this.store.attachFocused(v)) return;
    v.muted = true;
    this.attachedTrackSid = trackSid;
    this.previousFrames = 0;
    this.previousInstant = 0;
  }

  private readPlaybackQuality() {
    const v = this.video().nativeElement;
    this.readSource();
    if (v.videoHeight === 0) {
      this._measured.set(null);
      return;
    }
    let fps = '';
    const q = v.getVideoPlaybackQuality?.();
    const now = performance.now();
    if (q !== undefined) {
      if (this.previousInstant > 0) {
        const n = Math.round(((q.totalVideoFrames - this.previousFrames) * 1e3) / (now - this.previousInstant));
        if (n > 0) fps = ` ${n}FPS`;
      }
      this.previousFrames = q.totalVideoFrames;
      this.previousInstant = now;
    }
    this._measured.set(`${v.videoHeight}p${fps}`);
  }
}
