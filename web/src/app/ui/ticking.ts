import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';

/**
 * Relógios da tela num componente próprio: o tique de cada segundo redesenha só o número, e não a
 * tela da sala inteira (antes o contador de tempo fazia a sala toda ser conferida a cada segundo).
 */
function ticking(everyMs: number) {
  const now = signal(Date.now());
  const t = window.setInterval(() => now.set(Date.now()), everyMs);
  inject(DestroyRef).onDestroy(() => window.clearInterval(t));
  return now;
}

/** Tempo desde `since`, como o contador de uma fita: 00:12:34. */
@Component({
  selector: 'cen-timecode',
  template: `{{ text() }}`,
})
export class Timecode {
  readonly since = input.required<number>();
  private readonly now = ticking(1000);
  protected readonly text = computed(() => {
    const t = Math.max(0, Math.floor((this.now() - this.since()) / 1000));
    const two = (n: number) => String(n).padStart(2, '0');
    return `${two(Math.floor(t / 3600))}:${two(Math.floor((t % 3600) / 60))}:${two(t % 60)}`;
  });
}

/** Quanto falta até `until`, em m:ss. */
@Component({
  selector: 'cen-countdown',
  template: `{{ text() }}`,
})
export class Countdown {
  readonly until = input.required<number>();
  private readonly now = ticking(1000);
  protected readonly text = computed(() => {
    const s = Math.max(0, Math.floor((this.until() - this.now()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });
}
