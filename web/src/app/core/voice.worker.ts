// O caminho da voz, numa thread separada e sem AudioContext.
//
// O microfone chega aqui em pedaços de 10 ms (MediaStreamTrackProcessor), é tratado e volta como
// uma trilha nova (MediaStreamTrackGenerator) que vai para a sala. Medido no Chromium: passar o
// microfone por um AudioContext (o jeito antigo) somava ~20 ms só de ida e volta entre relógios,
// mais ~20 ms do RNNoise reempacotado de 128 em 480 amostras. Aqui o quadro do RNNoise é o próprio
// quadro do microfone: o RNNoise soma exatamente 10 ms, e o resto (equalizador, portão, ganho) zero.
//
// Ordem: microfone → (48 kHz) → redução de ruído com limite de intensidade → portão → equalizador
// → ganho → limitador → sala.

/// <reference lib="webworker" />

import { FRAME, MAX_STRENGTH, SAMPLE_RATE, VoiceSettings, bandSections, isDynamic, soloSections, type Biquad, type EqBand } from './voice-dsp';

export type VoiceWorkerIn =
  | { type: 'input'; readable: ReadableStream<AudioData> }
  | { type: 'output'; writable: WritableStream<AudioData> }
  | { type: 'settings'; settings: VoiceSettings }
  | { type: 'meter'; on: boolean }
  /** Saída extra só para você se ouvir (a sala não recebe o solo). null fecha. */
  | { type: 'monitor'; writable: WritableStream<AudioData> | null }
  /** Solo de uma banda do equalizador na saída de escuta (null = escuta normal). */
  | { type: 'solo'; band: EqBand | null }
  | { type: 'stop' };

export interface VoiceMeter {
  type: 'meter';
  /** dBFS (RMS) antes e depois do tratamento. */
  inDb: number;
  outDb: number;
  /** Probabilidade de voz do RNNoise (0-1), ou -1 sem RNNoise rodando. */
  vad: number;
  gateOpen: boolean;
  /** Fração de cada 10 ms gasta processando. */
  load: number;
  /** O que está rodando de fato (a IA forte usa a leve enquanto carrega ou se falhar). */
  engine: 'off' | 'leve' | 'forte';
  inputRate: number;
  /** Quanto cada banda dinâmica está mexendo agora, em dB (mesma ordem do equalizador; 0 = fixa). */
  dyn: number[];
}
export type VoiceWorkerOut =
  | VoiceMeter
  | { type: 'engine-failed'; engine: 'leve' | 'forte'; reason: string }
  /** A IA forte terminou de carregar (o processador troca para este worker só agora). */
  | { type: 'ready'; engine: 'forte' }
  | { type: 'overload'; load: number };

const ASSETS = '/voz/';

// ---------- RNNoise (xiph, BSD; wasm do @sapphi-red/web-noise-suppressor). Só 3 importações.

interface RnnExports {
  memory: WebAssembly.Memory;
  __wasm_call_ctors(): void;
  emscripten_stack_init?(): void;
  malloc(n: number): number;
  rnnoise_create(model: number): number;
  rnnoise_destroy(st: number): void;
  rnnoise_process_frame(st: number, out: number, input: number): number;
}

class Rnnoise {
  private constructor(
    private readonly x: RnnExports,
    private readonly st: number,
    private readonly inPtr: number,
    private readonly outPtr: number,
  ) {}

