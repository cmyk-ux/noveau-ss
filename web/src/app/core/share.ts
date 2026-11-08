// Publicar a tela (e o som dela) no LiveKit com as configurações escolhidas.
import {
  AudioPresets,
  BackupCodecPolicy,
  LocalAudioTrack,
  LocalTrack,
  LocalVideoTrack,
  Room,
  Track,
  type TrackPublishOptions,
} from 'livekit-client';
import { Codec, CodecChoice, pickCodec, planSize, probeEncoders, StreamPlan, bitrateFor, Size } from './stream';
import { LoadGovernor, LoadState } from './load';
import { ShareHealth, ShareWatch, sourceAudioLevel } from './stats';
import { StudioBits, StudioSender } from './studio';

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
}

export interface ShareResult {
  codec: Codec;
  bitrate: number;
  resolution: Size;
  audio: 'published' | 'refused' | 'not-requested';
  watch: ShareWatch;
  governor: LoadGovernor | null;
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
    video: { width: { ideal: width }, height: { ideal: height }, frameRate: req.plan.frameRate },
    audio,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'include',
    ...(req.includeAudio
      ? { systemAudio: 'include', windowAudio: 'window' }
      : { systemAudio: 'exclude', windowAudio: 'exclude' }),
  } as DisplayMediaStreamOptions;
}

function videoPublishOptions(req: ShareRequest, codec: Codec, maxBitrate: number): TrackPublishOptions {
  // H.265 só toca em quem tem decodificador de hardware; AV1/VP9 em navegadores antigos podem falhar.
  // Com REGRESSION o H.264 de reserva só é codificado se alguém da sala não conseguir decodificar.
  const needsBackup = codec === 'h265' || ((codec === 'av1' || codec === 'vp9') && (req.maxCompatibility || req.preferredCodec === 'auto'));
  return {
    source: Track.Source.ScreenShare,
    videoCodec: codec,
    screenShareEncoding: { maxBitrate, maxFramerate: req.plan.frameRate, priority: 'high' },
    degradationPreference: req.plan.degradation,
    // Uma camada só: simulcast codificaria a tela 2-3 vezes (mais custo para quem transmite).
    simulcast: false,
    ...(needsBackup ? { backupCodec: { codec: 'h264' }, backupCodecPolicy: BackupCodecPolicy.REGRESSION } : {}),
  } as TrackPublishOptions;
}

/** Som da tela: Opus estéreo, sem DTX, com RED. É aqui que entra o "modo estúdio" depois. */
export const SCREEN_AUDIO_PUBLISH: TrackPublishOptions = {
  source: Track.Source.ScreenShareAudio,
  audioPreset: { ...AudioPresets.musicStereo, priority: 'high' },
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
  const codec = pickCodec(req.preferredCodec);
  const bitrate = bitrateFor(resolution, req.plan.frameRate, codec);
  video.mediaStreamTrack.addEventListener(
    'ended',
    () => {
      const current = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
      if (current?.mediaStreamTrack === video.mediaStreamTrack) cb.onEndedByBrowser();
    },
    { once: true },
  );
  await room.localParticipant.publishTrack(video, videoPublishOptions(req, codec, bitrate));
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
  const watch = new ShareWatch({ track: video, onChange: cb.onHealth });
  watch.start();
  let governor: LoadGovernor | null = null;
  if (req.adaptToLoad) {
    governor = new LoadGovernor(video.mediaStreamTrack, resolution, req.plan.frameRate, cb.onLoad);
    governor.start();
  }
  return { codec, bitrate, resolution, audio: audioState, watch, surface, governor, gpu: probes[codec]?.gpu === true };
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
