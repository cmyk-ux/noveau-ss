// Modo estúdio: o som da tela vai sem compressão nenhuma (PCM), em vez do Opus.
//
// Por que não pelo track de áudio do WebRTC: o WebRTC sempre codifica (Opus, até 510 kbps).
// Para mandar o som exatamente como o navegador está tocando, pegamos as amostras com um
// AudioWorklet e mandamos pelo canal de dados do LiveKit no modo confiável (em ordem, com
// retransmissão). Quem recebe toca com um buffer ajustável, como o Audiomovers.
//
// Pacote (10 ms): cabeçalho de 12 bytes + PCM inteiro little-endian intercalado L R.
//   0 'S' | 1 versão | 2 bits (16 ou 24) | 3 canais | 4..7 seq | 8..9 frames | 10..11 livre
// Pacote com 0 frames = "acabou": quem recebe fecha o player na hora (sem esperar 3 s de silêncio).
//
// Banda: 48 000 Hz x 2 canais x 24 bits = 2,3 Mbps (16 bits: 1,5 Mbps) por pessoa assistindo.

import { signal } from '@angular/core';
import { Participant, RemoteParticipant, RemoteTrackPublication, Room, RoomEvent, Track } from 'livekit-client';

const TOPIC = 'studio';
const RATE = 48000;
const HEADER = 12;
const HEADER_V2 = 16;
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
  /** O som da tela acabou (o navegador parou a captura): para de mandar, nem que ninguém mais peça. */
  private readonly onEnded = () => this.stop();

  constructor(
    private readonly room: Room,
    private readonly track: MediaStreamTrack,
    readonly bits: StudioBits,
  ) {}

  async start() {
    if (this.track.readyState === 'ended') return this.stop();
    this.track.addEventListener('ended', this.onEnded, { once: true });
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
    if (this.stopped) return;
    this.stopped = true;
    this.track.removeEventListener('ended', this.onEnded);
    this.track.stop();
    if (this.ctx !== null) this.sendEnd();
    void this.ctx?.close();
    this.ctx = null;
  }

  /** Avisa quem recebe que o som acabou (selo e player somem na hora). */
  private sendEnd() {
    const buf = new ArrayBuffer(HEADER);
    const view = new DataView(buf);
    view.setUint8(0, 0x53);
    view.setUint8(1, 1);
    view.setUint8(2, this.bits);
    view.setUint8(3, 2);
    view.setUint32(4, this.seq++ >>> 0, true);
    view.setUint16(8, 0, true);
    void this.room.localParticipant
      .publishData(new Uint8Array(buf), { reliable: true, topic: TOPIC })
      .catch(() => undefined);
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
  /** Chave do player: a identidade na sala, ou o id do plugin de DAW. */
  key: string;
  identity: string;
  name: string;
  /** 'room' = modo estúdio do navegador; 'daw' = plugin de DAW. */
  source: 'room' | 'daw';
  bits: number;
  rate: number;
  channels: number;
  /** Segundos de som no buffer agora. */
  level: number;
  target: number;
  playing: boolean;
  underruns: number;
  lost: number;
  /**
   * Plugin de DAW conectado, mas sem som chegando (DAW parada: muitas não chamam o plugin quando
   * nada toca). Os controles ficam até o plugin sair da master ou a DAW fechar.
   */
  idle: boolean;
}

/** Sem pacote há tanto tempo, o plugin de DAW conta como parado (o player é fechado aos 3 s). */
const DAW_IDLE_MS = 600;

interface Player {
  key: string;
  identity: string;
  source: 'room' | 'daw';
  rate: number;
  channels: number;
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

/**
 * Lê as amostras de um pacote. v1 (navegador): cabeçalho de 12 bytes, 48 kHz estéreo.
 * v2 (plugin de DAW, veja server/daw.mjs): cabeçalho de 16 bytes, taxa no cabeçalho, 16/24-bit
 * inteiro ou 32-bit float, 1 ou 2 canais. Sai sempre estéreo intercalado (mono vira L = R).
 */
function decode(view: DataView, header: number, bits: number, channels: number, frames: number): Float32Array {
  const out = new Float32Array(frames * 2);
  const n = frames * channels;
  const step = 2 / channels; // mono: cada amostra vai para L e R
  let o = header;
  for (let i = 0, j = 0; i < n; i++, j += step) {
    let v: number;
    if (bits === 16) {
      v = view.getInt16(o, true) / 0x8000;
      o += 2;
    } else if (bits === 24) {
      v = (view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16)) / 0x800000;
      o += 3;
    } else {
      v = view.getFloat32(o, true);
      o += 4;
    }
    out[j] = v;
    if (channels === 1) out[j + 1] = v;
  }
  return out;
}

