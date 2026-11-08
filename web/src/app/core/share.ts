// Publicar a tela (e o som dela) no LiveKit com as configurações escolhidas.
import {
  AudioPresets,
  BackupCodecPolicy,
  createLocalScreenTracks,
  LocalTrack,
  Room,
  Track,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
} from 'livekit-client';
import { Codec, CodecChoice, isSvc, pickCodec, planSize, StreamPlan, bitrateFor, Size } from './stream';
import { ShareHealth, ShareWatch, sourceAudioLevel } from './stats';

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
}

export interface ShareCallbacks {
  onEndedByBrowser: () => void;
  onHealth: (h: ShareHealth) => void;
  onSilentAudio: () => void;
}

export interface ShareResult {
  codec: Codec;
  bitrate: number;
  resolution: Size;
  audio: 'published' | 'refused' | 'not-requested';
  watch: ShareWatch;
}

function captureOptions(req: ShareRequest): ScreenShareCaptureOptions {
  const { width, height } = planSize(req.plan);
  return {
    resolution: { width, height, frameRate: req.plan.frameRate },
    contentHint: req.plan.contentHint,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'include',
    // Som cru: sem cancelamento de eco, supressão de ruído ou ganho automático.
    audio: req.includeAudio
      ? { channelCount: 2, sampleRate: 48e3, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : false,
    ...(req.includeAudio
      ? { systemAudio: 'include', windowAudio: 'system', restrictOwnAudio: true }
      : { systemAudio: 'exclude', windowAudio: 'exclude' }),
  } as ScreenShareCaptureOptions;
}

function videoPublishOptions(req: ShareRequest, codec: Codec, maxBitrate: number): TrackPublishOptions {
  const svc = isSvc(codec);
  return {
    source: Track.Source.ScreenShare,
    videoCodec: codec,
    screenShareEncoding: { maxBitrate, maxFramerate: req.plan.frameRate, priority: 'high' },
    degradationPreference: req.plan.degradation,
    ...(svc ? { simulcast: false } : {}),
    ...(svc && req.maxCompatibility ? { backupCodec: { codec: 'h264' }, backupCodecPolicy: BackupCodecPolicy.REGRESSION } : {}),
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
  const codec = pickCodec(req.preferredCodec);
  let tracks: LocalTrack[];
  try {
    tracks = await createLocalScreenTracks(captureOptions(req));
  } catch (e) {
    throw e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')
      ? new ScreenShareCancelledError()
      : e;
  }
  const video = tracks.find((t) => t.kind === Track.Kind.Video);
  const audio = tracks.find((t) => t.kind === Track.Kind.Audio);
  if (video === undefined) {
    for (const t of tracks) t.stop();
    throw new Error('O navegador não entregou nenhuma imagem para compartilhar.');
  }
  const settings = await settledSettings(video.mediaStreamTrack);
  const planned = planSize(req.plan);
  const resolution: Size = {
    width: settings.width !== undefined && settings.width > 0 ? settings.width : planned.width,
    height: settings.height !== undefined && settings.height > 0 ? settings.height : planned.height,
  };
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
  if (audio !== undefined) {
    audio.mediaStreamTrack.contentHint = 'music';
    await room.localParticipant.publishTrack(audio, SCREEN_AUDIO_PUBLISH);
    audioState = 'published';
    void staysSilent(audio).then((silent) => {
      if (silent) cb.onSilentAudio();
    });
  }
  const watch = new ShareWatch({ track: video, onChange: cb.onHealth });
  watch.start();
  return { codec, bitrate, resolution, audio: audioState, watch };
}

export async function stopShareAudio(room: Room) {
  const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
  if (pub?.track !== undefined) await room.localParticipant.unpublishTrack(pub.track, true);
}

export async function stopShare(room: Room) {
  for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
    const pub = room.localParticipant.getTrackPublication(source);
    if (pub?.track !== undefined) await room.localParticipant.unpublishTrack(pub.track, true);
  }
}
