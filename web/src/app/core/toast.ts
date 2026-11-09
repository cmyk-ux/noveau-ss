import { Injectable, signal } from '@angular/core';

const TOAST_MS = 2800;

export interface ToastAction {
  label: string;
  run: () => void;
}

@Injectable({ providedIn: 'root' })
export class Toast {
  private readonly _message = signal<string | null>(null);
  private readonly _action = signal<ToastAction | null>(null);
  private timer?: number;
  readonly message = this._message.asReadonly();
  readonly action = this._action.asReadonly();

  /** Mostra um aviso; com `action`, um botão (ex.: desfazer) que vale enquanto o aviso estiver na tela. */
  show(text: string, opts: { action?: ToastAction; ms?: number } = {}) {
    this._message.set(text);
    this._action.set(opts.action ?? null);
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.hide(), opts.ms ?? TOAST_MS);
  }

  runAction() {
    const a = this._action();
    this.hide();
    a?.run();
  }

  hide() {
    window.clearTimeout(this.timer);
    this._message.set(null);
    this._action.set(null);
  }
}
