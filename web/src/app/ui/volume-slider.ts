import { Component, computed, input, output } from '@angular/core';
import { describeVolume, isSilent, Volume, volumeIcon } from '../core/volume';
import { Icon } from './icon';

@Component({
  selector: 'cen-volume',
  imports: [Icon],
  template: `
    <button type="button" class="mute" [class.silent]="silent()" [title]="muteLabel()" [attr.aria-label]="muteLabel()"
      (click)="muteToggle.emit()">
      <cen-icon [name]="icon()" [size]="16" />
    </button>
    <input type="range" min="0" max="100" step="1" [value]="percent()" [attr.aria-label]="label()"
      [attr.aria-valuetext]="readout()" (input)="levelChange.emit(+$any($event.target).value / 100)" />
    <span class="readout mono">{{ readout() }}</span>
  `,
  styles: `
    :host { display: flex; align-items: center; gap: 0.5rem; width: 100%; }
    .mute { background: none; border: 0; padding: 4px; display: grid; place-items: center; color: var(--muted); }
    .mute.silent { color: var(--danger); }
    input { flex: 1; min-width: 0; accent-color: var(--accent); }
    .readout { width: 3.2rem; text-align: right; font-size: 0.8rem; color: var(--muted); }
  `,
})
export class VolumeSlider {
  readonly volume = input.required<Volume>();
  readonly label = input.required<string>();
  readonly levelChange = output<number>();
  readonly muteToggle = output<void>();
  protected readonly silent = computed(() => isSilent(this.volume()));
  protected readonly icon = computed(() => volumeIcon(this.volume()));
  protected readonly percent = computed(() => Math.round(this.volume().level * 100));
  protected readonly readout = computed(() => describeVolume(this.volume()));
  protected readonly muteLabel = computed(() => (this.volume().muted ? `Ativar ${this.label()}` : `Silenciar ${this.label()}`));
}