  static async load(): Promise<Rnnoise> {
    const simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
    const bytes = await fetch(ASSETS + (simd ? 'rnnoise_simd.wasm' : 'rnnoise.wasm')).then((r) => {
      if (!r.ok) throw new Error(`rnnoise ${r.status}`);
      return r.arrayBuffer();
    });
    let memory: WebAssembly.Memory | null = null;
    const env = {
      // Sem devolver nada: o wasm espera um número, e devolver a Uint8Array fazia o navegador
      // convertê-la (16 MB de memória virando texto) a cada cópia: 1 s por quadro em vez de 0,3 ms.
      emscripten_memcpy_big: (d: number, s: number, n: number) => {
        new Uint8Array(memory!.buffer).copyWithin(d, s, s + n);
      },
      emscripten_resize_heap: (want: number) => {
        try {
          memory!.grow(Math.ceil((want - memory!.buffer.byteLength) / 65536));
          return 1;
        } catch {
          return 0;
        }
      },
      __assert_fail: () => {
        throw new Error('rnnoise: assert');
      },
    };
    const { instance } = await WebAssembly.instantiate(bytes, { env });
    const x = instance.exports as unknown as RnnExports;
    memory = x.memory;
    x.emscripten_stack_init?.();
    x.__wasm_call_ctors();
    const st = x.rnnoise_create(0);
    return new Rnnoise(x, st, x.malloc(FRAME * 4), x.malloc(FRAME * 4));
  }

  /** Processa 480 amostras (-1..1). Devolve a voz limpa (atrasada 1 quadro) e a chance de ser voz. */
  process(frame: Float32Array, out: Float32Array): number {
    const heap = new Float32Array(this.x.memory.buffer);
    const i0 = this.inPtr >> 2;
    for (let i = 0; i < FRAME; i++) heap[i0 + i] = frame[i] * 32768;
    const vad = this.x.rnnoise_process_frame(this.st, this.outPtr, this.inPtr);
    const o0 = this.outPtr >> 2;
    const h = new Float32Array(this.x.memory.buffer);
    for (let i = 0; i < FRAME; i++) out[i] = h[o0 + i] / 32768;
    return vad;
  }
}

// ---------- DeepFilterNet 3 (Rikorose, MIT/Apache-2.0). O wasm (libDF) e a cola do wasm-bindgen
// abaixo vêm do @workadventure/noise-suppression 0.2.0 (MIT), que compila o libDF do código-fonte.

interface DfExports {
  memory: WebAssembly.Memory;
  __wbindgen_externrefs: WebAssembly.Table;
  __wbindgen_start(): void;
  __wbindgen_malloc_command_export(size: number, align: number): number;
  __externref_table_alloc_command_export(): number;
  __wbindgen_exn_store_command_export(idx: number): void;
  df_create(ptr: number, len: number, attenLim: number): number;
  df_get_frame_length(st: number): number;
  df_process_frame(st: number, ptr: number, len: number): Float32Array;
  df_set_atten_lim(st: number, lim: number): void;
}

class DeepFilter {
  private constructor(
    private readonly w: DfExports,
    private readonly st: number,
  ) {}

  static async load(attenLim: number): Promise<DeepFilter> {
    const [module, model] = await Promise.all([
      WebAssembly.compileStreaming(fetch(ASSETS + 'dfn/df_bg.wasm')),
      fetch(ASSETS + 'dfn/DeepFilterNet3_onnx.tar.gz').then((r) => {
        // Sem o arquivo, o servidor devolve a página do site (rota do Angular).
        if (!r.ok || r.headers.get('content-type')?.includes('text/html')) throw new Error(`modelo não encontrado (${r.status})`);
        return r.arrayBuffer();
      }),
    ]);
    let w: DfExports | null = null;
    const u8 = () => new Uint8Array(w!.memory.buffer);
    const f32 = () => new Float32Array(w!.memory.buffer);
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
    const imports = {
      './df_bg.js': {
        __wbg___wbindgen_throw_6b64449b9b9ed33c: (p: number, n: number) => {
          throw new Error(decoder.decode(u8().subarray(p >>> 0, (p >>> 0) + n)));
        },
        __wbg_getRandomValues_cc7f052a444bb2ce: (p: number, n: number) => {
          try {
            crypto.getRandomValues(u8().subarray(p >>> 0, (p >>> 0) + n));
          } catch (e) {
            const idx = w!.__externref_table_alloc_command_export();
            w!.__wbindgen_externrefs.set(idx, e);
            w!.__wbindgen_exn_store_command_export(idx);
          }
        },
        __wbg_new_from_slice_b6858b485924da4e: (p: number, n: number) => new Float32Array(f32().subarray((p >>> 0) / 4, (p >>> 0) / 4 + n)),
        __wbindgen_init_externref_table: () => {
          const table = w!.__wbindgen_externrefs;
          const offset = table.grow(4);
          table.set(0, undefined);
          table.set(offset, undefined);
          table.set(offset + 1, null);
          table.set(offset + 2, true);
          table.set(offset + 3, false);
        },
      },
    };
    const instance = await WebAssembly.instantiate(module, imports);
    w = instance.exports as unknown as DfExports;
    w.__wbindgen_start();
    const bytes = new Uint8Array(model);
    const ptr = w.__wbindgen_malloc_command_export(bytes.length, 1) >>> 0;
    u8().set(bytes, ptr);
    const st = w.df_create(ptr, bytes.length, attenLim) >>> 0;
    if (w.df_get_frame_length(st) !== FRAME) throw new Error('quadro do DeepFilterNet diferente de 480');
    return new DeepFilter(w, st);
  }

