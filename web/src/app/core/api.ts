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
  return post('/api/token', { ...link, name }, 'Could not join the room.');
}

export function requestCamera(link: RoomLink): Promise<CameraAddress> {
  return post('/api/camera', link, 'Could not get a camera address.');
}

export function revokeCamera(link: RoomLink): Promise<unknown> {
  return post('/api/camera/stop', link, 'Could not revoke the camera key.');
}

export async function requiresSecret(): Promise<boolean> {
  const res = await fetch('/api/config');
  return (await res.json()).requiresSecret === true;
}
