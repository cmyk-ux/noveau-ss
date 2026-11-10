import { Injectable, signal } from '@angular/core';

/** Uma "janela de cópia" estilo Windows 98: um papelzinho pula de um ícone para o outro. */
export interface SendJob {
  /** Título da janela. */
  title: string;
  /** Ícone de onde sai, do que viaja e de onde chega (nomes de cen-pixel). */
  from: string;
  item: string;
  to: string;
  /** Linha enquanto envia, ex.: "Copiando convite para a área de transferência". */
  line: string;
}

export interface SendView extends SendJob {
  id: number;
  state: 'running' | 'done' | 'failed';
  result: string;
}

/** Tempo mínimo da animação antes de mostrar "pronto", para dar para ver o papel voando. */
const MIN_RUN_MS = 1100;
const CLOSE_DONE_MS = 2400;
const CLOSE_FAIL_MS = 3600;

export interface SendRun {
  done(result: string): void;
  fail(result: string): void;
}

@Injectable({ providedIn: 'root' })
export class SendFx {
  private readonly _view = signal<SendView | null>(null);
  readonly view = this._view.asReadonly();
  private next = 1;
  private closeTimer?: number;

  start(job: SendJob): SendRun {
    window.clearTimeout(this.closeTimer);
    const id = this.next++;
    const started = performance.now();
    this._view.set({ ...job, id, state: 'running', result: '' });
    const finish = (state: 'done' | 'failed', result: string) => {
      const wait = Math.max(0, MIN_RUN_MS - (performance.now() - started));
      window.setTimeout(() => {
        if (this._view()?.id !== id) return;
        this._view.update((v) => (v === null ? v : { ...v, state, result }));
        this.closeTimer = window.setTimeout(() => this.close(id), state === 'done' ? CLOSE_DONE_MS : CLOSE_FAIL_MS);
      }, wait);
    };
    return { done: (r) => finish('done', r), fail: (r) => finish('failed', r) };
  }

  close(id?: number) {
    if (id !== undefined && this._view()?.id !== id) return;
    window.clearTimeout(this.closeTimer);
    this._view.set(null);
  }
}