  setLimit(db: number) {
    this.w.df_set_atten_lim(this.st, db);
  }

  process(frame: Float32Array): Float32Array {
    const ptr = this.w.__wbindgen_malloc_command_export(FRAME * 4, 4) >>> 0;
    new Float32Array(this.w.memory.buffer).set(frame, ptr / 4);
    return this.w.df_process_frame(this.st, ptr, FRAME);
  }
}

// ---------- Reamostragem para 48 kHz (só quando o microfone vem cru em outra taxa)

/** Interpolador sinc com janela de Blackman, 32 pontos, tabela de 512 fases. */
class Resampler {
  private static readonly TAPS = 16;
  private static readonly PHASES = 512;
  private readonly table: Float32Array;
  private buf = new Float32Array(0);
  private pos = 0;
  private readonly step: number;

  constructor(inRate: number) {
    const T = Resampler.TAPS;
    const P = Resampler.PHASES;
    this.step = inRate / SAMPLE_RATE;
    const cutoff = Math.min(1, SAMPLE_RATE / inRate) * 0.95;
    this.table = new Float32Array((P + 1) * 2 * T);
    for (let p = 0; p <= P; p++) {
      const frac = p / P;
      let sum = 0;
      for (let k = 0; k < 2 * T; k++) {
        const t = k - (T - 1) - frac;
        const x = Math.PI * cutoff * t;
        const sinc = t === 0 ? 1 : Math.sin(x) / x;
        const n = (t + T) / (2 * T);
        const win = n <= 0 || n >= 1 ? 0 : 0.42 - 0.5 * Math.cos(2 * Math.PI * n) + 0.08 * Math.cos(4 * Math.PI * n);
        const v = sinc * win;
        this.table[p * 2 * T + k] = v;
        sum += v;
      }
      for (let k = 0; k < 2 * T; k++) this.table[p * 2 * T + k] /= sum;
    }
  }

  process(input: Float32Array): Float32Array {
    const T = Resampler.TAPS;
    const merged = new Float32Array(this.buf.length + input.length);
    merged.set(this.buf);
    merged.set(input, this.buf.length);
    const out: number[] = [];
    while (this.pos + T + 1 < merged.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const pf = frac * Resampler.PHASES;
      const p = Math.floor(pf);
      const a = pf - p;
      const r0 = p * 2 * T;
      const r1 = r0 + 2 * T;
      let s = 0;
      for (let k = 0; k < 2 * T; k++) {
        const idx = i - (T - 1) + k;
        const v = idx >= 0 ? merged[idx] : 0;
        s += v * (this.table[r0 + k] * (1 - a) + this.table[r1 + k] * a);
      }
      out.push(s);
      this.pos += this.step;
    }
    const keep = Math.max(0, Math.floor(this.pos) - T);
    this.buf = merged.subarray(keep).slice();
    this.pos -= keep;
    return Float32Array.from(out);
  }
}

