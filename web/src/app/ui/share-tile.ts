import { Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { Icon } from './icon';
import { ShareView } from '../core/room-session';
import { RoomStore } from '../core/room-store';

/** Uma tela na grade (várias telas ao mesmo tempo, como no Discord). */
@Component({
  selector: 'cen-share-tile',
  imports: [Icon],
  template: `
    <video #video autoplay playsinline muted></video>
    <div class="top">
      @if (share().cam !== null) {
        <!-- A câmera de quem transmite: uma tecla só, sempre aqui, liga e desliga. Desligada, não baixa nada. -->
        <button type="button" class="cam-key" [class.on]="!camHidden()" [attr.aria-pressed]="!camHidden()"
          [title]="camHidden() ? 'Mostrar a câmera' : 'Esconder a câmera (para de baixar o vídeo dela)'"
          (click)="$event.stopPropagation(); store.setCamClosed(share().id, !camHidden())">
          <span class="led" aria-hidden="true"></span>
          <cen-icon [name]="camHidden() ? 'cameraOff' : 'camera'" [size]="13" />
        </button>
      }
      <div class="eye" [title]="viewersTitle()"><cen-icon name="eye" [size]="14" /> {{ viewers().length }}</div>
    </div>
    @if (share().cam; as c) {
      @if (!camHidden()) {
        <!-- Câmera junto da tela: num canto do monitor, na cópia menor. Clique abre grande. -->
        <div class="cam" [style.aspect-ratio]="camAspect()" title="Clique para ver a câmera grande" (click)="$event.stopPropagation(); openCam()">
          <video #cam autoplay playsinline muted [class.mirror]="c.mirror" (playing)="camTuned.set(true)" (resize)="readCamAspect()"></video>
          @if (!camTuned()) { <span class="snow" aria-hidden="true"></span> }
        </div>
      }
    }
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
      <button type="button" class="hide" title="Esconder esta tela (para de baixar o vídeo e o som dela)"
        (click)="$event.stopPropagation(); store.hideShare(share().id)"><cen-icon name="eyeOff" [size]="13" /></button>
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
    .top { position: absolute; right: 8px; top: 8px; z-index: 3; display: flex; gap: 6px; align-items: center; }
    .eye { padding: 2px 7px; border-radius: 3px; background: rgb(8 7 11 / 0.82);
      font: 0.72rem var(--mono); display: flex; gap: 0.3rem; align-items: center; }
    .mute { position: absolute; right: 8px; bottom: 8px; border: 1px solid rgb(255 255 255 / 0.1); border-radius: 3px; padding: 4px 6px;
      background: rgb(8 7 11 / 0.82); color: #fff; display: none; cursor: pointer; }
    .mute.on { display: grid; color: var(--danger); }
    :host(:hover) .mute { display: grid; }
    /* Esconder: um olho riscado dentro da plaqueta do nome, só com o mouse em cima. */
    .hide { display: none; place-items: center; width: 18px; height: 16px; margin: -2px -4px -2px 0; padding: 0; border: 0;
      border-left: 1px solid rgb(255 255 255 / 0.12); background: none; color: var(--muted); cursor: pointer; }
    .hide:hover { color: var(--text); }
    :host(:hover) .hide { display: grid; }
    /* Toque: botão sempre visível e com área de dedo. */
    @media (hover: none) { .hide { display: grid; width: 32px; height: 28px; margin: -8px -8px -8px 0; } .mute { display: grid; } }
    .snd.off { color: var(--muted); text-decoration: line-through; }
    /* Câmera no canto de cima (embaixo de quem assiste), como um monitorzinho de retorno preso ao monitor maior. */
    .cam { position: absolute; right: 8px; top: 34px; z-index: 2; width: clamp(72px, 26%, 220px); max-height: 62%;
      background: #000; border-radius: 2px; overflow: hidden; cursor: zoom-in;
      box-shadow: 0 0 0 1px #0b0b0c, 0 0 0 2px #2a2a2b, 0 0 0 3px #0b0b0c, 0 6px 14px -8px #000; animation: crt-on 320ms var(--ease) both; }
    .cam video { width: 100%; height: 100%; object-fit: contain; display: block; pointer-events: none; }
    .cam video.mirror { transform: scaleX(-1); }
    .cam .snow { position: absolute; inset: 0; background: repeating-linear-gradient(0deg, #1a1a1b 0 2px, #0e0e0f 2px 4px);
      animation: blink 0.9s steps(1) infinite; }
    .cam-key { display: flex; align-items: center; gap: 4px; height: 22px; padding: 0 6px; border: 1px solid #0b0b0c; border-radius: 3px;
      background: var(--plate); color: var(--muted); box-shadow: var(--key-shadow); cursor: pointer; }
    .cam-key:hover { background: var(--plate-hi); color: var(--text); }
    .cam-key.on { transform: translateY(1px); box-shadow: var(--key-pressed); background: #303031; color: var(--text); }
    .cam-key .led { width: 5px; height: 5px; }
    .cam-key.on .led { background: var(--ok); box-shadow: 0 0 4px var(--ok); }
    @media (hover: none) { .cam-key { height: 30px; padding: 0 9px; } }
  `,
})
export class ShareTile {
  readonly share = input.required<ShareView>();
  protected readonly store = inject(RoomStore);
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private attached: string | null = null;
  private readonly camEl = viewChild<ElementRef<HTMLVideoElement>>('cam');
  private camAttached: { el: HTMLVideoElement; sid: string } | null = null;
  protected readonly camTuned = signal(false);
  /** Proporção real da câmera (4:3, 16:9, celular em pé): a janelinha segue ela. */
  protected readonly camAspect = signal('16 / 9');
  protected readCamAspect() {
    const v = this.camEl()?.nativeElement;
    if (v !== undefined && v.videoWidth > 0 && v.videoHeight > 0) this.camAspect.set(`${v.videoWidth} / ${v.videoHeight}`);
  }
  protected readonly camHidden = computed(() => this.store.camClosed().has(this.share().id));

  protected readonly viewers = computed(() => this.store.viewersOf(this.share().id));
  protected readonly viewersTitle = computed(() =>
    this.viewers().length === 0 ? 'Ninguém assistindo' : `Assistindo: ${this.viewers().join(', ')}`,
  );

  /** Abre esta tela em foco já com a câmera grande. */
  protected openCam() {
    this.store.focusShare(this.share().id);
    this.store.setCamBig(this.share().id, true);
  }

  protected hasStudio() {
    return this.store.studio.streams().some((s) => s.identity === this.share().id);
  }

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.store.detachShare(this.share().id, this.video().nativeElement);
      if (this.camAttached !== null) this.store.detachCam(this.share().id, this.camAttached.el);
    });
    // Câmera do canto: liga quando aparece, solta quando você esconde (o vídeo some junto).
    effect(() => {
      const el = this.camEl()?.nativeElement;
      const s = this.share();
      const sid = s.cam?.trackSid;
      const cur = this.camAttached;
      if (cur !== null && cur.el === el && cur.sid === sid) return;
      if (cur !== null) this.store.detachCam(s.id, cur.el);
      this.camAttached = null;
      if (el === undefined || sid === undefined) return;
      this.camTuned.set(false);
      if (this.store.attachCam(s.id, el)) this.camAttached = { el, sid };
    });
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
