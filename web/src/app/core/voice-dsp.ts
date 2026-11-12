// Tratamento da voz: tipos, presets e a matemática do equalizador. Sem nada de DOM: o mesmo arquivo
// roda na interface (desenhar a curva) e no worker da voz (filtrar o som). Veja docs/VOZ.md.

/** Redução de ruído. 'leve' = RNNoise (10 ms), 'forte' = DeepFilterNet 3 (~30 ms, melhor com teclado). */
export type Denoise = 'off' | 'navegador' | 'leve' | 'forte';
/** Cancelamento de eco: nenhum, só o som que sai do navegador, ou tudo que o PC toca (Chrome 141+). */
export type Echo = 'off' | 'site' | 'pc';
/** Portão: 'auto' abre quando a IA reconhece voz; 'manual' abre acima do limiar escolhido. */
export type GateMode = 'off' | 'auto' | 'manual';
export type BandType = 'bell' | 'lowshelf' | 'highshelf' | 'lowcut' | 'highcut' | 'notch';
/** Inclinação dos cortes, em dB por oitava. */
export type Slope = 6 | 12 | 24 | 48;

export interface EqBand {
  type: BandType;
  /** Hz */
  freq: number;
  /** dB (sino e prateleiras) */
  gain: number;
  q: number;
  slope: Slope;
  on: boolean;
}

export interface VoiceSettings {
  echo: Echo;
  /** Ganho automático do navegador. */
  agc: boolean;
  denoise: Denoise;
  /** Quanto a redução de ruído pode abaixar, em dB. MAX_STRENGTH = sem limite. */
  strength: number;
  gate: GateMode;
  /** Limiar do portão manual, em dBFS. */
  gateDb: number;
  eqOn: boolean;
  eq: EqBand[];
  /** Ganho final, em dB. */
  outDb: number;
}

export const MAX_STRENGTH = 60;
export const MAX_BANDS = 8;
export const SAMPLE_RATE = 48000;
/** Quadro de processamento: 10 ms a 48 kHz (o mesmo do RNNoise, do DeepFilterNet e do Opus). */
export const FRAME = 480;

export const DENOISE_LABELS: Record<Denoise, string> = {
  off: 'Desligada',
  navegador: 'Do navegador',
  leve: 'IA leve (RNNoise)',
  forte: 'IA forte (DeepFilterNet 3)',
};

/** Atraso que cada redução de ruído soma à voz (medido no Chromium, veja docs/VOZ.md). */
export const DENOISE_DELAY_MS: Record<Denoise, number> = { off: 0, navegador: 0, leve: 10, forte: 30 };

export function band(type: BandType, freq: number, gain = 0, q = 0.71, slope: Slope = 12): EqBand {
  return { type, freq, gain, q, slope, on: true };
}

export interface EqPreset {
  id: string;
  name: string;
  hint: string;
  bands: EqBand[];
  /** Preset salvo pela pessoa (dá para apagar). */
  mine?: boolean;
}

