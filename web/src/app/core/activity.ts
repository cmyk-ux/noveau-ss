// De onde vem a imagem de quem transmite (tela inteira, janela, aba, câmera, OBS), para o selo
// "ao vivo" da sala. Vai num atributo do participante ("act"), então chega a todos sem mensagem
// extra e some sozinho quando a pessoa sai da sala.

export type Surface = 'monitor' | 'window' | 'browser' | 'camera' | 'obs' | '';

export interface Activity {
  surface: Surface;
}

export const ACTIVITY_ATTR = 'act';

export function encodeActivity(a: Activity | null): string {
  return a === null ? '' : JSON.stringify({ s: a.surface });
}

export function parseActivity(raw: string | undefined): Activity | null {
  if (raw === undefined || raw === '') return null;
  try {
    const v = JSON.parse(raw) as { s?: unknown };
    const s = typeof v.s === 'string' && ['monitor', 'window', 'browser', 'camera', 'obs'].includes(v.s) ? (v.s as Surface) : '';
    return { surface: s };
  } catch {
    return null;
  }
}

/** Uma linha curta dizendo de onde vem a imagem. */
export function activityLine(a: Activity | null): string {
  switch (a?.surface) {
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
