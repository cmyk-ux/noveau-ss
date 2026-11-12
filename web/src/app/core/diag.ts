import { signal } from '@angular/core';

// Diário de problemas: a cada travada na tela que você assiste, junta o que se sabe (a rede de
// quem transmite, o PC dele, a sua rede, o seu PC) e diz o motivo mais provável, em português.
// Os mesmos registros vão para o servidor (sem nada pessoal além do apelido), para a gente ver
// depois o que mais acontece e ir corrigindo.

/** O que quem transmite conta sobre o envio (atributo "tx"). */
export interface SendHealth {
  /** Perda na subida, em %. */
  l: number;
  /** Teto atual / máximo do bitrate, em Mbps. */
  cap: number;
  max: number;
  /** Uso do processador: nominal, fair, serious, critical ou "". */
  cpu: string;
  /**
   * Por que o navegador está segurando a qualidade: cpu, bandwidth, none; ou 'capture' (a captura
   * entrega bem menos quadros que o pedido) e 'encoder' (o codificador perde quadros).
   */
  lim: string;
  /** Com lim 'capture' ou 'encoder': quadros por segundo que saem (em degraus) e os pedidos. */
  cf?: number;
  wf?: number;
}

/**
 * Quadros por segundo em degraus, para o atributo "tx" (vai para a sala inteira e não deve mudar a
 * cada leitura): de 5 em 5 até 60, de 10 em 10 acima.
 */
export function fpsStep(n: number): number {
  if (n <= 0) return 0;
  return n < 60 ? Math.max(5, Math.round(n / 5) * 5) : Math.round(n / 10) * 10;
}

/** O que dizer a quem transmite e a quem assiste quando a captura não acompanha. */
export function captureAdvice(cpu: string): string {
  const cpuBusy = cpu === 'serious' || cpu === 'critical';
  return cpuBusy
    ? 'O jogo está usando quase todo o processador (e provavelmente a placa de vídeo) e o navegador não consegue copiar a tela mais rápido.'
    : 'O jogo está usando a placa de vídeo inteira e o navegador fica esperando para copiar cada quadro da tela (o processador está com folga).';
}

export const CAPTURE_FIX =
  'Para ter fps cheio: limite o FPS do jogo um pouco abaixo do que ele faz hoje (no próprio jogo, ou "Taxa máxima de quadros" no painel da NVIDIA, ' +
  'ou "Frame Rate Target Control"/Chill no AMD), de preferência num múltiplo do fps da transmissão (120 para 60). ' +
  'Ou transmita pelo OBS (captura de jogo, rodando como administrador), na tecla OBS da sala.';

export function encodeSendHealth(h: SendHealth): string {
  return JSON.stringify(h);
}

export function parseSendHealth(raw: string | null): SendHealth | null {
  if (raw === null || raw === '') return null;
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as SendHealth) : null;
  } catch {
    return null;
  }
}

export type Cause = 'their-net' | 'their-pc' | 'their-idle' | 'my-net' | 'my-pc' | 'my-decoder' | 'my-capture' | 'unknown';

export interface DiagEvent {
  id: number;
  at: number;
  cause: Cause;
  /** Quem estava transmitindo. */
  who: string;
  text: string;
  /** Quantas travadas juntas neste registro. */
  count: number;
  metrics: Record<string, number | string>;
}

export interface Probe {
  shareId: string;
  owner: string;
  tx: string | null;
  theirQuality: string;
  myQuality: string;
  report: RTCStatsReport;
}

interface Sample {
  /** Quando foi lido (ms). */
  t: number;
  freezes: number;
  /** Tempo total travado, em segundos. */
  freezeSec: number;
  framesRx: number;
  framesDec: number;
  keyframes: number;
  plis: number;
  codec: string;
  lost: number;
  received: number;
  dropped: number;
  nacks: number;
  recovered: number;
  jitterMs: number;
}

const TICK_MS = 2000;
const MERGE_MS = 20_000;
const MAX_EVENTS = 40;
const SEND_EVERY_MS = 15_000;

const pct = (n: number) => (n >= 1 ? n.toFixed(1) : n.toFixed(2)).replace('.', ',');

