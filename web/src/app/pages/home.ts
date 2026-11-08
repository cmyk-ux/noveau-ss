import { Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { Me, requiresSecret, whoAmI } from '../core/api';
import { encodeLink, newKey, randomRoomName, readLink, slugify } from '../core/link';

@Component({
  selector: 'cen-home',
  template: `
    <div class="center">
      <form class="card" (submit)="create($event)">
        <h1>Noveau</h1>

        @if (me(); as m) {
          @if (m.discord) {
            <div class="discord">
              @if (m.user; as u) {
                <div class="who">
                  @if (u.avatar) { <img [src]="u.avatar" alt="" width="28" height="28" /> }
                  <span>{{ u.name }}</span>
                  <a class="btn small" href="/api/discord/logout">sair</a>
                </div>
                @if (m.call; as c) {
                  <button type="button" class="btn primary wide" (click)="goToCall()">Entrar na sala da call {{ c.name }}</button>
                } @else {
                  <p class="hint">Entre numa call do servidor e esta página te leva para a sala com as mesmas pessoas.</p>
                }
                @if (!anon()) {
                  <button type="button" class="btn wide" (click)="anon.set(true)">Entrar em uma call anônima</button>
                  <p class="hint">Uma sala fora do Discord, só com quem tiver o link.</p>
                }
              } @else {
                <a class="btn wide discord-login" href="/api/discord/login">Entrar com Discord</a>
                <p class="hint">Quem estiver numa call do servidor entra direto na sala com as mesmas pessoas.</p>
              }
            </div>
          }
        }
        @if (discordError()) { <p class="error">{{ discordError() }}</p> }

        @if (showForm()) {
        <p class="label or">call anônima</p>
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
        }
      </form>
    </div>
  `,
  styles: `
    h1 { margin: 0 0 0.25rem; }
    .row { display: flex; gap: 0.5rem; }
    .row .input { flex: 1; min-width: 0; }
    .discord { display: flex; flex-direction: column; gap: 0.5rem; margin: 1rem 0 0.5rem; }
    .who { display: flex; align-items: center; gap: 0.5rem; }
    .who img { border-radius: 50%; }
    .who span { flex: 1; font-weight: 600; }
    .discord-login { background: #5865f2; color: #fff; border-color: #5865f2; text-align: center; text-decoration: none; }
    .or { text-align: center; margin: 1rem 0 0; }
  `,
})
export class Home {
  private readonly router = inject(Router);
  private readonly roomInput = viewChild<ElementRef<HTMLInputElement>>('roomInput');
  protected readonly room = signal(randomRoomName());
  protected readonly secret = signal('');
  protected readonly error = signal('');
  protected readonly needsSecret = signal(false);
  protected readonly me = signal<Me | null>(null);
  /** Pessoa pediu a call anônima (fora do Discord). */
  protected readonly anon = signal(false);
  /**
   * O formulário de sala avulsa só aparece depois de entrar com o Discord e pedir a call
   * anônima. Se o login com Discord não estiver configurado no servidor, aparece direto.
   */
  protected readonly showForm = computed(() => {
    const m = this.me();
    if (m === null) return false;
    if (!m.discord) return true;
    return m.user !== null && this.anon();
  });
  protected readonly discordError = signal('');
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    void this.askWhetherSecretIsNeeded();
    const params = new URLSearchParams(location.search);
    if (params.get('discord') === 'falhou') this.discordError.set('O login com Discord não deu certo. Tente de novo.');
    // Ao voltar de uma call (?ficar=1) não manda de volta automaticamente.
    void this.checkCall(params.get('ficar') === null);
    // Se a pessoa entrar numa call com esta página aberta, leva para a sala.
    this.timer = setInterval(() => void this.checkCall(params.get('ficar') === null), 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(this.timer));
  }

  goToCall() {
    void this.router.navigateByUrl('/call');
  }

  private async checkCall(autoJoin: boolean) {
    let me: Me;
    try {
      me = await whoAmI();
    } catch {
      return;
    }
    this.me.set(me);
    if (!me.discord || me.user === null) clearInterval(this.timer);
    if (autoJoin && me.call !== null) this.goToCall();
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
