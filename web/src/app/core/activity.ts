// De onde vem a imagem de quem transmite (tela inteira, janela, aba, câmera, OBS), para o selo
// "ao vivo" da sala. Vai num atributo do participante ("act"), então chega a todos sem mensagem
// extra e some sozinho quando a pessoa sai da sala.

export type Surface = 'monitor' | 'window' | 'browser' | 'camera' | 'obs' | '';

export interface Activity {
  surface: Surface;
  /**
   * A janela transmitida parou de mandar imagem (minimizada, alt-tab num jogo em tela cheia, jogo que
   * para de desenhar fora de foco). Quem assiste vê "transmissão pausada". Ver pause-watch.ts.
   */
  paused?: boolean;
}

export const ACTIVITY_ATTR = 'act';

export function encodeActivity(a: Activity | null): string {
  return a === null ? '' : JSON.stringify(a.paused === true ? { s: a.surface, p: 1 } : { s: a.surface });
}

export function parseActivity(raw: string | undefined): Activity | null {
  if (raw === undefined || raw === '') return null;
  try {
    const v = JSON.parse(raw) as { s?: unknown; p?: unknown };
    const s = typeof v.s === 'string' && ['monitor', 'window', 'browser', 'camera', 'obs'].includes(v.s) ? (v.s as Surface) : '';
    return v.p === 1 ? { surface: s, paused: true } : { surface: s };
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
