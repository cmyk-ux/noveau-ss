// Qualidade que cede quando o PC aperta (ex.: Valorant puxando o processador).
//
// Usa a Compute Pressure API (Chrome 125+): o navegador diz se o processador está "nominal",
// "fair", "serious" ou "critical". Pela especificação, uma página que está capturando a tela
// continua recebendo esses avisos mesmo sem foco, então funciona com o jogo em primeiro plano.
//
// Ao apertar ("serious"), baixa só os quadros por segundo; a resolução só cai em "critical".
// Os quadros caem na própria captura (applyConstraints só com frameRate): menos quadros capturados =
// menos cópia e menos codificação. A resolução cai no codificador (scaleResolutionDownBy), nunca na
// captura: reduzir na captura faz o Chrome converter a tela inteira e depois reduzir, na mesma thread
// que ele limita a meio núcleo (desktop_capture_device.cc), ou seja, a captura fica MAIS cara.
// Quando o PC alivia por um tempo, sobe um degrau de volta até a qualidade total.

export type Pressure = 'nominal' | 'fair' | 'serious' | 'critical';

export interface LoadState {
  supported: boolean;
  pressure: Pressure | null;
  /** 0 = qualidade total. */
  step: number;
  width: number;
  height: number;
  fps: number;
}

interface Step {
  /** Quanto o codificador reduz a imagem (1 = tamanho que sai normalmente). */
  scale: number;
  fps: number;
}

const TICK_MS = 1000;
const CRITICAL_AFTER_MS = 3000;
const SERIOUS_AFTER_MS = 6000;
const RECOVER_AFTER_MS = 20000;

function stepsFor(fps: number): Step[] {
  const raw: Step[] = [
    { scale: 1, fps },
    { scale: 1, fps: Math.min(fps, 60) },
    { scale: 1, fps: Math.min(fps, 45) },
    { scale: 1, fps: Math.min(fps, 30) },
    { scale: 4 / 3, fps: Math.min(fps, 30) },
    { scale: 2, fps: Math.min(fps, 30) },
  ];
  return raw.filter((s, i) => i === 0 || s.fps !== raw[i - 1].fps || s.scale !== raw[i - 1].scale);
}

/** Teto da captura: a tela no tamanho original, de qualquer monitor (ver share.ts). */
export const CAPTURE_MAX = { width: 7680, height: 4320 };

type Observer = { observe(source: 'cpu', opts?: { sampleInterval?: number }): Promise<void>; disconnect(): void };
type ObserverCtor = new (cb: (records: { state: Pressure }[]) => void) => Observer;

export class LoadGovernor {
  private readonly steps: Step[];
  private step = 0;
  private pressure: Pressure | null = null;
  private since = performance.now();
  private lastChange = performance.now();
  private observer: Observer | null = null;
  private timer?: number;
  private stopped = false;
  private applied = 0;

  constructor(
    private readonly track: MediaStreamTrack,
    private readonly size: { width: number; height: number },
    fps: number,
    private readonly onChange: (s: LoadState) => void,
    /** Reduz a imagem no codificador (1 = normal). */
    private readonly scaleTo: (factor: number) => void,
  ) {
    this.steps = stepsFor(fps);
  }

  static supported(): boolean {
    return 'PressureObserver' in globalThis;
  }

  start() {
    const Ctor = (globalThis as unknown as { PressureObserver?: ObserverCtor }).PressureObserver;
    if (Ctor === undefined) {
      this.report(false);
      return;
    }
    this.observer = new Ctor((records) => {
      const last = records[records.length - 1];
      if (last === undefined || last.state === this.pressure) return;
      this.pressure = last.state;
      this.since = performance.now();
      this.report(true);
    });
    this.observer.observe('cpu', { sampleInterval: 1000 }).catch(() => this.report(false));
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.track.addEventListener('ended', () => this.stop(), { once: true });
    this.report(true);
  }

  stop() {
    this.stopped = true;
    this.observer?.disconnect();
    this.observer = null;
    window.clearInterval(this.timer);
  }

  private tick() {
    if (this.stopped || this.pressure === null) return;
    const now = performance.now();
    const held = now - this.since;
    const quiet = now - this.lastChange;
    if (this.pressure === 'critical' && quiet >= CRITICAL_AFTER_MS) this.move(+1);
    // "Pesado" só tira quadros; resolução só cai se chegar a "no limite".
    else if (this.pressure === 'serious' && held >= SERIOUS_AFTER_MS && quiet >= SERIOUS_AFTER_MS && this.fpsOnly(this.step + 1))
      this.move(+1);
    else if ((this.pressure === 'nominal' || this.pressure === 'fair') && held >= RECOVER_AFTER_MS && quiet >= RECOVER_AFTER_MS)
      this.move(-1);
  }

  private fpsOnly(step: number): boolean {
    const s = this.steps[step];
    return s !== undefined && s.scale === 1;
  }

  private move(delta: number) {
    const next = Math.max(0, Math.min(this.steps.length - 1, this.step + delta));
    if (next === this.step) return;
    this.step = next;
    this.lastChange = performance.now();
    const s = this.steps[next];
    if (s.fps !== this.applied) {
      this.applied = s.fps;
      void this.track
        .applyConstraints({ width: { max: CAPTURE_MAX.width }, height: { max: CAPTURE_MAX.height }, frameRate: { max: s.fps } })
        .catch(() => undefined);
    }
    this.scaleTo(s.scale);
    this.report(true);
  }

  private report(supported: boolean) {
    const s = this.steps[this.step];
    const even = (n: number) => Math.max(2, Math.round(n / s.scale / 2) * 2);
    this.onChange({ supported, pressure: this.pressure, step: this.step, width: even(this.size.width), height: even(this.size.height), fps: s.fps });
  }
}

export function describePressure(p: Pressure | null): string {
  switch (p) {
    case 'nominal':
      return 'tranquilo';
    case 'fair':
      return 'moderado';
    case 'serious':
      return 'pesado';
    case 'critical':
      return 'no limite';
    default:
      return 'medindo…';
  }
}
