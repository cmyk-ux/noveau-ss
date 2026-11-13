import { Component, inject } from '@angular/core';
import { RoomStore } from '../core/room-store';
import { Icon } from './icon';

/**
 * "Me ouvir": teste do microfone, ao lado do X do menu do microfone e da janela da voz (o mesmo em
 * qualquer aba). Ligado, você ouve a sua voz tratada e mais nada: a sala não te ouve e você não ouve
 * a sala até parar (ver RoomSession.selfTest).
 */
@Component({
  selector: 'cen-listen-button',
  imports: [Icon],
  template: `
    <button type="button" class="listen" [class.on]="store.micMonitor()" [attr.aria-pressed]="store.micMonitor()" [disabled]="!store.ownMicOn()"
      (click)="store.toggleMicMonitor()" [title]="title()">
      <cen-icon name="headphones" [size]="14" />
      <span>{{ store.micMonitor() ? 'parar teste' : 'me ouvir' }}</span>
      @if (store.micMonitor()) { <i class="wave" aria-hidden="true"><b></b><b></b><b></b></i> }
    </button>
  `,
  styles: `
    :host { display: inline-flex; }
    .listen {
      display: inline-flex; align-items: center; gap: 0.35rem; height: 26px; padding: 0 0.6rem;
      border: 1px solid var(--line-2); border-radius: 13px; background: var(--surface-3); color: var(--text);
      font: 500 0.74rem var(--mono); letter-spacing: 0.02em; cursor: pointer; white-space: nowrap;
    }
    .listen:hover:not(:disabled) { border-color: var(--accent-hi); }
    .listen:disabled { opacity: 0.45; cursor: default; }
    .listen.on { background: var(--accent); border-color: var(--accent-hi); color: var(--accent-ink); box-shadow: 0 0 0 3px var(--accent-glow); animation: listen-in 240ms steps(3) both; }
    @keyframes listen-in { from { box-shadow: 0 0 0 0 var(--accent-glow); } }
    /* Três barrinhas subindo e descendo: está tocando a sua voz. */
    .wave { display: inline-flex; align-items: flex-end; gap: 2px; height: 10px; }
    .wave b { width: 2px; height: 100%; background: currentColor; border-radius: 1px; animation: wave 900ms steps(4) infinite; transform-origin: bottom; }
    .wave b:nth-child(2) { animation-delay: -300ms; }
    .wave b:nth-child(3) { animation-delay: -600ms; }
    @keyframes wave { 0%, 100% { transform: scaleY(0.3); } 50% { transform: scaleY(1); } }
    @media (prefers-reduced-motion: reduce) { .wave b, .listen.on { animation: none; } }
  `,
})
export class ListenButton {
  protected readonly store = inject(RoomStore);

  protected title() {
    if (!this.store.ownMicOn()) return 'Ligue o microfone para se testar';
    return this.store.micMonitor()
      ? 'Parar o teste: a sala volta a te ouvir e você volta a ouvir a sala'
      : 'Testar o microfone: você ouve a sua voz já tratada. Enquanto testa, a sala não te ouve e você não ouve ninguém. Use fone.';
  }
}

/** Aviso enquanto o teste do microfone está ligado (embaixo do cabeçalho). */
@Component({
  selector: 'cen-listen-note',
  template: `
    @if (store.micMonitor()) {
      <p class="note" role="status">Testando o microfone: só você se ouve. A sala não te escuta e você não ouve ninguém até parar.</p>
    }
  `,
  styles: `
    .note { margin: 0.2rem 0 0.5rem; padding: 0.4rem 0.6rem; border-left: 2px solid var(--accent-hi); background: var(--accent-glow);
      color: var(--text); font-size: 0.78rem; line-height: 1.35; border-radius: 2px; animation: note-in 200ms steps(3) both; }
    @keyframes note-in { from { clip-path: inset(0 100% 0 0); } }
    @media (prefers-reduced-motion: reduce) { .note { animation: none; } }
  `,
})
export class ListenNote {
  protected readonly store = inject(RoomStore);
}
