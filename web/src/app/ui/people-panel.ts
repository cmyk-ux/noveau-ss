import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DiscordUser, callMembers, pingCall } from '../core/api';
import { isCallRoom } from '../core/link';
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
    <p class="label">na sala</p>
    @for (p of store.participants(); track p.identity) {
      <div class="person" [class.speaking]="p.isSpeaking">
        <span class="dot"></span>
        <span class="name">{{ p.name }} @if (p.isLocal) {<span class="you">(você)</span>}</span>
        @if (p.micEnabled) { <cen-icon name="mic" [size]="14" /> }
        @if (p.isSharing) { <span class="live">AO VIVO</span> }
      </div>
      @if (!p.isLocal) {
        <cen-volume [volume]="p.volume" [label]="'a voz de ' + p.name"
          (levelChange)="store.setVolume('mic', p.identity, $event)"
          (muteToggle)="store.toggleMute('mic', p.identity)" />
      }
    }
    @if (callRoom) {
      @if (outside().length > 0) {
        <p class="label">na call, fora do site</p>
        @for (m of outside(); track m.id) {
          <div class="person outside">
            @if (m.avatar) { <img [src]="m.avatar" alt="" width="20" height="20" /> } @else { <span class="dot"></span> }
            <span class="name">{{ m.name }}</span>
            <span class="tag">fora</span>
          </div>
        }
      }
      <button type="button" class="btn small wide ping" [disabled]="pinging()" (click)="ping()">
        {{ pinging() ? 'Avisando…' : 'Chamar a call no Discord' }}
      </button>
      <p class="hint">O bot marca todo mundo da call no chat do canal de voz com o link do site.</p>
    }
    <p class="hint">O ponto acende em quem está falando. Os volumes aqui valem só para você.</p>
  `,
  styles: `
    :host { display: block; }
    .person { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.6rem; }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .you { color: var(--muted); font-size: 0.85rem; margin-left: 0.25rem; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); flex-shrink: 0; }
    .speaking .dot { background: var(--ok); box-shadow: 0 0 0 3px #5cc88a33; }
    .live { font-size: 0.7rem; font-weight: 700; color: var(--danger); }
    .outside { color: var(--muted); }
    .outside img { border-radius: 50%; opacity: 0.6; filter: grayscale(1); }
    .tag { font-size: 0.7rem; border: 1px solid var(--line); border-radius: 4px; padding: 0 0.3rem; }
    .ping { margin-top: 1rem; }
  `,
})
export class PeoplePanel {
  protected readonly store = inject(RoomStore);
  private readonly toast = inject(Toast);
  protected readonly callRoom = isCallRoom();
  private readonly members = signal<DiscordUser[]>([]);
  protected readonly pinging = signal(false);
  /** Quem está na call do Discord mas ainda não abriu o site. */
  protected readonly outside = computed(() => {
    const inside = new Set(this.store.participants().map((p) => p.discordId));
    return this.members().filter((m) => !inside.has(m.id));
  });

  constructor() {
    if (!this.callRoom) return;
    const load = () =>
      callMembers()
        .then((r) => this.members.set(r.people))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 5000);
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
  protected readonly stageSound = computed(() => {
    const f = this.store.focused();
    if (f === null || f.isLocal || !f.hasAudio) return null;
    return { share: f, label: f.isIngress ? f.ownerName : `${f.ownerName} (${f.kind === 'camera' ? 'câmera' : 'tela'})` };
  });
}
