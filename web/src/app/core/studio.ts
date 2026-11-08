// Modo estúdio: o som da tela vai sem compressão nenhuma (PCM), em vez do Opus.
//
// Por que não pelo track de áudio do WebRTC: o WebRTC sempre codifica (Opus, até 510 kbps).
// Para mandar o som exatamente como o navegador está tocando, pegamos as amostras com um
// AudioWorklet e mandamos pelo canal de dados do LiveKit no modo confiável (em ordem, com
// retransmissão). Quem recebe toca com um buffer ajustável, como o Audiomovers.
//
// Pacote (10 ms): cabeçalho de 12 bytes + PCM inteiro little-endian intercalado L R.
//   0 'S' | 1 versão | 2 bits (16 ou 24) | 3 canais | 4..7 seq | 8..9 frames | 10..11 livre
//
// Banda: 48 000 Hz x 2 canais x 24 bits = 2,3 Mbps (16 bits: 1,5 Mbps) por pessoa assistindo.

import { signal } from '@angular/core';
import { Participant, RemoteParticipant, Room, RoomEvent } from 'livekit-client';

const TOPIC = 'studio';
const RATE = 48000;
const HEADER = 12;
const WORKLET_URL = '/studio-worklets.js';

export type StudioBits = 16 | 24;

export function studioMbps(bits: StudioBits) {
  return (RATE * 2 * bits) / 1e6;
}

// ---------------------------------------------------------------- envio

export class StudioSender {
  private ctx: AudioContext | null = null;
  private seq = 0;
  private stopped = false;

  constructor(
    private readonly room: Room,
    private readonly track: MediaStreamTrack,
    readonly bits: StudioBits,
  ) {}

  async start() {
    const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(WORKLET_URL);
    if (this.stopped) return void ctx.close();
    const source = ctx.createMediaStreamSource(new MediaStream([this.track]));
    const node = new AudioWorkletNode(ctx, 'studio-capture', { channelCount: 2, channelCountMode: 'explicit' });
    // O worklet só roda se estiver ligado até a saída; o ganho 0 evita tocar o som de novo aqui.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(ctx.destination);
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.send(e.data);
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
  }

  stop() {
    this.stopped = true;
    this.track.stop();
    void this.ctx?.close();
    this.ctx = null;
  }

  private send(pcm: Float32Array) {
    if (this.stopped) return;
    const frames = pcm.length / 2;
    const bytesPer = this.bits / 8;
    const buf = new ArrayBuffer(HEADER + pcm.length * bytesPer);
    const view = new DataView(buf);
    view.setUint8(0, 0x53);
    view.setUint8(1, 1);
    view.setUint8(2, this.bits);
    view.setUint8(3, 2);
    view.setUint32(4, this.seq++ >>> 0, true);
    view.setUint16(8, frames, true);
    let o = HEADER;
    if (this.bits === 16) {
      for (let i = 0; i < pcm.length; i++, o += 2) {
        // Escala simétrica 2^15, a mesma que o navegador usa ao decodificar 16 bits:
        // um arquivo 16-bit volta exatamente aos mesmos inteiros.
        view.setInt16(o, Math.max(-0x8000, Math.min(0x7fff, Math.round(pcm[i] * 0x8000))), true);
      }
    } else {
      for (let i = 0; i < pcm.length; i++, o += 3) {
        const n = Math.max(-0x800000, Math.min(0x7fffff, Math.round(pcm[i] * 0x800000)));
        view.setUint8(o, n & 0xff);
        view.setUint8(o + 1, (n >> 8) & 0xff);
        view.setInt8(o + 2, n >> 16);
      }
    }
    void this.room.localParticipant
      .publishData(new Uint8Array(buf), { reliable: true, topic: TOPIC })
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------- recebimento

export interface StudioStreamView {
  identity: string;
  name: string;
  bits: number;
  /** Segundos de som no buffer agora. */
  level: number;
  target: number;
  playing: boolean;
  underruns: number;
  lost: number;
}

interface Player {
  identity: string;
  name: string;
  ctx: AudioContext;
  node: AudioWorkletNode | null;
  gain: GainNode;
  queue: Float32Array[];
  expected: number;
  bits: number;
  lost: number;
  view: StudioStreamView;
  lastPacket: number;
}

function decode(view: DataView, bits: number, frames: number): Float32Array {
  const out = new Float32Array(frames * 2);
  let o = HEADER;
  if (bits === 16) {
    for (let i = 0; i < out.length; i++, o += 2) {
      out[i] = view.getInt16(o, true) / 0x8000;
    }
  } else {
    for (let i = 0; i < out.length; i++, o += 3) {
      const n = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16);
      out[i] = n / 0x800000;
    }
  }
  return out;
}

/** Recebe e toca o som de estúdio de quem estiver mandando. */
export class StudioHub {
  private readonly players = new Map<string, Player>();
  private readonly _streams = signal<StudioStreamView[]>([]);
  readonly streams = this._streams.asReadonly();
  private latency = 0.25;
  private volume = 1;
  private readonly perPerson = new Map<string, number>();
  private audible: (identity: string) => boolean = () => true;
  private readonly onData = (payload: Uint8Array, p?: RemoteParticipant, _k?: unknown, topic?: string) => {
    if (topic === TOPIC && p !== undefined) this.receive(payload, p);
  };
  private readonly onLeave = (p: Participant) => this.drop(p.identity);
  private readonly unlock = () => {
    for (const pl of this.players.values()) if (pl.ctx.state === 'suspended') void pl.ctx.resume();
  };
  private readonly sweep = setInterval(() => {
    // Quem parou de mandar há 3 s (parou de transmitir): libera.
    const now = performance.now();
    for (const pl of this.players.values()) if (now - pl.lastPacket > 3000) this.drop(pl.identity);
  }, 1000);