// ---------- Estado

let settings: VoiceSettings | null = null;
let writer: WritableStreamDefaultWriter<AudioData> | null = null;
let reader: ReadableStreamDefaultReader<AudioData> | null = null;
let meterOn = false;

let rnn: Rnnoise | null = null;
let rnnLoading: Promise<void> | null = null;
let rnnFailed = false;
let dfn: DeepFilter | null = null;
let dfnLoading: Promise<void> | null = null;
let dfnFailed = false;

/**
 * Uma banda do equalizador. A memória dos biquads (2 por seção) fica quando os coeficientes mudam,
 * para não estalar. Banda dinâmica: o detector ouve só a faixa dela, e o ganho é refeito a cada 10 ms.
 */
interface Stage {
  band: EqBand;
  secs: Biquad[];
  z: Float64Array;
  dyn: { det: Biquad[]; dz: Float64Array; env: number; gain: number } | null;
}
let stages: Stage[] = [];

let monitor: WritableStreamDefaultWriter<AudioData> | null = null;
let monitorTs = 0;
let solo: { band: EqBand; secs: Biquad[]; z: Float64Array } | null = null;
const soloBuf = new Float32Array(FRAME);
let outGain = 1;
let mixDry = 0;

let resampler: Resampler | null = null;
let resamplerRate = SAMPLE_RATE;
let pending = new Float32Array(FRAME * 4);
let pendingLen = 0;
let nextTimestamp = -1;

const frame = new Float32Array(FRAME);
const wet = new Float32Array(FRAME);
/** Quadro anterior, cru: o RNNoise devolve a voz um quadro atrasada, e a mistura precisa alinhar. */
const prevDry = new Float32Array(FRAME);

let gateGain = 0;
let gateHold = 0;
const GATE_HOLD_FRAMES = 30; // 300 ms
let limEnv = 0;

// Medidores (acumulados e enviados ~15 vezes por segundo, só com a janela aberta).
let mIn = -120;
let mOut = -120;
let mVad = -1;
let mBusy = 0;
let mFrames = 0;
let loadWindow = 0;
let loadFrames = 0;
let inputRate = SAMPLE_RATE;

function post(m: VoiceWorkerOut) {
  (self as unknown as Worker).postMessage(m);
}

function applySettings(s: VoiceSettings) {
  settings = s;
  const bands = s.eqOn ? s.eq : [];
  stages = bands.map((b, i) => {
    const old = stages[i];
    const dynamic = isDynamic(b);
    const secs = dynamic ? bandSections({ ...b, gain: b.gain + (old?.dyn?.gain ?? 0) }) : bandSections(b);
    // Mesma forma de antes: aproveita a memória (mexer no ganho ou na frequência não estala).
    const z = old !== undefined && old.z.length === Math.max(secs.length, 1) * 2 && old.band.type === b.type ? old.z : new Float64Array(Math.max(secs.length, 1) * 2);
    let dyn: Stage['dyn'] = null;
    if (dynamic) {
      const det = soloSections(b);
      dyn = old?.dyn && old.band.type === b.type ? { ...old.dyn, det } : { det, dz: new Float64Array(det.length * 2), env: -120, gain: 0 };
    }
    return { band: b, secs, z, dyn };
  });
  outGain = Math.pow(10, s.outDb / 20);
  mixDry = s.strength >= MAX_STRENGTH ? 0 : Math.pow(10, -s.strength / 20);
  const wantRnn = s.denoise === 'leve' || s.denoise === 'forte' || s.gate === 'auto';
  if (wantRnn && rnn === null && rnnLoading === null && !rnnFailed) {
    rnnLoading = Rnnoise.load()
      .then((r) => void (rnn = r))
      .catch((e) => {
        rnnFailed = true;
        post({ type: 'engine-failed', engine: 'leve', reason: String(e) });
      });
  }
  if (s.denoise === 'forte' && dfn === null && dfnLoading === null && !dfnFailed) {
    dfnLoading = DeepFilter.load(s.strength >= MAX_STRENGTH ? 100 : s.strength)
      .then((d) => {
        dfn = d;
        post({ type: 'ready', engine: 'forte' });
      })
      .catch((e) => {
        dfnFailed = true;
        post({ type: 'engine-failed', engine: 'forte', reason: String(e) });
      });
  }
  dfn?.setLimit(s.strength >= MAX_STRENGTH ? 100 : s.strength);
}

