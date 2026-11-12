// H.264 na placa de vídeo de verdade.
//
// O Chrome (e todo navegador feito dele: Brave, Edge, Opera) só manda H.264 para a placa de vídeo nos
// perfis Baseline (42001f), Main (4d001f) e High (6400xx). O perfil "Constrained Baseline" (42e01f) vai
// sempre para o OpenH264, no processador, numa thread só: no Windows e no Mac nenhuma placa recebe esse
// perfil (no Chromium, kPlatformH264CbpEncoding vem desligado no Windows e nem existe no Mac).
//
// O servidor do LiveKit, quando a tela sai em H.264, responde com o 42e01f antes de qualquer outro
// perfil. Conferido com o livekit-server 1.13.11 (o mesmo do servidor): sem nada, a resposta começa
// com 42e01f e o navegador codifica no processador. O teste do navegador para saber se o H.264 roda na
// placa também perguntava pelo 42e01f (é o perfil que vale quando não se diz nenhum), então a
// resposta era sempre "não", e o automático caía no VP8 por software.
//
// Aqui: na hora de criar a faixa de envio de vídeo, dizemos ao navegador quais perfis de H.264 oferecer
// (setCodecPreferences): High primeiro (se existir, ele só aparece quando a placa codifica), depois
// Baseline. O 42e01f sai da oferta. O LiveKit aceita os dois (o High é um dos perfis dele; o Baseline
// ele aceita pelo nome do codec, conferido no 1.13.11), e o navegador passa a usar o encoder da placa
// (NVENC, AMF, Quick Sync; no getStats aparece como "MediaFoundationVideoEncodeAccelerator" ou
// "D3D12VideoEncodeAccelerator"). Os outros codecs (VP8, VP9, AV1, H.265) não mudam.
//
// Quem assiste: o LiveKit entrega o vídeo no H.264 que essa pessoa negociou, mesmo com outro perfil
// (pkg/sfu/utils/helpers.go, CodecParametersFuzzySearch: se o perfil não bate, casa só pelo nome), e o
// decodificador lê o perfil do próprio vídeo. Chrome, Edge, Brave e Safari decodificam High e Baseline.
// O Firefox decodifica H.264 de chamada com o OpenH264, que desde a 1.5 aceita o "Constrained High"
// (CABAC e 8x8, sem quadros B). É o que os codificadores de chamada mandam: nenhum usa quadro B.
// (Bugzilla 1411681: câmera mandando High com SDP 42e01f, corrigido no Firefox 65.)

const PROFILE = /profile-level-id=([0-9a-f]{6})/i;
const MODE1 = /packetization-mode=1/;

function isH264(c: RTCRtpCodec): boolean {
  return c.mimeType.toLowerCase() === 'video/h264';
}

function profileOf(c: RTCRtpCodec): string {
  return (PROFILE.exec(c.sdpFmtpLine ?? '')?.[1] ?? '').toLowerCase();
}

/** High (6400xx): o perfil que só aparece no envio quando existe encoder de H.264 na placa. */
function isHigh(c: RTCRtpCodec): boolean {
  return profileOf(c).startsWith('6400');
}

/** Baseline sem a marca de "constrained" (42001f): a placa codifica; o OpenH264 também, se a placa falhar. */
function isPlainBaseline(c: RTCRtpCodec): boolean {
  return profileOf(c).startsWith('4200');
}

/**
 * Só em navegador feito do Chromium. O Safari codifica o 42e01f na placa (VideoToolbox) e o Firefox só
 * tem o OpenH264 com esse perfil: nos dois, mexer na oferta só atrapalha.
 */
export function chromiumBased(): boolean {
  const ua = navigator.userAgent;
  return /(Chrome|Chromium|Edg)\//.test(ua) && !/Firefox\//.test(ua);
}

function senderCodecs(): RTCRtpCodec[] {
  return (typeof RTCRtpSender !== 'undefined' && RTCRtpSender.getCapabilities?.('video')?.codecs) || [];
}

function receiverCodecs(): RTCRtpCodec[] {
  return (typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities?.('video')?.codecs) || [];
}

