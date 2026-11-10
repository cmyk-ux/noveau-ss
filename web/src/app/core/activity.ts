// "Atividade" de quem transmite, como o selo de jogo do Discord: o que a pessoa está passando.
// Vai num atributo do participante ("act"), então chega a todos sem mensagem extra e some sozinho
// quando a pessoa sai da sala.

export type Surface = 'monitor' | 'window' | 'browser' | 'camera' | 'obs' | '';

export interface Activity {
  /** De onde vem a imagem: tela inteira, janela, aba, câmera ou OBS. */
  surface: Surface;
  /** Nome do que está passando (jogo, programa), dito por quem transmite. Pode ser vazio. */
  name: string;
}

export const ACTIVITY_ATTR = 'act';
const MAX_NAME = 40;

export function cleanName(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

export function encodeActivity(a: Activity | null): string {
  return a === null ? '' : JSON.stringify({ s: a.surface, n: cleanName(a.name) });
}

export function parseActivity(raw: string | undefined): Activity | null {
  if (raw === undefined || raw === '') return null;
  try {
    const v = JSON.parse(raw) as { s?: unknown; n?: unknown };
    const s = typeof v.s === 'string' && ['monitor', 'window', 'browser', 'camera', 'obs'].includes(v.s) ? (v.s as Surface) : '';
    return { surface: s, name: typeof v.n === 'string' ? cleanName(v.n) : '' };
  } catch {
    return null;
  }
}

/**
 * Nome legível no rótulo da faixa capturada. O Firefox põe ali o título da janela; o Chrome põe um
 * código interno ("window:1234:0", "screen:0:0", "web-contents-media-stream://…"), que não serve.
 */
export function nameFromLabel(label: string): string {
  const l = label.trim();
  if (l === '' || /^(screen|window|tab|web-contents-media-stream)[:/]/i.test(l) || /^[0-9a-f:-]{16,}$/i.test(l)) return '';
  return cleanName(l);
}

/** Uma linha curta: "Fortnite", ou de onde vem se a pessoa não disse o nome. */
export function activityLine(a: Activity | null): string {
  if (a === null) return '';
  if (a.name !== '') return a.name;
  switch (a.surface) {
    case 'monitor':
      return 'tela inteira';
    case 'window':
      return 'uma janela';
    case 'browser':
      return 'uma aba';
    case 'camera':
      return 'câmera';
    case 'obs':
      return 'pelo OBS';
    default:
      return '';
  }
}

const RECENT_KEY = 'noveau.activities';

/** Últimos nomes usados, para escolher com um clique da próxima vez. */
export function recentActivities(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}

export function rememberActivity(name: string) {
  const n = cleanName(name);
  if (n === '') return;
  const list = [n, ...recentActivities().filter((x) => x.toLowerCase() !== n.toLowerCase())].slice(0, 6);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* sem armazenamento: só não lembra */
  }
}