/** Passa um quadro por uma série de biquads (DF2T), no lugar. */
function runBiquads(x: Float32Array, secs: Biquad[], z: Float64Array) {
  for (let k = 0; k < secs.length; k++) {
    const q = secs[k];
    let z1 = z[2 * k];
    let z2 = z[2 * k + 1];
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const o = q.b0 * v + z1;
      z1 = q.b1 * v - q.a1 * o + z2;
      z2 = q.b2 * v - q.a2 * o;
      x[i] = o;
    }
    z[2 * k] = z1;
    z[2 * k + 1] = z2;
  }
}

const detBuf = new Float32Array(FRAME);
/**
 * EQ dinâmico: mede a faixa da banda e decide quanto ela mexe neste quadro. Começa a agir no limiar
 * e chega ao alcance todo 10 dB acima dele; ataque rápido (~10 ms) e soltura de ~80 ms.
 */
function updateDynamic(st: Stage, y: Float32Array) {
  const d = st.dyn!;
  detBuf.set(y);
  runBiquads(detBuf, d.det, d.dz);
  let sq = 0;
  for (let i = 0; i < FRAME; i++) sq += detBuf[i] * detBuf[i];
  const level = dbOf(sq, FRAME);
  d.env = level > d.env ? d.env + (level - d.env) * 0.7 : d.env + (level - d.env) * 0.12;
  const amount = Math.min(1, Math.max(0, (d.env - st.band.thr) / 10));
  const target = st.band.dyn * amount;
  d.gain += (target - d.gain) * (Math.abs(target) > Math.abs(d.gain) ? 0.7 : 0.25);
  st.secs = bandSections({ ...st.band, gain: st.band.gain + d.gain });
  if (st.z.length !== Math.max(st.secs.length, 1) * 2) st.z = new Float64Array(Math.max(st.secs.length, 1) * 2);
}

function dbOf(sumSq: number, n: number) {
  return n === 0 ? -120 : Math.max(-120, 10 * Math.log10(sumSq / n + 1e-12));
}

