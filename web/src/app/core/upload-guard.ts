// Perda na subida de quem transmite: a cura mais leve é tirar só um pouco de bitrate.
//
// O navegador (GCC) só corta o bitrate quando a fila cresce ou a perda passa de ~10%. Uma perda
// baixa mas constante (0,3-2%: Wi-Fi, limite do provedor) não faz ele reagir, e a 30+ Mbps isso já é
// travada para todo mundo. Aqui o próprio site lê o relatório do servidor (remote-inbound-rtp) e, se
// a subida estiver perdendo de verdade, baixa o teto 15% por vez (no máximo até metade). Com a
// rede limpa por 30 s, sobe 10% de volta, até o máximo de novo.

export interface UploadState {
  /** Teto atual e o original, em bps. */
  cap: number;
  target: number;
  /** Perda na subida nos últimos ~10 s (0-1). */
  loss: number;
}

const TICK_MS = 2000;
const BAD_LOSS = 0.005;
const CLEAN_LOSS = 0.001;
const STEP_DOWN = 0.85;
const STEP_UP = 1.1;
const FLOOR = 0.5;
const DOWN_EVERY_MS = 6000;
const UP_AFTER_MS = 30000;

export class UploadGuard {
  private timer?: number;
  private cap: number;
  private prev: { sent: number; lost: number } | null = null;
  private samples: number[] = [];
  private lastChange = 0;
  private stopped = false;

  constructor(
    private readonly sender: () => RTCRtpSender | undefined,
    private readonly target: number,
    private readonly onChange: (s: UploadState) => void,
  ) {
    this.cap = target;
  }

  start() {
    if (this.target <= 0) return;
    this.timer = window.setInterval(() => void this.tick(), TICK_MS);
  }

  stop() {
    this.stopped = true;
    window.clearInterval(this.timer);
  }

  private async tick() {
    const sender = this.sender();
    if (sender === undefined || this.stopped) return;
    let sent = 0;
    let lost = 0;
    const report = await sender.getStats();
    report.forEach((r: any) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') sent += r.packetsSent ?? 0;
      if (r.type === 'remote-inbound-rtp' && r.kind === 'video') lost += Math.max(0, r.packetsLost ?? 0);
    });
    const prev = this.prev;
    this.prev = { sent, lost };
    if (prev === null || sent <= prev.sent) return;
    const loss = Math.max(0, lost - prev.lost) / (sent - prev.sent);
    this.samples = [...this.samples, loss].slice(-15);
    const now = performance.now();
    const recent = this.samples.slice(-3);
    const bad = recent.filter((l) => l > BAD_LOSS).length >= 2;
    if (bad && now - this.lastChange >= DOWN_EVERY_MS && this.cap > this.target * FLOOR) {
      this.cap = Math.max(Math.round(this.target * FLOOR), Math.round(this.cap * STEP_DOWN));
      this.lastChange = now;
    } else if (
      this.cap < this.target &&
      this.samples.length >= 15 &&
      this.samples.every((l) => l < CLEAN_LOSS) &&
      now - this.lastChange >= UP_AFTER_MS
    ) {
      this.cap = Math.min(this.target, Math.round(this.cap * STEP_UP));
      this.lastChange = now;
    }
    await this.apply(sender);
    const window10 = this.samples.slice(-5);
    this.onChange({ cap: this.cap, target: this.target, loss: window10.length ? window10.reduce((a, b) => a + b, 0) / window10.length : 0 });
  }

  /** Mexe só na camada mais alta; reaplica se o LiveKit reescrever os parâmetros. */
  private async apply(sender: RTCRtpSender) {
    const params = sender.getParameters();
    const encs = params.encodings ?? [];
    if (encs.length === 0) return;
    const top = encs.reduce((a, b) => ((b.maxBitrate ?? 0) > (a.maxBitrate ?? 0) ? b : a), encs[0]);
    const want = this.cap;
    if (top.maxBitrate === want) return;
    // Quando o LiveKit volta o teto original (ou nós voltamos ao máximo), só regrava se precisar.
    if (this.cap === this.target && (top.maxBitrate ?? 0) >= this.target) return;
    top.maxBitrate = want;
    await sender.setParameters(params).catch(() => undefined);
  }
}
