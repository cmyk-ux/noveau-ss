import { signal } from '@angular/core';

async function listDevices(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind);
  } catch {
    return [];
  }
}

export function listWebcams() {
  return listDevices('videoinput');
}

export async function listMicrophones() {
  // Sem permissão o navegador devolve entradas sem nome; essas não servem pra escolher.
  return (await listDevices('audioinput')).filter((d) => d.label !== '');
}

export class DeviceList {
  private readonly _devices = signal<MediaDeviceInfo[]>([]);
  private readonly _active = signal<string | undefined>(undefined);
  readonly devices = this._devices.asReadonly();

  constructor(
    private readonly enumerate: () => Promise<MediaDeviceInfo[]>,
    private readonly liveDeviceId: () => string | undefined,
  ) {}

  async refresh() {
    this._devices.set(await this.enumerate());
    this._active.set(this.liveDeviceId());
  }

  isSelected(id: string): boolean {
    const a = this._active();
    return a === id || (a === undefined && id === 'default');
  }
}