/** Um quadro de 10 ms (480 amostras a 48 kHz), no lugar. */
function processFrame(x: Float32Array) {
  const s = settings!;
  if (s.gate === 'off') gateGain = 1;
  let inSq = 0;
  for (let i = 0; i < FRAME; i++) inSq += x[i] * x[i];

  // 1) Redução de ruído (e a chance de ser voz, para o portão automático).
  let vad = -1;
  let engine: VoiceMeter['engine'] = 'off';
  const useDfn = s.denoise === 'forte' && dfn !== null;
  const useRnn = rnn !== null && (s.denoise === 'leve' || (s.denoise === 'forte' && dfn === null) || s.gate === 'auto');
  if (useRnn) vad = rnn!.process(x, wet);
  let y: Float32Array = x;
  if (useDfn) {
    y = dfn!.process(x);
    engine = 'forte';
  } else if (rnn !== null && (s.denoise === 'leve' || s.denoise === 'forte')) {
    // Limite de intensidade: o ruído desce no máximo `strength` dB, misturando o som original
    // (alinhado) por baixo. Sem limite, a voz fica "mascarada" e o fundo some e volta entre as palavras.
    const k = mixDry;
    if (k === 0) y = wet;
    else {
      y = new Float32Array(FRAME);
      for (let i = 0; i < FRAME; i++) y[i] = (1 - k) * wet[i] + k * prevDry[i];
    }
    engine = 'leve';
  }
  prevDry.set(x);

  // 2) Portão: decide pelo quadro inteiro, abre na hora e fecha devagar depois de 300 ms sem voz.
  let ySq = 0;
  for (let i = 0; i < FRAME; i++) ySq += y[i] * y[i];
  let open = true;
  if (s.gate !== 'off') {
    const speech = s.gate === 'auto' ? (vad < 0 ? true : vad >= 0.5) : dbOf(ySq, FRAME) > s.gateDb;
    gateHold = speech ? GATE_HOLD_FRAMES : Math.max(0, gateHold - 1);
    open = gateHold > 0;
  }
  const target = open ? 1 : 0;
  const coef = open ? 0.02 : 0.0015; // ~1 ms para abrir, ~14 ms para fechar

  // Solo (só na escuta): a faixa da banda, antes do equalizador.
  if (solo !== null && monitor !== null) {
    soloBuf.set(y);
    runBiquads(soloBuf, solo.secs, solo.z);
  }

  // 3) Equalizador (DF2T, banda por banda), 4) ganho, portão e limitador.
  const eqBuf = y === x ? x : y;
  for (const st of stages) {
    if (st.dyn !== null) updateDynamic(st, eqBuf);
    if (st.secs.length > 0) runBiquads(eqBuf, st.secs, st.z);
  }
  const out = eqBuf;
  const ceiling = 0.97;
  let outSq = 0;
  for (let i = 0; i < FRAME; i++) {
    let v = eqBuf[i];
    gateGain += (target - gateGain) * coef;
    v *= outGain * (s.gate === 'off' ? 1 : gateGain);
    const a = Math.abs(v);
    limEnv = a > limEnv ? a : limEnv * 0.9995;
    if (limEnv > ceiling) v *= ceiling / limEnv;
    out[i] = v;
    outSq += v * v;
  }
  if (out !== x) x.set(out);

  if (meterOn) {
    mIn = Math.max(mIn, dbOf(inSq, FRAME));
    mOut = Math.max(mOut, dbOf(outSq, FRAME));
    mVad = Math.max(mVad, vad);
  }
  return { open, vad, engine };
}

