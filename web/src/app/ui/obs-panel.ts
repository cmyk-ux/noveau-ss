import { Component, computed, inject, signal } from '@angular/core';
import { ObsKey } from '../core/api';
import { RoomStore } from '../core/room-store';
import { Toast } from '../core/toast';

/**
 * Submenu "OBS": endereço e chave para o OBS transmitir direto para a sala por WHIP.
 * O OBS codifica na placa de vídeo e o servidor só repassa (não recodifica), então chega para
 * quem assiste exatamente o que o OBS mandou.
 */
@Component({
  selector: 'cen-obs-panel',
  template: `
    <p class="hint lead">
      Transmita a tela (ou uma cena inteira) pelo <strong>OBS 30 ou mais novo</strong>. O OBS codifica na placa de vídeo
      e o servidor só repassa, sem recodificar: chega para a sala o que sai do OBS, com o som em estéreo.
    </p>

    @for (s of live(); track s.id) {
      <p class="on-air mono"><span class="led live"></span>{{ s.ownerName }} no ar pelo OBS</p>
    }

    @if (key(); as k) {
      <p class="label">servidor</p>
      <div class="field">
        <span class="mono value">{{ server }}</span>
        <button type="button" class="btn small" (click)="copy(server, 'Servidor copiado.')">copiar</button>
      </div>
      <p class="label">bearer token</p>
      <div class="field">
        <span class="mono value secret">{{ shown() ? k.token : '••••••••••••••••••••' }}</span>
        <button type="button" class="btn small" (click)="shown.set(!shown())">{{ shown() ? 'esconder' : 'ver' }}</button>
        <button type="button" class="btn small" (click)="copy(k.token, 'Chave copiada.')">copiar</button>
      </div>
      <p class="hint">
        @if (k.followsCall) {
          Essa chave é sua e <strong>segue a call do Discord</strong> em que você estiver quando apertar "Iniciar transmissão".
          Vale por 1 ano. Saiu da call, o OBS sai da sala junto.
        } @else {
          Essa chave transmite <strong>nesta sala</strong> e vale por 30 dias. Não passe para ninguém.
        }
      </p>
    } @else {
      <button type="button" class="btn primary small wide" [disabled]="busy()" (click)="fetchKey()">
        {{ busy() ? 'Pedindo…' : 'Mostrar o endereço e a chave' }}
      </button>
    }

    <p class="label">no OBS</p>
    <ol class="steps">
      <li><strong>Configurações → Transmissão</strong>: Serviço <em>WHIP</em>, cole o Servidor e o Bearer Token.</li>
      <li><strong>Saída</strong> (modo Avançado): codificador <em>NVIDIA NVENC H.264</em> (ou AMD/QuickSync H.264),
        controle <em>CBR</em>, a taxa que você usa no site (ex.: 12000–20000 Kbps em 1080p60),
        <strong>intervalo de quadro-chave 1 s</strong>.</li>
      <li><strong>Áudio</strong>: 48 kHz, estéreo; na Saída, bitrate do áudio no máximo (Opus).</li>
      <li>Aperte <strong>Iniciar transmissão</strong>. Aparece aqui como a tela de {{ me() }}.</li>
    </ol>
    <p class="hint">
      Por que 1 s: o OBS não atende pedido de quadro-chave, então quem entra ou perde um pacote espera o próximo.
      H.264 toca em todo navegador; AV1 só se todos da sala tiverem placa/navegador recentes (não há conversão no servidor).
    </p>
    <p class="hint">
      <strong>OBS 32.1 ou mais novo</strong>: em Transmissão, ponha <em>2 camadas</em> de simulcast (no máximo 3). Quem
      não aguenta a qualidade cheia recebe a cópia menor sozinho, em vez de travar; os outros continuam no máximo.
    </p>
  `,
  styles: `
    :host { display: block; }
    .lead { margin-top: 0; }
    .wide { width: 100%; margin-top: 0.4rem; }
    .field { display: flex; align-items: center; gap: 0.4rem; margin: 0.3rem 0 0.2rem; padding: 0.4rem 0.55rem;
      border: 1px solid var(--line-2); border-radius: 6px; background: #09080c; box-shadow: inset 0 1px 4px #000a; }
    .value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.78rem; color: var(--text); }
    .on-air { display: flex; align-items: center; gap: 0.4rem; margin: 0 0 0.4rem; color: var(--danger);
      font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.16em; }
    .steps { margin: 0.35rem 0 0; padding-left: 1.2rem; font-size: 0.82rem; line-height: 1.5; }
    .steps li + li { margin-top: 0.3rem; }
  `,
})
export class ObsPanel {
  protected readonly store = inject(RoomStore);
  private readonly toast = inject(Toast);
  protected readonly key = signal<ObsKey | null>(null);
  protected readonly busy = signal(false);
  protected readonly shown = signal(false);
  protected readonly server = `${location.origin}/api/whip`;
  protected readonly live = computed(() => this.store.shares().filter((s) => s.obs));
  protected readonly me = computed(() => this.store.participants().find((p) => p.isLocal)?.name ?? 'você');

  async fetchKey() {
    this.busy.set(true);
    try {
      this.key.set(await this.store.obsKey());
    } catch (e) {
      this.toast.show(e instanceof Error ? e.message : 'Não foi possível pegar a chave do OBS.');
    } finally {
      this.busy.set(false);
    }
  }

  async copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.show(done);
    } catch {
      this.shown.set(true); // sem área de transferência: mostra para copiar à mão
    }
  }
}