/** Presets prontos. Os nomes dizem o problema que cada um resolve. */
export const EQ_PRESETS: EqPreset[] = [
  { id: 'plano', name: 'Plano', hint: 'Nada mexido: o som do microfone como ele é.', bands: [] },
  {
    id: 'natural',
    name: 'Voz natural',
    hint: 'Só tira o ronco abaixo de 80 Hz (mesa batendo, ventilador, respiração no microfone).',
    bands: [band('lowcut', 80, 0, 0.71, 12)],
  },
  {
    id: 'radio',
    name: 'Voz de rádio',
    hint: 'Grave encorpado, menos "caixa", mais presença e brilho. O som de locutor.',
    bands: [
      band('lowcut', 70, 0, 0.71, 24),
      band('lowshelf', 140, 3, 0.71),
      band('bell', 320, -3, 1.2),
      band('bell', 3200, 3, 0.9),
      band('highshelf', 10000, 2.5, 0.71),
    ],
  },
  {
    id: 'callout',
    name: 'Call de jogo',
    hint: 'Feita para ser entendida por cima do som do jogo: corta grave e agudo que não ajudam e realça 2 a 3 kHz.',
    bands: [
      band('lowcut', 120, 0, 0.71, 24),
      band('bell', 280, -3, 1),
      band('bell', 2400, 4, 0.9),
      band('highcut', 11000, 0, 0.71, 12),
    ],
  },
  {
    id: 'headset',
    name: 'Headset abafado',
    hint: 'Para microfone de headset ou de notebook: devolve clareza e agudo.',
    bands: [
      band('lowcut', 100, 0, 0.71, 24),
      band('bell', 250, -4, 1.1),
      band('bell', 4000, 4, 0.8),
      band('highshelf', 8000, 4, 0.71),
    ],
  },
  {
    id: 'perto',
    name: 'Microfone colado na boca',
    hint: 'Tira o grave inchado de falar perto (efeito de proximidade) e os estouros de P e B.',
    bands: [band('lowcut', 120, 0, 0.71, 24), band('lowshelf', 250, -4, 0.71), band('bell', 160, -2, 1.4)],
  },
  {
    id: 'sibilancia',
    name: 'Menos chiado de S',
    hint: 'Abaixa a faixa onde o S e o X ardem (6 a 8 kHz).',
    bands: [band('lowcut', 80, 0, 0.71, 12), band('bell', 6800, -5, 2.5)],
  },
  {
    id: 'brilho',
    name: 'Brilho',
    hint: 'Mais ar no agudo, para microfone escuro.',
    bands: [band('lowcut', 80, 0, 0.71, 12), band('highshelf', 9000, 4, 0.71)],
  },
  {
    id: 'radinho',
    name: 'Radinho',
    hint: 'De brincadeira: soa como rádio de comunicação.',
    bands: [band('lowcut', 450, 0, 0.71, 48), band('bell', 1600, 6, 1.2), band('highcut', 3200, 0, 0.71, 48)],
  },
];

export const DEFAULT_VOICE: VoiceSettings = {
  echo: 'site',
  agc: true,
  denoise: 'leve',
  strength: 24,
  gate: 'off',
  gateDb: -50,
  eqOn: true,
  eq: EQ_PRESETS[1].bands.map((b) => ({ ...b })),
  outDb: 0,
};

/** Tudo desligado: o microfone vai como sai do aparelho, sem passar pelo worker. */
export function isRawChain(s: VoiceSettings): boolean {
  return (s.denoise === 'off' || s.denoise === 'navegador') && s.gate === 'off' && !eqActive(s) && s.outDb === 0;
}

export function eqActive(s: VoiceSettings): boolean {
  return s.eqOn && s.eq.some((b) => b.on && (b.type === 'lowcut' || b.type === 'highcut' || b.type === 'notch' || b.gain !== 0));
}

/** Atraso que o tratamento escolhido soma (fora a rede): o que a pessoa vai sentir. */
export function chainDelayMs(s: VoiceSettings): number {
  if (isRawChain(s)) return 0;
  return DENOISE_DELAY_MS[s.denoise];
}

// ---------- Opus da sala

/**
 * Qualidade de áudio da sala: vale para o microfone de todo mundo (quem muda, muda para todos).
 * Quadros de 10 ms tiram 10 ms do atraso de cada voz (o padrão do WebRTC é 20 ms) e
 * custam só uns 30 kbps a mais de cabeçalho; a 128 kbps a voz soa igual ao microfone.
 */
export type RoomAudio = 'instantaneo' | 'musica' | 'economia';
export interface RoomAudioPreset {
  id: RoomAudio;
  label: string;
  hint: string;
  /** Tamanho do quadro do Opus, em ms. */
  ptime: 10 | 20;
  kbps: number;
  dtx: boolean;
  red: boolean;
}
export const ROOM_AUDIO: RoomAudioPreset[] = [
  {
    id: 'instantaneo',
    label: 'Instantâneo',
    hint: 'Quadros de 10 ms (metade do padrão de 20 ms) e 128 kbps: o menor atraso que o navegador consegue, com a voz igual à do microfone.',
    ptime: 10,
    kbps: 128,
    dtx: true,
    red: true,
  },
  {
    id: 'musica',
    label: 'Música',
    hint: 'Para instrumento e voz cantada: 256 kbps e sem cortar o silêncio (o corte come a cauda das notas). Use com o tratamento desligado.',
    ptime: 20,
    kbps: 256,
    dtx: false,
    red: true,
  },
  {
    id: 'economia',
    label: 'Economia',
    hint: 'Para internet fraca ou 4G: 48 kbps em quadros de 20 ms. Ainda é voz em banda cheia.',
    ptime: 20,
    kbps: 48,
    dtx: true,
    red: true,
  },
];
export const DEFAULT_ROOM_AUDIO: RoomAudio = 'instantaneo';
export function roomAudio(id: string | undefined): RoomAudioPreset {
  return ROOM_AUDIO.find((p) => p.id === id) ?? ROOM_AUDIO[0];
}

