// Que tipo de aparelho é este. Celular entra na sala marcado como "mobile" (ícone de celular
// para os outros) e ganha um jeito de usar pensado para o toque.

interface UAData {
  mobile?: boolean;
}

function detect(): boolean {
  const nav = navigator as Navigator & { userAgentData?: UAData };
  if (typeof nav.userAgentData?.mobile === 'boolean' && nav.userAgentData.mobile) return true;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPod|Mobile|Windows Phone/i.test(ua)) return true;
  // iPad no iPadOS se apresenta como Mac; o que entrega é ter toque.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

export const IS_MOBILE = detect();
/** iPhone/iPad: sem tela cheia em elementos (só no próprio vídeo) e sem trava de orientação. */
export const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
export const DEVICE: 'mobile' | 'desktop' = IS_MOBILE ? 'mobile' : 'desktop';
