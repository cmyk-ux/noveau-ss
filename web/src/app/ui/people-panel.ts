import { Component, computed, inject } from '@angular/core';
import { RoomStore } from '../core/room-store';
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
  `,
})
export class PeoplePanel {
  protected readonly store = inject(RoomStore);
  protected readonly stageSound = computed(() => {
    const f = this.store.focused();
    if (f === null || f.isLocal || !f.hasAudio) return null;
    return { share: f, label: f.isIngress ? f.ownerName : `${f.ownerName} (${f.kind === 'camera' ? 'câmera' : 'tela'})` };
  });
}