// ---------- Equalizador (biquads do "Audio EQ Cookbook" de R. Bristow-Johnson)

/** Coeficientes já normalizados (a0 = 1). Um corte de 24/48 dB vira 2/4 seções em série. */
export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Q de cada seção de um Butterworth de ordem 2n (cortes mais íngremes ficam sem calombo). */
const BUTTERWORTH: Record<number, number[]> = {
  12: [0.7071],
  24: [0.5412, 1.3066],
  48: [0.5098, 0.6013, 0.9, 2.5629],
};

function norm(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function clampFreq(f: number, fs: number) {
  return Math.min(Math.max(f, 10), fs * 0.49);
}

function section(kind: 'lp' | 'hp', f: number, q: number, fs: number): Biquad {
  const w = (2 * Math.PI * clampFreq(f, fs)) / fs;
  const c = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  return kind === 'lp'
    ? norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha)
    : norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
}

function firstOrder(kind: 'lp' | 'hp', f: number, fs: number): Biquad {
  const k = Math.tan((Math.PI * clampFreq(f, fs)) / fs);
  const a1 = (k - 1) / (k + 1);
  return kind === 'lp' ? { b0: k / (k + 1), b1: k / (k + 1), b2: 0, a1, a2: 0 } : { b0: 1 / (k + 1), b1: -1 / (k + 1), b2: 0, a1, a2: 0 };
}

/** As seções de uma banda (vazio = banda sem efeito). */
export function bandSections(b: EqBand, fs = SAMPLE_RATE): Biquad[] {
  if (!b.on) return [];
  const f = clampFreq(b.freq, fs);
  const q = Math.min(Math.max(b.q, 0.1), 18);
  if (b.type === 'lowcut' || b.type === 'highcut') {
    const kind = b.type === 'lowcut' ? 'hp' : 'lp';
    if (b.slope === 6) return [firstOrder(kind, f, fs)];
    const qs = BUTTERWORTH[b.slope];
    // O Q da banda só mexe na ressonância da última seção (como no Pro-Q: Q alto = calombo no corte).
    return qs.map((bq, i) => section(kind, f, i === qs.length - 1 ? bq * (q / 0.7071) : bq, fs));
  }
  const w = (2 * Math.PI * f) / fs;
  const c = Math.cos(w);
  const s = Math.sin(w);
  if (b.type === 'notch') {
    const alpha = s / (2 * q);
    return [norm(1, -2 * c, 1, 1 + alpha, -2 * c, 1 - alpha)];
  }
  if (b.gain === 0) return [];
  const A = Math.pow(10, b.gain / 40);
  if (b.type === 'bell') {
    const alpha = s / (2 * q);
    return [norm(1 + alpha * A, -2 * c, 1 - alpha * A, 1 + alpha / A, -2 * c, 1 - alpha / A)];
  }
  const alpha = s / (2 * q);
  const sq = 2 * Math.sqrt(A) * alpha;
  if (b.type === 'lowshelf') {
    return [
      norm(
        A * (A + 1 - (A - 1) * c + sq),
        2 * A * (A - 1 - (A + 1) * c),
        A * (A + 1 - (A - 1) * c - sq),
        A + 1 + (A - 1) * c + sq,
        -2 * (A - 1 + (A + 1) * c),
        A + 1 + (A - 1) * c - sq,
      ),
    ];
  }
  return [
    norm(
      A * (A + 1 + (A - 1) * c + sq),
      -2 * A * (A - 1 + (A + 1) * c),
      A * (A + 1 + (A - 1) * c - sq),
      A + 1 - (A - 1) * c + sq,
      2 * (A - 1 - (A + 1) * c),
      A + 1 - (A - 1) * c - sq,
    ),
  ];
}

