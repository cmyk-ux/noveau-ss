import { Component, DestroyRef, ElementRef, computed, effect, inject, input, viewChild } from '@angular/core';
import { Icon } from './icon';
import { ShareView } from '../core/room-session';
import { RoomStore } from '../core/room-store';

/** Uma tela na grade (várias telas ao mesmo tempo, como no Discord). */
@Component({
  selector: 'cen-share-tile',
  imports: [Icon],
  template: `
    <video #video autoplay playsinline muted></video>
    <div class="eye" [title]="viewersTitle()"><cen-icon name="eye" [size]="14" /> {{ viewers().length }}</div>
    <button type="button" class="hide" title="Esconder esta tela (para de baixar o vídeo e o som dela)"
      (click)="$event.stopPropagation(); store.hideShare(share().id)">
      <cen-icon name="eyeOff" [size]="14" /> esconder
    </button>
    @if (!share().isLocal) {
      <button type="button" class="mute" [class.on]="share().volume.muted"
        [title]="share().volume.muted ? 'Ativar o som' : 'Mutar'"
        (click)="$event.stopPropagation(); store.toggleMute('share', share().id)">
        <cen-icon [name]="share().volume.muted ? 'speakerOff' : 'speaker'" [size]="15" />
      </button>
    }
    <div class="name">
      <span class="led" [class.live]="!share().isLocal" [class.accent]="share().isLocal"></span>
      @if (share().isLocal) { Sua tela } @else { {{ share().ownerName }} }
      @if (share().hasAudio || hasStudio()) { <span class="snd" [class.off]="share().volume.muted || share().volume.level === 0">♪</span> }
    </div>
  `,
  styles: `
    /* Monitor de ilha de edição: liga como tubo de TV, plaqueta com o nome embaixo. */
    :host { position: relative; display: block; min-width: 0; min-height: 0; background: #000; border-radius: 2px;
      overflow: hidden; cursor: pointer; box-shadow: 0 0 0 1px #0b0b0c, 0 0 0 3px #2a2a2b, 0 0 0 4px #0b0b0c;
      transition: box-shadow 160ms; animation: crt-on 420ms var(--ease) both; }
    :host(:hover) { box-shadow: 0 0 0 1px #0b0b0c, 0 0 0 3px var(--accent), 0 0 0 4px #0b0b0c; }
    video { width: 100%; height: 100%; object-fit: contain; display: block; }
    .name { position: absolute; left: 8px; bottom: 8px; padding: 3px 8px; border-radius: 3px; background: rgb(8 7 11 / 0.82);
      border: 1px solid rgb(255 255 255 / 0.08); font: 500 0.7rem/1.2 var(--mono); letter-spacing: 0.08em; text-transform: uppercase;
      display: flex; gap: 0.45rem; align-items: center; }
    .snd { color: var(--accent-hi); }
    .eye { position: absolute; right: 8px; top: 8px; padding: 2px 7px; border-radius: 3px; background: rgb(8 7 11 / 0.82);
      font: 0.72rem var(--mono); display: flex; gap: 0.3rem; align-items: center; }
    .mute { position: absolute; right: 8px; bottom: 8px; border: 1px solid rgb(255 255 255 / 0.1); border-radius: 3px; padding: 4px 6px;
      background: rgb(8 7 11 / 0.82); color: #fff; display: none; cursor: pointer; }
    .mute.on { display: grid; color: var(--danger); }
    :host(:hover) .mute { display: grid; }
    .hide { position: absolute; left: 8px; top: 8px; display: none; align-items: center; gap: 0.3rem; height: 24px; padding: 0 0.5rem;
      border: 1px solid #0b0b0c; border-radius: 2px; background: rgb(22 22 23 / 0.88); color: var(--text); cursor: pointer;
      font: 500 0.66rem/1 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; box-shadow: var(--key-shadow); }
    .hide:active { transform: translateY(2px); box-shadow: var(--key-pressed); }
    :host(:hover) .hide { display: inline-flex; }
    .snd.off { color: var(--muted); text-decoration: line-through; }
  `,
})
export class ShareTile {
  readonly share = input.required<ShareView>();
  protected readonly store = inject(RoomStore);
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private attached: string | null = null;

  protected readonly viewers = computed(() => this.store.viewersOf(this.share().id));
  protected readonly viewersTitle = computed(() =>
    this.viewers().length === 0 ? 'Ninguém assistindo' : `Assistindo: ${this.viewers().join(', ')}`,
  );

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
