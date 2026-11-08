// Volume de cada voz e de cada tela, só para quem está ouvindo.

export interface Volume {
  level: number;
  muted: boolean;
}

export const FULL: Volume = { level: 1, muted: false };

export function atLevel(level: number): Volume {
  return { level: clampLevel(level), muted: false };
}

export function toggled(v: Volume): Volume {
  return { ...v, muted: !v.muted };
}

export function isSilent(v: Volume): boolean {
  return v.muted || v.level === 0;
}

export function describeVolume(v: Volume): string {
  return v.muted ? 'muted' : `${Math.round(v.level * 100)}%`;
}

export function loudness(v: Volume): 'off' | 'low' | 'full' {
  return isSilent(v) ? 'off' : v.level < 0.5 ? 'low' : 'full';
}

export function volumeIcon(v: Volume): string {
  switch (loudness(v)) {
    case 'off':
      return 'speakerOff';
    case 'low':
      return 'speakerLow';
    default:
      return 'speaker';
  }
}

function clampLevel(l: number): number {
  return Number.isFinite(l) ? Math.min(1, Math.max(0, l)) : FULL.level;
}

export type Channel = 'mic' | 'share';

export class Mixer {
  private readonly volumes = new Map<string, Volume>();

  read(channel: Channel, identity: string): Volume {
    return this.volumes.get(`${channel}:${identity}`) ?? FULL;
  }

  turnTo(channel: Channel, identity: string, level: number) {
    this.volumes.set(`${channel}:${identity}`, atLevel(level));
  }

  toggleMute(channel: Channel, identity: string) {
    this.volumes.set(`${channel}:${identity}`, toggled(this.read(channel, identity)));
  }
}
