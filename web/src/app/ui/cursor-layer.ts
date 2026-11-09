import { Component, DestroyRef, ElementRef, effect, inject, input } from '@angular/core';
import { CursorNet } from '../core/cursors';
import { Prefs } from '../core/prefs';
import { RoomStore } from '../core/room-store';

const ARROW =
  '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M4.2 2.6 19.6 10.3a.8.8 0 0 1-.1 1.5l-6.2 1.9-2.9 5.9a.8.8 0 0 1-1.5-.1L3.1 3.6a.8.8 0 0 1 1.1-1Z" ' +
  'fill="var(--c)" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';

/**
 * Camada por cima da tela: manda o seu cursor e desenha o dos outros.
 * Desenha direto no DOM a cada quadro (requestAnimationFrame), sem passar pelo Angular,
 * para ficar liso sem custo de detecção de mudanças.
 */
@Component({
  selector: 'cen-cursor-layer',
  template: '',
  host: {
    '(pointermove)': 'onMove($event)',
    '(pointerdown)': 'onDown($event)',
    '(pointerleave)': 'net?.hide()',
  },
  styles: `
    :host { position: absolute; inset: 0; overflow: hidden; z-index: 1; }
    :host ::ng-deep .cur {
      position: absolute; left: 0; top: 0; pointer-events: none; will-change: transform, opacity; transform-origin: 4px 3px;
      filter: drop-shadow(0 1px 2px #0008);
    }
    :host ::ng-deep .cur svg { display: block; transform-origin: 4px 3px; transition: transform 120ms ease-out; }
    :host ::ng-deep .cur .tag {
      position: absolute; left: 14px; top: 20px; padding: 1px 7px; border-radius: 999px;
      background: var(--c); color: #0b0b0f; font: 600 11px/16px system-ui, sans-serif; white-space: nowrap;
      box-shadow: 0 0 0 1px #fff6 inset;
    }
    :host ::ng-deep .ripple {
      position: absolute; left: 0; top: 0; width: 34px; height: 34px; margin: -17px 0 0 -17px;
      border-radius: 50%; border: 2px solid var(--c); pointer-events: none;
    }
  `,
})
export class CursorLayer {
  /** Tamanho real da imagem da tela (para achar a área útil com as faixas pretas). */
  readonly source = input.required<{ width: number; height: number }>();
  /** Zoom da tela (a camada fica dentro dela): corrige a conta do mouse e mantém as setas no tamanho certo. */
  readonly zoom = input(1);
  private readonly store = inject(RoomStore);
  private readonly prefs = inject(Prefs);
  private readonly host = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
  protected net: CursorNet | null = null;
  private readonly nodes = new Map<string, { root: HTMLElement; svg: HTMLElement; tag: HTMLElement }>();
  private readonly ripples: HTMLElement[] = [];
  private raf = 0;

  constructor() {
    this.net = new CursorNet(this.store.liveRoom);
    // Desligar o cursor esconde o seu na hora para os outros.
    effect(() => {
      if (!this.prefs.cursorOn()) this.net?.hide();
    });
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    inject(DestroyRef).onDestroy(() => {
      cancelAnimationFrame(this.raf);
      this.net?.dispose();
      this.net = null;
    });
  }

  /** Retângulo onde a imagem aparece de fato (object-fit: contain). */
  private content() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const src = this.source();
    if (src.width === 0 || src.height === 0) return { x: 0, y: 0, w, h };
    const scale = Math.min(w / src.width, h / src.height);
    const cw = src.width * scale;
    const ch = src.height * scale;
    return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch };
  }

  private normalized(e: PointerEvent) {
    const r = this.host.getBoundingClientRect();
    const c = this.content();
    const k = this.host.clientWidth === 0 ? 1 : r.width / this.host.clientWidth;
    const x = ((e.clientX - r.left) / k - c.x) / c.w;
    const y = ((e.clientY - r.top) / k - c.y) / c.h;
    return x < 0 || y < 0 || x > 1 || y > 1 ? null : { x, y };
  }

  onMove(e: PointerEvent) {
    const share = this.store.focused()?.id;
    if (!this.prefs.cursorOn() || share === undefined || this.net === null) return;
    const p = this.normalized(e);
    if (p === null) this.net.hide();
    else this.net.move(share, p.x, p.y, this.prefs.cursorColor());
  }

  onDown(e: PointerEvent) {
    const share = this.store.focused()?.id;
    if (!this.prefs.cursorOn() || share === undefined || this.net === null) return;
    const p = this.normalized(e);
    if (p !== null) this.net.click(share, p.x, p.y, this.prefs.cursorColor());
  }

  private draw() {
    if (this.net === null) return;
    const share = this.store.focused()?.id ?? null;
    const frames = this.net.frame(share);
    const c = this.content();
    const seen = new Set<string>();
    let rippleIndex = 0;
    for (const f of frames) {
      seen.add(f.identity);
      let n = this.nodes.get(f.identity);
      if (n === undefined) {
        const root = document.createElement('div');
        root.className = 'cur';
        root.innerHTML = ARROW;
        const tag = document.createElement('span');
        tag.className = 'tag';
        root.appendChild(tag);
        this.host.appendChild(root);
        n = { root, svg: root.querySelector('svg') as unknown as HTMLElement, tag };
        this.nodes.set(f.identity, n);
      }
      const px = c.x + f.x * c.w;
      const py = c.y + f.y * c.h;
      n.root.style.setProperty('--c', f.color);
      // Opacidade menor para não atrapalhar a tela.
      n.root.style.opacity = String(0.82 * f.alpha);
      n.root.style.transform = `translate3d(${px - 4}px, ${py - 3}px, 0) scale(${1 / this.zoom()})`;
      n.svg.style.transform = `rotate(${f.tilt}deg)`;
      if (n.tag.textContent !== f.name) n.tag.textContent = f.name;
      for (const k of f.clicks) {
        if (k.age < 0) continue;
        const r = this.ripples[rippleIndex] ?? this.newRipple();
        rippleIndex++;
        r.style.setProperty('--c', f.color);
        r.style.display = 'block';
        r.style.opacity = String((1 - k.age) * 0.9);
        r.style.transform = `translate3d(${c.x + k.x * c.w}px, ${c.y + k.y * c.h}px, 0) scale(${(0.3 + k.age * 1.2) / this.zoom()})`;
      }
    }
    for (let i = rippleIndex; i < this.ripples.length; i++) this.ripples[i].style.display = 'none';
    for (const [id, n] of this.nodes) {
      if (!seen.has(id)) {
        n.root.remove();
        this.nodes.delete(id);
      }
    }
  }

  private newRipple() {
    const r = document.createElement('div');
    r.className = 'ripple';
    this.host.appendChild(r);
    this.ripples.push(r);
    return r;
  }
}
