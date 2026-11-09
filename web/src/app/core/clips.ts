import { signal } from '@angular/core';

// Clipes como no Discord: guarda os últimos 2 min da tela em foco e, ao clipar, sobe um MP4
// para o servidor, que devolve um link de download válido por 5 min. Só quem clipou vê o
// link e pode apagar antes.

export const CLIP_SECONDS = 120;
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const FPS = 60;
const BITRATE = 10_000_000;

export interface ClipSource {
  id: string;
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
  name: string;
  local: boolean;
}

export interface ClipItem {
  id: string;
  name: string;
  state: 'saving' | 'uploading' | 'ready' | 'failed';
  progress: number;
  url?: string;
  token?: string;
  expiresAt?: number;
  error?: string;
  mb?: number;
  seconds?: number;
}

interface ProcessorCtor {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream };
}

function processorCtor(): ProcessorCtor | null {
  return (globalThis as unknown as { MediaStreamTrackProcessor?: ProcessorCtor }).MediaStreamTrackProcessor ?? null;
}

/** Precisa ler quadros crus (Chrome, Edge, Brave) e codificar (WebCodecs). */
export function clipsSupported(): boolean {
  return processorCtor() !== null && 'VideoEncoder' in globalThis;
}

export interface ClipServer {
  ttlMs: number;
}

export async function clipServer(): Promise<ClipServer | null> {
  try {
    const res = await fetch('/api/config');
    return (await res.json()).clips ?? null;
  } catch {
    return null;
  }
}

export class ClipRecorder {
  private worker: Worker | null = null;
  private clones: MediaStreamTrack[] = [];
  private sourceKey: string | null = null;
  private readonly _buffered = signal(0);
  private readonly _items = signal<ClipItem[]>([]);
  private readonly _error = signal<string | null>(null);
  private readonly _size = signal<string | null>(null);
  /** Segundos já guardados (até 120). */
  readonly buffered = this._buffered.asReadonly();
  readonly items = this._items.asReadonly();
  readonly error = this._error.asReadonly();
  /** "1920x1080 · placa de vídeo". */
  readonly size = this._size.asReadonly();
  private pendingName = '';
  private ticker?: number;

  constructor(private readonly token: () => string) {}

  get recording() {
    return this.worker !== null && this.sourceKey !== null;
  }

  /** Começa (ou troca) a gravação contínua para esta fonte. */
  follow(src: ClipSource | null) {
    const key = src === null ? null : `${src.id}:${src.video.id}:${src.audio?.id ?? ''}`;
    if (key === this.sourceKey) return;
    this.release();
    this.sourceKey = key;
    if (src === null) return;
    const Ctor = processorCtor();
    if (Ctor === null) return;
    this.ensureWorker();
    const video = src.video.clone();
    // Na própria tela, o navegador já entrega reduzido a 1080p60 (mais barato que reduzir aqui).
    if (src.local) {
      void video
        .applyConstraints({ width: { max: MAX_WIDTH }, height: { max: MAX_HEIGHT }, frameRate: { max: FPS } })
        .catch(() => undefined);
    }
    const audio = src.audio?.clone() ?? null;
    this.clones = audio === null ? [video] : [video, audio];
    const v = new Ctor({ track: video }).readable;
    const a = audio === null ? null : new Ctor({ track: audio }).readable;
    this.worker!.postMessage(
      { type: 'start', video: v, audio: a, seconds: CLIP_SECONDS, maxWidth: MAX_WIDTH, maxHeight: MAX_HEIGHT, fps: FPS, bitrate: BITRATE },
      a === null ? [v] : [v, a],
    );
    this.pendingName = src.name;
    this._error.set(null);
  }

  stop() {
    this.release();
    this.sourceKey = null;
    this.worker?.terminate();
    this.worker = null;
    window.clearInterval(this.ticker);
    this.ticker = undefined;
  }

  clip() {
    if (this.worker === null) return;
    const id = `local-${Date.now()}`;
    this.upsert({ id, name: this.pendingName, state: 'saving', progress: 0 });
    this.worker.postMessage({ type: 'clip', id });
  }

  async remove(item: ClipItem) {
    this._items.update((list) => list.filter((i) => i.id !== item.id));
    if (item.token === undefined) return;
    await fetch(`/api/clips/${encodeURIComponent(item.id)}`, {
      method: 'DELETE',
      headers: { 'x-clip-token': item.token },
    }).catch(() => undefined);
  }

  dismiss(item: ClipItem) {
    this._items.update((list) => list.filter((i) => i.id !== item.id));
  }

  private release() {
    this.worker?.postMessage({ type: 'stop' });
    for (const t of this.clones) t.stop();
    this.clones = [];
    this._buffered.set(0);
    this._size.set(null);
  }

  private ensureWorker() {
    if (this.worker !== null) return;
    this.worker = new Worker(new URL('./clip.worker', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onWorker(e.data);
    // Tira da lista os clipes cujo link já venceu.
    this.ticker = window.setInterval(() => {
      const now = Date.now();
      this._items.update((list) => list.filter((i) => i.expiresAt === undefined || i.expiresAt > now));
    }, 1000);
  }

  private onWorker(msg: { type: string; [k: string]: unknown }) {
    switch (msg.type) {
      case 'buffered':
        this._buffered.set(Math.min(CLIP_SECONDS, Math.floor(msg['seconds'] as number)));
        break;
      case 'size':
        this._size.set(`${msg['width']}x${msg['height']} · ${msg['hardware'] ? 'placa de vídeo' : 'processador'}`);
        break;
      case 'error':
        this._error.set(String(msg['message']));
        break;
      case 'clip-error': {
        const saving = this._items().find((i) => i.state === 'saving');
        if (saving !== undefined) this.upsert({ ...saving, state: 'failed', error: String(msg['message']) });
        break;
      }
      case 'clip': {
        const saving = this._items().find((i) => i.state === 'saving');
        if (saving === undefined) return;
        const blob = new Blob([msg['buffer'] as ArrayBuffer], { type: 'video/mp4' });
        void this.upload(saving, blob, msg['seconds'] as number);
        break;
      }
    }
  }

  private upsert(item: ClipItem, replace?: string) {
    this._items.update((list) => {
      const at = list.findIndex((i) => i.id === (replace ?? item.id));
      if (at < 0) return [...list, item];
      const copy = list.slice();
      copy[at] = item;
      return copy;
    });
  }

  private upload(item: ClipItem, blob: Blob, seconds: number) {
    const mb = blob.size / 1e6;
    this.upsert({ ...item, state: 'uploading', progress: 0, mb, seconds });
    return new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/clips');
      xhr.setRequestHeader('authorization', `Bearer ${this.token()}`);
      xhr.setRequestHeader('x-clip-name', encodeURIComponent(item.name));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) this.upsert({ ...item, state: 'uploading', progress: e.loaded / e.total, mb, seconds });
      };
      const fail = (error: string) => {
        this.upsert({ ...item, state: 'failed', error, mb, seconds });
        resolve();
      };
      xhr.onerror = () => fail('A conexão caiu no meio do envio.');
      xhr.onload = () => {
        let body: { id?: string; url?: string; token?: string; expiresAt?: number; error?: string } = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* resposta vazia */
        }
        if (xhr.status !== 200 || body.id === undefined) return fail(body.error ?? `Erro ${xhr.status} ao enviar.`);
        this.upsert(
          { id: body.id, name: item.name, state: 'ready', progress: 1, url: body.url, token: body.token, expiresAt: body.expiresAt, mb, seconds },
          item.id,
        );
        resolve();
      };
      xhr.send(blob);
    });
  }
}
