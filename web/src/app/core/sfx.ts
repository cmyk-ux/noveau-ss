// Sons do 1o1, sintetizados na hora (sem arquivo para baixar).
//
// - "pull" (você puxou alguém): duas notas subindo, Mi → Si.
// - "pulled" (alguém puxou você): três notas subindo, Dó → Mi → Sol, um pouco mais longa, para
//   chamar a atenção de quem não fez nada.
// - "leave" (o 1o1 acabou, para os dois): as duas notas do "pull" ao contrário, Si → Mi.
// - "knock" (alguém tentou te puxar para um 1o1 enquanto você está noutro): duas batidinhas graves e
//   curtas na mesma nota (Lá 220 Hz), como bater de leve na porta. Só para você, por cima da conversa:
//   sem melodia para não parecer o "fui puxado", curta e abafada para não atrapalhar quem está falando.
//   Os harmônicos 2× e 3× fazem a nota grave aparecer também em fone e caixinha pequenos.
//
// Cada nota é um sino curto (seno + um parcial agudo bem baixo, ataque de 4 ms, queda de ~0,35 s),
// a uns -16 dBFS no pico: dá para ouvir por cima de um jogo sem assustar. Toca na mesma saída de som
// escolhida para a sala.
import type { DirectCue } from './direct';

interface Shape {
  notes: number[];
  /** Distância entre o começo de uma nota e o da próxima (s). */
  step: number;
  /** Queda de cada nota e da última (s). */
  decay: number;
  lastDecay: number;
  /** Parciais: [múltiplo da nota, nível]. */
  partials: readonly (readonly [number, number])[];
  peak: number;
  attack: number;
}
const BELL = [
  [1, 1],
  [2.76, 0.08],
] as const;
const chime = (notes: number[]): Shape => ({ notes, step: 0.09, decay: 0.22, lastDecay: 0.42, partials: BELL, peak: 0.16, attack: 0.004 });
export const SHAPES: Record<DirectCue, Shape> = {
  pull: chime([659.25, 987.77]),
  pulled: chime([523.25, 659.25, 783.99]),
  leave: chime([987.77, 659.25]),
  knock: {
    notes: [220, 220],
    step: 0.15,
    decay: 0.16,
    lastDecay: 0.2,
    partials: [
      [1, 1],
      [2, 0.35],
      [3, 0.12],
    ],
    peak: 0.2,
    attack: 0.006,
  },
};

let ctx: AudioContext | null = null;
let sinkOf = '';

/** Toca um som do 1o1 em `sink` (id da saída de som; vazio/"default" = a padrão). */
export function playCue(cue: DirectCue, sink?: string) {
  try {
    if (ctx === null || ctx.state === 'closed') {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      sinkOf = '';
    }
    const c = ctx;
    const want = sink && sink !== 'default' ? sink : '';
    if (want !== sinkOf && 'setSinkId' in c) {
      sinkOf = want;
      void (c as unknown as { setSinkId(id: string): Promise<void> }).setSinkId(want).catch(() => undefined);
    }
    if (c.state !== 'running') void c.resume().catch(() => undefined);
    const t0 = c.currentTime + 0.02;
    const sh = SHAPES[cue];
    const out = c.createGain();
    out.gain.value = sh.peak;
    out.connect(c.destination);
    const notes = sh.notes;
    notes.forEach((f, i) => {
      const at = t0 + i * sh.step;
      const last = i === notes.length - 1;
      const decay = last ? sh.lastDecay : sh.decay;
      for (const [mult, level] of sh.partials) {
        const o = c.createOscillator();
        o.type = 'sine';
        o.frequency.value = f * mult;
        const g = c.createGain();
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(level, at + sh.attack);
        g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
        o.connect(g).connect(out);
        o.start(at);
        o.stop(at + decay + 0.02);
      }
    });
    // Solta os nós quando acaba.
    window.setTimeout(() => out.disconnect(), (notes.length * sh.step + 0.6) * 1000);
  } catch {
    // Sem Web Audio (ou bloqueado): fica sem o som, o resto segue.
  }
}