interface Packet {
  bits: number;
  channels: number;
  rate: number;
  seq: number;
  frames: number;
  header: number;
}

function readHeader(view: DataView): Packet | null {
  if (view.byteLength < HEADER || view.getUint8(0) !== 0x53) return null;
  const version = view.getUint8(1);
  const bits = view.getUint8(2);
  const channels = version === 1 ? 2 : view.getUint8(3);
  const header = version === 1 ? HEADER : HEADER_V2;
  if (version !== 1 && version !== 2) return null;
  if (version === 2 && view.byteLength < HEADER_V2) return null;
  const rate = version === 1 ? RATE : view.getUint32(12, true);
  const frames = view.getUint16(8, true);
  const ok = version === 1 ? bits === 16 || bits === 24 : bits === 16 || bits === 24 || bits === 32;
  if (!ok || channels < 1 || channels > 2 || rate < 8000 || rate > 192000) return null;
  if (view.byteLength < header + frames * channels * (bits / 8)) return null;
  return { bits, channels, rate, seq: view.getUint32(4, true), frames, header };
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
  /** O som de estúdio é o som da tela: a tela saiu, o player (e o selo) saem junto. */
  private readonly onUnpublished = (pub: RemoteTrackPublication, p: RemoteParticipant) => {
    if (pub.source === Track.Source.ScreenShare) this.drop(p.identity);
  };
  private readonly dawVolume = new Map<string, number>();
  /** Plugins de DAW conectados nesta sala (do "on" ao "off"), tocando ou não. */
  private readonly dawOnline = new Map<string, { name: string; rate: number; bits: number; channels: number }>();
  private readonly unlock = () => {
    for (const pl of this.players.values()) if (pl.ctx.state === 'suspended') void pl.ctx.resume();
  };
  /** Só roda enquanto tem algum player (sem som de estúdio na sala, nada fica acordando a página). */
  private sweep: ReturnType<typeof setInterval> | undefined;
  private sweepPlayers() {
    // Quem parou de mandar há 3 s: libera o player. O plugin de DAW continua na lista (parado)
    // enquanto estiver conectado; só sai com o "off" do servidor.
    const now = performance.now();
    let changed = false;
    for (const pl of this.players.values()) {
      const quiet = now - pl.lastPacket;
      if (quiet > 3000) this.drop(pl.key);
      else if (pl.source === 'daw' && quiet > DAW_IDLE_MS && !pl.view.idle) {
        pl.view = { ...pl.view, idle: true };
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  constructor(private readonly room: Room) {
    room.on(RoomEvent.DataReceived, this.onData);
    room.on(RoomEvent.ParticipantDisconnected, this.onLeave);
    room.on(RoomEvent.TrackUnpublished, this.onUnpublished);
    document.addEventListener('pointerdown', this.unlock);
    document.addEventListener('keydown', this.unlock);
  }

  dispose() {
    this.room.off(RoomEvent.DataReceived, this.onData);
    this.room.off(RoomEvent.ParticipantDisconnected, this.onLeave);
    this.room.off(RoomEvent.TrackUnpublished, this.onUnpublished);
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
    // O plugin de DAW não tem tela: toca sempre, com o volume dele.
    const on = pl.source === 'daw' || this.audible(pl.identity);
    if (on && pl.ctx.state === 'suspended') void pl.ctx.resume();
    const level = pl.source === 'daw' ? this.dawVolumeOf(pl.key) : (this.perPerson.get(pl.identity) ?? 0.2);
    pl.gain.gain.value = on ? this.volume * level : 0;
  }

  get currentLatency() {
    return this.latency;
  }

  private receive(payload: Uint8Array, p: RemoteParticipant) {
    // Sem tela publicada não tem som de estúdio: ignora o que ainda chegar (pacotes atrasados depois
    // de parar, ou alguém com a versão antiga, que continuava mandando silêncio depois de parar a tela
    // pelo navegador). Sem isto o player renascia e o selo "estúdio" ficava aceso.
    if (p.getTrackPublication(Track.Source.ScreenShare) === undefined) return void this.drop(p.identity);
    this.ingest(p.identity, p.identity, p.name || p.identity.split('#')[0], 'room', payload);
  }

  /** Pacote do plugin de DAW (chegou pelo WebSocket do servidor). */
  feedDaw(id: string, name: string, payload: Uint8Array) {
    this.ingest(`daw:${id}`, id, name, 'daw', payload);
  }

  /**
   * O plugin entrou na sala (ou mandou o formato). Aparece mesmo sem som: a DAW parada não chama o
   * plugin, e sem isto os controles sumiam até alguém dar play.
   */
  announceDaw(id: string, name: string, rate?: number, format?: number, channels?: number) {
    const old = this.dawOnline.get(id);
    this.dawOnline.set(id, {
      name,
      rate: rate ?? old?.rate ?? 48000,
      bits: format ?? old?.bits ?? 24,
      channels: channels ?? old?.channels ?? 2,
    });
    this.publish();
  }

  /** O plugin desconectou (saiu da master, DAW fechada ou pausado no plugin). */
  dropDaw(id: string) {
    this.dawOnline.delete(id);
    this.drop(`daw:${id}`);
    this.publish();
  }

  /** Volume de um plugin de DAW (0..1), só para você. */
  setDawVolume(key: string, v: number) {
    this.dawVolume.set(key, v);
    const pl = this.players.get(key);
    if (pl !== undefined) this.applyAudible(pl);
  }

  dawVolumeOf(key: string) {
    return this.dawVolume.get(key) ?? 1;
  }

  private ingest(key: string, identity: string, name: string, source: 'room' | 'daw', payload: Uint8Array) {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const h = readHeader(view);
    if (h === null) return;
    if (h.frames === 0) return void this.drop(key);
    let pl = this.players.get(key);
    // Mudou a taxa (a DAW trocou de 48 para 96 kHz): recria o player na taxa nova.
    if (pl !== undefined && pl.rate !== h.rate) {
      this.drop(key);
      pl = undefined;
    }
    pl ??= this.create(key, identity, name, source, h.rate);
    pl.lastPacket = performance.now();
    if (pl.view.idle) {
      pl.view = { ...pl.view, idle: false };
      this.publish();
    }
    pl.bits = h.bits;
    pl.channels = h.channels;
    if (pl.expected >= 0 && h.seq !== pl.expected) {
      const gap = (h.seq - pl.expected) >>> 0;
      if (gap > 0x7fffffff) return; // atrasado/duplicado
      // Pacotes perdidos de vez: completa com silêncio para não adiantar o tempo.
      pl.lost += gap;
      if (gap < 50) this.feed(pl, new Float32Array(h.frames * 2 * gap));
    }
    pl.expected = (h.seq + 1) >>> 0;
    this.feed(pl, decode(view, h.header, h.bits, h.channels, h.frames));
  }

  private feed(pl: Player, pcm: Float32Array) {
    if (pl.node === null) {
      pl.queue.push(pcm);
      return;
    }
    pl.node.port.postMessage({ type: 'pcm', data: pcm }, [pcm.buffer]);
  }

  private create(key: string, identity: string, name: string, source: 'room' | 'daw', rate: number): Player {
    const ctx = new AudioContext({ sampleRate: rate, latencyHint: 'playback' });
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    const pl: Player = {
      key,
      identity,
      source,
      rate,
      channels: 2,
      name,
      ctx,
      node: null,
      gain,
      queue: [],
      expected: -1,
      bits: 24,
      lost: 0,
      lastPacket: performance.now(),
      view: {
        key,
        identity,
        name,
        source,
        bits: 24,
        rate,
        channels: 2,
        level: 0,
        target: this.latency,
        playing: false,
        underruns: 0,
        lost: 0,
        idle: false,
      },
    };
    this.players.set(key, pl);
    this.sweep ??= setInterval(() => this.sweepPlayers(), 250);
    this.applyAudible(pl);
    void ctx.audioWorklet.addModule(WORKLET_URL).then(() => {
      if (this.players.get(key) !== pl) return;
      const node = new AudioWorkletNode(ctx, 'studio-player', { numberOfInputs: 0, outputChannelCount: [2] });
      node.connect(gain);
      node.port.postMessage({ type: 'latency', seconds: this.latency });
      node.port.onmessage = (e) => {
        pl.view = { ...pl.view, ...e.data, bits: pl.bits, channels: pl.channels, lost: pl.lost };
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

  private drop(key: string) {
    const pl = this.players.get(key);
    if (pl === undefined) return;
    this.players.delete(key);
    if (this.players.size === 0) {
      clearInterval(this.sweep);
      this.sweep = undefined;
    }
    void pl.ctx.close();
    this.publish();
  }

  private publish() {
    const views = [...this.players.values()].map((pl) => pl.view);
    // Plugin conectado sem player (DAW parada): continua na lista, parado, com o volume dele.
    for (const [id, d] of this.dawOnline) {
      const key = `daw:${id}`;
      if (this.players.has(key)) continue;
      views.push({
        key,
        identity: id,
        name: d.name,
        source: 'daw',
        bits: d.bits,
        rate: d.rate,
        channels: d.channels,
        level: 0,
        target: this.latency,
        playing: false,
        underruns: 0,
        lost: 0,
        idle: true,
      });
    }
    this._streams.set(views);
  }
}
