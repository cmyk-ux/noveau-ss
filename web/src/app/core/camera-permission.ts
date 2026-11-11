// Pedir a câmera e o microfone do celular do jeito que os navegadores aceitam.
//
// O que fazia o pedido "fechar rápido ou nem aparecer":
// - O pedido saía depois de conectar na sala (fora de um toque). No Chrome, pedido de câmera sem
//   toque vira só um ícone ao lado do endereço, que some sozinho em segundos (permission chip).
//   Com um toque, abre a janela de permissão de verdade.
// - Navegador de dentro de app (Discord, WhatsApp, Instagram…): no Android, o WebView só mostra o
//   pedido se o app programou isso, e muitos não programaram: a câmera é negada na hora, sem
//   janela nenhuma. No iPhone funciona em alguns apps, mas o pedido volta toda vez.
// - Depois de negar uma vez, o navegador não pergunta mais: só liberando nos ajustes do site.

export type Platform = 'android' | 'ios' | 'other';
export type PermState = 'granted' | 'denied' | 'prompt' | 'unknown';

export function platform(): Platform {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1))
    return 'ios';
  return 'other';
}

const IN_APP: [RegExp, string][] = [
  [/Discord/i, 'Discord'],
  [/WhatsApp/i, 'WhatsApp'],
  [/Instagram/i, 'Instagram'],
  [/FBAN|FBAV|FB_IAB|FBIOS|Messenger/i, 'Facebook'],
  [/musical_ly|TikTok|Bytedance/i, 'TikTok'],
  [/Telegram/i, 'Telegram'],
  [/\bLine\//i, 'LINE'],
  [/Twitter|XApp/i, 'X'],
  [/Snapchat/i, 'Snapchat'],
];

/** Navegador de dentro de algum app (não o Chrome/Safari de verdade). Devolve o nome, se souber. */
export function inAppBrowser(): string | null {
  const ua = navigator.userAgent;
  for (const [re, name] of IN_APP) if (re.test(ua)) return name;
  // WebView genérico do Android ("; wv)") e do iPhone (sem o "Safari/" no fim).
  if (/Android/i.test(ua) && /; wv\)/.test(ua)) return 'um app';
  if (platform() === 'ios' && !/Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua))
    return 'um app';
  return null;
}

/** Link que abre esta mesma página no Chrome do Android (saindo do navegador do app). */
export function chromeIntentUrl(): string {
  const { host, pathname, search, hash } = location;
  return `intent://${host}${pathname}${search}${hash}#Intent;scheme=https;package=com.android.chrome;end`;
}

async function query(name: string): Promise<PermState> {
  try {
    const s = await navigator.permissions.query({ name: name as PermissionName });
    return s.state;
  } catch {
    return 'unknown';
  }
}

/** Como estão as permissões de câmera e microfone deste site (nem todo navegador sabe dizer). */
export async function mediaPermission(): Promise<{ camera: PermState; mic: PermState }> {
  const [camera, mic] = await Promise.all([query('camera'), query('microphone')]);
  return { camera, mic };
}

export type AskResult =
  | { ok: true; video: boolean; audio: boolean }
  | {
      ok: false;
      reason: 'denied' | 'dismissed' | 'busy' | 'none' | 'unsupported' | 'other';
      detail: string;
    };

function stop(s: MediaStream) {
  for (const t of s.getTracks()) t.stop();
}

/**
 * Pede câmera e microfone juntos (uma janela só). Tem que ser chamado direto do toque, sem nada
 * esperando antes: é o toque que faz o navegador abrir a janela de permissão.
 * A captura é solta logo depois; a sala liga a câmera de novo sem perguntar (já está liberada).
 * Com micOnly (celular como microfone), pede só o microfone: a câmera nem acende.
 */
export async function askCameraAndMic(micOnly = false): Promise<AskResult> {
  if (navigator.mediaDevices?.getUserMedia === undefined)
    return { ok: false, reason: 'unsupported', detail: '' };
  try {
    stop(
      await navigator.mediaDevices.getUserMedia(
        micOnly ? { audio: true } : { video: { facingMode: 'environment' }, audio: true },
      ),
    );
    return { ok: true, video: !micOnly, audio: true };
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    // Aparelho sem microfone (ou sem câmera): tenta só o que tem.
    if (micOnly && name === 'NotFoundError') return { ok: false, reason: 'none', detail: name };
    if (!micOnly && (name === 'NotFoundError' || name === 'OverconstrainedError')) {
      for (const c of [{ video: true }, { audio: true }] as MediaStreamConstraints[]) {
        try {
          stop(await navigator.mediaDevices.getUserMedia(c));
          return { ok: true, video: c.video === true, audio: c.audio === true };
        } catch {
          /* tenta o próximo */
        }
      }
      return { ok: false, reason: 'none', detail: name };
    }
    if (name === 'NotReadableError' || name === 'AbortError')
      return { ok: false, reason: 'busy', detail: name };
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      // Fechou a janela sem escolher (continua "perguntar") ou negou de vez?
      const p = await mediaPermission();
      const dismissed = micOnly ? p.mic === 'prompt' : p.camera === 'prompt' || p.mic === 'prompt';
      return { ok: false, reason: dismissed ? 'dismissed' : 'denied', detail: name };
    }
    return {
      ok: false,
      reason: 'other',
      detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }
}
