import { Injectable, inject } from '@angular/core';
import { copyRoomLink, copyText } from './link';
import { SendFx } from './send-fx';
import { Toast } from './toast';

@Injectable({ providedIn: 'root' })
export class Invites {
  private readonly toast = inject(Toast);
  private readonly fx = inject(SendFx);

  async copy(text: string, done: string) {
    this.report(await copyText(text), text, done, 'Copie isto:');
  }

  /** Copia o link da sala com a janela de cópia (o papel pulando da sala para a área de transferência). */
  async invite(label: string) {
    const run = this.fx.start({
      title: 'Copiando convite',
      from: 'folder',
      item: 'letter',
      to: 'clipboard',
      line: 'Copiando o link da sala para a área de transferência',
    });
    const { copied, link } = await copyRoomLink(label);
    if (copied) {
      run.done(`Copiado. Cole onde quiser: ${link.replace(/^https?:\/\//, '')}`);
      return;
    }
    run.fail('Não deu para copiar sozinho. Copie o link na caixa que abriu.');
    window.prompt('Copie o link da sala:', link);
  }

  private report(copied: boolean, text: string, done: string, ask: string) {
    if (copied) {
      this.toast.show(done);
      return;
    }
    window.prompt(ask, text);
  }
}