/** Todas as seções do equalizador, na ordem. */
export function eqSections(s: Pick<VoiceSettings, 'eqOn' | 'eq'>, fs = SAMPLE_RATE): Biquad[] {
  if (!s.eqOn) return [];
  return s.eq.flatMap((b) => bandSections(b, fs));
}

/** Ganho em dB de um conjunto de seções numa frequência. */
export function responseDb(sections: Biquad[], f: number, fs = SAMPLE_RATE): number {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  let mag2 = 1;
  for (const q of sections) {
    const nr = q.b0 + q.b1 * c1 + q.b2 * c2;
    const ni = -(q.b1 * s1 + q.b2 * s2);
    const dr = 1 + q.a1 * c1 + q.a2 * c2;
    const di = -(q.a1 * s1 + q.a2 * s2);
    mag2 *= (nr * nr + ni * ni) / (dr * dr + di * di);
  }
  return 10 * Math.log10(Math.max(mag2, 1e-12));
}

export function bandLabel(t: BandType): string {
  switch (t) {
    case 'bell':
      return 'Sino';
    case 'lowshelf':
      return 'Prateleira grave';
    case 'highshelf':
      return 'Prateleira aguda';
    case 'lowcut':
      return 'Corte de grave';
    case 'highcut':
      return 'Corte de agudo';
    case 'notch':
      return 'Rasgo (notch)';
  }
}

export function hasGain(t: BandType): boolean {
  return t === 'bell' || t === 'lowshelf' || t === 'highshelf';
}

// ---------- Guardar e ler (localStorage) sem confiar no que estiver lá

const TYPES: BandType[] = ['bell', 'lowshelf', 'highshelf', 'lowcut', 'highcut', 'notch'];
const SLOPES: Slope[] = [6, 12, 24, 48];
function num(v: unknown, lo: number, hi: number, fb: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;
}

export function cleanBand(v: unknown): EqBand | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!TYPES.includes(o['type'] as BandType)) return null;
  return {
    type: o['type'] as BandType,
    freq: num(o['freq'], 20, 20000, 1000),
    gain: num(o['gain'], -24, 24, 0),
    q: num(o['q'], 0.1, 18, 0.71),
    slope: SLOPES.includes(o['slope'] as Slope) ? (o['slope'] as Slope) : 12,
    on: o['on'] !== false,
  };
}

export function cleanBands(v: unknown): EqBand[] {
  return Array.isArray(v) ? v.map(cleanBand).filter((b): b is EqBand => b !== null).slice(0, MAX_BANDS) : [];
}

export function cleanVoice(v: unknown): VoiceSettings {
  const d = DEFAULT_VOICE;
  if (typeof v !== 'object' || v === null) return { ...d, eq: d.eq.map((b) => ({ ...b })) };
  const o = v as Record<string, unknown>;
  const pick = <T>(x: unknown, all: T[], fb: T) => (all.includes(x as T) ? (x as T) : fb);
  return {
    echo: pick(o['echo'], ['off', 'site', 'pc'] as Echo[], d.echo),
    agc: typeof o['agc'] === 'boolean' ? o['agc'] : d.agc,
    denoise: pick(o['denoise'], ['off', 'navegador', 'leve', 'forte'] as Denoise[], d.denoise),
    strength: num(o['strength'], 3, MAX_STRENGTH, d.strength),
    gate: pick(o['gate'], ['off', 'auto', 'manual'] as GateMode[], d.gate),
    gateDb: num(o['gateDb'], -80, -10, d.gateDb),
    eqOn: typeof o['eqOn'] === 'boolean' ? o['eqOn'] : d.eqOn,
    eq: Array.isArray(o['eq']) ? cleanBands(o['eq']) : d.eq.map((b) => ({ ...b })),
    outDb: num(o['outDb'], -12, 12, d.outDb),
  };
}
