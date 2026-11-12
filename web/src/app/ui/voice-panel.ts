import { Component, ElementRef, OnDestroy, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Prefs } from '../core/prefs';
import { RoomStore } from '../core/room-store';
import type { VoiceStats } from '../core/room-session';
import {
  BandType,
  Denoise,
  DENOISE_DELAY_MS,
  DENOISE_LABELS,
  EQ_PRESETS,
  EqBand,
  EqPreset,
  Echo,
  GateMode,
  MAX_BANDS,
  MAX_STRENGTH,
  ROOM_AUDIO,
  RoomAudio,
  Slope,
  band,
  bandLabel,
  bandSections,
  chainDelayMs,
  eqSections,
  hasGain,
  responseDb,
  roomAudio,
} from '../core/voice-dsp';
import { Icon } from './icon';

type Tab = 'eq' | 'ruido' | 'sala';

const F_MIN = 20;
const F_MAX = 20000;
const G_MAX = 18;
const LOG_MIN = Math.log10(F_MIN);
const LOG_SPAN = Math.log10(F_MAX) - LOG_MIN;
const BAND_HUES = [265, 30, 140, 200, 340, 95, 175, 55];
const GRID_F = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

function fmtHz(f: number) {
  return f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1).replace('.', ',')} k` : `${Math.round(f)}`;
}
function fmtDb(g: number) {
  return `${g > 0 ? '+' : ''}${g.toFixed(1).replace('.', ',')}`;
}

/**
 * Analisador de espectro: o microfone cru e o que vai para a sala. Só existe com a aba do
 * equalizador aberta (um AudioContext só para medir, sem tocar nada).
 */
class Scope {
  private ctx: AudioContext | null = null;
  private pre: AnalyserNode | null = null;
  private post: AnalyserNode | null = null;
  readonly preData = new Float32Array(2048);
  readonly postData = new Float32Array(2048);
  rate = 48000;

  start(raw: MediaStreamTrack | null, out: MediaStreamTrack | null) {
    this.stop();
    if (raw === null && out === null) return;
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    this.rate = this.ctx.sampleRate;
    const make = (t: MediaStreamTrack | null) => {
      if (t === null || t.readyState !== 'live') return null;
      const a = this.ctx!.createAnalyser();
      a.fftSize = 4096;
      a.smoothingTimeConstant = 0.82;
      a.minDecibels = -100;
      a.maxDecibels = -10;
      this.ctx!.createMediaStreamSource(new MediaStream([t])).connect(a);
      return a;
    };
    this.pre = make(raw);
    this.post = make(out);
  }

  read(): boolean {
    if (this.ctx === null) return false;
    this.pre?.getFloatFrequencyData(this.preData);
    this.post?.getFloatFrequencyData(this.postData);
    return this.post !== null || this.pre !== null;
  }

  get hasPre() {
    return this.pre !== null;
  }

  stop() {
    void this.ctx?.close().catch(() => undefined);
    this.ctx = this.pre = this.post = null;
  }
}

/** Equalizador, redução de ruído, eco e qualidade de áudio da sala. */
@Component({
  selector: 'cen-voice-panel',
  imports: [Icon],
  host: { '(keydown)': 'key($event)' },
  template: `
    <div class="win panel-surface" role="dialog" aria-label="Voz">
      <header>
        <span class="label">sua voz</span>
        <div class="chips tabs" role="tablist">
          <button type="button" class="chip" role="tab" [class.lit]="tab() === 'eq'" [attr.aria-selected]="tab() === 'eq'" (click)="tab.set('eq')">equalizador</button>
          <button type="button" class="chip" role="tab" [class.lit]="tab() === 'ruido'" [attr.aria-selected]="tab() === 'ruido'" (click)="tab.set('ruido')">ruído e eco</button>
          <button type="button" class="chip" role="tab" [class.lit]="tab() === 'sala'" [attr.aria-selected]="tab() === 'sala'" (click)="tab.set('sala')">sala e atraso</button>
        </div>
        <span class="meters" title="Nível antes e depois do tratamento">
          <span class="bar"><i [style.width.%]="meterPct(meter()?.inDb)"></i></span>
          <span class="bar out"><i [style.width.%]="meterPct(meter()?.outDb)"></i></span>
        </span>
        <button class="close" title="Fechar" (click)="store.openVoice(false)"><cen-icon name="close" [size]="15" /></button>
      </header>

      @if (!store.voiceWorker) {
        <p class="hint warn">Este navegador não tem o caminho rápido de áudio (Worker de áudio). Equalizador, IA e portão precisam do Chrome, Edge, Brave ou Opera. Aqui só vale o filtro do navegador.</p>
      }

      @switch (tab()) {
        @case ('eq') {
          <div class="row top">
            <!-- [selected] em cada opção: o [value] no select chega antes das opções do @for e não pega. -->
            <select class="sel" (change)="pickPreset($any($event.target).value)" aria-label="Preset do equalizador">
              @if (presetId() === '') { <option value="" disabled selected>(mexido)</option> }
              <optgroup label="prontos">
                @for (p of builtIn; track p.id) { <option [value]="p.id" [selected]="p.id === presetId()">{{ p.name }}</option> }
              </optgroup>
              @if (prefs.eqPresets().length > 0) {
                <optgroup label="seus">
                  @for (p of prefs.eqPresets(); track p.id) { <option [value]="p.id" [selected]="p.id === presetId()">{{ p.name }}</option> }
                </optgroup>
              }
            </select>
            @if (saving()) {
              <input #name class="txt" maxlength="32" placeholder="nome do preset" (keydown.enter)="save(name.value)" (keydown.escape)="saving.set(false)" />
              <button class="btn small primary" (click)="save(name.value)">Salvar</button>
              <button class="btn small" (click)="saving.set(false)">Cancelar</button>
            } @else {
              <button class="btn small" (click)="saving.set(true)" title="Guardar estas bandas com um nome">Salvar como…</button>
              @if (minePreset(); as m) {
                <button class="btn small" (click)="prefs.deleteEqPreset(m.id)" title="Apagar este preset salvo">Apagar</button>
              }
            }
            <span class="grow"></span>
            <button class="btn small" [class.on]="voice().eqOn" [attr.aria-pressed]="voice().eqOn" (click)="set({ eqOn: !voice().eqOn })"
              title="Liga/desliga o equalizador inteiro: bom para comparar antes e depois">{{ voice().eqOn ? 'EQ ligado' : 'EQ desligado' }}</button>
          </div>
          <p class="hint">{{ presetHint() }}</p>
          <div class="graph" #wrap>
            <canvas #canvas (pointerdown)="down($event)" (pointermove)="move($event)" (pointerup)="up($event)" (pointercancel)="up($event)"
              (dblclick)="dbl($event)" (wheel)="wheel($event)" (contextmenu)="ctx($event)" tabindex="0"
              aria-label="Gráfico do equalizador: clique duas vezes para pôr uma banda; arraste para mudar; roda muda a largura; clique direito apaga"></canvas>
          </div>
          <p class="hint small">Clique duas vezes no gráfico para pôr uma banda, arraste o ponto (frequência e ganho), use a roda do mouse para a largura (Q) e o clique direito para apagar. Até {{ maxBands }} bandas.</p>
          @if (selected(); as b) {
            <div class="row edit">
              <span class="dot" [style.background]="hue(sel())"></span>
              <select class="sel" (change)="patchBand({ type: $any($event.target).value })" aria-label="Tipo da banda">
                @for (t of types; track t) { <option [value]="t" [selected]="t === b.type">{{ bandLabel(t) }}</option> }
              </select>
              <label>Hz <input class="num" type="number" min="20" max="20000" step="1" [value]="round(b.freq)" (change)="patchBand({ freq: +$any($event.target).value })" /></label>
              @if (hasGain(b.type)) {
                <label>dB <input class="num" type="number" min="-24" max="24" step="0.5" [value]="b.gain" (change)="patchBand({ gain: +$any($event.target).value })" /></label>
              }
              <label>Q <input class="num" type="number" min="0.1" max="18" step="0.1" [value]="b.q" (change)="patchBand({ q: +$any($event.target).value })" /></label>
              @if (b.type === 'lowcut' || b.type === 'highcut') {
                <select class="sel" (change)="patchBand({ slope: $any(+$any($event.target).value) })" aria-label="Inclinação">
                  @for (s of slopes; track s) { <option [value]="s" [selected]="s === b.slope">{{ s }} dB/oit</option> }
                </select>
              }
              <button class="btn small" [class.on]="!b.on" (click)="patchBand({ on: !b.on })">{{ b.on ? 'Ligada' : 'Desligada' }}</button>
              <button class="btn small" title="Apagar banda" (click)="removeBand(sel())"><cen-icon name="trash" [size]="14" /></button>
            </div>
          }
          <div class="row">
            <span class="lbl">ganho final</span>
            <input class="range" type="range" min="-12" max="12" step="0.5" [value]="voice().outDb" (input)="set({ outDb: +$any($event.target).value })" aria-label="Ganho final" />
            <span class="val">{{ fmtDb(voice().outDb) }} dB</span>
          </div>
        }

        @case ('ruido') {
          <p class="label">redução de ruído</p>
          <div class="chips">
            @for (d of denoises; track d) {
              <button type="button" class="chip" [class.lit]="voice().denoise === d" [disabled]="!store.voiceWorker && (d === 'leve' || d === 'forte')" (click)="set({ denoise: d })">{{ denoiseLabels[d] }}</button>
            }
          </div>
          <p class="hint">{{ denoiseHint() }}</p>
          @if (voice().denoise === 'leve' || voice().denoise === 'forte') {
            <div class="row">
              <span class="lbl">intensidade</span>
              <input class="range" type="range" min="3" [max]="maxStrength" step="1" [value]="voice().strength" (input)="set({ strength: +$any($event.target).value })" aria-label="Intensidade da redução de ruído" />
              <span class="val">{{ voice().strength >= maxStrength ? 'máxima' : '−' + voice().strength + ' dB' }}</span>
            </div>
            <p class="hint small">O ruído desce no máximo isso. Com menos intensidade a voz fica natural e o fundo continua baixinho; na máxima o fundo some, mas a voz pode soar "mascarada".</p>
          }

          <p class="label">portão (corta tudo entre as falas)</p>
          <div class="chips">
            @for (g of gates; track g.id) {
              <button type="button" class="chip" [class.lit]="voice().gate === g.id" [disabled]="!store.voiceWorker && g.id !== 'off'" (click)="set({ gate: g.id })">{{ g.label }}</button>
            }
          </div>
          <p class="hint">{{ gateHint() }}</p>
          @if (voice().gate === 'manual') {
            <div class="row">
              <span class="lbl">abre acima de</span>
              <span class="thr">
                <span class="bar wide"><i [style.width.%]="levelPct(meter()?.outDb)"></i><b [style.left.%]="levelPct(voice().gateDb)"></b></span>
                <input class="range" type="range" min="-80" max="-10" step="1" [value]="voice().gateDb" (input)="set({ gateDb: +$any($event.target).value })" aria-label="Limiar do portão" />
              </span>
              <span class="val">{{ voice().gateDb }} dB</span>
            </div>
          }
          @if (voice().gate !== 'off' && meter(); as m) {
            <p class="hint small"><span class="led" [class.ok]="m.gateOpen"></span> {{ m.gateOpen ? 'aberto: sua voz está indo' : 'fechado: nada vai para a sala' }}</p>
          }

          <p class="label">cancelamento de eco</p>
          <div class="chips">
            @for (e of echoes; track e.id) {
              <button type="button" class="chip" [class.lit]="voice().echo === e.id" (click)="set({ echo: e.id })">{{ e.label }}</button>
            }
          </div>
          <p class="hint">{{ echoHint() }}</p>

          <p class="label">ganho automático</p>
          <div class="chips">
            <button type="button" class="chip" [class.lit]="voice().agc" (click)="set({ agc: true })">ligado</button>
            <button type="button" class="chip" [class.lit]="!voice().agc" (click)="set({ agc: false })">desligado</button>
          </div>
          <p class="hint">O navegador sobe a voz baixa e segura a alta. Desligue com microfone bom e interface de áudio (ele também sobe o ruído antes da IA).</p>

          @if (store.ownMicOn()) {
            <button class="btn wide" (click)="store.toggleMicMonitor()">
              {{ store.micMonitor() ? 'Parar de me ouvir' : 'Ouvir meu microfone como a sala ouve (use fone)' }}
            </button>
          }
          <p class="hint small mono">{{ status() }}</p>
        }

        @case ('sala') {
          <p class="label">qualidade de áudio da sala @if (store.roomAudio().by; as by) { <span class="tag">escolhida por {{ by }}</span> }</p>
          <div class="chips">
            @for (p of roomPresets; track p.id) {
              <button type="button" class="chip" [class.lit]="store.roomAudio().preset === p.id" (click)="pickRoom(p.id)">{{ p.label }}</button>
            }
          </div>
          <p class="hint">{{ roomHint() }} Vale para o microfone de todo mundo: quem muda, muda para a sala inteira.</p>

          <p class="label">atraso da voz (estimado agora)</p>
          <div class="lat">
            <div class="lr head"><span>sua voz até a sala</span><strong>~{{ mine().total }} ms</strong></div>
            @for (part of mine().parts; track part.what) {
              <div class="lr"><span>{{ part.what }}</span><span>{{ part.ms }} ms</span></div>
            }
            <div class="lr head"><span>a voz de cada um até você</span><span></span></div>
            @for (p of theirs(); track p.identity) {
              <div class="lr"><span>{{ p.name }}{{ p.boosted ? ' (acima de 100%: +Web Audio)' : '' }}</span><span>~{{ p.ms }} ms</span></div>
            } @empty {
              <div class="lr"><span class="dim">ninguém com microfone ligado</span><span></span></div>
            }
          </div>
          <p class="hint small">{{ verify() }} A conta: captura (10 ms), tratamento, quadro do Opus, codificador (6,5 ms), meia volta da rede e, do outro lado, a fila de chegada (jitter buffer) e a placa de som (~10 ms). Fone com fio: Bluetooth soma 100 a 200 ms.</p>
        }
      }
    </div>
  `,
  styles: `
    :host { position: fixed; left: 50%; bottom: 84px; z-index: 30; transform: translateX(-50%); width: min(760px, calc(100vw - 16px)); }
    .win { padding: 0.6rem 0.9rem 0.8rem; max-height: calc(100vh - 110px); overflow: auto; animation: develop 200ms var(--ease) both; }
    header { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
    header .label { margin: 0; }
    .tabs { flex: 1; }
    .close { background: none; border: 0; color: var(--muted); padding: 4px; display: grid; place-items: center; border-radius: 2px; }
    .close:hover { color: var(--text); }
    .meters { display: grid; gap: 2px; width: 70px; }
    .bar { display: block; position: relative; height: 4px; background: var(--well); box-shadow: var(--inset); border-radius: 1px; overflow: hidden; }
    .bar i { position: absolute; inset: 0 auto 0 0; background: var(--ok); }
    .bar.out i { background: var(--accent-hi); }
    .bar.wide { height: 6px; }
    .bar b { position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--warn); }
    .row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin: 0.55rem 0; }
    .grow { flex: 1; }
    .sel, .txt, .num { height: 28px; padding: 0 0.4rem; border-radius: 2px; border: 1px solid #0b0b0c; background: var(--well); box-shadow: var(--inset); font-size: 0.8rem; }
    .num { width: 72px; font-family: var(--mono); }
    .txt { width: 160px; }
    label { display: inline-flex; gap: 0.3rem; align-items: center; font: 500 0.68rem var(--mono); color: var(--muted); text-transform: uppercase; }
    .graph { position: relative; height: 250px; margin-top: 0.3rem; border-radius: 2px; background: #101011; box-shadow: var(--inset); }
    canvas { display: block; width: 100%; height: 100%; cursor: crosshair; touch-action: none; outline: none; }
    .dot { width: 10px; height: 10px; border-radius: 50%; }
    .lbl { font: 500 0.68rem var(--mono); text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); min-width: 92px; }
    .range { flex: 1; min-width: 120px; accent-color: var(--accent); }
    .thr { flex: 1; display: grid; gap: 4px; min-width: 120px; }
    .thr .range { width: 100%; }
    .val { font: 0.8rem var(--mono); min-width: 64px; text-align: right; }
    .hint.small { font-size: 0.74rem; }
    .hint.warn { color: var(--warn); }
    .lat { font: 0.8rem var(--mono); background: var(--well); box-shadow: var(--inset); padding: 0.45rem 0.6rem; border-radius: 2px; }
    .lr { display: flex; justify-content: space-between; gap: 1rem; padding: 1px 0; color: var(--muted); }
    .lr.head { color: var(--text); margin-top: 0.3rem; }
    .lr.head:first-child { margin-top: 0; }
    .dim { color: var(--faint); }
    .chip:disabled { opacity: 0.4; }
    @media (max-width: 560px) { :host { bottom: 70px; } .graph { height: 190px; } .lbl { min-width: 0; } }
  `,
})
export class VoicePanel implements OnDestroy {
  protected readonly store = inject(RoomStore);
  protected readonly prefs = inject(Prefs);
  protected readonly tab = signal<Tab>('eq');
  protected readonly voice = this.store.voice;
  protected readonly meter = this.store.voiceMeter;
  protected readonly saving = signal(false);
  protected readonly sel = signal(0);
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  protected readonly builtIn = EQ_PRESETS;
  protected readonly maxBands = MAX_BANDS;
  protected readonly maxStrength = MAX_STRENGTH;
  protected readonly types: BandType[] = ['bell', 'lowshelf', 'highshelf', 'lowcut', 'highcut', 'notch'];
  protected readonly slopes: Slope[] = [6, 12, 24, 48];
  protected readonly denoises: Denoise[] = ['off', 'navegador', 'leve', 'forte'];
  protected readonly denoiseLabels = DENOISE_LABELS;
  protected readonly gates: { id: GateMode; label: string }[] = [
    { id: 'off', label: 'desligado' },
    { id: 'auto', label: 'automático (IA)' },
    { id: 'manual', label: 'manual' },
  ];
  protected readonly echoes: { id: Echo; label: string }[] = [
    { id: 'off', label: 'desligado' },
    { id: 'site', label: 'som do site' },
    { id: 'pc', label: 'tudo do PC' },
  ];
  protected readonly roomPresets = ROOM_AUDIO;
  protected readonly bandLabel = bandLabel;
  protected readonly hasGain = hasGain;
  protected readonly fmtDb = fmtDb;
  protected readonly round = Math.round;

  private readonly scope = new Scope();
  private raf = 0;
  private statsTimer = 0;
  private drag: { index: number; id: number } | null = null;
  protected readonly stats = signal<VoiceStats | null>(null);
  private readonly peakPps = signal<{ preset: RoomAudio | null; pps: number }>({ preset: null, pps: 0 });

  constructor() {
    this.store.openVoice(true);
    // Desenha só com a aba do equalizador aberta; o analisador acompanha o microfone ligado.
    effect((onCleanup) => {
      if (this.tab() !== 'eq' || this.canvas() === undefined) return;
      this.store.ownMicOn();
      let { raw, out } = this.store.micTracks();
      this.scope.start(raw, out);
      let tick = 0;
      const loop = () => {
        // A trilha tratada muda sem o microfone desligar (IA forte entrando, sala mudando a
        // qualidade): o analisador segue a atual.
        if (++tick % 30 === 0) {
          const now = this.store.micTracks();
          if (now.raw !== raw || now.out !== out) {
            ({ raw, out } = now);
            this.scope.start(raw, out);
          }
        }
        this.draw();
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
      onCleanup(() => {
        cancelAnimationFrame(this.raf);
        this.scope.stop();
      });
    });
    effect((onCleanup) => {
      if (this.tab() !== 'sala') return;
      const read = () =>
        void this.store.voiceStats().then((s) => {
          this.stats.set(s);
          // Com o corte de silêncio (DTX) quase nada sai entre as falas: o que diz o tamanho do
          // quadro é o pico, com você falando.
          const pps = s.packetsPerSec ?? 0;
          const preset = this.store.roomAudio().preset;
          this.peakPps.update((p) => (p.preset === preset ? { preset, pps: Math.max(p.pps, pps) } : { preset, pps }));
        });
      read();
      this.statsTimer = window.setInterval(read, 2000);
      onCleanup(() => window.clearInterval(this.statsTimer));
    });
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.raf);
    window.clearInterval(this.statsTimer);
    this.scope.stop();
    this.store.openVoice(false);
  }

  protected set(patch: Parameters<RoomStore['setVoice']>[0]) {
    void this.store.setVoice(patch);
  }

  // ---------- presets

  private allPresets(): EqPreset[] {
    return [...EQ_PRESETS, ...this.prefs.eqPresets()];
  }
  /** Preset que bate exatamente com as bandas de agora ('' = mexido). */
  protected readonly presetId = computed(() => {
    const now = JSON.stringify(this.voice().eq);
    return this.allPresets().find((p) => JSON.stringify(p.bands) === now)?.id ?? '';
  });
  protected readonly minePreset = computed(() => this.prefs.eqPresets().find((p) => p.id === this.presetId()) ?? null);
  protected readonly presetHint = computed(() => {
    const p = this.allPresets().find((x) => x.id === this.presetId());
    return p?.hint ?? 'Do seu jeito. "Salvar como…" guarda estas bandas para usar de novo.';
  });
  protected pickPreset(id: string) {
    const p = this.allPresets().find((x) => x.id === id);
    if (p === undefined) return;
    this.sel.set(0);
    this.set({ eq: p.bands.map((b) => ({ ...b })), eqOn: true });
  }
  protected save(name: string) {
    const p = this.prefs.saveEqPreset(name, this.voice().eq);
    this.saving.set(false);
    this.pickPreset(p.id);
  }

  // ---------- bandas

  protected readonly selected = computed(() => this.voice().eq[this.sel()] ?? null);
  protected hue(i: number) {
    return `hsl(${BAND_HUES[i % BAND_HUES.length]} 55% 62%)`;
  }
  protected patchBand(patch: Partial<EqBand>) {
    const i = this.sel();
    const eq = this.voice().eq.map((b, k) => (k === i ? { ...b, ...patch } : b));
    const b = eq[i];
    if (b === undefined) return;
    b.freq = Math.min(F_MAX, Math.max(F_MIN, b.freq || 1000));
    b.gain = Math.min(24, Math.max(-24, Number.isFinite(b.gain) ? b.gain : 0));
    b.q = Math.min(18, Math.max(0.1, b.q || 0.71));
    if (!this.slopes.includes(b.slope)) b.slope = 12;
    this.set({ eq, eqOn: true });
  }
  protected removeBand(i: number) {
    const eq = this.voice().eq.filter((_, k) => k !== i);
    this.sel.set(Math.max(0, Math.min(this.sel(), eq.length - 1)));
    this.set({ eq });
  }
  private addBand(f: number, g: number) {
    const eq = this.voice().eq;
    if (eq.length >= MAX_BANDS) return;
    this.set({ eq: [...eq, band('bell', Math.round(f), Math.round(g * 2) / 2, 1)], eqOn: true });
    this.sel.set(eq.length);
  }

  // ---------- gráfico

  private size() {
    const c = this.canvas()?.nativeElement;
    if (c === undefined) return null;
    const r = c.getBoundingClientRect();
    return { c, w: r.width, h: r.height, r };
  }
  private xOf(f: number, w: number) {
    return ((Math.log10(f) - LOG_MIN) / LOG_SPAN) * w;
  }
  private fOf(x: number, w: number) {
    return Math.pow(10, LOG_MIN + (Math.min(Math.max(x, 0), w) / w) * LOG_SPAN);
  }
  private yOf(g: number, h: number) {
    return h / 2 - (g / G_MAX) * (h / 2 - 14);
  }
  private gOf(y: number, h: number) {
    return Math.max(-G_MAX, Math.min(G_MAX, ((h / 2 - y) / (h / 2 - 14)) * G_MAX));
  }
  private nodeXY(b: EqBand, w: number, h: number) {
    return { x: this.xOf(b.freq, w), y: hasGain(b.type) ? this.yOf(b.gain, h) : this.yOf(0, h) };
  }
  private hit(e: PointerEvent | MouseEvent): number {
    const s = this.size();
    if (s === null) return -1;
    const px = e.clientX - s.r.left;
    const py = e.clientY - s.r.top;
    let best = -1;
    let dist = 14;
    this.voice().eq.forEach((b, i) => {
      const n = this.nodeXY(b, s.w, s.h);
      const d = Math.hypot(n.x - px, n.y - py);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    return best;
  }

  protected down(e: PointerEvent) {
    if (e.button !== 0) return;
    const i = this.hit(e);
    if (i < 0) return;
    this.sel.set(i);
    this.drag = { index: i, id: e.pointerId };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  protected move(e: PointerEvent) {
    if (this.drag === null || this.drag.id !== e.pointerId) return;
    const s = this.size();
    if (s === null) return;
    const b = this.voice().eq[this.drag.index];
    const f = Math.round(this.fOf(e.clientX - s.r.left, s.w));
    const patch: Partial<EqBand> = { freq: f };
    if (hasGain(b.type)) patch.gain = Math.round(this.gOf(e.clientY - s.r.top, s.h) * 10) / 10;
    this.patchBand(patch);
  }
  protected up(e: PointerEvent) {
    if (this.drag?.id === e.pointerId) this.drag = null;
  }
  protected dbl(e: MouseEvent) {
    const i = this.hit(e);
    if (i >= 0) return this.removeBand(i);
    const s = this.size();
    if (s === null) return;
    this.addBand(this.fOf(e.clientX - s.r.left, s.w), this.gOf(e.clientY - s.r.top, s.h));
  }
  protected wheel(e: WheelEvent) {
    const i = this.hit(e);
    const target = i >= 0 ? i : this.sel();
    if (this.voice().eq[target] === undefined) return;
    e.preventDefault();
    this.sel.set(target);
    const q = this.voice().eq[target].q * (e.deltaY < 0 ? 1.12 : 1 / 1.12);
    this.patchBand({ q: Math.round(q * 100) / 100 });
  }
  protected ctx(e: MouseEvent) {
    const i = this.hit(e);
    if (i < 0) return;
    e.preventDefault();
    this.removeBand(i);
  }
  /** Setas mexem na banda escolhida (frequência e ganho), Delete apaga. */
  protected key(e: KeyboardEvent) {
    if (this.tab() !== 'eq' || !(e.target instanceof HTMLCanvasElement)) return;
    const b = this.selected();
    if (b === null) return;
    const step = e.shiftKey ? 0.2 : 0.05;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') this.patchBand({ freq: Math.round(b.freq * Math.pow(10, e.key === 'ArrowLeft' ? -step : step)) });
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && hasGain(b.type)) this.patchBand({ gain: b.gain + (e.key === 'ArrowUp' ? 0.5 : -0.5) });
    else if (e.key === 'Delete' || e.key === 'Backspace') this.removeBand(this.sel());
    else return;
    e.preventDefault();
  }

  private draw() {
    const s = this.size();
    if (s === null) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(s.w * dpr);
    const H = Math.round(s.h * dpr);
    if (s.c.width !== W || s.c.height !== H) {
      s.c.width = W;
      s.c.height = H;
    }
    const g = s.c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = s.w;
    const h = s.h;
    g.clearRect(0, 0, w, h);

    // grade
    g.font = '10px "DM Mono", monospace';
    g.lineWidth = 1;
    for (const f of GRID_F) {
      const x = Math.round(this.xOf(f, w)) + 0.5;
      g.strokeStyle = 'rgb(255 255 255 / 0.05)';
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
      g.fillStyle = 'rgb(255 255 255 / 0.28)';
      if (f > 20 && f < 20000) g.fillText(fmtHz(f), x + 3, h - 4);
    }
    for (const db of [-12, -6, 0, 6, 12]) {
      const y = Math.round(this.yOf(db, h)) + 0.5;
      g.strokeStyle = db === 0 ? 'rgb(255 255 255 / 0.14)' : 'rgb(255 255 255 / 0.05)';
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
      g.fillStyle = 'rgb(255 255 255 / 0.28)';
      g.fillText(`${db > 0 ? '+' : ''}${db}`, 3, y - 3);
    }

    // analisador: antes (cinza) e depois (cor) do tratamento
    if (this.scope.read()) {
      const spec = (data: Float32Array, fill: string, stroke: string) => {
        const nyq = this.scope.rate / 2;
        g.beginPath();
        g.moveTo(0, h);
        for (let px = 0; px <= w; px += 2) {
          const f = this.fOf(px, w);
          const bin = Math.min(data.length - 1, Math.round((f / nyq) * data.length));
          const v = Math.max(-100, Math.min(-10, data[bin]));
          g.lineTo(px, h - ((v + 100) / 90) * h);
        }
        g.lineTo(w, h);
        g.closePath();
        g.fillStyle = fill;
        g.fill();
        g.strokeStyle = stroke;
        g.stroke();
      };
      if (this.scope.hasPre) spec(this.scope.preData, 'rgb(255 255 255 / 0.03)', 'rgb(255 255 255 / 0.10)');
      spec(this.scope.postData, 'rgb(111 95 166 / 0.16)', 'rgb(164 151 207 / 0.35)');
    }

    const v = this.voice();
    const on = v.eqOn;
    // cada banda (fraca) e a soma (forte)
    v.eq.forEach((b, i) => {
      if (!b.on) return;
      const secs = bandSections(b);
      g.strokeStyle = this.hue(i).replace(')', ' / 0.35)');
      g.beginPath();
      for (let px = 0; px <= w; px += 3) {
        const y = this.yOf(responseDb(secs, this.fOf(px, w)), h);
        if (px === 0) g.moveTo(px, y);
        else g.lineTo(px, y);
      }
      g.stroke();
    });
    const all = eqSections(v);
    g.lineWidth = 2;
    g.strokeStyle = on ? '#cfc6ef' : 'rgb(255 255 255 / 0.25)';
    g.beginPath();
    for (let px = 0; px <= w; px += 2) {
      const y = this.yOf(responseDb(all, this.fOf(px, w)), h);
      if (px === 0) g.moveTo(px, y);
      else g.lineTo(px, y);
    }
    g.stroke();

    // pontos
    v.eq.forEach((b, i) => {
      const n = this.nodeXY(b, w, h);
      g.beginPath();
      g.arc(n.x, n.y, i === this.sel() ? 8 : 6.5, 0, Math.PI * 2);
      g.fillStyle = b.on ? this.hue(i) : '#555';
      g.globalAlpha = on ? 1 : 0.5;
      g.fill();
      g.globalAlpha = 1;
      g.lineWidth = i === this.sel() ? 2 : 1;
      g.strokeStyle = '#0b0b0c';
      g.stroke();
      g.fillStyle = '#0b0b0c';
      g.font = 'bold 9px "DM Mono", monospace';
      g.fillText(String(i + 1), n.x - 2.6, n.y + 3);
    });
    g.lineWidth = 1;
  }

  // ---------- textos

  protected meterPct(db: number | undefined) {
    return db === undefined ? 0 : Math.max(0, Math.min(100, ((db + 70) / 70) * 100));
  }
  protected levelPct(db: number | undefined) {
    return db === undefined ? 0 : Math.max(0, Math.min(100, ((db + 80) / 70) * 100));
  }

  protected readonly denoiseHint = computed(() => {
    switch (this.voice().denoise) {
      case 'off':
        return 'Nada de filtro: o som do microfone como ele é. Para microfone bom em lugar silencioso, ou instrumento.';
      case 'navegador':
        return 'O filtro clássico do Chrome (WebRTC): o mais leve e sem atraso, mas deixa passar teclado e ventilador.';
      case 'leve':
        return `RNNoise, rede neural pequena: tira ventilador, chiado e ar-condicionado. Soma ${DENOISE_DELAY_MS.leve} ms e quase nada de processador. Teclado mecânico passa um pouco.`;
      case 'forte':
        return `DeepFilterNet 3: a melhor gratuita, inclusive com teclado e mastigação. Soma ~${DENOISE_DELAY_MS.forte} ms, ~3% de um núcleo e baixa ~11 MB na primeira vez. Se o PC não der conta, volta para a leve sozinha.`;
    }
  });

  protected readonly gateHint = computed(() => {
    switch (this.voice().gate) {
      case 'off':
        return 'Sem portão: entre uma fala e outra vai o que sobrou do ruído (baixinho).';
      case 'auto':
        return 'Abre quando a IA reconhece voz e fecha 300 ms depois que você para. Como a IA olha 10 ms à frente, o começo da palavra não é cortado.';
      case 'manual':
        return 'Abre quando o nível passa da linha amarela, como a sensibilidade do Discord. Ponha a linha logo acima do barulho de fundo.';
    }
  });

  protected readonly echoHint = computed(() => {
    const e = this.voice().echo;
    const facts = this.store.voiceFacts();
    if (e === 'off') return 'Sem cancelamento: só com fone. Na caixa de som, quem fala com você se ouve de volta.';
    if (e === 'site') return 'Tira do microfone o som que sai do próprio site (as vozes da sala). Jogo, Spotify e Discord na caixa de som passam.';
    if (facts !== null && !facts.echoAllAvailable)
      return 'Este sistema não oferece cancelar o som do PC inteiro (só Windows e macOS, Chrome 141+): ficou só o som do site.';
    return 'Tira do microfone tudo que o PC toca: o som do site, do jogo, do Spotify e do Discord. Chrome 141+ no Windows e no macOS. Para quem joga com caixa de som.';
  });

  protected readonly status = computed(() => {
    const m = this.meter();
    const v = this.voice();
    const facts = this.store.voiceFacts();
    if (!this.store.ownMicOn()) return `microfone desligado · atraso do tratamento: ${chainDelayMs(v)} ms`;
    if (m === null) return `sem processamento extra (o microfone vai direto) · ${facts?.sampleRate ? facts.sampleRate / 1000 + ' kHz' : ''}`;
    const engine = m.engine === 'forte' ? 'IA forte' : m.engine === 'leve' ? 'IA leve' : v.denoise === 'navegador' ? 'filtro do navegador' : 'sem IA';
    const loading = v.denoise === 'forte' && m.engine !== 'forte' ? ' (carregando a forte…)' : '';
    return `rodando: ${engine}${loading} · ${(m.load * 100).toFixed(1).replace('.', ',')}% de um núcleo · microfone a ${m.inputRate / 1000} kHz`;
  });

  protected readonly roomHint = computed(() => roomAudio(this.store.roomAudio().preset).hint);
  protected pickRoom(p: RoomAudio) {
    void this.store.setRoomAudio(p);
  }

  protected readonly mine = computed(() => {
    const st = this.stats();
    const preset = roomAudio(this.store.roomAudio().preset);
    const half = st?.rttMs != null ? Math.round(st.rttMs / 2) : null;
    const parts = [
      { what: 'captura do microfone', ms: 10 },
      { what: `tratamento (${DENOISE_LABELS[this.voice().denoise]})`, ms: chainDelayMs(this.voice()) },
      { what: `quadro do Opus (${preset.ptime} ms) + codificador`, ms: preset.ptime + 6.5 },
      { what: 'rede até o servidor (meia volta)', ms: half ?? 0 },
    ];
    return { parts, total: Math.round(parts.reduce((a, p) => a + p.ms, 0)) };
  });

  protected readonly theirs = computed(() =>
    (this.stats()?.people ?? []).map((p) => ({
      identity: p.identity,
      name: p.name,
      boosted: p.boosted,
      ms: Math.round((p.jitterMs ?? 0) + (p.rttMs ?? 0) / 2 + 10 + (p.boosted ? 15 : 0)),
    })),
  );

  protected readonly verify = computed(() => {
    const peak = this.peakPps();
    const preset = roomAudio(this.store.roomAudio().preset);
    if (peak.preset !== preset.id || peak.pps < 30) return '';
    const frame = Math.round(1000 / peak.pps);
    return `Medido: falando, sua voz sai em até ${Math.round(peak.pps)} pacotes/s (quadros de ~${frame} ms${Math.abs(frame - preset.ptime) <= 2 ? ', como pedido' : ''}).`;
  });
}
