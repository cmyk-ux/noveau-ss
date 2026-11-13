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
  MAX_DYN,
  MAX_STRENGTH,
  ROOM_AUDIO,
  RoomAudio,
  Slope,
  band,
  bandLabel,
  bandSections,
  canDyn,
  chainDelayMs,
  eqSections,
  hasGain,
  isDynamic,
  responseDb,
  roomAudio,
  soloRange,
} from '../core/voice-dsp';
import { Icon } from './icon';
import { ListenButton, ListenNote } from './listen-button';

type Tab = 'eq' | 'ruido' | 'sala';

const F_MIN = 20;
const F_MAX = 20000;
const RANGES = [3, 6, 12, 30];
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** Nota mais próxima de uma frequência, como no teclado do Pro-Q ("A4 +12"). */
function noteOf(f: number) {
  const m = 69 + 12 * Math.log2(f / 440);
  const n = Math.round(m);
  const cents = Math.round((m - n) * 100);
  return `${NOTES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}${cents === 0 ? '' : ` ${cents > 0 ? '+' : ''}${cents}`}`;
}
function readRange(): number {
  try {
    const v = Number(localStorage.getItem('noveau:eq-escala'));
    return RANGES.includes(v) ? v : 12;
  } catch {
    return 12;
  }
}
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
  imports: [Icon, ListenButton, ListenNote],
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
        <cen-listen-button />
        <button class="close" title="Fechar" (click)="store.openVoice(false)"><cen-icon name="close" [size]="15" /></button>
      </header>
      <cen-listen-note />

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
          <div class="row tools">
            <span class="lbl short">analisador</span>
            <button type="button" class="chip" [class.lit]="showPre()" (click)="showPre.set(!showPre())" title="Microfone cru, antes de todo o tratamento">pré</button>
            <button type="button" class="chip" [class.lit]="showPost()" (click)="showPost.set(!showPost())" title="O que vai para a sala">pós</button>
            <button type="button" class="chip" [class.lit]="freeze()" (click)="toggleFreeze()" title="Segura o pico de cada frequência (bom para achar um zumbido ou o ponto que mais arde)">congelar</button>
            <span class="grow"></span>
            <span class="lbl short">escala</span>
            @for (r of ranges; track r) {
              <button type="button" class="chip" [class.lit]="range() === r" (click)="setRange(r)">±{{ r }}</button>
            }
          </div>
          <div class="graph" #wrap>
            <canvas #canvas (pointerdown)="down($event)" (pointermove)="move($event)" (pointerup)="up($event)" (pointercancel)="up($event)"
              (pointerleave)="hover.set(null)" (dblclick)="dbl($event)" (wheel)="wheel($event)" (contextmenu)="ctx($event)" tabindex="0"
              aria-label="Gráfico do equalizador: clique num lugar vazio para pôr uma banda; arraste para mudar; roda muda a largura; clique direito apaga"></canvas>
            @if (hover(); as h) { <span class="readout mono">{{ h }}</span> }
          </div>
          <p class="hint small">Clique num lugar vazio para pôr uma banda (na ponta esquerda vira corte de grave, na direita corte de agudo) e arraste. Roda: largura (Q) ou inclinação do corte · Ctrl + roda: ganho · Alt + roda: alcance dinâmico · Shift: ajuste fino · Alt + clique: liga/desliga a banda · clique duplo no ponto: digitar valores · clique direito: apaga. Segure o <cen-icon name="headphones" [size]="11" /> da banda para ouvir só a faixa dela (só você ouve; arraste para os lados para procurar o ruído). Até {{ maxBands }} bandas.</p>
          @if (selected(); as b) {
            <div class="row edit">
              <span class="dot" [style.background]="hue(sel())"></span>
              <button type="button" class="btn small solo" [class.on]="store.soloing()" title="Segure para ouvir só a faixa desta banda (só você ouve). Arraste para os lados para mudar a frequência."
                (pointerdown)="soloDown($event)" (pointermove)="soloMove($event)" (pointerup)="soloUp($event)" (pointercancel)="soloUp($event)" (contextmenu)="$event.preventDefault()">
                <cen-icon name="headphones" [size]="14" />
              </button>
              <select class="sel" (change)="patchBand({ type: $any($event.target).value })" aria-label="Tipo da banda">
                @for (t of types; track t) { <option [value]="t" [selected]="t === b.type">{{ bandLabel(t) }}</option> }
              </select>
              <label>Hz <input #hz class="num" type="number" min="20" max="20000" step="1" [value]="round(b.freq)" (change)="patchBand({ freq: +$any($event.target).value })" /></label>
              @if (hasGain(b.type)) {
                <label>dB <input class="num" type="number" min="-24" max="24" step="0.5" [value]="b.gain" (change)="patchBand({ gain: +$any($event.target).value })" /></label>
              }
              <label>Q <input class="num" type="number" min="0.1" max="18" step="0.1" [value]="b.q" (change)="patchBand({ q: +$any($event.target).value })" /></label>
              @if (b.type === 'lowcut' || b.type === 'highcut') {
                <select class="sel" (change)="patchBand({ slope: $any(+$any($event.target).value) })" aria-label="Inclinação">
                  @for (s of slopes; track s) { <option [value]="s" [selected]="s === b.slope">{{ s }} dB/oit</option> }
                </select>
              }
              @if (canDyn(b.type)) {
                <button class="btn small" [class.on]="b.dyn !== 0" [attr.aria-pressed]="b.dyn !== 0" (click)="toggleDyn(b)"
                  title="EQ dinâmico: a banda só age quando o som na faixa dela passa do limiar (ótimo para S ardido e estouro de P)">dinâmica</button>
              }
              <button class="btn small" [class.on]="!b.on" (click)="patchBand({ on: !b.on })">{{ b.on ? 'Ligada' : 'Desligada' }}</button>
              <button class="btn small" title="Apagar banda" (click)="removeBand(sel())"><cen-icon name="trash" [size]="14" /></button>
            </div>
            @if (b.dyn !== 0 && canDyn(b.type)) {
              <div class="row edit dynrow">
                <span class="lbl short">dinâmica</span>
                <label>limiar <input class="num" type="number" min="-70" max="0" step="1" [value]="b.thr" (change)="patchBand({ thr: +$any($event.target).value })" /> dB</label>
                <label>alcance <input class="num" type="number" [min]="-maxDyn" [max]="maxDyn" step="0.5" [value]="b.dyn" (change)="patchBand({ dyn: +$any($event.target).value })" /> dB</label>
                <span class="bar wide dynlvl" title="Quanto a banda está mexendo agora"><i [style.width.%]="dynPct(sel())"></i></span>
                <span class="val">{{ fmtDb(dynNow(sel())) }} dB</span>
              </div>
              <p class="hint small">Começa a agir quando a faixa da banda passa do limiar e chega ao alcance todo 10 dB acima. Alcance negativo abaixa (sibilância, estouro); positivo sobe. Segure o fone para ouvir a faixa e achar o limiar.</p>
            }
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
    .listen { display: inline-flex; align-items: center; gap: 0.35rem; }
    .solo { padding: 0 0.45rem; display: inline-grid; place-items: center; touch-action: none; }
    .tools { margin: 0.4rem 0 0; gap: 0.35rem; }
    .lbl.short { min-width: 0; }
    .readout { position: absolute; top: 6px; right: 8px; font-size: 0.72rem; color: var(--muted); pointer-events: none; background: rgb(16 16 17 / 0.8); padding: 1px 5px; border-radius: 2px; }
    .dynlvl { width: 90px; }
    .dynlvl i { background: var(--warn); }
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
  protected readonly canDyn = canDyn;
  protected readonly maxDyn = MAX_DYN;
  protected readonly ranges = RANGES;
  protected readonly range = signal(readRange());
  protected readonly showPre = signal(true);
  protected readonly showPost = signal(true);
  protected readonly freeze = signal(false);
  protected readonly hover = signal<string | null>(null);
  private readonly hzInput = viewChild<ElementRef<HTMLInputElement>>('hz');
  private peakPre: Float32Array | null = null;
  private peakPost: Float32Array | null = null;
  private soloDrag: { id: number; x: number; freq: number } | null = null;
  protected readonly hasGain = hasGain;
  protected readonly fmtDb = fmtDb;
  protected readonly round = Math.round;

  private readonly scope = new Scope();
  private raf = 0;
  private statsTimer = 0;
  private drag: { index: number; id: number; x: number; y: number; freq: number; gain: number; fine: boolean } | null = null;
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
    b.dyn = Math.min(MAX_DYN, Math.max(-MAX_DYN, Number.isFinite(b.dyn) ? b.dyn : 0));
    b.thr = Math.min(0, Math.max(-70, Number.isFinite(b.thr) ? b.thr : -30));
    this.set({ eq, eqOn: true });
    // Em solo, a escuta acompanha a banda (arrastar procurando o ruído).
    if (this.store.soloing()) this.store.soloBand(b);
  }
  protected removeBand(i: number) {
    const eq = this.voice().eq.filter((_, k) => k !== i);
    this.sel.set(Math.max(0, Math.min(this.sel(), eq.length - 1)));
    this.set({ eq });
  }
  /** Banda nova onde clicou: nas pontas vira corte (como no Pro-Q), no meio um sino. */
  private addBand(f: number, g: number): number {
    const eq = this.voice().eq;
    if (eq.length >= MAX_BANDS) return -1;
    const b = f < 40 ? band('lowcut', Math.max(20, Math.round(f)), 0, 0.71, 12) : f > 14000 ? band('highcut', Math.round(f), 0, 0.71, 12) : band('bell', Math.round(f), Math.round(g * 2) / 2, 1);
    this.set({ eq: [...eq, b], eqOn: true });
    this.sel.set(eq.length);
    return eq.length;
  }
  protected toggleDyn(b: EqBand) {
    this.patchBand(b.dyn !== 0 ? { dyn: 0 } : { dyn: -6, thr: -30 });
  }
  protected dynNow(i: number): number {
    return this.meter()?.dyn?.[i] ?? 0;
  }
  protected dynPct(i: number): number {
    const b = this.voice().eq[i];
    return b === undefined || b.dyn === 0 ? 0 : Math.min(100, (Math.abs(this.dynNow(i)) / Math.abs(b.dyn)) * 100);
  }
  protected setRange(r: number) {
    this.range.set(r);
    try {
      localStorage.setItem('noveau:eq-escala', String(r));
    } catch {
      /* sem armazenamento: vale só agora */
    }
  }
  protected toggleFreeze() {
    this.freeze.set(!this.freeze());
    this.peakPre = this.peakPost = null;
  }

  // ---------- solo (segurar o fone da banda)

  protected soloDown(e: PointerEvent) {
    const b = this.selected();
    if (b === null || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.soloDrag = { id: e.pointerId, x: e.clientX, freq: b.freq };
    this.store.soloBand(b);
  }
  protected soloMove(e: PointerEvent) {
    const d = this.soloDrag;
    if (d === null || d.id !== e.pointerId) return;
    // 40 px = uma oitava (Shift: 5x mais fino).
    const oct = (e.clientX - d.x) / (e.shiftKey ? 200 : 40);
    this.patchBand({ freq: Math.round(Math.min(F_MAX, Math.max(F_MIN, d.freq * Math.pow(2, oct)))) });
  }
  protected soloUp(e: PointerEvent) {
    if (this.soloDrag?.id !== e.pointerId) return;
    this.soloDrag = null;
    this.store.soloBand(null);
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
    const r = this.gMax();
    return h / 2 - (g / r) * (h / 2 - 14);
  }
  private gOf(y: number, h: number) {
    const r = this.gMax();
    return Math.max(-24, Math.min(24, ((h / 2 - y) / (h / 2 - 14)) * r));
  }
  /** Escala do gráfico: a escolhida, ou a próxima maior se alguma banda passar dela. */
  private gMax(): number {
    const need = Math.max(0, ...this.voice().eq.map((b) => Math.max(Math.abs(b.gain), Math.abs(b.gain + b.dyn))));
    return RANGES.find((r) => r >= this.range() && r >= need) ?? 30;
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

  /**
   * Clique no ponto: pega a banda; num lugar vazio: põe uma banda ali e já arrasta (como no Pro-Q).
   * Alt + clique: liga/desliga. O arrasto é relativo, então o Shift (fino) não pula.
   */
  protected down(e: PointerEvent) {
    if (e.button !== 0) return;
    const s = this.size();
    if (s === null) return;
    let i = this.hit(e);
    if (e.altKey) {
      if (i >= 0) {
        this.sel.set(i);
        this.patchBand({ on: !this.voice().eq[i].on });
      }
      e.preventDefault();
      return;
    }
    if (i < 0) i = this.addBand(this.fOf(e.clientX - s.r.left, s.w), this.gOf(e.clientY - s.r.top, s.h));
    if (i < 0) return;
    this.sel.set(i);
    const b = this.voice().eq[i];
    this.drag = { index: i, id: e.pointerId, x: e.clientX, y: e.clientY, freq: b.freq, gain: b.gain, fine: e.shiftKey };
    this.hover.set(null);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  protected move(e: PointerEvent) {
    const s = this.size();
    if (s === null) return;
    const d = this.drag;
    if (d === null || d.id !== e.pointerId) {
      if (e.buttons === 0) {
        const f = this.fOf(e.clientX - s.r.left, s.w);
        this.hover.set(`${fmtHz(f)} Hz · ${noteOf(f)} · ${fmtDb(this.gOf(e.clientY - s.r.top, s.h))} dB`);
      }
      return;
    }
    const b = this.voice().eq[d.index];
    if (b === undefined) return;
    // Shift trocou no meio do arrasto: recomeça daqui para não pular.
    if (e.shiftKey !== d.fine) Object.assign(d, { x: e.clientX, y: e.clientY, freq: b.freq, gain: b.gain, fine: e.shiftKey });
    const k = d.fine ? 0.15 : 1;
    const freq = d.freq * Math.pow(10, ((e.clientX - d.x) / s.w) * LOG_SPAN * k);
    const patch: Partial<EqBand> = { freq: Math.round(Math.min(F_MAX, Math.max(F_MIN, freq))) };
    if (hasGain(b.type)) {
      const g = d.gain - ((e.clientY - d.y) / (s.h / 2 - 14)) * this.gMax() * k;
      patch.gain = Math.round(Math.max(-24, Math.min(24, g)) * 10) / 10;
    }
    this.hover.set(`${fmtHz(patch.freq!)} Hz · ${noteOf(patch.freq!)}${patch.gain !== undefined ? ` · ${fmtDb(patch.gain)} dB` : ''}`);
    this.patchBand(patch);
  }
  protected up(e: PointerEvent) {
    if (this.drag?.id === e.pointerId) this.drag = null;
  }
  /** Clique duplo no ponto: vai para os números da banda. */
  protected dbl(e: MouseEvent) {
    const i = this.hit(e);
    if (i < 0) return;
    this.sel.set(i);
    setTimeout(() => {
      const el = this.hzInput()?.nativeElement;
      el?.focus();
      el?.select();
    });
  }
  /** Roda: largura (Q) ou inclinação do corte · Ctrl: ganho · Alt: alcance dinâmico · Shift: fino. */
  protected wheel(e: WheelEvent) {
    const i = this.hit(e);
    const target = i >= 0 ? i : this.sel();
    const b = this.voice().eq[target];
    if (b === undefined) return;
    e.preventDefault();
    this.sel.set(target);
    // Shift + roda vira rolagem de lado em vários sistemas.
    const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    if (delta === 0) return;
    const up = delta < 0;
    const fine = e.shiftKey;
    if (e.ctrlKey || e.metaKey) {
      if (hasGain(b.type)) this.patchBand({ gain: Math.round((b.gain + (up ? 1 : -1) * (fine ? 0.1 : 0.5)) * 10) / 10 });
    } else if (e.altKey) {
      if (canDyn(b.type)) this.patchBand({ dyn: Math.round((b.dyn + (up ? 1 : -1) * (fine ? 0.1 : 0.5)) * 10) / 10 });
    } else if (b.type === 'lowcut' || b.type === 'highcut') {
      const k = this.slopes.indexOf(b.slope) + (up ? 1 : -1);
      const slope = this.slopes[Math.max(0, Math.min(this.slopes.length - 1, k))];
      if (slope !== b.slope) this.patchBand({ slope });
    } else {
      const q = b.q * Math.pow(up ? 1.12 : 1 / 1.12, fine ? 0.25 : 1);
      this.patchBand({ q: Math.round(q * 100) / 100 });
    }
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

  /** Ganho de cada banda agora: as dinâmicas somam o que o detector está mexendo. */
  private liveBands(): EqBand[] {
    return this.voice().eq.map((b, i) => (isDynamic(b) ? { ...b, gain: b.gain + this.dynNow(i) } : b));
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
    const v = this.voice();
    const on = v.eqOn;
    const soloing = this.store.soloing();
    const sel = this.sel();

    // faixa em solo
    const solo = soloing ? v.eq[sel] : undefined;
    if (solo !== undefined) {
      const [lo, hi] = soloRange(solo);
      const x0 = this.xOf(Math.max(F_MIN, lo), w);
      const x1 = this.xOf(Math.min(F_MAX, hi), w);
      g.fillStyle = this.hue(sel).replace(')', ' / 0.10)');
      g.fillRect(x0, 0, x1 - x0, h);
    }

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
    const r = this.gMax();
    for (const db of [-r, -r / 2, 0, r / 2, r]) {
      const y = Math.round(this.yOf(db, h)) + 0.5;
      g.strokeStyle = db === 0 ? 'rgb(255 255 255 / 0.14)' : 'rgb(255 255 255 / 0.05)';
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
      g.fillStyle = 'rgb(255 255 255 / 0.28)';
      g.fillText(`${db > 0 ? '+' : ''}${String(db).replace('.', ',')}`, 3, y - 3);
    }

    // analisador: antes (cinza) e depois (cor), inclinado 4,5 dB por oitava em volta de 1 kHz
    // (como o Pro-Q: voz e música caem nos agudos, e assim a curva fica reta para o olho)
    if (this.scope.read()) {
      const hold = (data: Float32Array, peak: Float32Array | null) => {
        if (!this.freeze()) return data;
        if (peak === null || peak.length !== data.length) return Float32Array.from(data);
        for (let k = 0; k < data.length; k++) if (data[k] > peak[k]) peak[k] = data[k];
        return peak;
      };
      const spec = (data: Float32Array, fill: string, stroke: string) => {
        const nyq = this.scope.rate / 2;
        g.beginPath();
        g.moveTo(0, h);
        for (let px = 0; px <= w; px += 2) {
          const f = this.fOf(px, w);
          const bin = Math.min(data.length - 1, Math.round((f / nyq) * data.length));
          const t = data[bin] + 4.5 * Math.log2(f / 1000);
          const db = Math.max(-100, Math.min(-10, Number.isFinite(t) ? t : -100));
          g.lineTo(px, h - ((db + 100) / 90) * h);
        }
        g.lineTo(w, h);
        g.closePath();
        g.fillStyle = fill;
        g.fill();
        g.strokeStyle = stroke;
        g.stroke();
      };
      if (this.scope.hasPre && this.showPre()) {
        this.peakPre = this.freeze() ? hold(this.scope.preData, this.peakPre) : null;
        spec(this.peakPre ?? this.scope.preData, 'rgb(255 255 255 / 0.03)', 'rgb(255 255 255 / 0.10)');
      }
      if (this.showPost()) {
        this.peakPost = this.freeze() ? hold(this.scope.postData, this.peakPost) : null;
        spec(this.peakPost ?? this.scope.postData, 'rgb(111 95 166 / 0.16)', 'rgb(164 151 207 / 0.35)');
      }
    }

    const line = (secs: ReturnType<typeof bandSections>, step: number) => {
      g.beginPath();
      for (let px = 0; px <= w; px += step) {
        const y = this.yOf(responseDb(secs, this.fOf(px, w)), h);
        if (px === 0) g.moveTo(px, y);
        else g.lineTo(px, y);
      }
      g.stroke();
    };
    const live = this.liveBands();
    // cada banda (fraca); as dinâmicas mostram também até onde podem ir (tracejado)
    v.eq.forEach((b, i) => {
      if (!b.on) return;
      const dim = solo !== undefined && i !== sel;
      g.lineWidth = 1;
      if (isDynamic(b)) {
        g.setLineDash([3, 4]);
        g.strokeStyle = this.hue(i).replace(')', dim ? ' / 0.12)' : ' / 0.45)');
        line(bandSections({ ...b, gain: b.gain + b.dyn }), 3);
        g.setLineDash([]);
      }
      g.strokeStyle = this.hue(i).replace(')', dim ? ' / 0.12)' : ' / 0.35)');
      line(bandSections(live[i]), 3);
    });
    // a soma, com o que as bandas dinâmicas estão fazendo agora
    g.lineWidth = 2;
    g.strokeStyle = on ? '#cfc6ef' : 'rgb(255 255 255 / 0.25)';
    line(eqSections({ eqOn: on, eq: live }), 2);

    // pontos
    v.eq.forEach((b, i) => {
      const n = this.nodeXY(b, w, h);
      const dim = solo !== undefined && i !== sel;
      g.globalAlpha = !on || dim ? 0.45 : 1;
      if (isDynamic(b)) {
        // anel = banda dinâmica; marquinha = onde ela está agora
        g.beginPath();
        g.arc(n.x, n.y, (i === sel ? 8 : 6.5) + 3.5, 0, Math.PI * 2);
        g.lineWidth = 1.5;
        g.strokeStyle = this.hue(i);
        g.stroke();
        const yNow = this.yOf(live[i].gain, h);
        g.beginPath();
        g.moveTo(n.x - 5, yNow);
        g.lineTo(n.x + 5, yNow);
        g.lineWidth = 2;
        g.stroke();
      }
      g.beginPath();
      g.arc(n.x, n.y, i === sel ? 8 : 6.5, 0, Math.PI * 2);
      g.fillStyle = b.on ? this.hue(i) : '#555';
      g.fill();
      g.lineWidth = i === sel ? 2 : 1;
      g.strokeStyle = i === sel && solo !== undefined ? '#fff' : '#0b0b0c';
      g.stroke();
      g.fillStyle = '#0b0b0c';
      g.font = 'bold 9px "DM Mono", monospace';
      g.fillText(String(i + 1), n.x - 2.6, n.y + 3);
      g.globalAlpha = 1;
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