/** Perfis de H.264 que vão para a placa, na ordem de preferência (o primeiro é o que vai ser usado). */
function wantedH264(list: RTCRtpCodec[]): RTCRtpCodec[] {
  const rank = (c: RTCRtpCodec) => (isHigh(c) ? 0 : 2) + (MODE1.test(c.sdpFmtpLine ?? '') ? 0 : 1);
  return list.filter((c) => isH264(c) && (isHigh(c) || isPlainBaseline(c))).sort((a, b) => rank(a) - rank(b));
}

/**
 * O perfil de H.264 que vai ser negociado, no formato do teste de capacidade do navegador
 * (Media Capabilities, tipo "webrtc"). null = este navegador não tem perfil que vá para a placa.
 */
export function h264ContentTypes(): string[] {
  if (!chromiumBased()) return ['video/H264'];
  const send = wantedH264(senderCodecs()).filter((c) => MODE1.test(c.sdpFmtpLine ?? ''));
  const types = send.map((c) => `video/H264;${(c.sdpFmtpLine ?? '').replace(/\s+/g, '')}`);
  // Sem nenhum (não deveria acontecer no Chromium): o teste antigo, que responde pelo 42e01f.
  return types.length > 0 ? types : ['video/H264'];
}

/** Para quem assiste: decodifica o que vamos mandar (High ou Baseline). */
export function h264DecodeTypes(): string[] {
  return [
    'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f',
    'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f',
    'video/H264',
  ];
}

const same = (a: RTCRtpCodec, b: RTCRtpCodec) =>
  a.mimeType.toLowerCase() === b.mimeType.toLowerCase() &&
  (a.sdpFmtpLine ?? '') === (b.sdpFmtpLine ?? '') &&
  a.clockRate === b.clockRate &&
  (a.channels ?? 0) === (b.channels ?? 0);

/**
 * A lista de codecs para uma faixa de envio de vídeo: tudo o que o navegador tem, com o H.264 só nos
 * perfis da placa (High, depois Baseline). Devolve null se não há o que mudar.
 */
function preferenceList(base: RTCRtpCodec[], extra: RTCRtpCodec[]): RTCRtpCodec[] | null {
  // Sem repetidos: a lista do navegador pode trazer o mesmo codec duas vezes (decodificador da placa e
  // do processador). Repetido na preferência, o Chrome dá o mesmo número aos dois e recusa a oferta.
  const all: RTCRtpCodec[] = [];
  for (const c of [...base, ...extra]) if (!all.some((x) => same(x, c))) all.push(c);
  const h264 = wantedH264(all);
  if (h264.length === 0 || !all.some((c) => isH264(c) && !isHigh(c) && !isPlainBaseline(c))) return null;
  return [...h264, ...all.filter((c) => !isH264(c))];
}

let installed = false;
let applied = 0;
let refused = 0;

/** Quantas faixas de vídeo saíram com H.264 da placa na oferta (para o diagnóstico). */
export function h264PreferenceStatus(): { applied: number; refused: number } {
  return { applied, refused };
}

/** Faixas em que mexemos: se o navegador recusar a oferta por causa disso, voltam ao padrão. */
const touched = new WeakSet<RTCRtpTransceiver>();
/**
 * Depois de uma recusa, para de mexer, e lembra disso neste navegador (até o site mudar a versão da
 * regra): a próxima tentativa já sai sem preferência.
 */
const OFF_KEY = 'noveau:h264-pref-off';
const OFF_VERSION = '2';
let disabled = readOff();
/** Enquanto o teste em uma conexão de mentira não terminou ou falhou, não mexe. */
let verified = false;

function readOff(): boolean {
  try {
    return localStorage.getItem(OFF_KEY) === OFF_VERSION;
  } catch {
    return false;
  }
}

function turnOff(reason: unknown) {
  disabled = true;
  console.warn('[h264] preferência de codec desligada neste navegador:', reason);
  try {
    localStorage.setItem(OFF_KEY, OFF_VERSION);
  } catch {
    /* só nesta página */
  }
}

/**
 * Antes de usar de verdade: uma conexão sem rede, com uma faixa de vídeo de envio com a preferência, faz
 * duas ofertas (a segunda depois de fixar a primeira, como numa renegociação). Se o navegador recusar
 * qualquer uma, ou se a oferta sair com um número de payload repetido, não usamos a preferência.
 */
