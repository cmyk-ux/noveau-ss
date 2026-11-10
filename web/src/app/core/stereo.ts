// Som em estéreo para tudo que chega da sala.
//
// O Chrome só decodifica Opus em estéreo se a descrição LOCAL (a resposta que o navegador dá ao
// servidor) tiver "stereo=1"; sem isso, junta os dois canais em mono. O livekit-client só põe
// "stereo=1" nas faixas que o servidor marca como estéreo, e o LiveKit não marca o som que chega
// por WHIP (OBS): ele cria a faixa sem essa informação. Resultado: o som do OBS, que sai em
// estéreo, chegaria em mono para quem assiste.
//
// Aqui pedimos estéreo para todo Opus que recebemos. Quem manda em mono continua igual (o
// decodificador só repete o canal), e nada muda no que este navegador envia.

const OPUS_RTPMAP = /^a=rtpmap:(\d+) opus\/48000/gim;

export function preferStereoReceive(sdp: string): string {
  const pts = [...sdp.matchAll(OPUS_RTPMAP)].map((m) => m[1]);
  if (pts.length === 0) return sdp;
  return sdp
    .split('\r\n')
    .map((line) => {
      const m = /^a=fmtp:(\d+) (.*)$/.exec(line);
      if (m === null || !pts.includes(m[1])) return line;
      const params = m[2].split(';').map((p) => p.trim());
      if (params.includes('stereo=1')) return line;
      return `a=fmtp:${m[1]} ${[...params.filter((p) => p !== 'stereo=0'), 'stereo=1'].join(';')}`;
    })
    .join('\r\n');
}

let installed = false;

/** Troca o setLocalDescription das respostas (answer) por uma versão com estéreo. */
export function installStereoReceive() {
  if (installed || typeof RTCPeerConnection === 'undefined') return;
  installed = true;
  const original = RTCPeerConnection.prototype.setLocalDescription as (this: RTCPeerConnection, ...args: unknown[]) => Promise<void>;
  RTCPeerConnection.prototype.setLocalDescription = function (this: RTCPeerConnection, ...args: unknown[]) {
    const desc = args[0] as RTCLocalSessionDescriptionInit | undefined;
    if (desc?.type === 'answer' && typeof desc.sdp === 'string') {
      args[0] = { type: desc.type, sdp: preferStereoReceive(desc.sdp) };
    }
    return original.apply(this, args);
  } as typeof RTCPeerConnection.prototype.setLocalDescription;
}
