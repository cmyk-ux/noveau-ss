// Preferências da câmera, guardadas neste navegador: qual câmera do PC usar e onde fica a
// janelinha da câmera sobre a tela (posição e tamanho que você arrastou) e se você quer se ver.
import { Injectable, signal } from '@angular/core';

/** Posição da janelinha: canto de cima à esquerda e largura, em fração do quadro da tela (0 a 1). */
export interface PipBox {
  x: number;
  y: number;
  w: number;
}

/** Canto de baixo à direita, como pedido: ~22% da largura da tela. */
export const DEFAULT_PIP: PipBox = { x: 0.76, y: 0.7, w: 0.22 };

function read<T>(key: string, parse: (raw: string) => T | null, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (parse(raw) ?? fallback);
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* navegador sem localStorage (aba anônima com bloqueio) */
  }
}

function parseBox(raw: string): PipBox | null {
  const b = JSON.parse(raw);
  const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  return ok(b?.x) && ok(b?.y) && ok(b?.w) && b.w > 0.04 ? { x: b.x, y: b.y, w: b.w } : null;
}

@Injectable({ providedIn: 'root' })
export class CamPrefs {
  private readonly _device = signal(read('noveau:cam-device', (r) => r, ''));
  private readonly _pip = signal(read('noveau:cam-pip', parseBox, DEFAULT_PIP));
  private readonly _selfView = signal(read('noveau:cam-self', (r) => r !== '0', true));

  /** Câmera do PC escolhida da última vez ('' = a padrão). */
  readonly device = this._device.asReadonly();
  readonly pip = this._pip.asReadonly();
  /** Ver a própria câmera (o retorno). Desligado, a cópia nem é feita. */
  readonly selfView = this._selfView.asReadonly();

  setDevice(id: string) {
    write('noveau:cam-device', id);
    this._device.set(id);
  }

  setSelfView(on: boolean) {
    write('noveau:cam-self', on ? '1' : '0');
    this._selfView.set(on);
  }

  setPip(b: PipBox) {
    write('noveau:cam-pip', JSON.stringify(b));
    this._pip.set(b);
  }
}
