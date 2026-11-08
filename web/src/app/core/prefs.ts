import { Injectable, signal } from '@angular/core';
import { CodecChoice, DEFAULT_STREAM, FRAME_RATES, MODES, RESOLUTIONS, StreamSettings } from './stream';

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
    const raw = localStorage.getItem('cenaculum:stream');
    if (raw === null) return DEFAULT_STREAM;
    try {
      const s = JSON.parse(raw);
      return {
        mode: oneOf(s.mode, MODES.map((m) => m.id), DEFAULT_STREAM.mode),
        resolution: oneOf(s.resolution, RESOLUTIONS.map((r) => r.id), DEFAULT_STREAM.resolution),
        frameRate: oneOf(s.frameRate, FRAME_RATES, DEFAULT_STREAM.frameRate),
      };
    } catch {
      return DEFAULT_STREAM;
    }
  },
  set stream(v: StreamSettings) {
    localStorage.setItem('cenaculum:stream', JSON.stringify(v));
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
  get maxCompatibility(): boolean {
    return localStorage.getItem('cenaculum:compat') !== 'no';
  },
  set maxCompatibility(v: boolean) {
    localStorage.setItem('cenaculum:compat', v ? 'yes' : 'no');
  },
};

@Injectable({ providedIn: 'root' })
export class Prefs {
  private readonly _name = signal(store.name);
  private readonly _stream = signal(store.stream);
  private readonly _codec = signal(store.codec);
  private readonly _shareAudio = signal(store.shareAudio);
  private readonly _showStats = signal(store.showStats);
  private readonly _maxCompatibility = signal(store.maxCompatibility);
  private readonly _volumeHinted = signal(store.volumeHinted);

  readonly name = this._name.asReadonly();
  readonly stream = this._stream.asReadonly();
  readonly codec = this._codec.asReadonly();
  readonly shareAudio = this._shareAudio.asReadonly();
  readonly showStats = this._showStats.asReadonly();
  readonly maxCompatibility = this._maxCompatibility.asReadonly();
  readonly volumeHinted = this._volumeHinted.asReadonly();

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
    return [JSON.stringify(this._stream()), this._codec(), this._shareAudio(), this._maxCompatibility()].join('|');
  }
}
