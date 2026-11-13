// Sons do 1o1, sintetizados na hora (sem arquivo para baixar).
//
// - "pull" (você puxou alguém): duas notas subindo, Mi → Si.
// - "pulled" (alguém puxou você): três notas subindo, Dó → Mi → Sol, um pouco mais longa, para
//   chamar a atenção de quem não fez nada.
// - "leave" (o 1o1 acabou, para os dois): as duas notas do "pull" ao contrário, Si → Mi.
//
// Cada nota é um sino curto (seno + um parcial agudo bem baixo, ataque de 4 ms, queda de ~0,35 s),
// a uns -16 dBFS no pico: dá para ouvir por cima de um jogo sem assustar. Toca na mesma saída de som
// escolhida para a sala.
import type { DirectCue } from './direct';

const NOTES: Record<DirectCue, number[]> = {
  pull: [659.25, 987.77],
  pulled: [523.25, 659.25, 783.99],
  leave: [987.77, 659.25],
};
const STEP_S = 0.09;
const PEAK = 0.16;

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
    const out = c.createGain();
    out.gain.value = PEAK;
    out.connect(c.destination);
    const notes = NOTES[cue];
    notes.forEach((f, i) => {
      const at = t0 + i * STEP_S;
      const last = i === notes.length - 1;
      const decay = last ? 0.42 : 0.22;
      for (const [mult, level] of [
        [1, 1],
        [2.76, 0.08],
      ] as const) {
        const o = c.createOscillator();
        o.type = 'sine';
        o.frequency.value = f * mult;
        const g = c.createGain();
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(level, at + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
        o.connect(g).connect(out);
        o.start(at);
        o.stop(at + decay + 0.02);
      }
    });
    // Solta os nós quando acaba.
    window.setTimeout(() => out.disconnect(), (notes.length * STEP_S + 0.6) * 1000);
  } catch {
    // Sem Web Audio (ou bloqueado): fica sem o som, o resto segue.
  }
}
