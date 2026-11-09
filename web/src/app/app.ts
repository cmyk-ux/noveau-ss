import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Toast } from './core/toast';

@Component({
  selector: 'cen-root',
  imports: [RouterOutlet],
  template: `
    <router-outlet />
    @if (toast.message(); as message) {
      <div class="toast" role="status">{{ message }}</div>
    }
  `,
  styles: `
    /* Aviso como um recibo saindo da impressora: papel claro, texto em mono, borda serrilhada. */
    .toast {
      position: fixed; bottom: 6.2rem; left: 50%; translate: -50% 0; z-index: 60; max-width: min(440px, calc(100vw - 2rem));
      padding: 0.6rem 1rem 0.75rem; background: #ddd6c6; color: #1d1b17; font: 500 0.8rem/1.45 var(--mono);
      border-radius: 2px; box-shadow: 0 14px 40px -12px #000, 0 0 0 1px #000;
      -webkit-mask: radial-gradient(4px at 50% 100%, #0000 98%, #000) 50% 100% / 10px 100% repeat-x;
      mask: radial-gradient(4px at 50% 100%, #0000 98%, #000) 50% 100% / 10px 100% repeat-x;
      animation: print 340ms steps(8) both;
    }
  `,
})
export class App {
  protected readonly toast = inject(Toast);
}
