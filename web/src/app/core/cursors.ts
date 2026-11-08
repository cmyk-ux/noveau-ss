// Cursores ao vivo em cima da tela compartilhada.
//
// Rede: cada pessoa manda a posição do mouse (normalizada 0..1 sobre a imagem da tela que
// está vendo) pelo canal de dados do LiveKit, no modo "lossy" (como UDP: um pacote perdido
// não atrasa os próximos), a no máximo ~30 por segundo.
//
// Suavidade: quem recebe não pula para a última posição. Guarda as amostras com o horário de
// quem mandou e desenha um pouco no passado (INTERP_DELAY_MS), interpolando com uma curva
// Catmull-Rom entre as amostras. Assim o cursor anda liso a 60/144 fps mesmo recebendo 30
// pontos por segundo, e atrasos irregulares da rede somem.

import { Participant, RemoteParticipant, Room, RoomEvent } from 'livekit-client';

const TOPIC = 'cursor';
const SEND_EVERY_MS = 33;
export const INTERP_DELAY_MS = 110;
const KEEP_MS = 1500;
const IDLE_FADE_MS = 3500;

type Wire =
  | { k: 'm'; s: string; x: number; y: number; c: string; t: number }
  | { k: 'c'; s: string; x: number; y: number; c: string; t: number }
  | { k: 'h' };

interface Sample {
  t: number;
  x: number;
  y: number;
}

export interface RemoteCursor {
  identity: string;
  name: string;
  color: string;
  share: string | null;
  samples: Sample[];
  /** Diferença (horário local - horário de quem mandou), a menor vista: absorve relógio e atraso. */
  offset: number;
  lastMove: number;
  clicks: { x: number; y: number; at: number }[];
}

export interface CursorFrame {
  identity: string;
  name: string;
  color: string;
  x: number;
  y: number;
  /** Inclinação em graus, conforme a velocidade horizontal (dá "vida" ao movimento). */
  tilt: number;
  /** 0..1: some aos poucos quando a pessoa para de mexer. */
  alpha: number;
  clicks: { x: number; y: number; age: number }[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function round(n: number) {
  return Math.round(n * 1e4) / 1e4;
}

/** Interpolação Catmull-Rom de um eixo. */
function catmull(p0: number, p1: number, p2: number, p3: number, u: number) {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

export class CursorNet {
  readonly cursors = new Map<string, RemoteCursor>();
  private lastSent = 0;
  private pending: Wire | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private visible = false;
  private readonly onData = (payload: Uint8Array, p?: RemoteParticipant, _k?: unknown, topic?: string) =>
    this.receive(payload, p, topic);
  private readonly onLeave = (p: Participant) => this.cursors.delete(p.identity);

  constructor(private readonly room: Room) {
    room.on(RoomEvent.DataReceived, this.onData);
    room.on(RoomEvent.ParticipantDisconnected, this.onLeave);
  }

  dispose() {
    this.hide();
    this.room.off(RoomEvent.DataReceived, this.onData);
    this.room.off(RoomEvent.ParticipantDisconnected, this.onLeave);
    if (this.timer !== null) clearTimeout(this.timer);
  }

  move(share: string, x: number, y: number, color: string) {
    this.visible = true;
    this.queue({ k: 'm', s: share, x: round(x), y: round(y), c: color, t: Math.round(performance.now()) });
  }

  click(share: string, x: number, y: number, color: string) {
    this.visible = true;
    // Clique vai na hora, sem esperar o intervalo.
    this.send({ k: 'c', s: share, x: round(x), y: round(y), c: color, t: Math.round(performance.now()) });
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.pending = null;
    this.send({ k: 'h' });
  }

  /** Posições para desenhar agora, só de quem está olhando a mesma tela. */
  frame(share: string | null, now = performance.now()): CursorFrame[] {
    const out: CursorFrame[] = [];
    for (const c of this.cursors.values()) {
      if (share === null || c.share !== share || c.samples.length === 0) continue;
      const renderAt = now - c.offset - INTERP_DELAY_MS;
      const s = c.samples;
      while (s.length > 2 && s[1].t < renderAt - KEEP_MS) s.shift();
      let x = s[s.length - 1].x;
      let y = s[s.length - 1].y;
      let vx = 0;
      for (let i = 0; i < s.length - 1; i++) {
        const a = s[i];
        const b = s[i + 1];
        if (renderAt >= a.t && renderAt < b.t) {
          const u = (renderAt - a.t) / Math.max(1, b.t - a.t);
          const p0 = s[i - 1] ?? a;
          const p3 = s[i + 2] ?? b;
          x = catmull(p0.x, a.x, b.x, p3.x, u);
          y = catmull(p0.y, a.y, b.y, p3.y, u);
          vx = (b.x - a.x) / Math.max(1, b.t - a.t);
          break;
        }
        if (renderAt < s[0].t) {
          x = s[0].x;
          y = s[0].y;
          break;
        }
      }
      const idle = now - c.lastMove;
      const alpha = idle < IDLE_FADE_MS ? 1 : Math.max(0, 1 - (idle - IDLE_FADE_MS) / 600);
      if (alpha <= 0) continue;
      c.clicks = c.clicks.filter((k) => now - k.at < 700);
      out.push({
        identity: c.identity,
        name: c.name,
        color: c.color,
        x,
        y,
        tilt: Math.max(-14, Math.min(14, vx * 2500)),
        alpha,
        clicks: c.clicks.map((k) => ({ x: k.x, y: k.y, age: (now - k.at) / 700 })),
      });
    }
    return out;
  }

  private queue(msg: Wire) {
    this.pending = msg;
    const wait = SEND_EVERY_MS - (performance.now() - this.lastSent);
    if (wait <= 0) {
      this.flush();
    } else if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, wait);
    }
  }

  private flush() {
    if (this.pending === null) return;
    const msg = this.pending;
    this.pending = null;
    this.send(msg);
  }

  private send(msg: Wire) {
    this.lastSent = performance.now();
    void this.room.localParticipant
      .publishData(enc.encode(JSON.stringify(msg)), { reliable: msg.k !== 'm', topic: TOPIC })
      .catch(() => undefined);
  }

  private receive(payload: Uint8Array, p: RemoteParticipant | undefined, topic: string | undefined) {
    if (topic !== TOPIC || p === undefined) return;
    let msg: Wire;
    try {
      msg = JSON.parse(dec.decode(payload));
    } catch {
      return;
    }
    const now = performance.now();
    if (msg.k === 'h') {
      this.cursors.delete(p.identity);
      return;
    }
    if (typeof msg.x !== 'number' || typeof msg.y !== 'number' || typeof msg.t !== 'number') return;
    let c = this.cursors.get(p.identity);
    if (c === undefined || c.share !== msg.s) {
      c = {
        identity: p.identity,
        name: p.name || p.identity.split('#')[0],
        color: '#ffffff',
        share: msg.s,
        samples: [],
        offset: now - msg.t,
        lastMove: now,
        clicks: [],
      };
      this.cursors.set(p.identity, c);
    }
    c.color = /^#[0-9a-f]{6}$/i.test(msg.c) ? msg.c : c.color;
    c.name = p.name || c.name;
    c.offset = Math.min(c.offset, now - msg.t);
    c.lastMove = now;
    const last = c.samples[c.samples.length - 1];
    if (last !== undefined && msg.t <= last.t) return; // fora de ordem: descarta
    c.samples.push({ t: msg.t, x: msg.x, y: msg.y });
    if (msg.k === 'c') c.clicks.push({ x: msg.x, y: msg.y, at: now + INTERP_DELAY_MS });
  }
}
