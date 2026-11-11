// Publicar a tela (e o som dela) no LiveKit com as configurações escolhidas.
import {
  BackupCodecPolicy,
  LocalAudioTrack,
  LocalTrack,
  LocalVideoTrack,
  Room,
  Track,
  type TrackPublishOptions,
  VideoPreset,
} from 'livekit-client';
import { Codec, CodecChoice, cappedBitrate, encoderProbes, hardwareOnly, parseDecoders, pickCodec, planSize, probeEncoders, StreamPlan, Size } from './stream';
import { LoadGovernor, LoadState } from './load';
import { UploadGuard, UploadState } from './upload-guard';
import { ShareHealth, ShareWatch, StatsFeed, sourceAudioLevel } from './stats';
import { StudioBits, StudioSender } from './studio';
import { CodecGuard } from './codec-guard';

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
  governor: LoadGovernor | null;
  upload: UploadGuard;
  /** Vigia que troca de codec se o navegador codificar no processador. */
  guard: CodecGuard;
  /** Codec escolhido roda na placa de vídeo (segundo o navegador). */
  gpu: boolean;
  /** 'monitor' (tela inteira), 'window' (janela) ou 'browser' (aba). */
  surface?: string;
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
 */
function displayMediaOptions(req: ShareRequest): DisplayMediaStreamOptions {
  const { width, height } = planSize(req.plan);
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
    // Original: pede o tamanho nativo. Com teto: no máximo aquilo (a tela é reduzida, nunca ampliada).
    video:
      req.plan.resolution === 'source'
        ? { width: { ideal: width }, height: { ideal: height }, frameRate: req.plan.frameRate }
        : { width: { max: width }, height: { max: height }, frameRate: req.plan.frameRate },
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

function videoPublishOptions(req: ShareRequest, codec: Codec, maxBitrate: number, size: Size): TrackPublishOptions {
  // H.265 só toca em quem tem decodificador de hardware; AV1/VP9 em navegadores antigos podem falhar.
  // Com REGRESSION a reserva só é codificada se alguém da sala não conseguir decodificar. Ela sai na
  // resolução cheia, então se cair no processador o jogo de quem transmite perde FPS no instante em
  // que essa pessoa entra (era o "do nada"). Por isso o H.265 ficou por último no automático e a
  // reserva é H.264 quando a placa codifica H.264. O CodecGuard confere o codificador de verdade.
  const needsBackup = codec === 'h265' || ((codec === 'av1' || codec === 'vp9') && req.maxCompatibility);
  // A reserva é H.264 quando a placa codifica H.264: quem não decodifica o principal (iPhone, Firefox)
  // recebe H.264 da placa, sem custo para o jogo. Só sem placa para H.264 ela volta a ser VP8.
  const backup = encoderProbes().h264?.gpu === true ? 'h264' : 'vp8';
  // Automático (bitrate Auto): manda também uma cópia menor (2/3 da resolução). O servidor troca para ela
  // só para quem não está aguentando (rede ou PC), em vez de travar; quem aguenta continua no máximo.
  // AV1/VP9 já saem com camadas de tempo (L1T3), que fazem o mesmo cortando quadros.
  const adaptive = req.plan.maxBitrate === 0 && (codec === 'vp8' || codec === 'h264') && Math.max(size.width, size.height) >= 960;
  const lowFps = Math.min(req.plan.frameRate, 60);
  return {
    source: Track.Source.ScreenShare,
    videoCodec: codec,
    screenShareEncoding: { maxBitrate, maxFramerate: req.plan.frameRate, priority: 'high' },
    degradationPreference: req.plan.degradation,
    simulcast: adaptive,
    ...(adaptive
      ? {
          screenShareSimulcastLayers: [
            // 2/3 do tamanho (1080p -> 720p): se alguém precisar cair, cai pouco.
            new VideoPreset(even((size.width * 2) / 3), even((size.height * 2) / 3), Math.max(2e6, Math.round(maxBitrate * 0.4)), lowFps, 'high'),
          ],
        }
      : {}),
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
  // Com o tamanho real da captura, pergunta ao navegador quais codecs rodam na GPU e escolhe.
  const probes = await probeEncoders(resolution, req.plan.frameRate);
  // Quem já está na sala e disse o que decodifica na placa de vídeo (atributo "hwdec").
  const codec = pickCodec(req.preferredCodec, viewersOf(room));
  const bitrate = cappedBitrate(resolution, req.plan, codec);
  video.mediaStreamTrack.addEventListener(
    'ended',
    () => {
      const current = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
      if (current?.mediaStreamTrack === video.mediaStreamTrack) cb.onEndedByBrowser();
    },
    { once: true },
  );
  await room.localParticipant.publishTrack(video, videoPublishOptions(req, codec, bitrate, resolution));
  if (codec === 'vp8') await addTemporalLayers(video);
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
  const watch = new ShareWatch({ onChange: cb.onHealth }, feed);
  watch.start();
  let governor: LoadGovernor | null = null;
  if (req.adaptToLoad) {
    governor = new LoadGovernor(video.mediaStreamTrack, resolution, req.plan.frameRate, cb.onLoad);
    governor.start();
  }
  const upload = new UploadGuard(() => video.sender, bitrate, cb.onUpload, feed);
  upload.start();
  // Vigia: se o navegador estiver codificando no processador (OpenH264, libvpx, libaom), republica a
  // mesma captura com um codec que a placa codifica. Quem assiste vê um piscar; o jogo volta a ter FPS.
  let current = codec;
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
      const br = cappedBitrate(resolution, req.plan, next);
      console.info(`[tela] ${e.from} saía no processador (${e.encoder}); trocando para ${next}`);
      await room.localParticipant.unpublishTrack(video, false);
      if (video.mediaStreamTrack.readyState !== 'live') return null;
      await room.localParticipant.publishTrack(video, videoPublishOptions(req, next, br, resolution));
      if (next === 'vp8') await addTemporalLayers(video);
      current = next;
      // O teto de perda na subida passa a contar do máximo do codec novo.
      upload.retarget(br);
      cb.onCodecSwitch?.({ from: e.from, encoder: e.encoder, to: next, bitrate: br });
      return next;
    },
    feed,
  );
  guard.start();
  return { codec, bitrate, resolution, audio: audioState, watch, surface, governor, upload, guard, gpu: probes[codec]?.gpu === true };
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
