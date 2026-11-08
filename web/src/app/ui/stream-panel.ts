import { Component, computed, inject } from '@angular/core';
import { Prefs } from '../core/prefs';
import { RoomStore } from '../core/room-store';
import { lackOf } from '../core/stats';
import {
  CodecChoice,
  FRAME_RATES,
  formatBitrate,
  MODES,
  pickCodec,
  planBitrate,
  planFor,
  Resolution,
  RESOLUTIONS,
  resolutionLabel,
  StreamMode,
  supportedCodecs,
} from '../core/stream';

/** Qualidade da transmissão da tela. */
@Component({
  selector: 'cen-stream-panel',
  template: `
    <div class="head">
      <p class="label">modo de transmissão</p>
      @if (sharing()) { <span class="on-air">no ar</span> }
    </div>
    @if (changedWhileLive()) {
      <div class="apply">
        <span>A transmissão ainda está com os ajustes antigos.</span>
        <button class="btn small primary" (click)="store.restartShare()">Aplicar agora</button>
      </div>
    }
    @for (m of modes; track m.id) {
      <button type="button" class="option" [class.lit]="m.id === settings().mode" (click)="pickMode(m.id)">
        <strong>{{ m.label }}</strong><span>{{ m.description }}</span>
      </button>
    }
    @if (settings().mode === 'custom') {
      <p class="label">resolução</p>
      <div class="chips">
        @for (r of resolutions; track r.id) {
          <button type="button" class="chip" [class.lit]="r.id === settings().resolution" (click)="pickResolution(r.id)">{{ r.label }}</button>
        }
      </div>
      <p class="label">quadros por segundo</p>
      <div class="chips">
        @for (f of frameRates; track f) {
          <button type="button" class="chip" [class.lit]="f === settings().frameRate" (click)="pickFrameRate(f)">{{ f }}fps</button>
        }
      </div>
    }

    <p class="label">som</p>
    <label class="switch">
      <input type="checkbox" [checked]="prefs.shareAudio()" (change)="prefs.setShareAudio(!prefs.shareAudio())" />
      <span>Compartilhar o áudio</span>
    </label>
    <p class="hint">Marque também a caixa de áudio na janela do navegador. Ela só aparece para uma aba, ou para a tela inteira no Windows.</p>

    @if (prefs.shareAudio()) {
      <p class="label">qualidade do som</p>
      <div class="chips">
        <button type="button" class="chip" [class.lit]="prefs.studio() === 'off'" (click)="prefs.setStudio('off')">Opus (leve)</button>
        <button type="button" class="chip" [class.lit]="prefs.studio() === '16'" (click)="prefs.setStudio('16')">Estúdio 16-bit</button>
        <button type="button" class="chip" [class.lit]="prefs.studio() === '24'" (click)="prefs.setStudio('24')">Estúdio 24-bit</button>
      </div>
      <p class="hint">
        @if (prefs.studio() === 'off') {
          Opus comprime o som (bom para voz, jogo e vídeo).
        } @else {
          Sem compressão nenhuma: o som sai exatamente como o navegador está tocando, a 48 kHz.
          Gasta {{ prefs.studio() === '16' ? '1,5' : '2,3' }} Mbps de upload por pessoa assistindo e chega com
          um atraso de ~0,25 s. Para música, compartilhe a <strong>aba</strong> do site com "compartilhar áudio da aba".
        }
      </p>
    }

    <p class="label">codec</p>
    <div class="chips">
      @for (c of codecs(); track c) {
        <button type="button" class="chip" [class.lit]="c === prefs.codec()" (click)="prefs.setCodec(c)">{{ c.toUpperCase() }}</button>
      }
    </div>
    <p class="hint">VP9 comprime melhor, bom pra conexão limitada, mas gasta mais CPU. VP8 é mais leve quando a máquina é o gargalo. H.264 fica limitado a 20 Mbps.</p>

    <label class="switch">
      <input type="checkbox" [checked]="prefs.maxCompatibility()" (change)="prefs.setMaxCompatibility(!prefs.maxCompatibility())" />
      <span>Máxima compatibilidade</span>
    </label>
    <p class="hint">Usa H.264 de reserva se alguém não decodificar VP9 ou AV1.</p>
    <label class="switch">
      <input type="checkbox" [checked]="prefs.showStats()" (change)="prefs.setShowStats(!prefs.showStats())" />
      <span>Mostrar estatísticas</span>
    </label>

    <p class="summary">
      @if (adapted(); as a) {
        O navegador reduziu a qualidade por falta de <strong>{{ a.cause }}</strong>: enviando {{ a.detail }}. Volta sozinho.
      } @else {
        {{ plan().prefix }}<strong>{{ plan().codec }}</strong>{{ plan().suffix }}
      }
    </p>
  `,
  styles: `
    :host { display: block; }
    .head { display: flex; justify-content: space-between; align-items: baseline; }
    .on-air { color: var(--danger); font-size: 0.75rem; font-weight: 700; text-transform: uppercase; }
    .apply { display: flex; gap: 0.5rem; align-items: center; justify-content: space-between; padding: 0.6rem;
      border: 1px solid var(--accent); border-radius: var(--radius); margin-bottom: 0.5rem; font-size: 0.85rem; }
    .option { display: flex; flex-direction: column; align-items: flex-start; width: 100%; text-align: left;
      padding: 0.55rem 0.75rem; margin-bottom: 0.35rem; border-radius: var(--radius);
      border: 1px solid var(--line); background: transparent; }
    .option span { color: var(--muted); font-size: 0.82rem; }
    .option.lit { border-color: var(--accent); background: #e9a9301a; }
    .switch { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.6rem; cursor: pointer; }
    .switch input { accent-color: var(--accent); width: 16px; height: 16px; }
    .summary { margin-top: 1.2rem; padding-top: 0.8rem; border-top: 1px solid var(--line); font-size: 0.88rem; }
  `,
})
export class StreamPanel {
  protected readonly prefs = inject(Prefs);
  protected readonly store = inject(RoomStore);
  protected readonly modes = MODES;
  protected readonly resolutions = RESOLUTIONS;
  protected readonly frameRates = FRAME_RATES;
  protected readonly settings = this.prefs.stream;
  protected readonly sharing = computed(() => this.store.liveSignature() !== null);
  protected readonly codecs = computed<CodecChoice[]>(() => ['auto', ...supportedCodecs()]);
  protected readonly changedWhileLive = computed(() => {
    const live = this.store.liveSignature();
    return live !== null && live !== this.prefs.signature();
  });
  protected readonly adapted = computed(() => {
    const h = this.store.health();
    return h === null || !h.sustained ? null : { cause: lackOf(h.reason), detail: `${h.width}x${h.height} a ${h.fps} fps` };
  });
  protected readonly plan = computed(() => {
    const plan = planFor(this.settings());
    const codec = pickCodec(this.prefs.codec());
    return {
      prefix: `${resolutionLabel(plan.resolution)} a ${plan.frameRate}fps em `,
      codec: codec.toUpperCase(),
      suffix: `, até ${formatBitrate(planBitrate(plan, codec))}.`,
    };
  });

  pickMode(mode: StreamMode) {
    this.prefs.setStream({ ...this.settings(), mode });
  }
  pickResolution(resolution: Resolution) {
    this.prefs.setStream({ ...this.settings(), resolution });
  }
  pickFrameRate(frameRate: number) {
    this.prefs.setStream({ ...this.settings(), frameRate });
  }
}
