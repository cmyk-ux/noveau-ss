import { Component, DestroyRef, ElementRef, effect, inject, input, viewChild } from '@angular/core';
import { ShareView } from '../core/room-session';
import { RoomStore } from '../core/room-store';

/** Uma tela na grade (várias telas ao mesmo tempo, como no Discord). */
@Component({
  selector: 'cen-share-tile',
  template: `
    <video #video autoplay playsinline muted></video>
    <div class="name">
      @if (share().isLocal) { Sua tela } @else { {{ share().ownerName }} }
      @if (share().hasAudio || hasStudio()) { <span class="snd" [class.off]="share().volume.muted || share().volume.level === 0">♪</span> }
    </div>
  `,
  styles: `
    :host { position: relative; display: block; min-width: 0; min-height: 0; background: #000; border-radius: 10px;
      overflow: hidden; cursor: pointer; outline: 2px solid transparent; transition: outline-color 0.15s; }
    :host(:hover) { outline-color: var(--accent); }
    video { width: 100%; height: 100%; object-fit: contain; display: block; }
    .name { position: absolute; left: 8px; bottom: 8px; padding: 2px 8px; border-radius: 6px; background: #000a;
      font-size: 0.8rem; font-weight: 600; display: flex; gap: 0.4rem; align-items: center; }
    .snd { color: var(--accent); }
    .snd.off { color: var(--muted); text-decoration: line-through; }
  `,
})
export class ShareTile {
  readonly share = input.required<ShareView>();
  private readonly store = inject(RoomStore);
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private attached: string | null = null;

  protected hasStudio() {
    return this.store.studio.streams().some((s) => s.identity === this.share().id);
  }

  constructor() {
    inject(DestroyRef).onDestroy(() => this.store.detachShare(this.share().id, this.video().nativeElement));
    effect(() => {
      const s = this.share();
      // Quando a pessoa reinicia a transmissão, o track muda: liga o novo.
      if (this.attached === s.trackSid) return;
      // A grade liga o track depois que a sessão habilita o vídeo; tenta de novo se ainda não chegou.
      const el = this.video().nativeElement;
      if (this.store.attachShare(s.id, el)) {
        el.muted = true;
        this.attached = s.trackSid;
      }
    });
  }
}