function read(report: RTCStatsReport): Sample | null {
  let out: Sample | null = null;
  report.forEach((r: any) => {
    if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
    const codec = r.codecId === undefined ? undefined : (report.get(r.codecId) as { mimeType?: string } | undefined);
    out = {
      t: Date.now(),
      freezes: r.freezeCount ?? 0,
      freezeSec: r.totalFreezesDuration ?? 0,
      framesRx: r.framesReceived ?? 0,
      framesDec: r.framesDecoded ?? 0,
      keyframes: r.keyFramesDecoded ?? 0,
      plis: r.pliCount ?? 0,
      codec: (codec?.mimeType ?? '').replace(/^video\//i, ''),
      lost: Math.max(0, r.packetsLost ?? 0),
      received: r.packetsReceived ?? 0,
      dropped: r.framesDropped ?? 0,
      nacks: r.nackCount ?? 0,
      recovered: r.retransmittedPacketsReceived ?? 0,
      jitterMs: Math.round((r.jitter ?? 0) * 1000),
    };
  });
  return out;
}

const BAD_QUALITY = new Set(['poor', 'lost']);

/** O que aconteceu com os quadros durante a travada (do quadro antes dela até agora). */
export interface FreezeWindow {
  /** Duração das travadas deste intervalo, em segundos. */
  freezeSec: number;
  /** Quadros por segundo que chegavam antes da travada. */
  fpsBefore: number;
  /** Quadros que chegaram e não foram decodificados nem descartados (presos no decodificador). */
  stuck: number;
  /** Quadros que chegaram durante a travada em si. */
  arrivedDuring: number;
  /** Pedidos de quadro-chave que o meu navegador fez. */
  plis: number;
  /** Pacotes que não chegaram nem com reenvio. */
  lost: number;
  /** Quadros jogados fora (por exemplo, à espera de um quadro-chave). */
  dropped: number;
  codec: string;
}

/** O motivo mais provável, do mais específico para o mais vago. */
export function classify(
  who: string,
  tx: SendHealth | null,
  theirQuality: string,
  myQuality: string,
  d: { lossPct: number; dropped: number; nacks: number; recovered: number; jitterMs: number },
  w: FreezeWindow | null = null,
): { cause: Cause; text: string } {
  // 1) A subida de quem transmite: o servidor nem recebe os pacotes, todo mundo trava junto.
  if ((tx !== null && tx.l >= 0.5) || BAD_QUALITY.has(theirQuality)) {
    const mbps = (n: number) => String(n).replace('.', ',');
    const extra = tx !== null && tx.cap < tx.max ? `; já baixou para ${mbps(tx.cap)} de ${mbps(tx.max)} Mbps` : '';
    return {
      cause: 'their-net',
      text: tx !== null && tx.l >= 0.5
        ? `A internet de ${who} está perdendo ${pct(tx.l)}% dos pacotes ao enviar${extra}. Trava para todo mundo.`
        : `A conexão de ${who} com o servidor está ruim. Trava para todo mundo.`,
    };
  }
  // 2) A captura de quem transmite não acompanha (jogo ocupando a placa de vídeo dele).
  if (tx !== null && tx.lim === 'capture' && (tx.cf ?? 0) > 0) {
    return {
      cause: 'their-pc',
      text: `O navegador de ${who} está capturando só ~${tx.cf} de ${tx.wf ?? '?'} quadros por segundo. ${captureAdvice(tx.cpu)} Não é a internet nem o seu PC.`,
    };
  }
  // 3) O PC de quem transmite não dá conta de codificar. ("serious" é 75-90% do processador, o normal
  //    de qualquer jogo, e agora chega sempre, mesmo com o "Ceder" desligado: só "critical" conta.)
  if (tx !== null && (tx.cpu === 'critical' || tx.lim === 'cpu' || tx.lim === 'encoder')) {
    return { cause: 'their-pc', text: `O PC de ${who} está no limite (processador). A imagem sai com menos quadros.` };
  }
  // 4) A minha rede: perda que chega até mim (os reenvios do servidor não chegaram a tempo).
  if (d.lossPct >= 0.3 || BAD_QUALITY.has(myQuality)) {
    return {
      cause: 'my-net',
      text: d.lossPct >= 0.3
        ? `Sua conexão está perdendo ${pct(d.lossPct)}% dos pacotes vindos do servidor. Só você trava. Cabo em vez de Wi-Fi costuma resolver.`
        : 'Sua conexão com o servidor está ruim. Só você trava.',
    };
  }
  // 5) Um pacote se perdeu de vez e a imagem esperou um quadro inteiro novo (os quadros seguintes
  //    dependiam dele e foram jogados fora). Uma perda só já basta, mesmo que a % pareça zero.
  if (w !== null && w.lost > 0 && (w.plis > 0 || w.dropped > 0)) {
    const theirs = tx !== null && tx.l >= 0.1;
    return {
      cause: theirs ? 'their-net' : 'my-net',
      text: theirs
        ? `${w.lost} pacote(s) de ${who} se perderam na subida e o reenvio não chegou a tempo; a imagem esperou um quadro inteiro novo.`
        : `${w.lost} pacote(s) se perderam e o reenvio não chegou a tempo; a imagem esperou um quadro inteiro novo. A subida de ${who} não acusou perda, então provavelmente foi no caminho até você.`,
    };
  }
  if (w !== null && w.fpsBefore >= 5) {
    const codec = w.codec === '' ? '' : ` (${w.codec})`;
    // 6) Chegou tudo, mas o meu navegador pediu quadro-chave: o decodificador não conseguiu ler
    //    um quadro. Sem perda nenhuma, isso é o decodificador (comum com H.265 na placa de vídeo).
    if (w.plis > 0) {
      return {
        cause: 'my-decoder',
        text: `Seu navegador não conseguiu decodificar um quadro de ${who}${codec} e teve de esperar um quadro inteiro novo. Chegou tudo, então é o decodificador, não a rede.`,
      };
    }
    // 7) Os quadros chegaram e ficaram presos sem ser decodificados.
    if (w.stuck >= Math.max(3, w.fpsBefore * w.freezeSec * 0.5)) {
      return {
        cause: 'my-decoder',
        text: `Os quadros de ${who} chegaram, mas o decodificador do seu navegador${codec} engasgou com eles.`,
      };
    }
    // 8) Nada chegou durante a pausa, sem perda: quem transmite parou de mandar quadros.
    if (w.arrivedDuring <= w.fpsBefore * w.freezeSec * 0.2) {
      return {
        cause: 'their-idle',
        text: `Nenhum quadro novo veio de ${who} por ${pct(w.freezeSec)} s, sem perda nenhuma. Ou a tela dele ficou parada (aí o navegador não manda nada e não é travada de verdade), ou o PC dele segurou os quadros por um instante.`,
      };
    }
  }
  // 9) O meu PC: chegou tudo, sem pedir quadro-chave, mas o navegador descartou quadros ao mostrar.
  if (d.dropped > 0) {
    return {
      cause: 'my-pc',
      text: `Seu PC descartou ${d.dropped} quadros ao mostrar a tela (decodificação lenta). Feche abas pesadas ou use a janela menor.`,
    };
  }
  return {
    cause: 'unknown',
    text: `Travou sem causa clara (perda ${pct(d.lossPct)}%, oscilação ${d.jitterMs} ms). Fica registrado para a gente investigar.`,
  };
}

export class Diagnostics {
  private readonly _events = signal<DiagEvent[]>([]);
  readonly events = this._events.asReadonly();
  private readonly _unseen = signal(0);
  /** Problemas novos desde a última vez que abriu o diário. */
  readonly unseen = this._unseen.asReadonly();
  private prev: { shareId: string; s: Sample } | null = null;
  /** Leituras dos últimos ~30 s da tela em foco, para ver o que houve durante a travada. */
  private history: Sample[] = [];
  private nextId = 1;
  private outbox: DiagEvent[] = [];
  /** Travadas de cada registro que já foram para o servidor (manda só a diferença). */
  private sent = new Map<number, number>();
  private sender?: number;

  constructor(private readonly token: () => string) {}

  /** Começa a mandar os registros ao servidor. As leituras chegam por feed(), a cada ~2 s. */
  start() {
    if (this.sender !== undefined) return;
    this.sender = window.setInterval(() => void this.flush(), SEND_EVERY_MS);
  }

  stop() {
    window.clearInterval(this.sender);
    this.sender = undefined;
    this.prev = null;
    void this.flush();
  }

  markSeen() {
    this._unseen.set(0);
  }

  clear() {
    this._events.set([]);
    this._unseen.set(0);
  }

  /**
   * Uma leitura da tela em foco (a sala lê uma vez para a proteção contra travadas e para cá).
   * null = nada em foco (ou a janela está escondida).
   */
  feed(p: Probe | null) {
    if (this.sender === undefined) return;
    if (p === null) {
      this.prev = null;
      return;
    }
    const s = read(p.report);
    if (s === null) return;
    const prev = this.prev?.shareId === p.shareId ? this.prev.s : null;
    if (prev === null) this.history = [];
    this.prev = { shareId: p.shareId, s };
    this.history = [...this.history, s].slice(-16);
    if (prev === null) return;
    const freezes = s.freezes - prev.freezes;
    if (freezes <= 0) return;
    const lost = Math.max(0, s.lost - prev.lost);
    const got = Math.max(0, s.received - prev.received);
    const d = {
      lossPct: lost + got === 0 ? 0 : (lost * 100) / (lost + got),
      dropped: Math.max(0, s.dropped - prev.dropped),
      nacks: Math.max(0, s.nacks - prev.nacks),
      recovered: Math.max(0, s.recovered - prev.recovered),
      jitterMs: s.jitterMs,
    };
    const w = this.window(s);
    const tx = parseSendHealth(p.tx);
    const { cause, text } = classify(p.owner, tx, p.theirQuality, p.myQuality, d, w);
    this.add(cause, p.owner, text, freezes, {
      codec: w?.codec ?? '',
      travadaSeg: w === null ? -1 : Number(w.freezeSec.toFixed(2)),
      fpsAntes: w === null ? -1 : Math.round(w.fpsBefore),
      quadrosPresos: w?.stuck ?? -1,
      quadrosNaPausa: w?.arrivedDuring ?? -1,
      pedidosChave: w?.plis ?? -1,
      pacotesPerdidos: w?.lost ?? -1,
      perdaMinha: Number(d.lossPct.toFixed(3)),
      perdaDele: tx?.l ?? -1,
      reenviosPedidos: d.nacks,
      reenviosRecuperados: d.recovered,
      quadrosDescartados: d.dropped,
      jitterMs: d.jitterMs,
      qualidadeDele: p.theirQuality,
      cpuDele: tx?.cpu ?? '',
      tetoDele: tx === null ? '' : `${tx.cap}/${tx.max}`,
    });
  }

  /**
   * Do quadro antes da travada até agora: quantos quadros chegaram, quantos o decodificador
   * engoliu e quantos chegaram no meio da pausa. A travada é contada no fim dela, então olha para trás.
   */
  private window(now: Sample): FreezeWindow | null {
    const prev = this.history[this.history.length - 2];
    if (prev === undefined) return null;
    const freezeSec = Math.max(0, now.freezeSec - prev.freezeSec);
    // A última leitura antes de a travada começar, e a anterior a ela (para o ritmo normal).
    const startAt = now.t - freezeSec * 1000 - TICK_MS;
    let i = this.history.length - 2;
    while (i > 0 && this.history[i].t > startAt) i--;
    const base = this.history[i];
    const before = this.history[i - 1];
    const fpsBefore = before === undefined
      ? 0
      : ((base.framesRx - before.framesRx) * 1000) / Math.max(1, base.t - before.t);
    const rx = now.framesRx - base.framesRx;
    const span = Math.max(0.001, (now.t - base.t) / 1000);
    return {
      freezeSec,
      fpsBefore,
      stuck: Math.max(0, rx - (now.framesDec - base.framesDec) - (now.dropped - base.dropped)),
      arrivedDuring: Math.max(0, Math.round(rx - fpsBefore * Math.max(0, span - freezeSec))),
      plis: Math.max(0, now.plis - base.plis),
      lost: Math.max(0, now.lost - base.lost),
      dropped: Math.max(0, now.dropped - base.dropped),
      codec: now.codec,
    };
  }

  /**
   * Quem transmite: a captura ficou curta (ou voltou). Entra no diário e vai para o servidor uma vez
   * por episódio, com o que se sabe do envio, para a gente ver em que jogos, placas e telas acontece.
   */
  noteCapture(e: { who: string; cf: number; wf: number; cpu: string; metrics: DiagEvent['metrics'] }) {
    if (this.sender === undefined) return;
    this.add(
      'my-capture',
      e.who,
      `Sua tela está saindo a ~${e.cf} de ${e.wf} fps: a captura do navegador não pega mais quadros. ${captureAdvice(e.cpu)} ${CAPTURE_FIX}`,
      1,
      { fpsCapturados: e.cf, fpsPedidos: e.wf, cpuMeu: e.cpu, ...e.metrics },
    );
  }

  private add(cause: Cause, who: string, text: string, count: number, metrics: DiagEvent['metrics']) {
    const now = Date.now();
    this._events.update((list) => {
      const last = list[0];
      // Mesma causa, mesma pessoa, logo em seguida: soma no mesmo registro.
      if (last !== undefined && last.cause === cause && last.who === who && now - last.at < MERGE_MS) {
        const merged = { ...last, at: now, text, count: last.count + count, metrics };
        this.outbox = this.outbox.filter((e) => e.id !== last.id).concat(merged);
        return [merged, ...list.slice(1)];
      }
      const ev: DiagEvent = { id: this.nextId++, at: now, cause, who, text, count, metrics };
      this.outbox.push(ev);
      this._unseen.update((n) => n + 1);
      return [ev, ...list].slice(0, MAX_EVENTS);
    });
  }

  private async flush() {
    if (this.outbox.length === 0 || this.token() === '') return;
    const events = this.outbox
      .splice(0, 20)
      .map((e) => {
        const delta = e.count - (this.sent.get(e.id) ?? 0);
        this.sent.set(e.id, e.count);
        return { at: e.at, cause: e.cause, who: e.who, count: delta, metrics: e.metrics };
      })
      .filter((e) => e.count > 0);
    if (events.length === 0) return;
    if (this.sent.size > 200) this.sent = new Map([...this.sent].slice(-100));
    await fetch('/api/diag', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token()}` },
      body: JSON.stringify({ events }),
      keepalive: true,
    }).catch(() => undefined);
  }
}
