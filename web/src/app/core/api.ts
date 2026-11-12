import { DEVICE } from './device';
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
  return post('/api/token', { ...link, name, device: DEVICE }, 'Não foi possível entrar na sala.');
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
  return post('/api/discord/token', { device: DEVICE }, 'Não foi possível entrar na sala da call.');
}

export interface CallMembers {
  call: DiscordCall;
  people: DiscordUser[];
}

/** Erro da API com o código HTTP (404 = recurso desligado no servidor, 401 = sem login). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function callMembers(): Promise<CallMembers> {
  const res = await fetch('/api/discord/members', { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Não foi possível ver quem está na call.');
  return data;
}

export function pingCall(): Promise<{ ok: boolean; count: number }> {
  return post('/api/discord/ping', {}, 'Não foi possível avisar a call.');
}

export function inviteToRoom(userId: string, link: string): Promise<{ ok: boolean }> {
  return post('/api/discord/invite', { userId, link }, 'Não foi possível convidar.');
}

/** Convite de 1 uso para alguém sem Discord entrar na sala da call. */
export function createGuestInvite(): Promise<{ id: string; expiresAt: number }> {
  return post('/api/discord/guest-invite', {}, 'Não foi possível criar o convite.');
}

export function requestGuestToken(id: string, holder: string, name: string): Promise<JoinGrant & { call: DiscordCall }> {
  return post('/api/guest/token', { id, holder, name, device: DEVICE }, 'Não foi possível entrar com este convite.');
}

export function kickGuest(identity: string): Promise<unknown> {
  return post('/api/discord/kick', { identity }, 'Não foi possível expulsar.');
}

/** Chave para o OBS transmitir por WHIP (veja server/obs.mjs). */
export interface ObsKey {
  token: string;
  /** Sala da call do Discord: a chave segue a call em que você estiver. */
  followsCall: boolean;
  expiresAt: number;
  path: string;
}

export async function requestObsKey(roomToken: string): Promise<ObsKey> {
  const res = await fetch('/api/obs/key', { method: 'POST', headers: { authorization: `Bearer ${roomToken}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.token !== 'string') throw new Error(body.error ?? `Erro ${res.status} ao pegar a chave do OBS.`);
  return body as ObsKey;
}

// ---------- Celular como câmera/microfone (veja server/phone.mjs)
export interface PhoneLink {
  state: 'none' | 'waiting' | 'claimed';
  code?: string;
  expiresAt?: number;
  phoneIdentity?: string | null;
  /** Para que o link foi gerado: o celular começa ligando só isso. */
  use?: PhoneUse;
}

/** Celular como câmera ou como microfone: um não liga o outro. */
export type PhoneUse = 'cam' | 'mic';

async function withRoomToken<T>(method: 'GET' | 'POST', path: string, roomToken: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(path, {
    method,
    cache: 'no-store',
    headers: { authorization: `Bearer ${roomToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? fallback);
  return data as T;
}

export function phoneLinkStatus(roomToken: string): Promise<PhoneLink> {
  return withRoomToken('GET', '/api/phone/link', roomToken, undefined, 'Não foi possível ver o celular.');
}

export function createPhoneLink(roomToken: string, use: PhoneUse): Promise<PhoneLink> {
  return withRoomToken('POST', '/api/phone/link', roomToken, { use }, 'Não foi possível gerar o link do celular.');
}

export function disconnectPhone(roomToken: string): Promise<{ ok: boolean }> {
  return withRoomToken('POST', '/api/phone/disconnect', roomToken, {}, 'Não foi possível desconectar o celular.');
}

export function controlPhone(roomToken: string, what: { cam?: boolean; mic?: boolean }): Promise<{ ok: boolean }> {
  return withRoomToken('POST', '/api/phone/control', roomToken, what, 'O celular não respondeu.');
}

export function requestPhoneToken(code: string, holder: string): Promise<{ token: string; url: string; name: string; identity: string }> {
  return post('/api/phone/token', { code, holder }, 'Não foi possível conectar o celular.');
}

/** Muda a qualidade de áudio da sala (vale para o microfone de todo mundo). */
export async function setRoomAudio(roomToken: string, preset: string): Promise<void> {
  const res = await fetch('/api/room/audio', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${roomToken}` },
    body: JSON.stringify({ preset }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Não foi possível mudar o áudio da sala.');
}
