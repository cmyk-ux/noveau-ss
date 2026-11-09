import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { DiscordUser, callMembers, inviteToRoom, pingCall } from '../core/api';
import { encodeLink, isCallRoom, newKey, randomRoomName } from '../core/link';
import { IS_MOBILE } from '../core/device';
import { Prefs } from '../core/prefs';
import { RoomStore } from '../core/room-store';
import { Toast } from '../core/toast';
import { Icon } from './icon';
import { VolumeSlider } from './volume-slider';

/** Quem está na sala e o volume de cada um, só para você. */
@Component({
  selector: 'cen-people-panel',
  imports: [Icon, VolumeSlider],
  template: `
    @if (stageSound(); as s) {
      <p class="label">som da tela</p>
      <div class="person">
        <span class="name">{{ s.label }}</span>
      </div>
      <cen-volume [volume]="s.share.volume" [label]="s.label"
        (levelChange)="store.setVolume('share', s.share.id, $event)"
        (muteToggle)="store.toggleMute('share', s.share.id)" />
    }
    @for (st of store.studio.streams(); track st.identity) {
      <p class="label">som de estúdio · sem compressão</p>
      <div class="studio">
        <div class="person">
          <span class="name">{{ st.name }}</span>
          <span class="tag">{{ st.bits }}-bit · 48 kHz</span>
        </div>
        <div class="person">
          <input type="range" min="0" max="1" step="0.01" [value]="studioVolume()" aria-label="Volume do som de estúdio"
            (input)="setStudioVolume(+$any($event.target).value)" />
          <span class="mono small">{{ (studioVolume() * 100).toFixed(0) }}%</span>
        </div>
        <p class="hint mono">
          buffer {{ (st.level * 1000).toFixed(0) }} / {{ (st.target * 1000).toFixed(0) }} ms
          @if (!st.playing) { · carregando }
          @if (st.underruns > 0) { · {{ st.underruns }} engasgo(s) }
          @if (st.lost > 0) { · {{ st.lost }} pacote(s) perdido(s) }
        </p>
        <div class="chips">
          @for (l of latencies; track l) {
            <button type="button" class="chip" [class.lit]="l === prefs.studioLatency()" (click)="setLatency(l)">{{ l * 1000 }} ms</button>
          }
        </div>
        <p class="hint">Engasgando? Aumente o atraso. Ele só afeta o som de estúdio.</p>
      </div>
    }
    <p class="label">na sala</p>
    @for (p of store.participants(); track p.identity) {
      <div class="person" [class.speaking]="p.isSpeaking">
        @if (p.avatar) { <img class="avatar" [src]="p.avatar" alt="" width="22" height="22" /> } @else { <span class="dot"></span> }
        <span class="name">{{ p.name }} @if (p.isLocal) {<span class="you">(você{{ isMobile ? ', no celular' : '' }})</span>} @else if (p.myOtherDevice) {<span class="you">(você, {{ p.mobile ? 'no celular' : 'no PC' }})</span>}</span>
        @if (p.isLocal ? isMobile : p.mobile) { <cen-icon class="device" name="phone" [size]="14" title="Pelo celular" /> }
        @if (p.micEnabled) { <cen-icon name="mic" [size]="14" /> }
        @if (p.isSharing) { <span class="live">AO VIVO</span> }
      </div>
      @if (p.myOtherDevice) {
        <p class="hint other">Seu outro aparelho. A voz dele não toca aqui, para não dar eco. Ligar o microfone num desliga no outro.</p>
      } @else if (!p.isLocal) {
        <cen-volume [volume]="p.volume" [label]="'a voz de ' + p.name"
          (levelChange)="store.setVolume('mic', p.identity, $event)"
          (muteToggle)="store.toggleMute('mic', p.identity)" />
      }
    }

    @if (outside().length > 0) {
      <p class="label">{{ callRoom ? 'na call, fora do site' : 'na sua call do Discord' }}</p>
      @for (m of outside(); track m.id) {
        <div class="person outside">
          @if (m.avatar) { <img class="avatar" [src]="m.avatar" alt="" width="22" height="22" /> } @else { <span class="dot"></span> }
          <span class="name">{{ m.name }}</span>
          <span class="tag">fora</span>
          <button type="button" class="btn small invite" [class.busy]="inviting() === m.id"
            [disabled]="inviting() === m.id" (click)="invite(m)">
            {{ inviting() === m.id ? '…' : 'convidar' }}
          </button>
        </div>
      }
      <p class="hint">{{ isMobile ? 'Toque em convidar' : 'Passe o mouse em alguém para convidar' }}: o bot manda o link no privado do Discord.</p>
    }

    @if (callRoom) {
      <button type="button" class="btn small wide action" [disabled]="pinging()" (click)="ping()">
        {{ pinging() ? 'Avisando…' : 'Chamar a call no Discord' }}
      </button>
      <p class="hint">O bot marca todo mundo da call no chat do canal de voz com o link do site.</p>
      <button type="button" class="btn small wide action" (click)="privateRoom()">Abrir uma sala privada</button>
      <p class="hint">Cria uma sala só com quem você convidar, para passar tela em particular.</p>
    }
    <p class="hint">O ponto acende em quem está falando. Os volumes aqui valem só para você.</p>
  `,
  styles: `
    :host { display: block; }
    .person { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.7rem; }
    .person + cen-volume { margin-top: 0.25rem; }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .you { color: var(--muted); font-size: 0.85rem; margin-left: 0.25rem; }
    .dot { width: 8px; height: 8px; margin: 0 7px; border-radius: 50%; background: var(--line-2); flex-shrink: 0; }
    .avatar { border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 0 2px transparent; transition: box-shadow 0.12s; }
    .speaking .dot { background: var(--ok); box-shadow: 0 0 4px rgb(127 168 100 / 0.5); }
    .speaking .avatar { box-shadow: 0 0 0 2px var(--ok); }
    .live { font: 500 0.62rem var(--mono); letter-spacing: 0.12em; color: #fff; background: var(--danger); padding: 2px 5px;
      border-radius: 1px; }
    .outside { color: var(--muted); }
    .outside .avatar { opacity: 0.6; filter: grayscale(1); }
    .action { margin-top: 1rem; }
    .studio { border: 1px solid var(--line-2); border-radius: 6px; padding: 0.25rem 0.6rem 0.6rem; margin-bottom: 0.5rem;
      background: #09080c; box-shadow: inset 0 1px 4px #000a; }
    .studio input[type=range] { flex: 1; accent-color: var(--accent); }
    .small { font-size: 0.75rem; }
    .chips { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.4rem; }
    .invite { display: none; }
    .outside:hover .tag { display: none; }
    .outside:hover .invite, .invite.busy { display: inline-flex; }
    /* Toque não tem "passar o mouse": no celular o botão fica sempre à mostra. */
    @media (hover: none) { .outside .tag { display: none; } .outside .invite { display: inline-flex; } }
    .device { color: var(--muted); flex-shrink: 0; }
    .other { margin: 0.1rem 0 0.5rem 1.9rem; }
  `,
})
export class PeoplePanel {
  protected readonly store = inject(RoomStore);
  private readonly toast = inject(Toast);
  private readonly router = inject(Router);
  protected readonly callRoom = isCallRoom();
  protected readonly isMobile = IS_MOBILE;
  private readonly members = signal<DiscordUser[]>([]);
  protected readonly pinging = signal(false);
  protected readonly inviting = signal<string | null>(null);
  protected readonly prefs = inject(Prefs);
  protected readonly latencies = [0.1, 0.25, 0.5, 1];
  protected readonly studioVolume = signal(1);

