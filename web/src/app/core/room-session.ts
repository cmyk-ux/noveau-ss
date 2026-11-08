// Tudo que fala direto com o Room do LiveKit: participantes, telas, áudio e dados.
import {
  ConnectionState,
  Participant,
  ParticipantKind,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  TrackPublication,
  VideoPresets,
  VideoQuality,
} from 'livekit-client';
import { ShareCallbacks, ShareRequest, ShareResult, startShare, stopShare, stopShareAudio } from './share';
import { Channel, isSilent, Mixer, Volume } from './volume';

export type RoomStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface ShareView {
  /** Identidade de quem compartilha; cada pessoa tem no máximo uma tela/câmera em destaque. */
  id: string;
  ownerIdentity: string;
  ownerName: string;
  isLocal: boolean;
  kind: 'screen' | 'camera';
  /** Câmera chegando por RTMP (LiveKit Ingress). */
  isIngress: boolean;
  hasAudio: boolean;
  trackSid: string;
  volume: Volume;
}

export interface PersonView {
  identity: string;
  name: string;
  isLocal: boolean;
  isSpeaking: boolean;
  micEnabled: boolean;
  isSharing: boolean;
  canPublish: boolean;
  volume: Volume;
  /** Id do Discord, nas salas de call. */
  discordId: string | null;
}

export interface RoomSnapshot {
  status: RoomStatus;
  participants: PersonView[];
  shares: ShareView[];
  focusedShareId: string | null;
  needsAudioUnlock: boolean;
  watchers: Map<string, number>;
}

interface LiveShare {
  view: ShareView;
  publication: TrackPublication;
}

const WATCHING = 'watching';

function watchingOf(attrs: Record<string, string> | undefined): string | null {
  const v = attrs?.[WATCHING];
  return v === undefined || v === '' ? null : v;
}

function countWatchers(people: { identity: string; watching: string | null }[], shareIds: string[]) {
  const counts = new Map(shareIds.map((id) => [id, 0]));
  for (const p of people) {
    if (p.watching === null || p.watching === p.identity) continue;
    const n = counts.get(p.watching);
    if (n !== undefined) counts.set(p.watching, n + 1);
  }
  return counts;
}

export function formatWatchers(n: number): string {
  return n === 0 ? 'nobody watching' : n === 1 ? '1 watching' : `${n} watching`;
}

export function localPerson(s: RoomSnapshot) {
  return s.participants.find((p) => p.isLocal) ?? null;
}
function localShare(s: RoomSnapshot) {
  return s.shares.find((x) => x.isLocal) ?? null;
}
export function focusedShare(s: RoomSnapshot) {
  return s.shares.find((x) => x.id === s.focusedShareId) ?? null;
}
export function isSharingScreen(s: RoomSnapshot) {
  return localShare(s)?.kind === 'screen';
}
export function isWebcamOn(s: RoomSnapshot) {
  return localShare(s)?.kind === 'camera';
}
export function isMicOn(s: RoomSnapshot) {
  return localPerson(s)?.micEnabled ?? false;
}
export function watchersOf(s: RoomSnapshot, id: string) {
  return s.watchers.get(id) ?? 0;
}
export function focusedWatchers(s: RoomSnapshot) {
  const f = focusedShare(s);
  return f === null ? 0 : watchersOf(s, f.id);
}
export function isWaitingForCamera(s: RoomSnapshot, cameraOffered: boolean) {
  return cameraOffered && !s.shares.some((x) => x.isIngress);
}

function keepFocus(ids: string[], current: string | null) {
  return current !== null && ids.includes(current) ? current : (ids[0] ?? null);
}

/** Quando a primeira tela aparece, ela ganha o foco; com várias, o foco fica onde estava. */
function focusIfOnly(ids: string[], arriving: string, current: string | null) {
  return ids.length === 1 ? arriving : current;
}

function isVisual(source: Track.Source) {
  return source === Track.Source.ScreenShare || source === Track.Source.Camera;
}

function pickVisual(p: { screen?: TrackPublication; webcam?: TrackPublication; webcamMuted?: boolean; isIngress: boolean }) {
  if (p.screen !== undefined) return { publication: p.screen, kind: p.isIngress ? ('camera' as const) : ('screen' as const) };
  if (p.webcam !== undefined && p.webcamMuted !== true) return { publication: p.webcam, kind: 'camera' as const };
  return null;
}

export function displayName(p: Participant): string {
  return p.name !== undefined && p.name !== '' ? p.name : p.identity.split('#')[0];
}

const WEBCAM_RESOLUTION = VideoPresets.h720.resolution;

export class RoomSession {
  private focusedShareId: string | null = null;
  private readonly listeners = new Set<(s: RoomSnapshot) => void>();
  private readonly mixer = new Mixer();
  private publishedWatching: string | null | undefined = undefined;
  private refusedWatching: string | null | undefined = undefined;
  private live: LiveShare[] = [];

  constructor(
    private readonly audioContainer: HTMLElement,
    readonly room: Room = new Room({ adaptiveStream: false, dynacast: true }),
  ) {
    this.bindEvents();
  }