async function pump(r: ReadableStreamDefaultReader<AudioData>) {
  let last: ReturnType<typeof processFrame> = { open: true, vad: -1, engine: 'off' };
  for (;;) {
    let res: ReadableStreamReadResult<AudioData>;
    try {
      res = await r.read();
    } catch {
      return;
    }
    if (res.done || r !== reader) {
      res.value?.close();
      return;
    }
    const ad = res.value;
    let t0 = performance.now();
    // Só o trabalho conta para a carga (não a espera pela saída).
    let busy = 0;
    const n = ad.numberOfFrames;
    const ch = ad.numberOfChannels;
    let mono = new Float32Array(n);
    try {
      ad.copyTo(mono, { planeIndex: 0, format: 'f32-planar' });
      if (ch > 1) {
        const other = new Float32Array(n);
        for (let c = 1; c < ch; c++) {
          ad.copyTo(other, { planeIndex: c, format: 'f32-planar' });
          for (let i = 0; i < n; i++) mono[i] += other[i];
        }
        for (let i = 0; i < n; i++) mono[i] /= ch;
      }
    } catch {
      ad.close();
      continue;
    }
    if (nextTimestamp < 0) nextTimestamp = ad.timestamp;
    inputRate = ad.sampleRate;
    ad.close();
    if (inputRate !== SAMPLE_RATE) {
      if (resampler === null || resamplerRate !== inputRate) {
        resampler = new Resampler(inputRate);
        resamplerRate = inputRate;
      }
      mono = resampler.process(mono) as Float32Array<ArrayBuffer>;
    }
    if (pendingLen + mono.length > pending.length) {
      const bigger = new Float32Array((pendingLen + mono.length) * 2);
      bigger.set(pending.subarray(0, pendingLen));
      pending = bigger;
    }
    pending.set(mono, pendingLen);
    pendingLen += mono.length;

    while (pendingLen >= FRAME && settings !== null) {
      frame.set(pending.subarray(0, FRAME));
      pending.copyWithin(0, FRAME, pendingLen);
      pendingLen -= FRAME;
      last = processFrame(frame);
      const outFrame = new AudioData({
        format: 'f32-planar',
        sampleRate: SAMPLE_RATE,
        numberOfFrames: FRAME,
        numberOfChannels: 1,
        timestamp: nextTimestamp,
        data: frame.slice(),
      });
      nextTimestamp += (FRAME / SAMPLE_RATE) * 1e6;
      if (monitor !== null) {
        // Escuta: o mesmo som da sala, ou só a faixa da banda em solo. Sem esperar (não atrasa a sala).
        const mf = new AudioData({
          format: 'f32-planar',
          sampleRate: SAMPLE_RATE,
          numberOfFrames: FRAME,
          numberOfChannels: 1,
          timestamp: monitorTs,
          data: solo !== null ? soloBuf.slice() : frame.slice(),
        });
        monitorTs += (FRAME / SAMPLE_RATE) * 1e6;
        monitor.write(mf).catch(() => mf.close());
      }
      busy += performance.now() - t0;
      try {
        await writer?.write(outFrame);
      } catch {
        outFrame.close();
        return;
      }
      t0 = performance.now();
    }

    busy += performance.now() - t0;
    const audioMs = (n / inputRate) * 1000;
    loadWindow += busy;
    loadFrames += audioMs;
    if (loadFrames >= 2000) {
      const load = loadWindow / loadFrames;
      if (load > 0.5 && settings?.denoise === 'forte' && dfn !== null) post({ type: 'overload', load });
      loadWindow = loadFrames = 0;
    }
    if (meterOn) {
      mBusy += busy;
      mFrames += audioMs;
      if (mFrames >= 66) {
        post({
          type: 'meter',
          inDb: mIn,
          outDb: mOut,
          vad: mVad,
          gateOpen: last.open,
          load: mBusy / mFrames,
          engine: last.engine,
          inputRate,
          dyn: settings?.eqOn ? settings.eq.map((_, i) => stages[i]?.dyn?.gain ?? 0) : [],
        });
        mIn = mOut = -120;
        mVad = -1;
        mBusy = mFrames = 0;
      }
    }
  }
}

self.onmessage = (e: MessageEvent<VoiceWorkerIn>) => {
  const m = e.data;
  switch (m.type) {
    case 'output':
      writer = m.writable.getWriter();
      break;
    case 'input': {
      const old = reader;
      reader = m.readable.getReader();
      void old?.cancel().catch(() => undefined);
      // Microfone novo: recomeça o quadro e a reamostragem, mas não o estado do RNNoise/portão.
      pendingLen = 0;
      resampler = null;
      void pump(reader);
      break;
    }
    case 'settings':
      applySettings(m.settings);
      break;
    case 'monitor':
      void monitor?.close().catch(() => undefined);
      monitor = m.writable?.getWriter() ?? null;
      break;
    case 'solo':
      if (m.band === null) solo = null;
      else {
        const secs = soloSections(m.band);
        // Mesma forma: guarda a memória (arrastar a banda em solo não estala).
        const z = solo !== null && solo.z.length === secs.length * 2 ? solo.z : new Float64Array(secs.length * 2);
        solo = { band: m.band, secs, z };
      }
      break;
    case 'meter':
      meterOn = m.on;
      mIn = mOut = -120;
      mVad = -1;
      mBusy = mFrames = 0;
      break;
    case 'stop':
      void reader?.cancel().catch(() => undefined);
      reader = null;
      void writer?.close().catch(() => undefined);
      writer = null;
      void monitor?.close().catch(() => undefined);
      monitor = null;
      self.close();
      break;
  }
};
