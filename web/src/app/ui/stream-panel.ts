import { Component, computed, inject, signal } from '@angular/core';
import { describePressure, LoadGovernor } from '../core/load';
import { Prefs } from '../core/prefs';
import { readLink } from '../core/link';
import { RoomStore } from '../core/room-store';
import { lackOf } from '../core/stats';
import {
  CodecChoice,
  FRAME_RATES,
  formatBitrate,
  BITRATE_LIMITS,
  encoderProbes,
  pickCodec,
  planBitrate,
  planSize,
  hardwareOnly,
  probeEncoders,
  planFor,
  Resolution,
  RESOLUTIONS,
  resolutionLabel,
  supportedCodecs,
} from '../core/stream';

/** Qualidade da transmissão da tela. */
@Component({
  selector: 'cen-stream-panel',
  template: `
    @if (sharing()) { <p class="on-air mono"><span class="led live"></span>no ar</p> }
    @if (changedWhileLive()) {
      <div class="apply">
        <span>A transmissão ainda está com os ajustes antigos.</span>
        <button class="btn small primary" (click)="store.restartShare()">Aplicar agora</button>
      </div>
    }
    <!-- O que vai sair agora, lido no visor, antes de qualquer ajuste. -->
    <p class="summary">
      @if (store.load(); as l) {
        @if (l.supported && l.step > 0) {
          PC {{ pressure(l.pressure) }}: enviando até {{ l.width }}x{{ l.height }} a {{ l.fps }}fps para não pesar no jogo.<br />
        }
      }
      @if (store.encoder(); as e) {
        Codificando em <strong>{{ e.codec.toUpperCase() }}</strong> na {{ e.gpu ? 'placa de vídeo' : 'CPU' }}.<br />
      }
      @if (adapted(); as a) {
        O navegador reduziu a qualidade por falta de <strong>{{ a.cause }}</strong>: enviando {{ a.detail }}. Volta sozinho.
      } @else {
        {{ plan().prefix }}<strong>{{ plan().codec }}</strong>{{ plan().suffix }}
      }
    </p>
    <p class="hint">Tudo em <strong>Auto</strong> já sai no máximo que o seu PC aguenta. Só mude para fixar um valor.</p>

    <p class="label">resolução máxima</p>
    <div class="chips">
      @for (r of resolutions; track r.id) {
        <button type="button" class="chip" [class.lit]="r.id === settings().resolution" (click)="pickResolution(r.id)">{{ r.label }}</button>
      }
    </div>
    @if (settings().resolution === 'auto') {
      <p class="hint">
        @if (settings().frameRate > 60) {
          Auto acima de 60fps sai em <strong>1080p</strong>, para cada quadro ter bits suficientes. Para mais, escolha Original ou 1440p.
        } @else {
          Auto: a tela no tamanho original, sem reduzir.
        }
      </p>
    }
    <p class="label">quadros por segundo</p>
    <div class="chips">
      @for (f of frameRates; track f) {
        <button type="button" class="chip" [class.lit]="f === settings().frameRate" (click)="pickFrameRate(f)">{{ f }}fps</button>
      }
    </div>
    @if (settings().frameRate > 60) {
      <p class="hint">Acima de 60 só aparece para quem assiste num monitor de 120 Hz ou mais. 120 é o máximo que o navegador captura.</p>
    }
    <details class="more">
      <summary>O fps cai quando estou num jogo?</summary>
      <p class="hint">Ligue o NVIDIA Reflex (ou o AMD Anti-Lag) nas opções do jogo. Sem ele, o jogo enfileira quadros na placa de vídeo
        e o navegador espera atrás deles para copiar a tela. Ele não limita o fps do jogo.</p>
      <p class="hint">Com tela cheia exclusiva, comece a transmitir antes de voltar ao jogo: o aviso de compartilhamento do navegador
        tira o foco e o jogo minimiza.</p>
    </details>
    <p class="label">bitrate máximo</p>
    <div class="chips">
      @for (b of bitrates; track b.bps) {
        <button type="button" class="chip" [class.lit]="b.bps === settings().maxBitrate" (click)="pickBitrate(b.bps)">{{ b.label }}</button>
      }
    </div>

    <p class="label">som</p>
    <label class="switch">
      <input type="checkbox" [checked]="prefs.shareAudio()" (change)="prefs.setShareAudio(!prefs.shareAudio())" />
      <span>Mandar o som junto</span>
    </label>
    <p class="hint indent">Na janela do navegador, marque também a caixa de áudio (aparece para aba, janela, ou tela inteira no Windows).</p>

    @if (prefs.shareAudio()) {
      <p class="label">qualidade do som</p>
      <div class="chips">
        <button type="button" class="chip" [class.lit]="prefs.studio() === 'off'" (click)="prefs.setStudio('off')">Opus 192k</button>
        <button type="button" class="chip" [class.lit]="prefs.studio() === '16'" (click)="prefs.setStudio('16')">Estúdio 16-bit</button>
        <button type="button" class="chip" [class.lit]="prefs.studio() === '24'" (click)="prefs.setStudio('24')">Estúdio 24-bit</button>
      </div>
      <p class="hint">
        @if (prefs.studio() === 'off') {
          Praticamente igual ao original em jogo, vídeo e música, com pouco upload. O melhor para quase tudo.
        } @else {
          Sem compressão nenhuma, a 48 kHz. Gasta {{ prefs.studio() === '16' ? '1,5' : '2,3' }} Mbps de upload por pessoa assistindo e
          chega ~0,25 s atrasado. Para música, compartilhe a <strong>aba</strong> do site com "compartilhar áudio da aba".
        }
      </p>
    }

    <details class="more advanced" [open]="advancedOpen()" (toggle)="advancedOpen.set($any($event.target).open)">
      <summary>Avançado: codec, ceder e compatibilidade</summary>
      <p class="label">codec</p>
      <div class="chips">
        @for (c of codecs(); track c) {
          <button type="button" class="chip" [class.lit]="c === prefs.codec()" (click)="prefs.setCodec(c)">{{ c.toUpperCase() }}</button>
        }
      </div>
      <p class="hint">
        @if (gpuCodecs().length > 0) {
          Neste PC a placa de vídeo codifica <strong>{{ gpuCodecs().join(', ') }}</strong>. O Auto usa um desses, então quase não tira fps do jogo.
        } @else {
          O navegador não informou nenhum codec na placa de vídeo. Confira se a aceleração de hardware do navegador está ligada.
        }
      </p>

      <label class="switch">
        <input type="checkbox" [checked]="prefs.adaptToLoad()" (change)="prefs.setAdaptToLoad(!prefs.adaptToLoad())" />
        <span>Ceder quando o PC apertar</span>
      </label>
      <p class="hint indent">
        @if (pressureSupported) {
          Só age com o processador acima de ~90% por alguns segundos: baixa o fps, depois a resolução, e volta sozinho.
          @if (!prefs.adaptToLoad()) { Desligado, o site nunca baixa o fps. }
        } @else {
          Este navegador não informa o uso do processador; o ajuste não funciona aqui.
        }
      </p>

      <label class="switch">
        <input type="checkbox" [checked]="prefs.maxCompatibility()" (change)="prefs.setMaxCompatibility(!prefs.maxCompatibility())" />
        <span>Máxima compatibilidade</span>
      </label>
      <p class="hint indent">Manda também H.264 de reserva, para quem não decodificar VP9 ou AV1.</p>
    </details>

    <a class="btn small wide test" [href]="testHref" target="_blank" rel="noopener" title="Abre uma sala só sua no servidor e mostra o tamanho e o fps que chegam a quem assiste, com estes ajustes">
      Testar minha transmissão
    </a>
  `,
  styles: `
    :host { display: block; }
    .on-air { display: inline-flex; align-items: center; gap: 0.4rem; margin: 0 0 0.4rem; color: var(--danger);
      font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.16em; }
    .apply { display: flex; gap: 0.5rem; align-items: center; justify-content: space-between; padding: 0.6rem;
      border: 1px solid #0b0b0c; border-radius: 2px; margin-bottom: 0.5rem; font-size: 0.85rem;
      background: var(--well); box-shadow: var(--inset); animation: unfold-down 200ms var(--ease) both; }
    /* O que está saindo agora, no visor de LCD, logo no alto. */
    .summary { margin: 0.8rem 0 0.2rem; padding: 0.6rem 0.75rem; border-radius: 2px; background: var(--lcd); color: var(--lcd-ink);
      font: 0.76rem/1.55 var(--mono); box-shadow: inset 0 2px 3px rgb(0 0 0 / 0.45), inset 0 0 0 1px rgb(0 0 0 / 0.35); }
    .summary strong { font-weight: 500; }
    /* Explicação de uma chave: alinhada com o texto dela, não com a chave. */
    .hint.indent { margin: 0.2rem 0 0 calc(30px + 0.6rem); }
    .advanced { margin-top: 1.2rem; padding-top: 0.6rem; border-top: 1px dashed var(--line-2); }
    .test { margin-top: 1.1rem; text-decoration: none; }
  `,
})
export class StreamPanel {
  protected readonly prefs = inject(Prefs);
  protected readonly store = inject(RoomStore);
  /** /teste leva a senha da instância do link da sala (se houver), para não pedir de novo. */
  protected readonly testHref = (() => {
    const s = readLink().secret;
    return s === '' ? '/teste' : `/teste#s=${encodeURIComponent(s)}`;
  })();
  protected readonly bitrates = BITRATE_LIMITS;
  protected readonly resolutions = RESOLUTIONS;
  protected readonly frameRates = FRAME_RATES;
  protected readonly settings = this.prefs.stream;
  protected readonly sharing = computed(() => this.store.liveSignature() !== null);
  protected readonly codecs = computed<CodecChoice[]>(() => ['auto', ...supportedCodecs()]);
  protected readonly pressureSupported = LoadGovernor.supported();
  private readonly probeTick = signal(0);
  /** Avançado fica fechado: quem acabou de entrar vê só o que importa. */
  protected readonly advancedOpen = signal(false);
  protected readonly gpuCodecs = computed(() => {
    this.probeTick();
    const p = encoderProbes();
    return supportedCodecs()
      .filter((c) => p[c]?.gpu === true || hardwareOnly(c))
      .map((c) => c.toUpperCase());
  });
  protected pressure(p: Parameters<typeof describePressure>[0]) {
    return describePressure(p);
  }

  constructor() {
    const plan = planFor(this.settings());
    void probeEncoders(planSize(plan), plan.frameRate).then(() => this.probeTick.update((n) => n + 1));
  }
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
    this.probeTick();
    const codec = pickCodec(this.prefs.codec());
    return {
      prefix: `${resolutionLabel(plan.resolution)} a ${plan.frameRate}fps em `,
      codec: codec.toUpperCase(),
      suffix: `, até ${formatBitrate(planBitrate(plan, codec))}.`,
    };
  });

  pickBitrate(maxBitrate: number) {
    this.prefs.setStream({ ...this.settings(), maxBitrate });
  }
  pickResolution(resolution: Resolution) {
    this.prefs.setStream({ ...this.settings(), resolution });
  }
  pickFrameRate(frameRate: number) {
    this.prefs.setStream({ ...this.settings(), frameRate });
  }
}
