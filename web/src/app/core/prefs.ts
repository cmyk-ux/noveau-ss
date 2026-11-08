import { Injectable, signal } from '@angular/core';
import { BITRATE_LIMITS, CodecChoice, DEFAULT_STREAM, FRAME_RATES, RESOLUTIONS, StreamSettings } from './stream';

function oneOf<T>(value: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

// Preferências guardadas no localStorage com o prefixo "cenaculum:".
const store = {
  get name(): string {
    return localStorage.getItem('cenaculum:name') ?? '';
  },
  set name(v: string) {
    localStorage.setItem('cenaculum:name', v);
  },
  get stream(): StreamSettings {
    // Chave nova: os presets antigos (Games/Film/Code) saíram, todo mundo começa no Original a 60fps.
    const raw = localStorage.getItem('cenaculum:stream2');
    if (raw === null) return DEFAULT_STREAM;
    try {
      const s = JSON.parse(raw);
      return {
        resolution: oneOf(s.resolution, RESOLUTIONS.map((r) => r.id), DEFAULT_STREAM.resolution),
        frameRate: oneOf(s.frameRate, FRAME_RATES, DEFAULT_STREAM.frameRate),
        maxBitrate: oneOf(s.maxBitrate, BITRATE_LIMITS.map((b) => b.bps), DEFAULT_STREAM.maxBitrate),
      };
    } catch {
      return DEFAULT_STREAM;
    }
  },
  set stream(v: StreamSettings) {
    localStorage.setItem('cenaculum:stream2', JSON.stringify(v));
  },
  get codec(): CodecChoice {
    return (localStorage.getItem('cenaculum:codec') as CodecChoice) ?? 'auto';
  },
  set codec(v: CodecChoice) {
    localStorage.setItem('cenaculum:codec', v);
  },
  get shareAudio(): boolean {
    return localStorage.getItem('cenaculum:audio') !== 'no';
  },
  set shareAudio(v: boolean) {
    localStorage.setItem('cenaculum:audio', v ? 'yes' : 'no');
  },
  get showStats(): boolean {
    return localStorage.getItem('cenaculum:stats') === 'yes';
  },
  set showStats(v: boolean) {
    localStorage.setItem('cenaculum:stats', v ? 'yes' : 'no');
  },
  get volumeHinted(): boolean {
    return localStorage.getItem('cenaculum:volume-hint') === 'yes';
  },
  set volumeHinted(v: boolean) {
    localStorage.setItem('cenaculum:volume-hint', v ? 'yes' : 'no');
  },
  get adaptToLoad(): boolean {
    return localStorage.getItem('cenaculum:adapt-load') !== 'no';
  },
  set adaptToLoad(v: boolean) {
    localStorage.setItem('cenaculum:adapt-load', v ? 'yes' : 'no');
  },
  get maxCompatibility(): boolean {
    return localStorage.getItem('cenaculum:compat') !== 'no';
  },
  set maxCompatibility(v: boolean) {
    localStorage.setItem('cenaculum:compat', v ? 'yes' : 'no');
  },
  get studio(): 'off' | '16' | '24' {
    const v = localStorage.getItem('cenaculum:studio');
    return v === '16' || v === '24' ? v : 'off';
  },
  set studio(v: 'off' | '16' | '24') {
    localStorage.setItem('cenaculum:studio', v);
  },
  get studioLatency(): number {
    const v = Number(localStorage.getItem('cenaculum:studio-latency'));
    return v >= 0.05 && v <= 2 ? v : 0.25;
  },
  set studioLatency(v: number) {
    localStorage.setItem('cenaculum:studio-latency', String(v));
  },
  get cursorOn(): boolean {
    return localStorage.getItem('cenaculum:cursor') === 'yes';
  },
  set cursorOn(v: boolean) {
    localStorage.setItem('cenaculum:cursor', v ? 'yes' : 'no');
  },
  get cursorColor(): string {
    const saved = localStorage.getItem('cenaculum:cursor-color');
    if (saved !== null && /^#[0-9a-f]{6}$/i.test(saved)) return saved;
    const color = randomCursorColor();
    localStorage.setItem('cenaculum:cursor-color', color);
    return color;
  },
  set cursorColor(v: string) {
    localStorage.setItem('cenaculum:cursor-color', v);
  },
};

/** Cor viva aleatória (matiz qualquer, saturação e luz fixas para ler bem no escuro e no claro). */
function randomCursorColor(): string {
  const h = Math.random() * 360;
  const s = 0.85;
  const l = 0.6;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

@Injectable({ providedIn: 'root' })
export class Prefs {
  private readonly _name = signal(store.name);
  private readonly _stream = signal(store.stream);
  private readonly _codec = signal(store.codec);
  private readonly _shareAudio = signal(store.shareAudio);
  private readonly _showStats = signal(store.showStats);
  private readonly _maxCompatibility = signal(store.maxCompatibility);
  private readonly _volumeHinted = signal(store.volumeHinted);
  private readonly _adaptToLoad = signal(store.adaptToLoad);
  readonly adaptToLoad = this._adaptToLoad.asReadonly();
  setAdaptToLoad(v: boolean) {
    store.adaptToLoad = v;
    this._adaptToLoad.set(v);
  }
  private readonly _cursorOn = signal(store.cursorOn);
  private readonly _studio = signal(store.studio);
  private readonly _studioLatency = signal(store.studioLatency);
  private readonly _cursorColor = signal(store.cursorColor);

  readonly name = this._name.asReadonly();
  readonly stream = this._stream.asReadonly();
  readonly codec = this._codec.asReadonly();
  readonly shareAudio = this._shareAudio.asReadonly();
  readonly showStats = this._showStats.asReadonly();
  readonly maxCompatibility = this._maxCompatibility.asReadonly();
  readonly volumeHinted = this._volumeHinted.asReadonly();
  readonly cursorOn = this._cursorOn.asReadonly();
  readonly studio = this._studio.asReadonly();
  readonly studioLatency = this._studioLatency.asReadonly();

  setStudio(v: 'off' | '16' | '24') {
    store.studio = v;
    this._studio.set(v);
  }
  setStudioLatency(v: number) {
    store.studioLatency = v;
    this._studioLatency.set(v);
  }
  readonly cursorColor = this._cursorColor.asReadonly();

  setCursorOn(v: boolean) {
    store.cursorOn = v;
    this._cursorOn.set(v);
  }
  setCursorColor(v: string) {
    if (!/^#[0-9a-f]{6}$/i.test(v)) return;
    store.cursorColor = v;
    this._cursorColor.set(v);
  }

  setName(v: string) {
    store.name = v;
    this._name.set(v);
  }
  setStream(v: StreamSettings) {
    store.stream = v;
    this._stream.set(v);
  }
  setCodec(v: CodecChoice) {
    store.codec = v;
    this._codec.set(v);
  }
  setShareAudio(v: boolean) {
    store.shareAudio = v;
    this._shareAudio.set(v);
  }
  setShowStats(v: boolean) {
    store.showStats = v;
    this._showStats.set(v);
  }
  setMaxCompatibility(v: boolean) {
    store.maxCompatibility = v;
    this._maxCompatibility.set(v);
  }
  setVolumeHinted(v: boolean) {
    store.volumeHinted = v;
    this._volumeHinted.set(v);
  }

  /** Muda quando qualquer ajuste que exige reiniciar o compartilhamento muda. */
  signature(): string {
    return [JSON.stringify(this._stream()), this._codec(), this._shareAudio(), this._maxCompatibility(), this._studio(), this._adaptToLoad()].join('|');
  }
}
