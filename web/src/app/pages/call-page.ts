import { Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { DiscordCall, requestCallToken } from '../core/api';
import { RoomStore } from '../core/room-store';
import { RoomScreen } from '../ui/room-screen';

/** Sala da call do Discord: entra direto, sem link nem apelido. */
@Component({
  selector: 'cen-call-page',
  imports: [RoomScreen],
  providers: [RoomStore],
  template: `
    @if (store.joinState() === 'joined') {
      <cen-room-screen [label]="label()" (leave)="goHome()" />
    } @else {
      <div class="center">
        <div class="card screws">
          <p class="label">Sala da call</p>
          <h1>{{ call()?.name ?? '…' }}</h1>
          @if (store.error()) {
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
  `,
})
export class CallPage {
  protected readonly store = inject(RoomStore);
  private readonly router = inject(Router);
  protected readonly call = signal<DiscordCall | null>(null);
  protected readonly label = signal('call');

  constructor() {
    void this.enter();
    // Saiu ou trocou de call no Discord: o servidor tira a pessoa da sala. Volta ao início,
    // que leva para a sala da call nova (se houver).
    let wasConnected = false;
    let leaving = false;
    inject(DestroyRef).onDestroy(() => (leaving = true));
    effect(() => {
      const status = this.store.status();
      if (status === 'connected') wasConnected = true;
      if (wasConnected && !leaving && status === 'disconnected') void this.router.navigateByUrl('/');
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

  goHome() {
    // ?ficar evita que o início mande de volta para a call na hora.
    void this.router.navigateByUrl('/?ficar=1');
  }
}
