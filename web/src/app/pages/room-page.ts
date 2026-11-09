import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Invites } from '../core/invites';
import { newKey, readLink, slugify } from '../core/link';
import { Prefs } from '../core/prefs';
import { RoomStore } from '../core/room-store';
import { RoomScreen } from '../ui/room-screen';

@Component({
  selector: 'cen-room-page',
  imports: [RoomScreen],
  providers: [RoomStore],
  template: `
    @if (store.joinState() === 'joined') {
      <cen-room-screen [label]="label()" (leave)="goHome()" />
    } @else if (key() === '') {
      <div class="center">
        <div class="card marks">
          <h1>{{ label() }}</h1>
          <p class="hint">
            Este endereço não tem a chave da sala, então não abre nenhuma sala. Peça o link inteiro a quem te
            convidou: o que vem depois do # é o que deixa você entrar.
          </p>
          <div class="stack">
            <button class="btn primary wide" (click)="startFresh()">Criar uma sala nova com este nome</button>
            <button class="btn wide" (click)="goHome()">Voltar ao início</button>
          </div>
        </div>
      </div>
    } @else {
      <div class="center">
        <form class="card marks" (submit)="submit($event)">
          <p class="label">Entrando em</p>
          <h1>{{ label() }}</h1>
          <div class="field">
            <label class="label" for="nickname">Como te chamamos</label>
            <input id="nickname" class="input" type="text" maxlength="24" autocomplete="nickname"
              [value]="name()" (input)="name.set($any($event.target).value)" />
          </div>
          <p class="error" role="alert">{{ message() }}</p>
          <button type="submit" class="btn primary wide" [disabled]="joining()">
            {{ joining() ? 'Entrando…' : 'Entrar na sala' }}
          </button>
          <div class="row">
            <button type="button" class="btn small" (click)="copy()">copiar convite</button>
            <button type="button" class="btn small" (click)="goHome()">voltar</button>
          </div>
        </form>
      </div>
    }
  `,
  styles: `
    h1 { margin: 0.2rem 0 0.5rem; word-break: break-all; }
    .stack { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1rem; }
    .row { display: flex; justify-content: space-between; margin-top: 1rem; }
  `,
})
export class RoomPage {
  protected readonly store = inject(RoomStore);
  private readonly invites = inject(Invites);
  private readonly prefs = inject(Prefs);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly link = signal(readLink());
  protected readonly key = computed(() => this.link().key);
  protected readonly label = computed(() =>
    slugify(decodeURIComponent(this.route.snapshot.paramMap.get('label') ?? '')),
  );
  protected readonly name = signal(this.prefs.name());
  private readonly local = signal('');
  protected readonly message = computed(() => this.local() || this.store.error());
  protected readonly joining = computed(() => this.store.joinState() === 'joining');

  async submit(e: Event) {
    e.preventDefault();
    const name = this.name().trim();
    if (name === '') {
      this.local.set('Digite um apelido para os outros te reconhecerem.');
      return;
    }
    this.local.set('');
    this.prefs.setName(name);
    await this.store.join(this.link(), name);
  }

  copy() {
    void this.invites.invite(this.label());
  }

  goHome() {
    void this.router.navigateByUrl('/');
  }

  startFresh() {
    void this.router.navigateByUrl(`/room/${this.label()}#${newKey()}`).then(() => this.link.set(readLink()));
  }
}
