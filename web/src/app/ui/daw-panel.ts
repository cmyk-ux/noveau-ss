import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DawPairCode } from '../core/daw';
import { Prefs } from '../core/prefs';
import { RoomStore } from '../core/room-store';
import { Toast } from '../core/toast';

/** Submenu do plugin de DAW: link para instalar, código (salas fora do Discord) e o som dos plugins tocando. */
@Component({
  selector: 'cen-daw-panel',
  template: `
    <p class="hint lead">
      O som da sua DAW na sala, <strong>sem compressão</strong> e na taxa do projeto (até 192 kHz). Sai do plugin
      direto para o servidor: funciona com ASIO e com o site fechado.
    </p>
    <a class="btn primary small wide" href="/plugin" target="_blank" rel="noopener">Instalar o plugin (passo a passo)</a>

    @if (callRoom) {
      <p class="hint">Nesta sala da call é só clicar em <strong>Conectar com o Discord</strong> no plugin, uma vez.
        Depois ele toca sozinho para a call em que você estiver.</p>
    } @else {
      <p class="label">código desta sala</p>
      @if (code(); as c) {
        <div class="code">
          <span class="mono big">{{ c.code }}</span>
          <button type="button" class="btn small" (click)="copy(c.code)">copiar</button>
        </div>
        <p class="hint mono">vale por {{ left(c.expiresAt) }} · só uma vez</p>
      }
      <button type="button" class="btn small wide" [disabled]="busy()" (click)="newCode()">
        {{ code() === null ? 'Gerar código para o plugin' : 'Gerar outro código' }}
      </button>
      <p class="hint">Digite no campo "código da sala" do plugin. Ele volta sozinho para esta sala por 24 h.</p>
    }

    <p class="label">plugins na sala</p>
    @for (st of dawStreams(); track st.key) {
      <div class="stream">
        <div class="row">
          <span class="name">{{ st.name }}</span>
          <span class="tag">{{ st.bits === 32 ? '32-bit float' : st.bits + '-bit' }} · {{ khz(st.rate) }} kHz{{ st.channels === 1 ? ' · mono' : '' }}</span>
        </div>
        <div class="row">
          <input type="range" min="0" max="1" step="0.01" [value]="store.studio.dawVolumeOf(st.key)" aria-label="Volume do plugin"
            (input)="store.studio.setDawVolume(st.key, +$any($event.target).value)" />
        </div>
        <p class="hint mono">
          @if (st.idle) {
            parada · nada tocando na DAW
          } @else {
          buffer {{ (st.level * 1000).toFixed(0) }} / {{ (st.target * 1000).toFixed(0) }} ms
          @if (!st.playing) { · carregando }
          }
          @if (st.underruns > 0) { · {{ st.underruns }} engasgo(s) }
          @if (st.lost > 0) { · {{ st.lost }} pacote(s) perdido(s) }
        </p>
      </div>
    } @empty {
      <p class="hint">Nenhum plugin conectado nesta sala.
        @if (!store.daw.connected()) { <span class="warn">Sem conexão com o servidor do plugin, tentando de novo…</span> }</p>
    }

    <p class="label">atraso de quem ouve</p>
    <div class="chips">
      @for (l of latencies; track l) {
        <button type="button" class="chip" [class.lit]="l === prefs.studioLatency()" (click)="setLatency(l)">{{ l * 1000 }} ms</button>
      }
    </div>
    <p class="hint">Engasgando? Aumente o atraso. Vale para o plugin e para o modo estúdio da tela, só para você.</p>
  `,
  styles: `
    :host { display: block; }
    .lead { margin-top: 0; }
    .code { display: flex; align-items: center; gap: 0.6rem; margin: 0.4rem 0 0.2rem; padding: 0.45rem 0.6rem;
      border: 1px solid var(--line-2); border-radius: 6px; background: #09080c; box-shadow: inset 0 1px 4px #000a; }
    .big { flex: 1; font-size: 1.35rem; letter-spacing: 0.14em; color: var(--text); }
    .wide { width: 100%; margin-top: 0.4rem; }
    .stream { border: 1px solid var(--line-2); border-radius: 6px; padding: 0.25rem 0.6rem 0.5rem; margin-top: 0.4rem;
      background: #09080c; box-shadow: inset 0 1px 4px #000a; }
    .row { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.4rem; }
    .row input[type=range] { flex: 1; accent-color: var(--accent); }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chips { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.4rem; }
    .warn { color: var(--warn, #c9a227); }
  `,
})
export class DawPanel {
  protected readonly store = inject(RoomStore);
  protected readonly prefs = inject(Prefs);
  private readonly toast = inject(Toast);
  protected readonly callRoom = this.store.isCallRoom;
  protected readonly latencies = [0.1, 0.25, 0.5, 1];
  protected readonly code = signal<DawPairCode | null>(null);
  protected readonly busy = signal(false);
  private readonly now = signal(Date.now());
  protected readonly dawStreams = computed(() => this.store.studio.streams().filter((s) => s.source === 'daw'));

  constructor() {
    const tick = window.setInterval(() => {
      this.now.set(Date.now());
      const c = this.code();
      if (c !== null && c.expiresAt <= Date.now()) this.code.set(null);
    }, 1000);
    inject(DestroyRef).onDestroy(() => window.clearInterval(tick));
  }

  async newCode() {
    this.busy.set(true);
    try {
      this.code.set(await this.store.dawCode());
    } catch (e) {
      this.toast.show(e instanceof Error ? e.message : 'Não foi possível gerar o código.');
    } finally {
      this.busy.set(false);
    }
  }

  async copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      this.toast.show('Código copiado.');
    } catch {
      /* sem permissão de área de transferência: o código está à vista */
    }
  }

  setLatency(seconds: number) {
    this.prefs.setStudioLatency(seconds);
    this.store.studio.setLatency(seconds);
  }

  protected left(at: number) {
    const s = Math.max(0, Math.round((at - this.now()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  protected khz(rate: number) {
    return (rate / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  }
}