  setStudioVolume(v: number) {
    this.studioVolume.set(v);
    this.store.studio.setVolume(v);
  }

  setLatency(seconds: number) {
    this.prefs.setStudioLatency(seconds);
    this.store.studio.setLatency(seconds);
  }
  protected readonly stageSound = computed(() => {
    const f = this.store.focused();
    if (f === null || f.isLocal || !f.hasAudio) return null;
    return { share: f, label: f.isIngress ? f.ownerName : `${f.ownerName} (${f.kind === 'camera' ? 'câmera' : 'tela'})` };
  });
  /** Quem está na call do Discord mas não está nesta sala do site. */
  protected readonly outside = computed(() => {
    const inside = new Set(this.store.participants().map((p) => p.discordId));
    return this.members().filter((m) => !inside.has(m.id));
  });

  constructor() {
    // Em qualquer sala, se a pessoa está logada e numa call, mostra quem está na call
    // (na sala da call para ver quem falta; numa sala privada para convidar).
    const load = () =>
      callMembers()
        .then((r) => this.members.set(r.people))
        .catch(() => this.members.set([]));
    void load();
    // Vem do cache do bot (não chama a API do Discord), então dá para olhar a cada 2 s.
    const timer = setInterval(load, 2000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  async ping() {
    this.pinging.set(true);
    try {
      const r = await pingCall();
      this.toast.show(`Avisei ${r.count} ${r.count === 1 ? 'pessoa' : 'pessoas'} no chat da call.`);
    } catch (e) {
      this.toast.show(e instanceof Error ? e.message : 'Não foi possível avisar a call.');
    } finally {
      this.pinging.set(false);
    }
  }

  async invite(m: DiscordUser) {
    this.inviting.set(m.id);
    try {
      // Na sala da call, convida para o site (a pessoa entra com o Discord e cai na call);
      // numa sala privada, manda o link desta sala.
      await inviteToRoom(m.id, this.callRoom ? `${location.origin}/` : location.href);
      this.toast.show(`Mandei o link no privado de ${m.name}.`);
    } catch (e) {
      this.toast.show(e instanceof Error ? e.message : 'Não foi possível convidar.');
    } finally {
      this.inviting.set(null);
    }
  }

  privateRoom() {
    // Sai da sala da call e abre uma sala avulsa nova, com chave própria.
    void this.router.navigateByUrl(`/room/${randomRoomName()}#${encodeLink({ key: newKey(), secret: '' })}`);
  }
}
