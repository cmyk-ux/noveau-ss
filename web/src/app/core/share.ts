// Publicar a tela (e o som dela) no LiveKit com as configurações escolhidas.
import { PauseWatch } from './pause-watch';
import { captureRateFor } from './monitor';
import {
  BackupCodecPolicy,
  LocalAudioTrack,
  LocalTrack,
  LocalVideoTrack,
  Room,
  Track,
  type TrackPublishOptions,
} from 'livekit-client';
import { Codec, CodecChoice, cappedBitrate, encoderProbes, hardwareOnly, LADDER, parseDecoders, pickCodec, planSize, probeEncoders, StreamPlan, Size } from './stream';
import { CAPTURE_MAX, LoadGovernor, LoadState } from './load';
import { UploadGuard, UploadState } from './upload-guard';
import { ShareHealth, ShareWatch, StatsFeed, sourceAudioLevel } from './stats';
import { StudioBits, StudioSender } from './studio';
import { CodecGuard } from './codec-guard';
import { ShrinkEvent, ShrinkGuard } from './shrink-guard';

/** Envio do som em modo estúdio (sem compressão), se estiver ativo. */
let studio: StudioSender | null = null;

function stopStudio() {
  studio?.stop();
  studio = null;
}

export class ScreenShareCancelledError extends Error {
  constructor() {
    super('Screen share cancelled.');
    this.name = 'ScreenShareCancelledError';
  }
}

export interface ShareRequest {
  plan: StreamPlan;
  preferredCodec: CodecChoice;
  includeAudio: boolean;
  maxCompatibility: boolean;
  /** Som sem compressão (PCM) em vez de Opus; null = Opus normal. */
  studio: StudioBits | null;
  /** Baixar fps/resolução sozinho quando o processador do PC aperta (jogo pesado). */
  adaptToLoad: boolean;
  /** Aba em que o seletor do navegador abre (padrão: janelas). */
  surface?: 'window' | 'monitor' | 'browser';
}

export interface ShareCallbacks {
  onEndedByBrowser: () => void;
  onHealth: (h: ShareHealth) => void;
  onSilentAudio: () => void;
  /** Mudou o degrau de qualidade por causa do uso do PC. */
  onLoad: (s: LoadState) => void;
  /** Teto de bitrate por perda na subida. */
  onUpload: (s: UploadState) => void;
  /** O codec saía no processador e trocamos para um da placa de vídeo. */
  onCodecSwitch?: (s: CodecSwitch) => void;
  /** O navegador encolheu a tela sozinho com bits de sobra; passou para "manter resolução". */
  onShrinkFix?: (e: ShrinkEvent) => void;
  /** A janela transmitida parou de mandar imagem (minimizada, alt-tab) ou voltou. */
  onPaused?: (paused: boolean) => void;
}

export interface CodecSwitch {
  from: Codec;
  /** Implementação que o navegador contou (ex.: OpenH264, libvpx). */
  encoder: string;
  to: Codec;
  bitrate: number;
}

export interface ShareResult {
  codec: Codec;
  bitrate: number;
  resolution: Size;
  audio: 'published' | 'refused' | 'not-requested';
  watch: ShareWatch;
  governor: LoadGovernor;
  upload: UploadGuard;
  /** Vigia que troca de codec se o navegador codificar no processador. */
  guard: CodecGuard;
  /** Vigia que desfaz o encolhimento da imagem pelo controle de qualidade do navegador. */
  shrink: ShrinkGuard;
  /** Codec escolhido roda na placa de vídeo (segundo o navegador). */
  gpu: boolean;
  /** 'monitor' (tela inteira), 'window' (janela) ou 'browser' (aba). */
  surface?: string;
  /** Vigia de "transmissão pausada" (janela minimizada). */
  pause: PauseWatch;
}

