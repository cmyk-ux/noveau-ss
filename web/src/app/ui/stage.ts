import { Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { RoomStore } from '../core/room-store';
import { Toast } from '../core/toast';

const QUALITY_EVERY_MS = 2000;

/** O vídeo da tela em foco. */
@Component({
  selector: 'cen-stage',
  template: `<video #video autoplay playsinline muted (resize)="readSource()"></video>`,
  styles: `
    :host { position: absolute; inset: 0; display: block; }
    video { width: 100%; height: 100%; object-fit: contain; background: #000; }
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
  private previousInstant = 0;

  constructor() {
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

  private attach(trackSid: string) {
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
