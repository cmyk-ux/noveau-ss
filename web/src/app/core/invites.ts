import { Injectable, inject } from '@angular/core';
import { copyRoomLink, copyText } from './link';
import { Toast } from './toast';

@Injectable({ providedIn: 'root' })
export class Invites {
  private readonly toast = inject(Toast);

  async copy(text: string, done: string) {
    this.report(await copyText(text), text, done, 'Copie isto:');
  }

  async invite(label: string) {
    const { copied, link } = await copyRoomLink(label);
    this.report(copied, link, `Copiado: ${link.replace(/^https?:\/\//, '')}`, 'Copie o link da sala:');
  }

  private report(copied: boolean, text: string, done: string, ask: string) {
    if (copied) {
      this.toast.show(done);
      return;
    }
    window.prompt(ask, text);
  }
}
