import { Component, computed, input, output, signal } from '@angular/core';
import { Icon } from './icon';

/** Até onde a bolinha anda dentro do trilho (px) e a partir de onde ela trava. */
const TRAVEL = 30;
const LOCK_AT = 22;

/**
 * Botão de conversa direta, numa pessoa da lista.
 * Segurar = fala e ouve só com ela enquanto segura. Segurar e arrastar para a direita até o
 * cadeado = fica travado (conversa a dois) até alguém desligar. Travado, um clique desliga.
 * Teclado: segurar Espaço = segurar; Enter = travar/destravar.
 */
@Component({
  selector: 'cen-direct-key',
  imports: [Icon],
  template: `
    <button type="button" class="slot" [class.held]="state() === 'hold'" [class.armed]="armed()" [class.locked]="state() === 'lock'"
      [disabled]="disabled()" [attr.aria-pressed]="state() !== 'idle'" [attr.aria-label]="title()" [title]="title()"
      (pointerdown)="down($event)" (pointermove)="move($event)" (pointerup)="up()" (pointercancel)="cancel()"
      (lostpointercapture)="cancel()" (contextmenu)="$event.preventDefault()"
      (keydown)="keyDown($event)" (keyup)="keyUp($event)" (blur)="cancel()">
      <span class="lock" aria-hidden="true"><cen-icon name="lock" [size]="10" /></span>
      <span class="knob" aria-hidden="true" [style.transform]="'translateX(' + knobX() + 'px)'"><cen-icon name="direct" [size]="12" /></span>
    </button>
  `,
  styles: `
    :host { display: inline-flex; flex-shrink: 0; }
    /* Um trilho rebaixado com uma tecla que desliza até o cadeado. */
    .slot { position: relative; width: 56px; height: 24px; padding: 0; border: 0; border-radius: 2px; cursor: grab;
      background: var(--well); box-shadow: var(--inset); color: var(--faint); touch-action: none; user-select: none;
      -webkit-user-select: none; -webkit-touch-callout: none; }
    .slot:disabled { opacity: 0.4; cursor: not-allowed; }
    .slot.held { cursor: grabbing; }
    .lock { position: absolute; right: 6px; top: 50%; translate: 0 -50%; display: grid; place-items: center; transition: color 100ms; }
    .armed .lock, .locked .lock { color: var(--accent-hi); }
    .knob { position: absolute; left: 2px; top: 2px; width: 20px; height: 20px; display: grid; place-items: center;
      border-radius: 2px; border: 1px solid #0b0b0c; background: var(--plate); color: var(--muted); box-shadow: var(--key-shadow);
      transition: transform 140ms steps(4), background 100ms, color 100ms; }
    .slot:hover:not(:disabled) .knob { background: var(--plate-hi); color: var(--text); }
    /* Segurando: a tecla afunda e acende. Travada: fica no cadeado, acesa. */
    .slot.held:not(:disabled) .knob { transition: background 100ms, color 100ms; box-shadow: var(--key-pressed); background: var(--accent); color: #fff; }
    .slot.locked:not(:disabled) .knob { background: var(--accent); color: #fff; }
  `,
})
export class DirectKey {
  readonly name = input.required<string>();
  /** Como está a conversa direta com esta pessoa. */
  readonly state = input<'idle' | 'hold' | 'lock'>('idle');
  readonly disabled = input(false);
  readonly hold = output<void>();
  readonly release = output<void>();
  readonly lock = output<void>();
  readonly unlock = output<void>();

  private readonly dx = signal(0);
  private pressing = false;
  private startX = 0;
  private wasLocked = false;
  protected readonly armed = computed(() => this.dx() >= LOCK_AT);
  protected readonly knobX = computed(() => (this.state() === 'lock' && !this.pressing ? TRAVEL : this.dx()));
  protected readonly title = computed(() =>
    this.state() === 'lock'
      ? `Falando só com ${this.name()}. Clique para voltar a falar com todos.`
      : `Segure para falar só com ${this.name()}. Segure e arraste até o cadeado para continuar só com ${this.name()}.`,
  );

  down(e: PointerEvent) {
    if (e.button !== 0 || this.disabled()) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    (e.currentTarget as HTMLElement).focus();
    this.pressing = true;
    this.startX = e.clientX;
    this.wasLocked = this.state() === 'lock';
    this.dx.set(0);
    if (!this.wasLocked) this.hold.emit();
  }

  move(e: PointerEvent) {
    if (!this.pressing || this.wasLocked) return;
    this.dx.set(Math.max(0, Math.min(TRAVEL, e.clientX - this.startX)));
  }

  up() {
    if (!this.pressing) return;
    this.pressing = false;
    const armed = this.armed();
    this.dx.set(0);
    if (this.wasLocked) this.unlock.emit();
    else if (armed) this.lock.emit();
    else this.release.emit();
  }

  /** Perdeu o toque (janela trocou, rolou a página): solta sem travar. */
  cancel() {
    if (!this.pressing) return;
    this.pressing = false;
    this.dx.set(0);
    if (!this.wasLocked) this.release.emit();
  }

  keyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;
      if (this.state() === 'lock') this.unlock.emit();
      else this.lock.emit();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (e.repeat || this.state() === 'lock' || this.pressing) return;
      this.pressing = true;
      this.wasLocked = false;
      this.hold.emit();
    }
  }

  keyUp(e: KeyboardEvent) {
    if (e.key !== ' ' || !this.pressing) return;
    e.preventDefault();
    this.pressing = false;
    this.release.emit();
  }
}
