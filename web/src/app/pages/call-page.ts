import { Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { DiscordCall, requestCallToken, requestGuestToken } from '../core/api';

const GUEST_KEY = 'noveau:guest';
interface GuestSeat {
  id: string;
  holder: string;
  name: string;
}
function readGuest(): GuestSeat | null {
  try {
    return JSON.parse(localStorage.getItem(GUEST_KEY) ?? 'null');
  } catch {
    return null;
  }
}
function writeGuest(g: GuestSeat) {
  try {
    localStorage.setItem(GUEST_KEY, JSON.stringify(g));
  } catch {
    /* navegação privada */
  }
}
function randomHolder() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
import { RoomStore } from '../core/room-store';
import { RoomScreen } from '../ui/room-screen';

/** Sala da call do Discord: entra direto, sem link nem apelido. */
@Component({
  selector: 'cen-call-page',
  imports: [RoomScreen],
  providers: [RoomStore],
  template: `
    @if (store.joinState() === 'joined' && !kickedOut()) {
      <cen-room-screen [label]="label()" (leave)="goHome()" />
    } @else {
      <div class="center">
        <div class="card screws">
          <p class="label">Sala da call</p>
          <h1>{{ call()?.name ?? (guestId !== null ? 'Convite' : '…') }}</h1>
          @if (kickedOut()) {
            <p class="error" role="alert">Você saiu da sala ou foi removido. Este convite não vale mais.</p>
            <div class="stack"><button class="btn wide" (click)="goHome()">Ir para o início</button></div>
          } @else if (guestId !== null && !guestReady()) {
            <p class="hint">Você recebeu um convite de 1 uso, para entrar sem Discord. Escolha um apelido para o pessoal saber quem é.</p>
            <form class="stack" (submit)="$event.preventDefault(); enterGuest()">
              <label class="label" for="nickname">apelido</label>
              <div class="row">
                <input id="nickname" class="input" maxlength="32" autocomplete="nickname" [value]="nick()"
                  (input)="nick.set($any($event.target).value)" placeholder="seu apelido" />
                <button type="button" class="btn" (click)="nick.set(randomNick())">sortear</button>
              </div>
              @if (store.error()) { <p class="error" role="alert">{{ store.error() }}</p> }
              <button type="submit" class="btn primary wide" [disabled]="nick().trim() === ''">Entrar na sala</button>
            </form>
          } @else if (store.error()) {
            <p class="error" role="alert">{{ store.error() }}</p>
            <div class="stack">
              <button class="btn primary wide" (click)="enter()">Tentar de novo</button>
              <button class="btn wide" (click)="goHome()">Voltar ao início</button>
            </div>
          } @else {
            <p class="hint">Entrando com as mesmas pessoas da sua call no Discord…</p>
          }
        </div>
      </div>
    }
  `,
  styles: `
    h1 { margin: 0.2rem 0 0.5rem; word-break: break-all; }
    .stack { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1rem; }
    .row { display: flex; gap: 0.5rem; }
    .row .input { flex: 1; min-width: 0; }
  `,
})
export class CallPage {
  protected readonly store = inject(RoomStore);
  private readonly router = inject(Router);
  protected readonly call = signal<DiscordCall | null>(null);
  protected readonly label = signal('call');

  /** Convite de 1 uso: /call#convite=<id>. */
  protected readonly guestId = /^#convite=([\w-]{8,64})$/.exec(location.hash)?.[1] ?? null;
  protected readonly guestReady = signal(false);
  protected readonly kickedOut = signal(false);
  protected readonly nick = signal(readGuest()?.name ?? '');

  constructor() {
    // Já usou este convite neste navegador (recarregou a página): entra direto com o mesmo apelido.
    if (this.guestId === null) void this.enter();
    else if (readGuest()?.id === this.guestId && this.nick() !== '') void this.enterGuest();
    // Saiu ou trocou de call no Discord: o servidor tira a pessoa da sala. Volta ao início,
    // que leva para a sala da call nova (se houver).
    let wasConnected = false;
    let leaving = false;
    inject(DestroyRef).onDestroy(() => (leaving = true));
    // Recarregar/fechar a aba também desconecta: isso não é ser expulso.
    window.addEventListener('beforeunload', () => (leaving = true), { once: true });
    window.addEventListener('pagehide', () => (leaving = true), { once: true });
    effect(() => {
      const status = this.store.status();
      if (status === 'connected') wasConnected = true;
      if (wasConnected && !leaving && status === 'disconnected') {
        // Convidado não tem call do Discord para voltar: mostra o aviso aqui.
        if (this.guestId !== null) {
          this.kickedOut.set(true);
          try {
            localStorage.removeItem(GUEST_KEY);
          } catch {
            /* ok */
          }
        }
        else void this.router.navigateByUrl('/');
      }
    });
  }

  async enter() {
    await this.store.joinWith(async () => {
      const grant = await requestCallToken();
      this.call.set(grant.call);
      this.label.set(grant.call.name.trim() || 'call');
      return grant;
    }, null);
  }

  async enterGuest() {
    const id = this.guestId;
    const name = this.nick().trim();
    if (id === null || name === '') return;
    const saved = readGuest();
    const holder = saved?.id === id ? saved.holder : randomHolder();
    writeGuest({ id, holder, name });
    this.guestReady.set(true);
    await this.store.joinWith(async () => {
      const grant = await requestGuestToken(id, holder, name);
      this.call.set(grant.call);
      this.label.set(grant.call.name.trim() || 'call');
      return grant;
    }, null);
    if (this.store.error()) this.guestReady.set(false);
  }

  randomNick() {
    const a = ['Capivara', 'Tatu', 'Quati', 'Sagui', 'Lontra', 'Jabuti', 'Tucano', 'Arara', 'Gambá', 'Preá'];
    const b = ['Veloz', 'Calmo', 'Curioso', 'Turbo', 'Sonolento', 'Ligeiro', 'Sereno', 'Bravo'];
    const pick = (l: string[]) => l[Math.floor(Math.random() * l.length)];
    return `${pick(a)} ${pick(b)}`;
  }

  goHome() {
    // ?ficar evita que o início mande de volta para a call na hora.
    void this.router.navigateByUrl('/?ficar=1');
  }
}
