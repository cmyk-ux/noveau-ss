// Link da sala: o nome é só rótulo; a chave depois do # é o que abre a sala.

export interface RoomLink {
  key: string;
  secret: string;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function readLink(): RoomLink {
  const hash = location.hash.replace(/^#/, '');
  if (hash === '') return { key: '', secret: '' };
  if (!hash.includes('=')) return { key: hash, secret: '' };
  const p = new URLSearchParams(hash);
  return { key: p.get('k') ?? '', secret: p.get('s') ?? '' };
}

export function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function encodeLink(link: RoomLink): string {
  return link.secret === '' ? link.key : `k=${encodeURIComponent(link.key)}&s=${encodeURIComponent(link.secret)}`;
}

/** Sala da call do Discord: não tem chave no link, quem está na call entra pelo login. */
export function isCallRoom(): boolean {
  return location.pathname === '/call';
}

export function roomUrl(label: string): string {
  if (isCallRoom()) return `${location.origin}/`;
  return `${location.origin}/room/${encodeURIComponent(label)}#${encodeLink(readLink())}`;
}

export async function copyRoomLink(label: string): Promise<{ copied: boolean; link: string }> {
  const link = roomUrl(label);
  return { copied: await copyText(link), link };
}

const ADJECTIVES = ['amber', 'bold', 'brave', 'bright', 'calm', 'clever', 'curious', 'eager', 'gentle', 'golden',
  'happy', 'hungry', 'lucky', 'merry', 'noble', 'quiet', 'rapid', 'silent', 'sunny', 'swift'];
const NOUNS = ['anchor', 'badger', 'beacon', 'cedar', 'comet', 'falcon', 'harbor', 'heron', 'lantern', 'meadow',
  'otter', 'pepper', 'quartz', 'raven', 'river', 'sparrow', 'thistle', 'walnut', 'willow', 'wombat'];

function any<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

export function randomRoomName(): string {
  const n = Math.floor(Math.random() * 90) + 10;
  return `${any(ADJECTIVES)}-${any(NOUNS)}-${n}`;
}

export function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