async function preflight(): Promise<void> {
  const pc = new RTCPeerConnection();
  try {
    const tr = pc.addTransceiver('video', { direction: 'sendonly' });
    const list = preferenceList(receiverCodecs(), []);
    if (list === null || typeof tr.setCodecPreferences !== 'function') return;
    tr.setCodecPreferences(list);
    for (let round = 0; round < 2; round++) {
      const offer = await pc.createOffer();
      const pts = [...(offer.sdp ?? '').matchAll(/^a=rtpmap:(\d+) /gm)].map((m) => m[1]);
      if (new Set(pts).size !== pts.length) throw new Error('payload repetido na oferta');
      if (!/profile-level-id=(6400|4200)/i.test(offer.sdp ?? '')) throw new Error('perfil da placa ausente na oferta');
      await pc.setLocalDescription(offer);
    }
    verified = true;
  } catch (e) {
    turnOff(e);
  } finally {
    pc.close();
  }
}

function prefer(tr: RTCRtpTransceiver) {
  if (disabled || !verified || typeof tr.setCodecPreferences !== 'function') return;
  const send = senderCodecs();
  const recv = receiverCodecs();
  // Só os codecs de recebimento, reordenados. Misturar os de envio (ex.: H.264 High 640034 da placa, que
  // no recebimento aparece como 64001f) passava no setCodecPreferences, mas o Chrome dava o mesmo número
  // de payload a dois codecs e o createOffer falhava ("Duplicate payload type in codec list"): a tela
  // não abria. O nível do perfil não importa para escolher o codificador da placa (só o perfil).
  const attempts = [preferenceList(recv, [])];
  const sendMimes = new Set(send.filter((c) => !/rtx|red|ulpfec|flexfec/i.test(c.mimeType)).map((c) => c.mimeType.toLowerCase()));
  for (const list of attempts) {
    if (list === null) continue;
    // Não deixa sumir um codec que o navegador sabe mandar (ex.: H.265 só no envio): sem ele, publicar
    // nesse codec quebraria.
    const mimes = new Set(list.map((c) => c.mimeType.toLowerCase()));
    if ([...sendMimes].some((m) => !mimes.has(m))) continue;
    try {
      tr.setCodecPreferences(list);
      touched.add(tr);
      applied++;
      return;
    } catch {
      /* próxima tentativa */
    }
  }
  refused++;
}

/**
 * Liga a preferência para toda faixa de vídeo que este navegador for publicar (tela, reserva da tela,
 * câmera). Chamar uma vez, antes de entrar na sala.
 */
export function installH264Preference() {
  if (installed || typeof RTCPeerConnection === 'undefined' || !chromiumBased()) return;
  installed = true;
  const original = RTCPeerConnection.prototype.addTransceiver;
  const createOffer = RTCPeerConnection.prototype.createOffer;
  if (!disabled) void preflight();
  RTCPeerConnection.prototype.addTransceiver = function (
    this: RTCPeerConnection,
    trackOrKind: MediaStreamTrack | string,
    init?: RTCRtpTransceiverInit,
  ): RTCRtpTransceiver {
    const tr = original.call(this, trackOrKind, init);
    const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
    if (kind === 'video' && typeof trackOrKind !== 'string' && init?.direction === 'sendonly') {
      try {
        prefer(tr);
      } catch {
        /* fica o padrão do navegador */
      }
    }
    return tr;
  } as typeof RTCPeerConnection.prototype.addTransceiver;

  // Rede de segurança: se o navegador recusar a oferta por causa da lista de codecs (já aconteceu:
  // "Duplicate payload type in codec list"), devolve as faixas ao padrão e tenta de novo. A tela abre
  // com o H.264 que o navegador escolher, em vez de não abrir.
  RTCPeerConnection.prototype.createOffer = async function (this: RTCPeerConnection, ...args: unknown[]) {
    const call = () => (createOffer as (...a: unknown[]) => Promise<RTCSessionDescriptionInit>).apply(this, args);
    if (typeof args[0] === 'function') return call();
    try {
      return await call();
    } catch (e) {
      const ours = this.getTransceivers().filter((t) => touched.has(t));
      if (ours.length === 0) throw e;
      turnOff(e);
      refused++;
      // Volta ao padrão todas as faixas desta conexão, não só as nossas.
      for (const t of this.getTransceivers()) {
        touched.delete(t);
        if (t.currentDirection === 'stopped') continue;
        try {
          t.setCodecPreferences([]);
        } catch {
          /* segue */
        }
      }
      return call();
    }
  } as typeof RTCPeerConnection.prototype.createOffer;
}
