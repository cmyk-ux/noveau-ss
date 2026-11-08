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
    .toast {
      position: fixed; bottom: 6.5rem; left: 50%; transform: translateX(-50%); z-index: 30;
      background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius);
      padding: 0.55rem 1.1rem; font-size: 0.9rem;
    }
  `,
})
export class App {
  protected readonly toast = inject(Toast);
}
