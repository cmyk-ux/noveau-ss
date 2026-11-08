import { RoomLink } from './link';

export interface JoinGrant {
  token: string;
  url: string;
  name: string;
  canPublish: boolean;
  camera: boolean;
}

export interface CameraAddress {
  url: string;
  streamKey: string;
  pushUrl: string;
  name: string;
  sendAt: { resolution: string; mbps: number };
  endsAfterHours: number;
}

async function post<T>(path: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? fallback);
  return data as T;
}

export function requestToken(link: RoomLink, name: string): Promise<JoinGrant> {
  return post('/api/token', { ...link, name }, 'Não foi possível entrar na sala.');
}

export function requestCamera(link: RoomLink): Promise<CameraAddress> {
  return post('/api/camera', link, 'Não foi possível pegar um endereço de câmera.');
}

export function revokeCamera(link: RoomLink): Promise<unknown> {
  return post('/api/camera/stop', link, 'Não foi possível revogar a chave da câmera.');
}

export async function requiresSecret(): Promise<boolean> {
  const res = await fetch('/api/config');
  return (await res.json()).requiresSecret === true;
}

export interface DiscordUser {
  id: string;
  name: string;
  avatar: string | null;
}

export interface DiscordCall {
  id: string;
  name: string;
}

export interface Me {
  /** Login com Discord configurado no servidor. */
  discord: boolean;
  user: DiscordUser | null;
  /** Canal de voz do servidor em que a pessoa está agora. */
  call: DiscordCall | null;
}

export async function whoAmI(): Promise<Me> {
  const res = await fetch('/api/me', { cache: 'no-store' });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Não foi possível falar com o servidor.');
  return res.json();
}

export function requestCallToken(): Promise<JoinGrant & { call: DiscordCall }> {
  return post('/api/discord/token', {}, 'Não foi possível entrar na sala da call.');
}

export interface CallMembers {
  call: DiscordCall;
  people: DiscordUser[];
}

export async function callMembers(): Promise<CallMembers> {
  const res = await fetch('/api/discord/members', { cache: 'no-store' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Não foi possível ver quem está na call.');
  return data;
}

export function pingCall(): Promise<{ ok: boolean; count: number }> {
  return post('/api/discord/ping', {}, 'Não foi possível avisar a call.');
}
