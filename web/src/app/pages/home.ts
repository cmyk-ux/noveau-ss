import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { requiresSecret } from '../core/api';
import { encodeLink, newKey, randomRoomName, readLink, slugify } from '../core/link';

@Component({
  selector: 'cen-home',
  template: `
    <div class="center">
      <form class="card" (submit)="create($event)">
        <h1>Noveau</h1>
        <p class="hint">Escolha um nome, mande o link, e quem abrir entra na sala com você.</p>

        <div class="field">
          <label class="label" for="room">Nome da sala</label>
          <div class="row">
            <input #roomInput id="room" class="input" type="text" autocomplete="off" autocapitalize="off"
              spellcheck="false" [value]="room()" (input)="room.set($any($event.target).value)" />
            <button type="button" class="btn" (click)="shuffle()">sortear</button>
          </div>
          <p class="hint">O nome é só um rótulo. O que abre a sala é a chave que vai no link.</p>
        </div>

        @if (needsSecret()) {
          <div class="field">
            <label class="label" for="secret">Senha da instância</label>
            <input id="secret" class="input" type="password" autocomplete="off"
              [value]="secret()" (input)="secret.set($any($event.target).value)" />
          </div>
        }

        <p class="error" role="alert">{{ error() }}</p>
        <button type="submit" class="btn primary wide">Criar sala</button>
      </form>
    </div>
  `,
  styles: `
    h1 { margin: 0 0 0.25rem; }
    .row { display: flex; gap: 0.5rem; }
    .row .input { flex: 1; min-width: 0; }
  `,
})
export class Home {
  private readonly router = inject(Router);
  private readonly roomInput = viewChild<ElementRef<HTMLInputElement>>('roomInput');
  protected readonly room = signal(randomRoomName());
  protected readonly secret = signal('');
  protected readonly error = signal('');
  protected readonly needsSecret = signal(false);

  constructor() {
    void this.askWhetherSecretIsNeeded();
  }

  shuffle() {
    this.room.set(randomRoomName());
    this.roomInput()?.nativeElement.focus();
  }

  create(e: Event) {
    e.preventDefault();
    const label = slugify(this.room());
    if (label === '') {
      this.error.set('Use pelo menos uma letra ou número no nome.');
      this.roomInput()?.nativeElement.focus();
      return;
    }
    const hash = encodeLink({ key: newKey(), secret: this.secret().trim() });
    void this.router.navigateByUrl(`/room/${label}#${hash}`);
  }

  private async askWhetherSecretIsNeeded() {
    let needed = false;
    try {
      needed = await requiresSecret();
    } catch {
      return;
    }
    if (!needed) return;
    const known = readLink().secret;
    if (known === '') this.needsSecret.set(true);
    else this.secret.set(known);
  }
}
