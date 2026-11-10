import { signal } from '@angular/core';
import { StudioHub } from './studio';

// Plugin de DAW: o som chega do servidor por um WebSocket (veja server/daw.mjs) e toca pelo
// mesmo player do modo estúdio (buffer ajustável, sem reamostrar no caminho).

/** Todas as versões do plugin (builds automáticos do GitHub). */
export const DAW_PLUGIN_RELEASES = 'https://github.com/cmyk-ux/noveau-ss/releases';
/** O CI republica a versão mais nova do main sempre com a tag plugin-latest. */
const LATEST = 'https://github.com/cmyk-ux/noveau-ss/releases/download/plugin-latest';
export const DAW_INSTALLERS = {
  windows: `${LATEST}/noveau-DAW-Windows.exe`,
  mac: `${LATEST}/noveau-DAW-Mac.pkg`,
};

export type DesktopOs = 'windows' | 'mac' | 'other';
export function desktopOs(): DesktopOs {
  const p = `${navigator.platform} ${navigator.userAgent}`;
  return /Win/i.test(p) ? 'windows' : /Mac/i.test(p) && !/iPhone|iPad/i.test(p) ? 'mac' : 'other';
}

/** Página /plugin: confirma o pedido de conexão que o plugin abriu no navegador. */
export async function confirmDawLink(code: string): Promise<void> {
  const res = await fetch('/api/daw/link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Erro ${res.status}.`);
}

export interface DawPairCode {
  code: string;
  expiresAt: number;
}

export async function requestDawCode(token: string): Promise<DawPairCode> {
  const res = await fetch('/api/daw/pair', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.code !== 'string') throw new Error(body.error ?? `Erro ${res.status} ao gerar o código.`);
  return body as DawPairCode;
}

/** Escuta os plugins de DAW desta sala enquanto você está nela. */
export class DawListener {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 1000;
  private timer?: number;
  private readonly names = new Map<string, string>();
  private readonly decoder = new TextDecoder();
  private readonly _connected = signal(false);
  readonly connected = this._connected.asReadonly();

  constructor(
    private readonly hub: StudioHub,
    private readonly token: () => string,
  ) {}

  start() {
    this.stopped = false;
    if (this.ws === null) this.open();
  }

  stop() {
    this.stopped = true;
    window.clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    for (const id of this.names.keys()) this.hub.dropDaw(id);
    this.names.clear();
    this._connected.set(false);
  }

  private open() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/daw/listen`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'auth', token: this.token() }));
      this.retry = 1000;
      this._connected.set(true);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') return this.onText(e.data);
      const buf = new Uint8Array(e.data as ArrayBuffer);
      const n = buf[0];
      if (buf.length < 1 + n) return;
      const id = this.decoder.decode(buf.subarray(1, 1 + n));
      this.hub.feedDaw(id, this.names.get(id) ?? 'DAW', buf.subarray(1 + n));
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this._connected.set(false);
      for (const id of this.names.keys()) this.hub.dropDaw(id);
      this.names.clear();
      if (this.stopped) return;
      this.timer = window.setTimeout(() => this.open(), this.retry);
      this.retry = Math.min(30_000, this.retry * 2);
    };
  }

  private onText(raw: string) {
    let m: { t?: string; id?: string; name?: string; rate?: number; format?: number; channels?: number };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.t === 'on' && m.id !== undefined) {
      // O plugin está na master: os controles aparecem já, mesmo sem som tocando.
      this.names.set(m.id, m.name ?? 'DAW');
      this.hub.announceDaw(m.id, m.name ?? 'DAW', m.rate, m.format, m.channels);
    } else if (m.t === 'off' && m.id !== undefined) {
      this.names.delete(m.id);
      this.hub.dropDaw(m.id);
    }
  }
}
