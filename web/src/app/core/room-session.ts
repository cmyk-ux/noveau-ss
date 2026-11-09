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
  /** Escondida por você: não recebe o vídeo nem toca o som dela. */
  hidden?: boolean;
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
  /** Foto do Discord, nas salas de call. */
  avatar: string | null;
}

export interface RoomSnapshot {
  status: RoomStatus;
  participants: PersonView[];
  shares: ShareView[];
  focusedShareId: string | null;
  needsAudioUnlock: boolean;
  watchers: Map<string, number>;
  /** Nomes de quem está vendo cada tela. */
  viewers: Map<string, string[]>;
}

interface LiveShare {
  view: ShareView;
  publication: TrackPublication;
}

const WATCHING = 'watching';
/** Quanto tempo escondida até parar de receber vídeo (alt-tab rápido não conta). */
const AWAY_AFTER_MS = 2000;

function watchingOf(attrs: Record<string, string> | undefined): string | null {
  const v = attrs?.[WATCHING];
  return v === undefined || v === '' ? null : v;
}

/** "watching" = id da tela em foco, ou "*" para a grade (vendo todas). */
function viewersByShare(people: { identity: string; name: string; watching: string | null }[], shareIds: string[]) {
  const out = new Map<string, string[]>(shareIds.map((id) => [id, []]));
  for (const p of people) {
    if (p.watching === null) continue;
    for (const id of p.watching === '*' ? shareIds : [p.watching]) {
      if (id === p.identity) continue; // não conta a própria tela
      out.get(id)?.push(p.name);
    }
  }
  return out;
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

/**
 * Foco: com uma tela só, ela fica em foco. Com várias, o foco fica onde estava; se a tela em
 * foco sumir, volta para a grade (null), como no Discord.
 */
function keepFocus(ids: string[], current: string | null) {
  if (current !== null && ids.includes(current)) return current;
  return ids.length === 1 ? ids[0] : null;
}

/** Quando a primeira tela aparece, ela ganha o foco; com várias, o foco fica onde estava. */
function focusIfOnly(ids: string[], arriving: string, _current: string | null) {
  // Chegou outra tela: mostra todas em grade, como o Discord.
  return ids.length === 1 && ids[0] === arriving ? arriving : null;
}

/**
 * Folga para a tela de quem transmite: o navegador segura ~150 ms antes de mostrar.
 * Quando entra uma cena pesada (vídeo do TikTok, menu do jogo, tela preta para imagem) o quadro
 * fica enorme e demora mais para chegar; sem folga a imagem engasga. A folga também dá tempo de
 * pedir de novo um pacote perdido em vez de travar até o próximo quadro-chave. Vídeo e som da
 * tela ganham a mesma folga para continuarem juntos. A voz não muda (fica sem atraso).
 */
const SCREEN_CUSHION_MS = 150;
function cushion(track: Track) {
  if (track.source !== Track.Source.ScreenShare && track.source !== Track.Source.ScreenShareAudio) return;
  const receiver = (track as unknown as { receiver?: RTCRtpReceiver & { jitterBufferTarget?: number | null } }).receiver;
  if (receiver === undefined || !('jitterBufferTarget' in receiver)) return;
  try {
    receiver.jitterBufferTarget = SCREEN_CUSHION_MS;
  } catch {
    /* navegador sem suporte */
  }
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
  private readonly hidden = new Set<string>();
  private readonly listeners = new Set<(s: RoomSnapshot) => void>();
  private readonly mixer = new Mixer();
  private publishedWatching: string | null | undefined = undefined;
  private refusedWatching: string | null | undefined = undefined;
  private live: LiveShare[] = [];
  /**
   * Janela escondida (alt-tab para o jogo, minimizado): para de receber o vídeo das telas.
   * Quem assiste economiza decodificação enquanto joga, e ao voltar o servidor manda um quadro-chave
   * novo na hora, em vez da imagem engasgar até se acertar.
   */
  private away = false;
  private awayTimer?: number;
  private readonly onVisibility = () => {
    window.clearTimeout(this.awayTimer);
    if (document.visibilityState === 'visible') {
      if (!this.away) return;
      this.away = false;
      this.followFocus(this.live);
      return;
    }
    // Alt-tab rápido não mexe em nada; janela flutuante (PiP) continua recebendo.
    this.awayTimer = window.setTimeout(() => {
      if (document.visibilityState !== 'hidden' || document.pictureInPictureElement !== null) return;
      this.away = true;
      this.followFocus(this.live);
    }, AWAY_AFTER_MS);
  };

  constructor(
    private readonly audioContainer: HTMLElement,
    readonly room: Room = new Room({ adaptiveStream: false, dynacast: true, webAudioMix: true }),
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
    document.addEventListener('visibilitychange', this.onVisibility);
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
        cushion(track);
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
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.clearTimeout(this.awayTimer);
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

  /** Esconde uma tela só para você: para de baixar o vídeo e de tocar o som dela. */
  hideShare(id: string) {
    this.hidden.add(id);
    if (this.focusedShareId === id) this.focusedShareId = null;
    this.emit();
  }

  showShare(id: string) {
    this.hidden.delete(id);
    this.emit();
  }

  /** Volta para a grade com todas as telas. */
  unfocus() {
    this.focusedShareId = null;
    this.emit();
  }

  /** Solta o vídeo de um elemento que vai sumir. */
  detachShare(id: string, el: HTMLMediaElement) {
    this.live.find((s) => s.view.id === id)?.publication.track?.detach(el);
  }

  /** Liga o vídeo de uma tela qualquer (para a grade). */
  attachShare(id: string, el: HTMLMediaElement): boolean {
    const track = this.live.find((s) => s.view.id === id)?.publication.track;
    if (track === undefined) return false;
    track.attach(el);
    return true;
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

  /** Faixas cruas da tela em foco (vídeo e o som dela), para o gravador de clipes. */
  focusedMedia(): { id: string; video: MediaStreamTrack; audio: MediaStreamTrack | null; name: string; local: boolean } | null {
    const f = this.focusedLive();
    const video = f?.publication.track?.mediaStreamTrack;
    if (f === undefined || video === undefined) return null;
    const owner = f.view.isLocal ? this.room.localParticipant : this.room.remoteParticipants.get(f.view.ownerIdentity);
    const audio =
      f.view.kind === 'camera' && !f.view.isIngress
        ? null
        : (owner?.getTrackPublication(Track.Source.ScreenShareAudio)?.track?.mediaStreamTrack ?? null);
    return { id: f.view.id, video, audio, name: f.view.isLocal ? 'minha-tela' : f.view.ownerName, local: f.view.isLocal };
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
    this.focusedShareId = keepFocus(shares.filter((s) => !this.hidden.has(s.view.id)).map((s) => s.view.id), this.focusedShareId);
    this.followFocus(shares);
    this.mix();
    this.publishWatching();
    return this.describe(shares);
  }

  private liveIds() {
    return this.collectShares().map((s) => s.view.id).filter((id) => !this.hidden.has(id));
  }

  private describe(shares: LiveShare[]): RoomSnapshot {
    return {
      status: statusOf(this.room.state),
      participants: this.collectParticipants(),
      shares: shares.map((s) => (this.hidden.has(s.view.id) ? { ...s.view, hidden: true } : s.view)),
      focusedShareId: this.focusedShareId,
      needsAudioUnlock: !this.room.canPlaybackAudio,
      ...(() => {
        const viewers = viewersByShare(this.collectWatchers(), shares.map((s) => s.view.id));
        return { viewers, watchers: new Map([...viewers].map(([k, v]) => [k, v.length])) };
      })(),
    };
  }

  /** Conta pros outros qual tela estou assistindo (atributo "watching"). */
  private publishWatching() {
    const id = this.focusedShareId ?? (this.live.length > 1 ? '*' : null);
    if (this.room.state !== ConnectionState.Connected || this.publishedWatching === id || this.refusedWatching === id) return;
    this.publishedWatching = id;
    this.refusedWatching = undefined;
    this.room.localParticipant.setAttributes({ [WATCHING]: id ?? '' }).catch(() => {
      this.publishedWatching = undefined;
      this.refusedWatching = id;
    });
  }

  private collectWatchers() {
    return this.everyone().map((p) => ({ identity: p.identity, name: displayName(p), watching: watchingOf(p.attributes) }));
  }

  /**
   * Com uma tela em foco, só ela é recebida, em alta qualidade. Na grade, todas são recebidas;
   * até 2 telas em alta, mais que isso em média (cada uma ocupa menos espaço).
   */
  private followFocus(shares: LiveShare[]) {
    const grid = this.focusedShareId === null;
    const remote = shares.filter((s) => !s.view.isLocal);
    const visible = shares.filter((s) => !this.hidden.has(s.view.id)).length;
    for (const s of remote) {
      const shown = !this.away && !this.hidden.has(s.view.id) && (grid || s.view.id === this.focusedShareId);
      const pub = s.publication as any;
      pub.setSubscribed(true);
      pub.setEnabled(shown);
      if (shown) pub.setVideoQuality(grid && visible > 2 ? VideoQuality.MEDIUM : VideoQuality.HIGH);
    }
  }

  private mix() {
    for (const p of this.room.remoteParticipants.values()) {
      const id = p.identity;
      this.tune(p, Track.Source.Microphone, this.mixer.read('mic', id), true);
      // Na grade, o som de todas as telas toca (cada uma com seu volume); em foco, só a dela.
      this.tune(
        p,
        Track.Source.ScreenShareAudio,
        this.mixer.read('share', id),
        !this.hidden.has(id) && (this.focusedShareId === null || id === this.focusedShareId),
      );
    }
  }

  private tune(p: RemoteParticipant, source: Track.Source, v: Volume, audible: boolean) {
    const track = p.getTrackPublication(source)?.track;
    if (track === undefined || track.kind !== Track.Kind.Audio) return;
    // Com webAudioMix o volume é um ganho do Web Audio, que passa de 100%.
    (track as any).setVolume(!audible || isSilent(v) ? 0 : v.level);
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
      avatar: p.attributes?.['avatar'] ?? null,
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
    viewers: new Map(),
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

export function viewersOf(s: RoomSnapshot, id: string): string[] {
  return s.viewers.get(id) ?? [];
}
