import { Injectable, signal } from '@angular/core';

const TOAST_MS = 2800;

@Injectable({ providedIn: 'root' })
export class Toast {
  private readonly _message = signal<string | null>(null);
  private timer?: number;
  readonly message = this._message.asReadonly();

  show(text: string) {
    this._message.set(text);
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this._message.set(null), TOAST_MS);
  }
}
