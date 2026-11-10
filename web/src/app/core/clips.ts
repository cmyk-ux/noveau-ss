import { signal } from '@angular/core';

// Clipes como no Discord: guarda sempre os últimos 2 min de cada tela da sala e, ao clipar, sobe um MP4
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
  /** Resolução que quem transmite manda (a maior). O clipe sai nela (até 1080p), mesmo que agora chegue menor. */
  size?: { width: number; height: number };
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

/** No máximo tantas telas guardadas ao mesmo tempo (cada uma é um codificador e até ~150 MB). */
const MAX_SOURCES = 4;

/**
 * Os últimos 2 min de uma tela, num worker só dela. Continua guardando quando a tela sai de
 * foco: o vídeo para de chegar (o servidor deixa de mandar), o som continua, e ao voltar segue
 * no mesmo buffer. Trocar de trilha (reconexão, parar e voltar a compartilhar) também não apaga.
 */
class SourceBuffer {
  readonly worker = new Worker(new URL('./clip.worker', import.meta.url), { type: 'module' });
  private clones: MediaStreamTrack[] = [];
  private key: string | null = null;
  name = '';

  constructor(onMessage: (msg: { type: string; [k: string]: unknown }) => void) {
    this.worker.onmessage = (e) => onMessage(e.data);
  }

  follow(src: ClipSource, Ctor: ProcessorCtor) {
    const key = `${src.video.id}:${src.audio?.id ?? ''}`;
    this.name = src.name;
    // Mesma trilha e a cópia ainda viva: nada a fazer. Trilha nova ou cópia encerrada: troca a
    // entrada, mas o que já foi guardado fica.
    if (key === this.key && !this.clones.some((t) => t.readyState === 'ended')) return;
    const keep = this.key !== null;
    this.releaseTracks();
    this.key = key;
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
    this.worker.postMessage(
      {
        type: 'start',
        keep,
        video: v,
        audio: a,
        target: src.size ?? null,
        seconds: CLIP_SECONDS,
        maxWidth: MAX_WIDTH,
        maxHeight: MAX_HEIGHT,
        fps: FPS,
        bitrate: BITRATE,
      },
      a === null ? [v] : [v, a],
    );
  }

  dispose() {
    this.releaseTracks();
    this.worker.terminate();
  }

  private releaseTracks() {
    for (const t of this.clones) t.stop();
    this.clones = [];
  }
}

export class ClipRecorder {
  private readonly sources = new Map<string, SourceBuffer>();
  private readonly _ready = signal<ReadonlySet<string>>(new Set());
  private readonly _items = signal<ClipItem[]>([]);
  private readonly _error = signal<string | null>(null);
  /** Telas que já têm o que clipar (pelo menos 1 s guardado). */
  readonly ready = this._ready.asReadonly();
  readonly items = this._items.asReadonly();
  readonly error = this._error.asReadonly();
  private ticker?: number;
  private watcher?: number;

  constructor(private readonly token: () => string) {}

  /**
   * Guarda todas as telas que `get` devolver (a em foco primeiro), conferindo de novo a cada 2 s.
   * A trilha costuma chegar depois de a tela aparecer (ainda não inscrita) e o LiveKit troca a
   * trilha ao reconectar; sem conferir de novo, a gravação ficava parada até recarregar a página.
   */
  watch(get: () => ClipSource[]) {
    this.sync(get());
    window.clearInterval(this.watcher);
    this.watcher = window.setInterval(() => this.sync(get()), 2000);
  }

  /** Começa, troca ou encerra os buffers para ficar igual à lista de telas. */
  sync(list: ClipSource[]) {
    const Ctor = processorCtor();
    if (Ctor === null) return;
    const wanted = list.filter((s) => s.video.readyState !== 'ended').slice(0, MAX_SOURCES);
    const ids = new Set(wanted.map((s) => s.id));
    for (const [id, buf] of this.sources) if (!ids.has(id)) this.drop(id, buf);
    for (const src of wanted) {
      let buf = this.sources.get(src.id);
      if (buf === undefined) {
        buf = new SourceBuffer((msg) => this.onWorker(src.id, msg));
        this.sources.set(src.id, buf);
      }
      buf.follow(src, Ctor);
    }
    this.ensureTicker();
  }

  stop() {
    window.clearInterval(this.watcher);
    this.watcher = undefined;
    for (const [id, buf] of this.sources) this.drop(id, buf);
    window.clearInterval(this.ticker);
    this.ticker = undefined;
  }

  /** Clipa estas telas (cada uma vira um MP4). Devolve quantas tinham o que clipar. */
  clip(ids: string[]): number {
    let n = 0;
    for (const sourceId of ids) {
      const buf = this.sources.get(sourceId);
      if (buf === undefined || !this._ready().has(sourceId)) continue;
      const id = `local-${Date.now()}-${n++}`;
      this.upsert({ id, name: buf.name, state: 'saving', progress: 0 });
      buf.worker.postMessage({ type: 'clip', id });
      // Rede de segurança: se o gravador não responder, o cartão não fica preso em "montando".
      window.setTimeout(() => {
        const item = this._items().find((i) => i.id === id);
        if (item?.state === 'saving') this.upsert({ ...item, state: 'failed', error: 'O navegador não terminou de montar o vídeo (30 s). Tente de novo.' });
      }, 30_000);
    }
    return n;
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

  private drop(id: string, buf: SourceBuffer) {
    buf.dispose();
    this.sources.delete(id);
    this.setReady(id, false);
  }

  private setReady(id: string, on: boolean) {
    if (this._ready().has(id) === on) return;
    this._ready.update((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  private ensureTicker() {
    if (this.ticker !== undefined) return;
    // Tira da lista os clipes cujo link já venceu.
    this.ticker = window.setInterval(() => {
      const now = Date.now();
      const list = this._items();
      if (list.some((i) => i.expiresAt !== undefined && i.expiresAt <= now)) {
        this._items.set(list.filter((i) => i.expiresAt === undefined || i.expiresAt > now));
      }
    }, 1000);
  }

  private onWorker(sourceId: string, msg: { type: string; [k: string]: unknown }) {
    switch (msg.type) {
      case 'ready':
        this.setReady(sourceId, msg['ready'] === true);
        break;
      case 'error':
        this._error.set(String(msg['message']));
        break;
      case 'clip-error': {
        const item = this._items().find((i) => i.id === msg['id']);
        if (item?.state === 'saving') this.upsert({ ...item, state: 'failed', error: String(msg['message']) });
        break;
      }
      case 'clip': {
        const item = this._items().find((i) => i.id === msg['id']);
        if (item?.state !== 'saving') return;
        const blob = new Blob([msg['buffer'] as ArrayBuffer], { type: 'video/mp4' });
        void this.upload(item, blob, msg['seconds'] as number);
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
