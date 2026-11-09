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
  /** Por que o navegador está segurando a qualidade: cpu, bandwidth, none. */
  lim: string;
}

export function encodeSendHealth(h: SendHealth): string {
  return JSON.stringify(h);
}

function parseSendHealth(raw: string | null): SendHealth | null {
  if (raw === null || raw === '') return null;
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as SendHealth) : null;
  } catch {
    return null;
  }
}

export type Cause = 'their-net' | 'their-pc' | 'my-net' | 'my-pc' | 'unknown';

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
  report: Promise<RTCStatsReport | null>;
}

interface Sample {
  freezes: number;
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
    out = {
      freezes: r.freezeCount ?? 0,
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

/** O motivo mais provável, do mais específico para o mais vago. */
export function classify(
  who: string,
  tx: SendHealth | null,
  theirQuality: string,
  myQuality: string,
  d: { lossPct: number; dropped: number; nacks: number; recovered: number; jitterMs: number },
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
  // 2) O PC de quem transmite não dá conta de capturar/codificar.
  if (tx !== null && (tx.cpu === 'serious' || tx.cpu === 'critical' || tx.lim === 'cpu')) {
    return { cause: 'their-pc', text: `O PC de ${who} está no limite (processador). A imagem sai com menos quadros.` };
  }
  // 3) A minha rede: perda que chega até mim (os reenvios do servidor não chegaram a tempo).
  if (d.lossPct >= 0.3 || BAD_QUALITY.has(myQuality)) {
    return {
      cause: 'my-net',
      text: d.lossPct >= 0.3
        ? `Sua conexão está perdendo ${pct(d.lossPct)}% dos pacotes vindos do servidor. Só você trava. Cabo em vez de Wi-Fi costuma resolver.`
        : 'Sua conexão com o servidor está ruim. Só você trava.',
    };
  }
  // 4) O meu PC: chegou tudo, mas o navegador descartou quadros ao mostrar.
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
  private nextId = 1;
  private outbox: DiagEvent[] = [];
  /** Travadas de cada registro que já foram para o servidor (manda só a diferença). */
  private sent = new Map<number, number>();
  private timer?: number;
  private sender?: number;

  constructor(
    private readonly probe: () => Probe | null,
    private readonly token: () => string,
  ) {}

  start() {
    if (this.timer !== undefined) return;
    this.timer = window.setInterval(() => void this.tick(), TICK_MS);
    this.sender = window.setInterval(() => void this.flush(), SEND_EVERY_MS);
  }

  stop() {
    window.clearInterval(this.timer);
    window.clearInterval(this.sender);
    this.timer = undefined;
    void this.flush();
  }

  markSeen() {
    this._unseen.set(0);
  }

  clear() {
    this._events.set([]);
    this._unseen.set(0);
  }

  private async tick() {
    const p = this.probe();
    if (p === null) {
      this.prev = null;
      return;
    }
    const report = await p.report;
    const s = report === null ? null : read(report);
    if (s === null) return;
    const prev = this.prev?.shareId === p.shareId ? this.prev.s : null;
    this.prev = { shareId: p.shareId, s };
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
    const tx = parseSendHealth(p.tx);
    const { cause, text } = classify(p.owner, tx, p.theirQuality, p.myQuality, d);
    this.add(cause, p.owner, text, freezes, {
      perdaMinha: Number(d.lossPct.toFixed(3)),
      perdaDele: tx?.l ?? -1,
      reenviosPedidos: d.nacks,
      reenviosRecuperados: d.recovered,
      quadrosDescartados: d.dropped,
      jitterMs: d.jitterMs,
      qualidadeDele: p.theirQuality,
      qualidadeMinha: p.myQuality,
      cpuDele: tx?.cpu ?? '',
      tetoDele: tx === null ? '' : `${tx.cap}/${tx.max}`,
    });
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