  onChange(fn: (s: RoomSnapshot) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.announce(this.settle());
  }

  private announce(s = this.read()) {
    for (const fn of this.listeners) fn(s);
  }

  private bindEvents() {
    const changed = () => this.emit();
    this.room
      .on(RoomEvent.ParticipantConnected, changed)
      .on(RoomEvent.ParticipantDisconnected, changed)
      .on(RoomEvent.ParticipantAttributesChanged, changed)
      .on(RoomEvent.ConnectionStateChanged, (state) => {
        if (state !== ConnectionState.Connected) {
          this.publishedWatching = undefined;
          this.refusedWatching = undefined;
        }
        changed();
      })
      .on(RoomEvent.ActiveSpeakersChanged, changed)
      .on(RoomEvent.TrackMuted, changed)
      .on(RoomEvent.TrackUnmuted, changed)
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        if (isVisual(pub.source))
          this.focusedShareId = focusIfOnly(this.liveIds(), this.room.localParticipant.identity, this.focusedShareId);
        changed();
      })
      .on(RoomEvent.LocalTrackUnpublished, changed)
      .on(RoomEvent.TrackPublished, (pub, p) => {
        if (isVisual(pub.source)) this.focusedShareId = focusIfOnly(this.liveIds(), p.identity, this.focusedShareId);
        changed();
      })
      .on(RoomEvent.TrackUnpublished, changed)
      .on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) this.audioContainer.appendChild(track.attach());
        changed();
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) for (const el of track.detach()) el.remove();
        changed();
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, changed)
      .on(RoomEvent.Disconnected, changed);
  }

  async connect(url: string, token: string) {
    await this.room.connect(url, token, { autoSubscribe: true });
    this.emit();
  }

  async disconnect() {
    await this.room.disconnect();
  }

  async unlockAudio() {
    await this.room.startAudio();
    this.emit();
  }

  focusShare(id: string) {
    this.focusedShareId = id;
    this.emit();
  }

  setVolume(channel: Channel, identity: string, level: number) {
    this.mixer.turnTo(channel, identity, level);
    this.mix();
    this.announce();
  }

  toggleMute(channel: Channel, identity: string) {
    this.mixer.toggleMute(channel, identity);
    this.mix();
    this.announce();
  }

  async startShare(req: ShareRequest, cb: ShareCallbacks): Promise<ShareResult> {
    const result = await startShare(this.room, req, cb);
    this.emit();
    return result;
  }

  async stopAudio() {
    await stopShareAudio(this.room);
    this.emit();
  }

  async stopShare() {
    await stopShare(this.room);
    this.emit();
  }

  async startWebcam(deviceId?: string) {
    await this.room.localParticipant.setCameraEnabled(true, { deviceId, resolution: WEBCAM_RESOLUTION });
    this.emit();
  }

  async stopWebcam() {
    const pub = this.room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (pub?.track === undefined) return;
    await this.room.localParticipant.unpublishTrack(pub.track, true);
    this.emit();
  }

  async setMicrophone(on: boolean) {
    await this.room.localParticipant.setMicrophoneEnabled(on);
    this.emit();
  }

  activeDevice(kind: MediaDeviceKind) {
    return this.room.getActiveDevice(kind);
  }

  async switchDevice(kind: MediaDeviceKind, id: string) {
    await this.room.switchActiveDevice(kind, id);
    this.emit();
  }

  attachFocused(el: HTMLMediaElement): boolean {
    const track = this.focusedLive()?.publication.track;
    if (track === undefined) return false;
    track.attach(el);
    return true;
  }

  shareReport() {
    return this.senderReport(Track.Source.ScreenShare);
  }
  shareAudioReport() {
    return this.senderReport(Track.Source.ScreenShareAudio);
  }

  private async senderReport(source: Track.Source) {
    const track = this.room.localParticipant.getTrackPublication(source)?.track;
    return track?.sender === undefined ? null : await track.sender.getStats();
  }

  async focusedReport(): Promise<RTCStatsReport | null> {
    const f = this.focusedLive();
    if (f === undefined || f.view.isLocal) return null;
    return (await (f.publication.track as any)?.getRTCStatsReport()) ?? null;
  }

  async focusedAudioReport(): Promise<RTCStatsReport | null> {
    const f = this.focusedLive();
    if (f === undefined || f.view.isLocal) return null;
    const track = this.room.remoteParticipants.get(f.view.ownerIdentity)?.getTrackPublication(Track.Source.ScreenShareAudio)
      ?.track as any;
    return (await track?.getRTCStatsReport()) ?? null;
  }

  private focusedLive() {
    return this.live.find((s) => s.view.id === this.focusedShareId);
  }

  private everyone(): Participant[] {
    return [this.room.localParticipant, ...this.room.remoteParticipants.values()];
  }

  private collectShares(): LiveShare[] {
    const out: LiveShare[] = [];
    for (const p of this.everyone()) {
      const isIngress = p.kind === ParticipantKind.INGRESS;
      const audio = p.getTrackPublication(Track.Source.ScreenShareAudio);
      const webcam = p.getTrackPublication(Track.Source.Camera);
      const visual = pickVisual({
        screen: p.getTrackPublication(Track.Source.ScreenShare),
        webcam,
        webcamMuted: webcam?.isMuted,
        isIngress,
      });
      if (visual === null) continue;
      out.push({
        view: {
          id: p.identity,
          ownerIdentity: p.identity,
          ownerName: displayName(p),
          isLocal: p === this.room.localParticipant,
          kind: visual.kind,
          isIngress,
          hasAudio: audio !== undefined && !audio.isMuted,
          trackSid: visual.publication.trackSid,
          volume: this.mixer.read('share', p.identity),
        },
        publication: visual.publication,
      });
    }
    return out;
  }

  read(): RoomSnapshot {
    return statusOf(this.room.state) === 'disconnected' ? emptySnapshot() : this.describe(this.collectShares());
  }

  private settle(): RoomSnapshot {
    if (statusOf(this.room.state) === 'disconnected') {
      this.focusedShareId = null;
      this.live = [];
      return emptySnapshot();
    }
    const shares = this.collectShares();
    this.live = shares;
    this.focusedShareId = keepFocus(shares.map((s) => s.view.id), this.focusedShareId);
    this.followFocus(shares);
    this.mix();
    this.publishWatching();
    return this.describe(shares);
  }

  private liveIds() {
    return this.collectShares().map((s) => s.view.id);
  }

  private describe(shares: LiveShare[]): RoomSnapshot {
    return {
      status: statusOf(this.room.state),
      participants: this.collectParticipants(),
      shares: shares.map((s) => s.view),
      focusedShareId: this.focusedShareId,
      needsAudioUnlock: !this.room.canPlaybackAudio,
      watchers: countWatchers(this.collectWatchers(), shares.map((s) => s.view.id)),
    };
  }

  /** Conta pros outros qual tela estou assistindo (atributo "watching"). */
  private publishWatching() {
    const id = this.focusedShareId;
    if (this.room.state !== ConnectionState.Connected || this.publishedWatching === id || this.refusedWatching === id) return;
    this.publishedWatching = id;
    this.refusedWatching = undefined;
    this.room.localParticipant.setAttributes({ [WATCHING]: id ?? '' }).catch(() => {
      this.publishedWatching = undefined;
      this.refusedWatching = id;
    });
  }

  private collectWatchers() {
    return this.everyone().map((p) => ({ identity: p.identity, watching: watchingOf(p.attributes) }));
  }

  /** Só a tela em foco é recebida, e em alta qualidade. */
  private followFocus(shares: LiveShare[]) {
    for (const s of shares) {
      if (s.view.isLocal) continue;
      const focused = s.view.id === this.focusedShareId;
      const pub = s.publication as any;
      pub.setSubscribed(true);
      pub.setEnabled(focused);
      if (focused) pub.setVideoQuality(VideoQuality.HIGH);
    }
  }

  private mix() {
    for (const p of this.room.remoteParticipants.values()) {
      const id = p.identity;
      this.tune(p, Track.Source.Microphone, this.mixer.read('mic', id), true);
      this.tune(p, Track.Source.ScreenShareAudio, this.mixer.read('share', id), id === this.focusedShareId);
    }
  }

  private tune(p: RemoteParticipant, source: Track.Source, v: Volume, audible: boolean) {
    const track = p.getTrackPublication(source)?.track;
    if (track === undefined || track.kind !== Track.Kind.Audio) return;
    for (const el of track.attachedElements) {
      el.muted = !audible || isSilent(v);
      el.volume = v.level;
    }
  }

  private collectParticipants(): PersonView[] {
    const speaking = new Set(this.room.activeSpeakers.map((p) => p.identity));
    return this.everyone().map((p) => ({
      identity: p.identity,
      name: displayName(p),
      isLocal: p === this.room.localParticipant,
      isSpeaking: speaking.has(p.identity),
      micEnabled: p.getTrackPublication(Track.Source.Microphone)?.isMuted === false,
      isSharing:
        p.getTrackPublication(Track.Source.ScreenShare) !== undefined ||
        p.getTrackPublication(Track.Source.Camera) !== undefined,
      canPublish: p.permissions?.canPublish === true,
      volume: this.mixer.read('mic', p.identity),
      discordId: p.attributes?.['discordId'] ?? null,
    }));
  }
}

function emptySnapshot(): RoomSnapshot {
  return {
    status: 'disconnected',
    participants: [],
    shares: [],
    focusedShareId: null,
    needsAudioUnlock: false,
    watchers: new Map(),
  };
}

function statusOf(state: ConnectionState): RoomStatus {
  switch (state) {
    case ConnectionState.Connecting:
      return 'connecting';
    case ConnectionState.Connected:
      return 'connected';
    case ConnectionState.Reconnecting:
      return 'reconnecting';
    default:
      return 'disconnected';
  }
}