  constructor(private readonly room: Room) {
    room.on(RoomEvent.DataReceived, this.onData);
    room.on(RoomEvent.ParticipantDisconnected, this.onLeave);
    document.addEventListener('pointerdown', this.unlock);
    document.addEventListener('keydown', this.unlock);
  }

  dispose() {
    this.room.off(RoomEvent.DataReceived, this.onData);
    this.room.off(RoomEvent.ParticipantDisconnected, this.onLeave);
    document.removeEventListener('pointerdown', this.unlock);
    document.removeEventListener('keydown', this.unlock);
    clearInterval(this.sweep);
    for (const id of [...this.players.keys()]) this.drop(id);
  }

  /** Atraso alvo do buffer (segundos). Mais alto = mais resistente a oscilações da rede. */
  setLatency(seconds: number) {
    this.latency = seconds;
    for (const pl of this.players.values()) pl.node?.port.postMessage({ type: 'latency', seconds });
  }

  setVolume(v: number) {
    this.volume = v;
    for (const pl of this.players.values()) this.applyAudible(pl);
  }

  /** Volume do som de estúdio de uma pessoa (o mesmo controle do volume da tela dela). */
  setVolumeFor(identity: string, v: number) {
    this.perPerson.set(identity, v);
    const pl = this.players.get(identity);
    if (pl !== undefined) this.applyAudible(pl);
  }

  /** Só toca o som de estúdio das telas visíveis (como o som normal da tela). */
  setAudible(isAudible: (identity: string) => boolean) {
    this.audible = isAudible;
    for (const pl of this.players.values()) this.applyAudible(pl);
  }

  private applyAudible(pl: Player) {
    const on = this.audible(pl.identity);
    if (on && pl.ctx.state === 'suspended') void pl.ctx.resume();
    pl.gain.gain.value = on ? this.volume * (this.perPerson.get(pl.identity) ?? 1) : 0;
  }

  get currentLatency() {
    return this.latency;
  }

  private receive(payload: Uint8Array, p: RemoteParticipant) {
    if (payload.byteLength < HEADER) return;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    if (view.getUint8(0) !== 0x53 || view.getUint8(1) !== 1) return;
    const bits = view.getUint8(2);
    const seq = view.getUint32(4, true);
    const frames = view.getUint16(8, true);
    if ((bits !== 16 && bits !== 24) || payload.byteLength < HEADER + frames * 2 * (bits / 8)) return;
    const pl = this.players.get(p.identity) ?? this.create(p);
    pl.lastPacket = performance.now();
    pl.bits = bits;
    if (pl.expected >= 0 && seq !== pl.expected) {
      const gap = (seq - pl.expected) >>> 0;
      if (gap > 0x7fffffff) return; // atrasado/duplicado
      // Pacotes perdidos de vez: completa com silêncio para não adiantar o tempo.
      pl.lost += gap;
      if (gap < 50) this.feed(pl, new Float32Array(frames * 2 * gap));
    }
    pl.expected = (seq + 1) >>> 0;
    this.feed(pl, decode(view, bits, frames));
  }

  private feed(pl: Player, pcm: Float32Array) {
    if (pl.node === null) {
      pl.queue.push(pcm);
      return;
    }
    pl.node.port.postMessage({ type: 'pcm', data: pcm }, [pcm.buffer]);
  }

  private create(p: RemoteParticipant): Player {
    const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'playback' });
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    const pl: Player = {
      identity: p.identity,
      name: p.name || p.identity.split('#')[0],
      ctx,
      node: null,
      gain,
      queue: [],
      expected: -1,
      bits: 24,
      lost: 0,
      lastPacket: performance.now(),
      view: {
        identity: p.identity,
        name: p.name || p.identity.split('#')[0],
        bits: 24,
        level: 0,
        target: this.latency,
        playing: false,
        underruns: 0,
        lost: 0,
      },
    };
    this.players.set(p.identity, pl);
    this.applyAudible(pl);
    void ctx.audioWorklet.addModule(WORKLET_URL).then(() => {
      if (!this.players.has(p.identity)) return;
      const node = new AudioWorkletNode(ctx, 'studio-player', { numberOfInputs: 0, outputChannelCount: [2] });
      node.connect(gain);
      node.port.postMessage({ type: 'latency', seconds: this.latency });
      node.port.onmessage = (e) => {
        pl.view = { ...pl.view, ...e.data, bits: pl.bits, lost: pl.lost };
        this.publish();
      };
      pl.node = node;
      for (const q of pl.queue) node.port.postMessage({ type: 'pcm', data: q }, [q.buffer]);
      pl.queue = [];
    });
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    this.publish();
    return pl;
  }

  private drop(identity: string) {
    const pl = this.players.get(identity);
    if (pl === undefined) return;
    this.players.delete(identity);
    void pl.ctx.close();
    this.publish();
  }

  private publish() {
    this._streams.set([...this.players.values()].map((pl) => pl.view));
  }
}
