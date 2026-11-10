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
      <cen-icon [name]="icon()" [size]="15" />
    </button>
    <span class="rail" [class.muted]="volume().muted" [class.boost]="boosted()" [style.--fill]="fill()">
      <input type="range" min="0" [max]="SLIDER_MAX" step="1" [value]="position()" [attr.aria-label]="label()"
        [attr.aria-valuetext]="readout()" (input)="levelChange.emit(levelAt(+$any($event.target).value))" />
    </span>
    <span class="readout" [class.boost]="boosted()" [class.silent]="silent()">{{ readout() }}</span>
  `,
  styles: `
    :host { display: flex; align-items: center; gap: 0.45rem; width: 100%; }
    .mute { background: none; border: 0; padding: 3px; display: grid; place-items: center; color: var(--muted); border-radius: 2px;
      transition: color 120ms, transform 60ms linear; }
    .mute:hover { color: var(--text); }
    .mute:active { transform: translateY(1px); }
    .mute.silent { color: var(--danger); }
    /* Fader: canaleta funda e um botão de chapa dura com a linha do meio. Acima de 100% a canaleta fica âmbar. */
    .rail { position: relative; flex: 1; min-width: 0; height: 22px; display: flex; align-items: center; --fill: 0%; --t: 5.5px; }
    .rail::before { content: ''; position: absolute; left: 0; right: 0; top: 50%; height: 4px; margin-top: -2px; border-radius: 1px;
      background: linear-gradient(90deg, var(--accent) 0 var(--fill), transparent var(--fill)) 0 0 / 100% 100% no-repeat, var(--well);
      box-shadow: var(--inset); }
    .rail.boost::before { background:
        linear-gradient(90deg, var(--accent) 0 calc(var(--t) + (100% - 2 * var(--t)) * 0.4587), var(--warn) calc(var(--t) + (100% - 2 * var(--t)) * 0.4587) var(--fill), transparent var(--fill)) 0 0 / 100% 100% no-repeat,
        var(--well); }
    .rail.muted::before { background: var(--well); }
    /* Só um risco no 100%, onde o controle trava. */
    .rail::after { content: ''; position: absolute; left: calc(var(--t) + (100% - 2 * var(--t)) * 0.4587); top: 4px; bottom: 4px; width: 1px;
      background: var(--faint); pointer-events: none; }
    input { position: relative; z-index: 1; width: 100%; height: 22px; margin: 0; background: transparent; cursor: pointer;
      -webkit-appearance: none; appearance: none; }
    input::-webkit-slider-runnable-track { height: 22px; background: transparent; }
    input::-moz-range-track { height: 22px; background: transparent; }
    input::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 11px; height: 16px; margin-top: 3px; border-radius: 2px;
      border: 1px solid #0b0b0c; box-shadow: var(--key-shadow);
      background: linear-gradient(90deg, transparent 4px, var(--muted) 4px 5px, transparent 5px), var(--plate-hi); }
    input::-moz-range-thumb { width: 9px; height: 14px; border-radius: 2px; border: 1px solid #0b0b0c; box-shadow: var(--key-shadow);
      background: linear-gradient(90deg, transparent 3px, var(--muted) 3px 4px, transparent 4px), var(--plate-hi); }
    input:active::-webkit-slider-thumb { box-shadow: var(--key-pressed); }
    input:focus-visible { outline: none; }
    input:focus-visible::-webkit-slider-thumb { outline: 1px dashed var(--accent-hi); outline-offset: 2px; }
    .readout { flex-shrink: 0; width: 2.9rem; text-align: right; font: 400 0.74rem/1 var(--mono); color: var(--muted); }
    .readout.boost { color: var(--warn); }
    .readout.silent { color: var(--danger); }
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
  /** Quanto da canaleta pinta, em % do trilho. */
  protected readonly fill = computed(() => `calc(5.5px + (100% - 11px) * ${(this.position() / SLIDER_MAX).toFixed(4)})`);
  /** Acima de 100%: pode distorcer, número em vermelho. */
  protected readonly boosted = computed(() => !this.volume().muted && this.volume().level > 1.001);
  protected readonly readout = computed(() => describeVolume(this.volume()));
  protected readonly muteLabel = computed(() => (this.volume().muted ? `Ativar ${this.label()}` : `Silenciar ${this.label()}`));
}
