// Taxa de atualização do monitor onde está esta janela, medida pelos quadros de animação do navegador.
//
// Serve para pedir à captura de tela um ritmo que caiba no monitor. A captura só ganha um quadro novo a
// cada atualização do monitor (144 Hz = um a cada 6,9 ms). Medido num PC com monitor de 144 Hz
// (12/11/2026, /teste, tela 1080p, H.265 na placa, nada limitando): pedindo 60, a captura entregou 48,
// que é 144 / 3, ou seja, um quadro a cada 3 atualizações. Pedindo um divisor do monitor (144 / 2 = 72)
// o ritmo não precisa "pular" uma atualização; o codificador, com teto de 60, corta o excesso de forma
// regular. O /teste mede a captura pedindo vários ritmos, para conferir isso em cada PC.

const COMMON = [30, 50, 60, 75, 90, 100, 120, 144, 165, 170, 175, 180, 200, 240, 280, 300, 360];

let hz = 0;
let pending: Promise<number> | null = null;

/** Última taxa medida (0 = ainda não mediu). */
export function monitorHz(): number {
  return hz;
}

/** Mede por ~1 s (só com a aba à vista; o navegador para a animação com a aba escondida). */
export function measureMonitor(): Promise<number> {
  if (pending !== null) return pending;
  if (typeof requestAnimationFrame !== 'function' || document.hidden) return Promise.resolve(hz);
  pending = new Promise<number>((done) => {
    const times: number[] = [];
    const step = (t: number) => {
      times.push(t);
      if (t - times[0] < 1000) return void requestAnimationFrame(step);
      // Mediana dos intervalos: um quadro perdido no meio não puxa a conta.
      const d = times
        .slice(1)
        .map((x, i) => x - times[i])
        .sort((a, b) => a - b);
      const mid = d[Math.floor(d.length / 2)];
      if (mid > 0) hz = nearest(1000 / mid);
      done(hz);
    };
    requestAnimationFrame(step);
  }).finally(() => (pending = null));
  return pending;
}

function nearest(x: number): number {
  return COMMON.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
}

/**
 * Quadros por segundo a pedir à captura para mandar `want`: o divisor do monitor logo acima (ou igual)
 * do pedido. 144 Hz: 60 -> 72, 120 -> 144. 165 Hz: 60 -> 82,5. 60, 120 e 240 Hz com 60: 60 (divide
 * certinho). Monitor mais lento que o pedido: o pedido (a captura não passa do monitor de qualquer jeito).
 */
export function captureRateFor(want: number, monitor = hz): number {
  if (!(monitor > 0) || monitor <= want) return want;
  const n = Math.floor(monitor / want + 1e-6);
  const rate = monitor / n;
  return Math.abs(rate - want) < 0.5 ? want : Math.round(rate * 10) / 10;
}

if (typeof document !== 'undefined') {
  void measureMonitor();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void measureMonitor();
  });
}