/**
 * Opções do getDisplayMedia. Chamamos o navegador direto (e não o createLocalScreenTracks do
 * livekit-client) porque o livekit-client 2.22 descarta windowAudio, e o Cenaculum original
 * mandava windowAudio: 'system', o que fazia uma janela compartilhada levar o som do PC
 * inteiro (Discord junto).
 *
 * - windowAudio: 'window' (Chrome/Edge 141+): ao escolher uma janela, o navegador oferece
 *   "compartilhar o áudio deste app", só o som do programa daquela janela.
 * - systemAudio: 'include': ao escolher a tela inteira, ainda dá para mandar o som do sistema
 *   (aí vai tudo, inclusive o Discord; o navegador não consegue separar).
 * - restrictOwnAudio (Chrome 140+, Windows/macOS): tira do som do sistema o que esta própria
 *   página toca, ou seja, as vozes da sala não voltam para quem está assistindo.
 *
 * Imagem: sempre no tamanho original da tela ou janela, qualquer que seja o teto escolhido. O teto
 * (720p/1080p/1440p, ou o Auto acima de 60 fps) é aplicado no codificador (EncoderScale). Motivo: o
 * Chrome captura numa thread que ele limita a meio núcleo (desktop_capture_device.cc: espera o dobro
 * do tempo que o quadro levou). Com um teto na captura, essa thread converte a tela inteira e depois
 * ainda reduz (libyuv ARGBToI420 + I420Scale), ou seja, mais trabalho por quadro e menos quadros por
 * segundo, principalmente com o jogo disputando o processador. No tamanho original ela só converte.
 */
function displayMediaOptions(req: ShareRequest): DisplayMediaStreamOptions {
  const audio: MediaTrackConstraints | false = req.includeAudio
    ? ({
        channelCount: 2,
        sampleRate: 48e3,
        // Som cru: sem cancelamento de eco, supressão de ruído ou ganho automático.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        restrictOwnAudio: true,
        suppressLocalAudioPlayback: false,
      } as MediaTrackConstraints)
    : false;
  return {
    // Só um teto bem alto: o Chrome entrega o tamanho original de qualquer monitor ou janela (sem
    // teto, ele usaria o tamanho da tela onde está o navegador e reduziria um monitor maior).
    // A captura pede o divisor do monitor logo acima do pedido (144 Hz: 72 para mandar 60; ver
    // monitor.ts); o codificador continua com teto no pedido (maxFramerate em videoPublishOptions).
    // O seletor abre na aba de janelas. No Windows 11 24H2+ a captura de TELA INTEIRA do Chromium fica
    // presa a ~48 fps num monitor de 144 Hz (60 num de 240), seja qual for o pedido e com qualquer flag;
    // a de JANELA acompanha o monitor (medido no PC do Pedro em 12/11/2026: tela 48,1 fps, janela 144,1,
    // 1920x1080, Brave 157). A tela inteira continua no seletor. Ver DESEMPENHO.md, "Nona rodada".
    video: {
      width: { max: CAPTURE_MAX.width },
      height: { max: CAPTURE_MAX.height },
      frameRate: captureRateFor(req.plan.frameRate),
      displaySurface: req.surface ?? 'window',
    },
    audio,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'include',
    ...(req.includeAudio
      ? // audioSelection 'preferred' (Chrome 153+): a chave de áudio já vem LIGADA no seletor,
        // para tela inteira e janela. Navegador mais antigo ignora.
        { systemAudio: 'include', windowAudio: 'window', audioSelection: 'preferred' }
      : { systemAudio: 'exclude', windowAudio: 'exclude' }),
  } as unknown as DisplayMediaStreamOptions;
}

/**
 * Camadas de tempo (L1T3) no VP8: os quadros se dividem em 3 níveis e só 1 a cada 4 serve de base
 * para os próximos. Se um pacote se perde num quadro que não é base, o navegador de quem assiste só
 * pula aquele quadro (1/60 s) e segue; sem camadas, todo quadro depende do anterior e qualquer
 * perda não recuperada congela a imagem até chegar um quadro-chave (~0,5-1 s). O livekit-client só
 * liga isso para VP9/AV1, então ligamos direto no RTCRtpSender. Custa ~10% de eficiência.
 */
