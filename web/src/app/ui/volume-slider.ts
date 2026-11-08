import { Component, computed, input, output } from '@angular/core';
import { describeVolume, isSilent, Volume, volumeIcon } from '../core/volume';
import { Icon } from './icon';

/**
 * Trilho do controle: 0..100 = 0..100%, depois um trecho "travado" em 100% (STICKY passos,
 * é preciso arrastar mais para passar), e daí até 200%.
 */
const STICKY = 18;
const SLIDER_MAX = 200 + STICKY;

function levelAt(pos: number): number {
  if (pos <= 100) return pos / 100;
  if (pos <= 100 + STICKY) return 1;
  return (pos - STICKY) / 100;
}

function positionOf(level: number): number {
  const pct = Math.round(level * 100);
  return pct <= 100 ? pct : pct + STICKY;
}

@Component({
  selector: 'cen-volume',
  imports: [Icon],
  template: `
    <button type="button" class="mute" [class.silent]="silent()" [title]="muteLabel()" [attr.aria-label]="muteLabel()"
      (click)="muteToggle.emit()">
      <cen-icon [name]="icon()" [size]="16" />
    </button>
    <input type="range" min="0" [max]="SLIDER_MAX" step="1" [value]="position()" [attr.aria-label]="label()"
      [attr.aria-valuetext]="readout()" (input)="levelChange.emit(levelAt(+$any($event.target).value))" />
    <span class="readout mono" [class.boost]="boosted()">{{ readout() }}</span>
  `,
  styles: `
    :host { display: flex; align-items: center; gap: 0.5rem; width: 100%; }
    .mute { background: none; border: 0; padding: 4px; display: grid; place-items: center; color: var(--muted); }
    .mute.silent { color: var(--danger); }
    input { flex: 1; min-width: 0; accent-color: var(--accent); }
    .readout { width: 3.2rem; text-align: right; font-size: 0.8rem; color: var(--muted); }
    .readout.boost { color: var(--danger); font-weight: 700; }
  `,
})
export class VolumeSlider {
  protected readonly SLIDER_MAX = SLIDER_MAX;
  protected readonly levelAt = levelAt;
  readonly volume = input.required<Volume>();
  readonly label = input.required<string>();
  readonly levelChange = output<number>();
  readonly muteToggle = output<void>();
  protected readonly silent = computed(() => isSilent(this.volume()));
  protected readonly icon = computed(() => volumeIcon(this.volume()));
  protected readonly position = computed(() => positionOf(this.volume().level));
  /** Acima de 100%: pode distorcer, número em vermelho. */
  protected readonly boosted = computed(() => !this.volume().muted && this.volume().level > 1.001);
  protected readonly readout = computed(() => describeVolume(this.volume()));
  protected readonly muteLabel = computed(() => (this.volume().muted ? `Ativar ${this.label()}` : `Silenciar ${this.label()}`));
}
