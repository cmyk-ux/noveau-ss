import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { CamPrefs } from '../core/cam-prefs';
import { RoomStore } from '../core/room-store';
import { Icon } from './icon';

/**
 * Retorno da própria câmera: um monitorzinho no canto de cima do palco, para você se ver.
 * É uma cópia leve (360p a 15 fps; a do celular, a cópia menor que chega pela sala).
 * "Parar de ver" desliga a cópia de verdade: nada é decodificado nem desenhado. Fica guardado.
 */
@Component({
  selector: 'cen-self-cam',
  imports: [Icon],
  template: `
    @if (store.selfCam(); as me) {
      @if (prefs.selfView()) {
        <div class="win" role="group" aria-label="Sua câmera">
          <video #v autoplay playsinline muted [class.mirror]="me.mirror" (playing)="tuned.set(true)"></video>
          @if (!tuned()) {
            <span class="snow" aria-hidden="true"><span class="mono">sintonizando</span></span>
          }
          <div class="plate">
            <span class="led accent" aria-hidden="true"></span>
            <span class="mono">você{{ me.fromPhone ? ' · celular' : '' }}</span>
            <button type="button" class="key" title="Parar de ver a sua câmera (não pesa no PC; quem assiste continua vendo)"
              (click)="prefs.setSelfView(false)">
              <cen-icon name="eyeOff" [size]="12" />
            </button>
          </div>
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
    .win { position: relative; width: 176px; aspect-ratio: 16 / 9; background: #000; border-radius: 2px; overflow: hidden;
      box-shadow: 0 0 0 1px #0b0b0c, 0 0 0 3px #2a2a2b, 0 0 0 4px #0b0b0c, 0 10px 24px -10px #000;
      animation: crt-on 420ms var(--ease) both; }
    video { width: 100%; height: 100%; object-fit: cover; display: block; }
    video.mirror { transform: scaleX(-1); }
    .snow { position: absolute; inset: 0; display: grid; place-items: center;
      background: repeating-linear-gradient(0deg, #1a1a1b 0 2px, #0e0e0f 2px 4px); }
    .snow .mono { font-size: 0.58rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--faint);
      animation: blink 1.2s steps(1) infinite; }
    /* Plaqueta com o nome, como nos monitores da grade; o botão só aparece com o mouse em cima. */
    .plate { position: absolute; left: 5px; bottom: 5px; display: flex; align-items: center; gap: 0.35rem; padding: 2px 3px 2px 6px;
      border-radius: 3px; background: rgb(8 7 11 / 0.82); border: 1px solid rgb(255 255 255 / 0.08);
      font-size: 0.6rem; letter-spacing: 0.1em; text-transform: uppercase; }
    .plate .led { width: 6px; height: 6px; }
    .key { width: 18px; height: 16px; display: none; place-items: center; padding: 0; border: 1px solid #0b0b0c; border-radius: 2px;
      background: var(--plate); color: var(--muted); box-shadow: var(--key-shadow); cursor: pointer; }
    .key:hover { background: var(--plate-hi); color: var(--text); }
    .key:active { transform: translateY(1px); box-shadow: var(--key-pressed); }
    .win:hover .key, .win:focus-within .key { display: grid; }
    .chip { box-shadow: var(--key-shadow), 0 6px 14px -8px #000; animation: win-zoom 160ms steps(4) both; }
    @media (hover: none) { .key { display: grid; width: 26px; height: 22px; } }
    @media (max-width: 640px) { :host { left: 0.5rem; top: 0.5rem; } .win { width: 112px; } }
  `,
})
export class SelfCam {
  protected readonly store = inject(RoomStore);
  protected readonly prefs = inject(CamPrefs);
  protected readonly tuned = signal(false);
  private readonly v = viewChild<ElementRef<HTMLVideoElement>>('v');
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
      if (el === undefined || this.key() === '') return;
      this.tuned.set(false);
      onCleanup(this.store.startLocalPreview(el, 'cam'));
    });
  }
}