async function addTemporalLayers(track: LocalVideoTrack) {
  const sender = (track as unknown as { sender?: RTCRtpSender }).sender;
  if (sender === undefined) return;
  const params = sender.getParameters();
  let changed = false;
  for (const e of params.encodings ?? []) {
    const mode = (e as RTCRtpEncodingParameters & { scalabilityMode?: string }).scalabilityMode;
    if (mode === undefined || mode === 'L1T1') {
      (e as RTCRtpEncodingParameters & { scalabilityMode?: string }).scalabilityMode = 'L1T3';
      changed = true;
    }
  }
  if (changed) await sender.setParameters(params).catch((e) => console.warn('[tela] camadas de tempo recusadas:', e));
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Quanto reduzir a captura (tamanho original) para caber no teto escolhido. 1 = sem reduzir. */
function capScale(capture: Size, plan: StreamPlan): number {
  if (plan.resolution === 'auto' || plan.resolution === 'source') return 1;
  const cap = LADDER[plan.resolution];
  return Math.max(1, capture.width / cap.width, capture.height / cap.height);
}

function scaled(size: Size, factor: number): Size {
  return { width: even(size.width / factor), height: even(size.height / factor) };
}

/** A cópia menor (simulcast) sai com 2/3 do tamanho da de cima (ver videoPublishOptions). */
const LOW_LAYER_RATIO = 1.5;

/**
 * Redução de tamanho no codificador (scaleResolutionDownBy), para todos os envios da tela: o
 * principal e a reserva (backupCodec), que o LiveKit cria sozinho quando alguém precisa. A camada
 * de cima vai para o teto escolhido e a de baixo para 2/3 dela, sempre contados do tamanho REAL que a
 * captura está entregando (media-source no getStats). Antes o teto vinha do primeiro quadro e a cópia
 * menor da conta do LiveKit na hora de publicar; se a captura mudasse de tamanho (janela redimensionada,
 * troca de superfície, primeiro quadro diferente) as escalas ficavam erradas para sempre.
 * Com o PC apertado (LoadGovernor), todas reduzem junto.
 */
class EncoderScale {
  private load = 1;
  private cap: number;

  constructor(
    private readonly track: LocalVideoTrack,
    private readonly plan: StreamPlan,
    first: Size,
  ) {
    this.cap = capScale(first, plan);
  }

  /** Tamanho que a captura entrega agora (da leitura de 2 s): refaz o teto se mudou. */
  setSource(report: RTCStatsReport) {
    for (const s of report.values()) {
      if (s.type !== 'media-source' || s.kind !== 'video') continue;
      const w = Number(s.width);
      const h = Number(s.height);
      if (w > 0 && h > 0) this.cap = capScale({ width: w, height: h }, this.plan);
      return;
    }
  }

  setLoad(factor: number) {
    this.load = factor;
    this.apply();
  }

  /** Confere e acerta. Barato (getParameters não vai ao navegador de fora): roda a cada leitura. */
  apply() {
    const senders: RTCRtpSender[] = [];
    if (this.track.sender !== undefined) senders.push(this.track.sender);
    const extra = (this.track as unknown as { simulcastCodecs?: Map<string, { sender?: RTCRtpSender }> }).simulcastCodecs;
    for (const [, info] of extra ?? []) if (info.sender !== undefined) senders.push(info.sender);
    for (const sender of senders) {
      const params = sender.getParameters();
      const encodings = params.encodings ?? [];
      if (encodings.length === 0) continue;
      const last = encodings.length - 1;
      let changed = false;
      encodings.forEach((e, i) => {
        const want = Math.max(1, this.cap * LOW_LAYER_RATIO ** (last - i) * this.load);
        if (Math.abs((e.scaleResolutionDownBy ?? 1) - want) < 0.01) return;
        e.scaleResolutionDownBy = want;
        changed = true;
      });
      if (changed) void sender.setParameters(params).catch(() => undefined);
    }
  }
}

function videoPublishOptions(req: ShareRequest, codec: Codec, maxBitrate: number): TrackPublishOptions {
  // H.265 só toca em quem tem decodificador de hardware; AV1/VP9 em navegadores antigos podem falhar.
  // Com REGRESSION a reserva só é codificada se alguém da sala não conseguir decodificar. Ela sai na
  // resolução cheia, então se cair no processador o jogo de quem transmite perde FPS no instante em
  // que essa pessoa entra (era o "do nada"). Por isso o H.265 ficou por último no automático e a
  // reserva é H.264 quando a placa codifica H.264. O CodecGuard confere o codificador de verdade.
  const needsBackup = codec === 'h265' || ((codec === 'av1' || codec === 'vp9') && req.maxCompatibility);
  // A reserva é H.264 quando a placa codifica H.264: quem não decodifica o principal (iPhone, Firefox)
  // recebe H.264 da placa, sem custo para o jogo. Só sem placa para H.264 ela volta a ser VP8.
  // (Antes a sondagem nunca via o H.264 na placa e a reserva era sempre VP8 por software, em resolução
  // cheia: quando ela ligava, a sala inteira passava para ela. Ver h264.ts.)
  const backup = encoderProbes().h264?.gpu === true ? 'h264' : 'vp8';
  // Uma camada só, como era no começo (quando a tela chegava "quase original" a 60 fps). A cópia menor
  // (simulcast, 2/3 do tamanho) fazia o servidor mandar 720p para quem a estimativa de banda dele não
  // alcançava a camada de cima: medido aqui mesmo, sem limite nenhum de rede, quem assistia passava os
  // primeiros ~10 s na cópia menor; num servidor pequeno ele pode nunca subir. Ver DESEMPENHO.md,
  // "Sétima rodada".
  return {
    source: Track.Source.ScreenShare,
    videoCodec: codec,
    screenShareEncoding: { maxBitrate, maxFramerate: req.plan.frameRate, priority: 'high' },
    degradationPreference: req.plan.degradation,
    simulcast: false,
    ...(needsBackup ? { backupCodec: { codec: backup }, backupCodecPolicy: BackupCodecPolicy.REGRESSION } : {}),
  } as TrackPublishOptions;
}

/**
 * Som da tela: Opus estéreo a 192 kbps, sem DTX, com RED. Antes ia a 64 kbps (o "musicStereo" do
 * LiveKit, 32 kbps por canal), abaixo do que o Opus precisa para música: a Xiph diz que 128 kbps em
 * estéreo já é "praticamente transparente" (wiki.xiph.org/Opus_Recommended_Settings); 192 dá folga
 * para música densa e jogo. Perto do vídeo da tela (muitos Mbps), é quase nada a mais de internet.
 * O "modo estúdio" (sem compressão) continua para quem precisa do som exato.
 */
export const SCREEN_AUDIO_BITRATE = 192_000;
export const SCREEN_AUDIO_PUBLISH: TrackPublishOptions = {
  source: Track.Source.ScreenShareAudio,
  audioPreset: { maxBitrate: SCREEN_AUDIO_BITRATE, priority: 'high' },
  dtx: false,
  red: true,
  forceStereo: true,
  stream: 'screen_share',
};

const SILENCE_WINDOW_MS = 6e4;
const SILENCE_POLL_MS = 1e3;

/** true se o áudio ficou completamente mudo durante a janela inteira. */
async function staysSilent(track: LocalTrack): Promise<boolean> {
  const until = performance.now() + SILENCE_WINDOW_MS;
  while (performance.now() < until) {
    await new Promise((r) => setTimeout(r, SILENCE_POLL_MS));
    const sender = track.sender;
    if (sender === undefined) return false;
    try {
      if (sourceAudioLevel(await sender.getStats()) > 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** O que cada pessoa da sala disse que decodifica na placa de vídeo (atributo "hwdec"). */
function viewersOf(room: Room): Set<string>[] {
  return [...room.remoteParticipants.values()]
    .filter((p) => p.attributes?.['phoneOf'] === undefined && p.attributes?.['obs'] !== '1')
    .map((p) => parseDecoders(p.attributes?.['hwdec']))
    .filter((d): d is Set<string> => d !== null);
}

async function settledSettings(track: MediaStreamTrack): Promise<MediaTrackSettings> {
  const until = performance.now() + 1500;
  let s = track.getSettings();
  while ((s.width === undefined || s.width === 0) && performance.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
    s = track.getSettings();
  }
  return s;
}

export async function startShare(room: Room, req: ShareRequest, cb: ShareCallbacks): Promise<ShareResult> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions(req));
  } catch (e) {
    throw e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')
      ? new ScreenShareCancelledError()
      : e;
  }
  const rawVideo = stream.getVideoTracks()[0];
  const rawAudio = stream.getAudioTracks()[0];
  if (rawVideo === undefined) {
    for (const t of stream.getTracks()) t.stop();
    throw new Error('O navegador não entregou nenhuma imagem para compartilhar.');
  }
  rawVideo.contentHint = req.plan.contentHint;
  const video = new LocalVideoTrack(rawVideo, undefined, false);
  video.source = Track.Source.ScreenShare;
  let audio: LocalAudioTrack | undefined;
  if (rawAudio !== undefined) {
    audio = new LocalAudioTrack(rawAudio, undefined, false);
    audio.source = Track.Source.ScreenShareAudio;
  }
  const surface = (rawVideo.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface;
  const settings = await settledSettings(video.mediaStreamTrack);
  const planned = planSize(req.plan);
  const resolution: Size = {
    width: settings.width !== undefined && settings.width > 0 ? settings.width : planned.width,
    height: settings.height !== undefined && settings.height > 0 ? settings.height : planned.height,
  };
  // A captura vem no tamanho original; o teto escolhido é aplicado no codificador.
  const cap = capScale(resolution, req.plan);
  const encoded = scaled(resolution, cap);
  // Com o tamanho que vai sair, pergunta ao navegador quais codecs rodam na GPU e escolhe.
  const probes = await probeEncoders(encoded, req.plan.frameRate);
  // Quem já está na sala e disse o que decodifica na placa de vídeo (atributo "hwdec").
  const codec = pickCodec(req.preferredCodec, viewersOf(room));
  const bitrate = cappedBitrate(encoded, req.plan, codec);
  // "Parar de compartilhar" do navegador. O LiveKit ouve o mesmo 'ended' (e ouviu primeiro: ele se
  // inscreveu ao criar a faixa) e já tirou a publicação do mapa quando chegamos aqui. Antes este
  // teste exigia a publicação ainda lá, então nunca passava: o som de estúdio continuava mandando
  // silêncio para sempre e o selo "estúdio 24-bit" não saía de quem assistia. 'ended' só vem do
  // navegador (track.stop() não dispara), então só ignora se outra tela já tomou o lugar desta.
  video.mediaStreamTrack.addEventListener(
    'ended',
    () => {
      const current = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
      if (current === undefined || current.mediaStreamTrack === video.mediaStreamTrack) cb.onEndedByBrowser();
    },
    { once: true },
  );
  await room.localParticipant.publishTrack(video, videoPublishOptions(req, codec, bitrate));
  if (codec === 'vp8') await addTemporalLayers(video);
  const scale = new EncoderScale(video, req.plan, resolution);
  scale.apply();
  let audioState: ShareResult['audio'] = req.includeAudio ? 'refused' : 'not-requested';
  stopStudio();
  if (audio !== undefined && req.studio !== null) {
    // Modo estúdio: o som vai pelo canal de dados, sem passar pelo Opus.
    studio = new StudioSender(room, audio.mediaStreamTrack, req.studio);
    await studio.start();
    audioState = 'published';
  } else if (audio !== undefined) {
    audio.mediaStreamTrack.contentHint = 'music';
    await room.localParticipant.publishTrack(audio, SCREEN_AUDIO_PUBLISH);
    audioState = 'published';
    void staysSilent(audio).then((silent) => {
      if (silent) cb.onSilentAudio();
    });
  }
  // Uma leitura de estatísticas a cada 2 s para os três vigias (saúde, perda na subida, codificador).
  // Depois de trocar de codec o sender muda: a leitura segue o atual.
  const feed = new StatsFeed(() => video.sender);
  // A reserva (backupCodec) aparece sozinha quando alguém precisa: a cada leitura confere o tamanho.
  feed.add((r) => {
    scale.setSource(r);
    scale.apply();
  });
  // O vigia do processador existe sempre: com o "Ceder" desligado ele só lê o uso (para o diagnóstico
  // dizer se a captura curta é o processador ou a placa de vídeo), sem mexer na transmissão.
  const governor = new LoadGovernor(video.mediaStreamTrack, encoded, req.plan.frameRate, cb.onLoad, (f) => scale.setLoad(f), req.adaptToLoad);
  governor.start();
  const watch = new ShareWatch({ onChange: cb.onHealth, want: () => governor.fps() }, feed);
  watch.start();
  const upload = new UploadGuard(() => video.sender, bitrate, cb.onUpload, feed);
  upload.start();
  // Vigia: se o navegador estiver codificando no processador (OpenH264, libvpx, libaom), republica a
  // mesma captura com um codec que a placa codifica. Quem assiste vê um piscar; o jogo volta a ter FPS.
  let current = codec;
  // Numa reconexão completa o LiveKit republica a tela num sender novo, sem as camadas de tempo
  // (elas foram ligadas direto no sender). A leitura seguinte põe de volta; nos outros codecs nada muda.
  feed.add(() => {
    if (current === 'vp8') void addTemporalLayers(video);
  });
  const soft = new Set<Codec>();
  const guard = new CodecGuard(
    video,
    () => current,
    async (e) => {
      soft.add(e.from);
      const next = pickCodec('auto', viewersOf(room), soft);
      if (next === current || !(encoderProbes()[next]?.gpu === true || hardwareOnly(next))) return null;
      const live = () =>
        video.mediaStreamTrack.readyState === 'live' &&
        room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track === video;
      if (!live()) return null;
      const br = cappedBitrate(encoded, req.plan, next);
      console.info(`[tela] ${e.from} saía no processador (${e.encoder}); trocando para ${next}`);
      await room.localParticipant.unpublishTrack(video, false);
      if (video.mediaStreamTrack.readyState !== 'live') return null;
      await room.localParticipant.publishTrack(video, videoPublishOptions(req, next, br));
      if (next === 'vp8') await addTemporalLayers(video);
      scale.apply();
      current = next;
      // O teto de perda na subida passa a contar do máximo do codec novo.
      upload.retarget(br);
      cb.onCodecSwitch?.({ from: e.from, encoder: e.encoder, to: next, bitrate: br });
      return next;
    },
    feed,
  );
  guard.start();
  // Vigia: o controle de qualidade do navegador pode encolher a tela até 320x180 com banda sobrando
  // (visto com H.264 na NVIDIA). Aí a tela passa a manter a resolução. Ver shrink-guard.ts.
  const shrink = new ShrinkGuard(video, (e) => cb.onShrinkFix?.(e), feed);
  shrink.start();
  // Janela minimizada / alt-tab: os quadros param; quem assiste vê "transmissão pausada".
  const pause = new PauseWatch(video.mediaStreamTrack, (p) => cb.onPaused?.(p));
  pause.start();
  return { codec, bitrate, resolution: encoded, audio: audioState, watch, surface, governor, upload, guard, shrink, pause, gpu: probes[codec]?.gpu === true };
}

export async function stopShareAudio(room: Room) {
  stopStudio();
  const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
  if (pub?.track !== undefined) await room.localParticipant.unpublishTrack(pub.track, true);
}

export async function stopShare(room: Room) {
  stopStudio();
  for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
    const pub = room.localParticipant.getTrackPublication(source);
    if (pub?.track !== undefined) await room.localParticipant.unpublishTrack(pub.track, true);
  }
}
