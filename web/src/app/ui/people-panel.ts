import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { DiscordUser, callMembers, createGuestInvite, inviteToRoom, kickGuest, pingCall } from '../core/api';
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
    @for (st of store.studio.streams(); track st.key) {
      <p class="label">som de estúdio · sem compressão</p>
      <div class="studio">
        <div class="person">
          <span class="name">{{ st.name }}</span>
          <span class="tag">{{ st.source === 'daw' ? 'DAW · ' : '' }}{{ st.bits === 32 ? '32f' : st.bits + '-bit' }} · {{ st.rate / 1000 }} kHz</span>
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
    <p class="label">na sala <span class="count">{{ store.participants().length }}</span></p>
    @for (p of store.participants(); track p.identity) {
      <div class="person" [class.speaking]="p.isSpeaking">
        @if (p.avatar) { <img class="avatar" [src]="p.avatar" alt="" width="22" height="22" /> } @else { <span class="dot"></span> }
        <span class="name">{{ p.name }} @if (p.isLocal) {<span class="you">(você{{ isMobile ? ', no celular' : '' }})</span>} @else if (p.myOtherDevice) {<span class="you">(você, {{ p.mobile ? 'no celular' : 'no PC' }})</span>}</span>
        @if (p.isLocal ? isMobile : p.mobile) { <cen-icon class="device" name="phone" [size]="14" title="Pelo celular" /> }
        @if (p.micEnabled) { <cen-icon name="mic" [size]="14" /> }
        @if (p.isSharing) { <span class="live">AO VIVO</span> }
        @if (p.guest) { <span class="tag" [title]="'Sem Discord. Convidado por ' + (p.invitedBy ?? 'alguém')">convidado</span> }
        @if (p.guest && !p.isLocal && iAmDiscord()) {
          <button type="button" class="btn small kick" [class.danger]="kicking() === p.identity"
            [title]="'Tirar ' + p.name + ' da sala (o convite deixa de valer)'" (click)="kick(p.identity, p.name)">
            {{ kicking() === p.identity ? 'confirmar' : 'expulsar' }}
          </button>
        }
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
      <p class="label">{{ callRoom ? 'na call, fora do site' : 'na sua call do Discord' }} <span class="count">{{ outside().length }}</span></p>
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
      <p class="hint tight">{{ isMobile ? 'Toque em convidar' : 'Passe o mouse para convidar' }}: o bot manda o link no privado.</p>
    }

    @if (callRoom && iAmDiscord()) {
      <p class="label">chamar gente</p>
      <div class="acts">
        <button type="button" class="act" [disabled]="pinging()" (click)="ping()">
          <strong>{{ pinging() ? 'Avisando…' : 'Chamar a call' }}</strong>
          <span>o bot marca todo mundo no chat do canal de voz</span>
        </button>
        <button type="button" class="act" [disabled]="makingGuest()" (click)="guestInvite()"
          title="Link que só uma pessoa usa. Ela escolhe um apelido e entra nesta sala. Qualquer um daqui com Discord pode expulsar.">
          <strong>{{ makingGuest() ? 'Criando…' : 'Convite de 1 uso' }}</strong>
          <span>para quem não tem Discord</span>
        </button>
        <button type="button" class="act" (click)="privateRoom()">
          <strong>Sala privada</strong>
          <span>só com quem você convidar</span>
        </button>
      </div>
    }
    <p class="foot">Os volumes valem só para você. O contorno verde é quem está falando.</p>
  `,
  styles: `
    :host { display: block; }
    .person { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.7rem; }
    .person + cen-volume { display: block; margin: 0.15rem 0 0 calc(22px + 0.5rem); }
    .label .count { color: var(--muted); margin-left: 0.3rem; }
    .tight { margin-top: 0.4rem; }
    .acts { display: grid; gap: 1px; margin-top: 0.5rem; border: 1px solid var(--line-2); border-radius: 6px; overflow: hidden;
      background: var(--line-2); }
    .act { display: grid; gap: 0.1rem; text-align: left; padding: 0.55rem 0.7rem; border: 0; background: var(--surface);
      color: inherit; font: inherit; cursor: pointer; }
    .act:hover:not(:disabled) { background: var(--surface-3); }
    .act:disabled { opacity: 0.6; cursor: default; }
    .act strong { font-size: 0.85rem; font-weight: 600; }
    .act span { font-size: 0.75rem; color: var(--muted); }
    .foot { margin-top: 1rem; font-size: 0.72rem; color: var(--muted); }
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
    .kick { height: 22px; padding: 0 0.5rem; font-size: 0.72rem; }
  `,
})
export class PeoplePanel {
  protected readonly store = inject(RoomStore);
  private readonly toast = inject(Toast);
  private readonly router = inject(Router);
  protected readonly callRoom = isCallRoom();
  protected readonly isMobile = IS_MOBILE;
  /** Entrei com Discord (convidado não gera convite nem expulsa ninguém). */
  protected readonly iAmDiscord = computed(() => this.store.participants().some((p) => p.isLocal && p.discordId !== null));
  protected readonly makingGuest = signal(false);
  protected readonly kicking = signal<string | null>(null);
  private kickTimer?: number;

  async guestInvite() {
    this.makingGuest.set(true);
    try {
      const { id } = await createGuestInvite();
      const link = `${location.origin}/call#convite=${id}`;
      let copied = false;
      try {
        await navigator.clipboard.writeText(link);
        copied = true;
      } catch {
        /* sem permissão de copiar */
      }
      if (!copied && 'share' in navigator) {
        await navigator.share({ title: 'Convite para a call', url: link }).catch(() => undefined);
      } else if (!copied) {
        window.prompt('Copie o convite:', link);
      }
      if (copied) this.toast.show('Convite de 1 uso copiado. Vale por 12 h ou até alguém usar.');
    } catch (e) {
      this.toast.show(e instanceof Error ? e.message : 'Não foi possível criar o convite.');
    } finally {
      this.makingGuest.set(false);
    }
  }

  /** Primeiro clique arma, o segundo (em até 3 s) expulsa. */
  async kick(identity: string, name: string) {
    window.clearTimeout(this.kickTimer);
    if (this.kicking() !== identity) {
      this.kicking.set(identity);
      this.kickTimer = window.setTimeout(() => this.kicking.set(null), 3000);
      return;
    }
    this.kicking.set(null);
    try {
      await kickGuest(identity);
      this.toast.show(`${name} saiu da sala. O convite dele não vale mais.`);
    } catch (e) {
      this.toast.show(e instanceof Error ? e.message : 'Não foi possível expulsar.');
    }
  }
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
    return { share: f, label: f.isIngress ? f.ownerName : f.obs ? `${f.ownerName} (OBS)` : `${f.ownerName} (${f.kind === 'camera' ? 'câmera' : 'tela'})` };
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
      // Convidado (sem Discord) não tem call para olhar.
      this.store.participants().some((p) => p.isLocal && p.guest)
        ? Promise.resolve()
        : callMembers()
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
