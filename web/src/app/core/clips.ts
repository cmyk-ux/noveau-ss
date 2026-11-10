import { signal } from '@angular/core';

// Clipes como no Discord: guarda os últimos 2 min da tela em foco e, ao clipar, sobe um MP4
// direto para o Cloudflare R2 e recebe um link de download válido por 5 min. Só quem clipou vê o
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
  /** Já clicou em baixar (o botão muda de cor). */
  downloaded?: boolean;
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
  private watcher?: number;

  constructor(private readonly token: () => string) {}

  get recording() {
    return this.worker !== null && this.sourceKey !== null;
  }

  /**
   * Segue a fonte que `get` devolver, conferindo de novo a cada 2 s. A trilha da tela em foco
   * costuma chegar depois do foco (ainda não inscrita) e o LiveKit troca a trilha ao reconectar;
   * sem conferir de novo, a gravação ficava parada até recarregar a página.
   */
  watch(get: () => ClipSource | null) {
    this.follow(get());
    window.clearInterval(this.watcher);
    this.watcher = window.setInterval(() => this.follow(get()), 2000);
  }

  /** Começa (ou troca) a gravação contínua para esta fonte. */
  follow(src: ClipSource | null) {
    if (src !== null && src.video.readyState === 'ended') src = null;
    const key = src === null ? null : `${src.id}:${src.video.id}:${src.audio?.id ?? ''}`;
    // Mesma fonte e a cópia ainda viva: nada a fazer. Cópia encerrada: recomeça.
    if (key === this.sourceKey && !this.clones.some((t) => t.readyState === 'ended')) return;
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
    window.clearInterval(this.watcher);
    this.watcher = undefined;
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
    // Rede de segurança: se o gravador não responder, o cartão não fica preso em "montando".
    window.setTimeout(() => {
      const item = this._items().find((i) => i.id === id);
      if (item?.state === 'saving') this.upsert({ ...item, state: 'failed', error: 'O navegador não terminou de montar o vídeo (30 s). Tente de novo.' });
    }, 30_000);
  }

  async remove(item: ClipItem) {
    this._items.update((list) => list.filter((i) => i.id !== item.id));
    if (item.token === undefined) return;
    await fetch(`/api/clips/${encodeURIComponent(item.id)}`, {
      method: 'DELETE',
      headers: { 'x-clip-token': item.token },
    }).catch(() => undefined);
  }

  /**
   * Apagar com "desfazer": some da lista na hora e só apaga do servidor depois de `ms`.
   * Devolve a função que desfaz (põe o clipe de volta e cancela a exclusão).
   */
  removeLater(item: ClipItem, ms: number): () => void {
    const at = this._items().findIndex((i) => i.id === item.id);
    this._items.update((list) => list.filter((i) => i.id !== item.id));
    const timer = window.setTimeout(() => void this.remove(item), ms);
    return () => {
      window.clearTimeout(timer);
      if (item.expiresAt !== undefined && item.expiresAt <= Date.now()) return;
      this._items.update((list) => {
        const copy = list.slice();
        copy.splice(Math.min(Math.max(0, at), copy.length), 0, item);
        return copy;
      });
    };
  }

  markDownloaded(item: ClipItem) {
    this._items.update((list) => list.map((i) => (i.id === item.id ? { ...i, downloaded: true } : i)));
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

  private async upload(item: ClipItem, blob: Blob, seconds: number) {
    const mb = blob.size / 1e6;
    this.upsert({ ...item, state: 'uploading', progress: 0, mb, seconds });
    const fail = (error: string) => this.upsert({ ...item, state: 'failed', error, mb, seconds });
    // 1) O servidor reserva o clipe e assina um endereço do R2 só para este arquivo.
    let start: { id?: string; token?: string; uploadUrl?: string; error?: string };
    try {
      const res = await fetch('/api/clips', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token()}` },
        body: JSON.stringify({ name: item.name, bytes: blob.size }),
      });
      start = await res.json().catch(() => ({ error: `Erro ${res.status} ao preparar o envio.` }));
      if (!res.ok || start.id === undefined || start.uploadUrl === undefined) return fail(start.error ?? `Erro ${res.status} ao preparar o envio.`);
    } catch {
      return fail('Sem conexão com o servidor.');
    }
    const { id, token, uploadUrl } = start as { id: string; token: string; uploadUrl: string };
    // 2) O arquivo vai direto do navegador para o R2 (não passa pelo servidor do site).
    const sent = await new Promise<string | null>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('content-type', 'video/mp4');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) this.upsert({ ...item, state: 'uploading', progress: e.loaded / e.total, mb, seconds });
      };
      // Status 0 = o navegador barrou a resposta: quase sempre falta a regra de CORS no bucket.
      xhr.onerror = () => resolve('O envio para o R2 foi barrado (confira o CORS do bucket) ou a conexão caiu.');
      xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300 ? null : `O R2 recusou o envio (erro ${xhr.status}).`);
      xhr.send(blob);
    });
    if (sent !== null) {
      void fetch(`/api/clips/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'x-clip-token': token } }).catch(() => undefined);
      return fail(sent);
    }
    // 3) Avisa o servidor, que confere o arquivo e devolve o link de download.
    try {
      const res = await fetch(`/api/clips/${encodeURIComponent(id)}/done`, { method: 'POST', headers: { 'x-clip-token': token } });
      const body: { url?: string; expiresAt?: number; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || body.url === undefined) return fail(body.error ?? `Erro ${res.status} ao finalizar.`);
      this.upsert({ id, name: item.name, state: 'ready', progress: 1, url: body.url, token, expiresAt: body.expiresAt, mb, seconds }, item.id);
    } catch {
      fail('Sem conexão com o servidor.');
    }
  }
}
