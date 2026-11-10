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
import { IS_MOBILE } from './device';
import { installStereoReceive } from './stereo';

// O som do OBS (WHIP) chega sem a marca de estéreo; veja stereo.ts.
installStereoReceive();

const DEVICE_TOPIC = 'device';
const GUARD_TICK_MS = 2000;
const GUARD_FREEZES = 3;
const GUARD_WINDOW_MS = 60_000;
const GUARD_HOLD_MS = 60_000;
const GUARD_MAX_MS = 8 * 60_000;

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
  /** Tela chegando do OBS (WHIP). */
  obs: boolean;
  hasAudio: boolean;
  trackSid: string;
  volume: Volume;
  /** Escondida por você: não recebe o vídeo nem toca o som dela. */
  hidden?: boolean;
  /** Travou várias vezes seguidas: recebendo a cópia menor por um tempo (só para você). */
  shielded?: { until: number; width: number; height: number } | null;
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
  /** Entrou pelo celular. */
  mobile: boolean;
  /** Outro aparelho da mesma conta do Discord (ex.: eu no PC e no celular). */
  myOtherDevice: boolean;
  /** Entrou por convite de 1 uso, sem Discord. */
  guest: boolean;
  /** Quem chamou o convidado. */
  invitedBy: string | null;
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
function cushion(track: Track, fromObs: boolean) {
  if (!fromObs && track.source !== Track.Source.ScreenShare && track.source !== Track.Source.ScreenShareAudio) return;
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

/**
 * Transmissão do OBS (WHIP): o LiveKit marca o vídeo como câmera e o som como microfone, então
 * para este participante a "câmera" é a tela e o "microfone" é o som da tela.
 */
export function isObs(p: Participant | undefined): boolean {
  return p?.attributes?.['obs'] === '1';
}
function screenAudioSource(p: Participant | undefined) {
  return isObs(p) ? Track.Source.Microphone : Track.Source.ScreenShareAudio;
}

export function displayName(p: Participant): string {
  if (isObs(p) && p.attributes['obsName']) return p.attributes['obsName'];
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
    readonly room: Room = new Room({
      adaptiveStream: false,
      dynacast: true,
      webAudioMix: true,
      // O LiveKit sai da sala no 'beforeunload', que o Chrome dispara também ao clicar num link de
      // download (clipe). Quem sai da sala de verdade é o 'pagehide', no RoomStore.
      disconnectOnPageLeave: false,
    }),
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
      .on(RoomEvent.DataReceived, this.onDeviceData)
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
      .on(RoomEvent.TrackSubscribed, (track, _pub, p) => {
        cushion(track, isObs(p));
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

  // ---------- proteção contra travadas (por quem assiste)
  // A qualidade máxima fica sempre, até travar de verdade: 3 travadas em 60 s na tela em foco.
  // Aí, se a tela tem a cópia menor (simulcast), recebe ela por um tempo e tenta voltar. Travou
  // de novo logo depois de voltar? Segura o dobro do tempo (até 8 min). Só afeta quem trava.
  private readonly guards = new Map<string, { freezes: number; times: number[]; until: number; hold: number; lastEnd: number; width: number; height: number; during: number; useless: number }>();
  private guardTimer = window.setInterval(() => void this.watchFreezes(), GUARD_TICK_MS);

  private shielded(id: string) {
    const g = this.guards.get(id);
    return g !== undefined && g.until > Date.now();
  }

  private async watchFreezes() {
    const f = this.focusedLive();
    const now = Date.now();
    for (const [id, g] of this.guards) {
      if (g.until !== 0 && g.until <= now) {
        g.until = 0;
        g.lastEnd = now;
        g.times = [];
        this.followFocus(this.live);
        this.announce();
      }
      // Muito tempo sem travar: esquece o histórico (próxima proteção volta a ser curta).
      if (g.until === 0 && g.lastEnd !== 0 && now - g.lastEnd > 10 * 60_000) g.hold = GUARD_HOLD_MS;
      if (f?.view.id !== id && g.until === 0) this.guards.delete(id);
    }
    if (f === undefined || f.view.isLocal || this.away) return;
    const pub = f.publication as any;
    const layers: { width?: number; height?: number }[] = pub.trackInfo?.layers ?? [];
    if (!pub.simulcasted || layers.length < 2) return;
    const report: RTCStatsReport | null = (await pub.track?.getRTCStatsReport?.()) ?? null;
    if (report === null) return;
    let freezes = -1;
    report.forEach((r: any) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video' && typeof r.freezeCount === 'number') freezes = Math.max(freezes, r.freezeCount);
    });
    if (freezes < 0) return;
    let g = this.guards.get(f.view.id);
    if (g === undefined) {
      g = { freezes, times: [], until: 0, hold: GUARD_HOLD_MS, lastEnd: 0, width: 0, height: 0, during: 0, useless: 0 };
      this.guards.set(f.view.id, g);
      return;
    }
    const fresh = Math.max(0, freezes - g.freezes);
    g.freezes = freezes;
    if (g.until > now) {
      // Continua travando mesmo na cópia menor: o problema é a internet de quem transmite (todo mundo
      // trava igual), e baixar aqui não resolve. Volta ao máximo e não tenta de novo por 10 min.
      g.during += fresh;
      if (g.during >= GUARD_FREEZES) {
        g.useless = now;
        this.unshield(f.view.id);
      }
      return;
    }
    if (g.useless !== 0 && now - g.useless < 10 * 60_000) return;
    for (let i = 0; i < fresh; i++) g.times.push(now);
    g.times = g.times.filter((t) => now - t < GUARD_WINDOW_MS);
    if (g.times.length < GUARD_FREEZES) return;
    // Voltou e travou de novo em menos de 2 min: segura mais tempo.
    if (g.lastEnd !== 0 && now - g.lastEnd < 2 * 60_000) g.hold = Math.min(GUARD_MAX_MS, g.hold * 2);
    const low = [...layers].sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0];
    g.width = low.width ?? 0;
    g.height = low.height ?? 0;
    g.until = now + g.hold;
    g.times = [];
    g.during = 0;
    this.followFocus(this.live);
    this.announce();
  }

  /** Quem transmite conta aos outros como está o envio (atributo "tx"), para o diagnóstico deles. */
  private publishedTx = '';
  publishSendHealth(tx: string) {
    if (tx === this.publishedTx || this.room.state !== ConnectionState.Connected) return;
    this.publishedTx = tx;
    this.room.localParticipant.setAttributes({ tx }).catch(() => (this.publishedTx = ''));
  }

  /** Para o diagnóstico: quem transmite a tela em foco, como está a rede dele e a minha. */
  focusedProbe(): {
    shareId: string;
    owner: string;
    tx: string | null;
    theirQuality: string;
    myQuality: string;
    report: Promise<RTCStatsReport | null>;
  } | null {
    const f = this.focusedLive();
    if (f === undefined || f.view.isLocal || this.away) return null;
    const owner = this.room.remoteParticipants.get(f.view.ownerIdentity);
    return {
      shareId: f.view.id,
      owner: f.view.ownerName,
      tx: owner?.attributes?.['tx'] ?? null,
      theirQuality: String(owner?.connectionQuality ?? 'unknown'),
      myQuality: String(this.room.localParticipant.connectionQuality ?? 'unknown'),
      report: Promise.resolve((f.publication.track as any)?.getRTCStatsReport?.() ?? null).catch(() => null),
    };
  }

  /** Quem transmite a tela em foco e o que ele conta sobre o envio (atributo "tx"). */
  focusedSender(): { name: string; tx: string | null } | null {
    const f = this.focusedLive();
    if (f === undefined || f.view.isLocal) return null;
    const owner = this.room.remoteParticipants.get(f.view.ownerIdentity);
    return { name: f.view.ownerName, tx: owner?.attributes?.['tx'] ?? null };
  }

  /** Para as estatísticas: a proteção contra travadas está disponível/ligada para a tela em foco? */
  shieldStatus(): string {
    const f = this.focusedLive();
    if (f === undefined || f.view.isLocal) return '';
    const pub = f.publication as any;
    const layers: { width?: number; height?: number }[] = pub.trackInfo?.layers ?? [];
    if (!pub.simulcasted || layers.length < 2) return 'sem cópia menor';
    const g = this.guards.get(f.view.id);
    const now = Date.now();
    if (g !== undefined && g.until > now) return `ligada (${g.height}p, ${Math.ceil((g.until - now) / 1000)} s)`;
    if (g !== undefined && g.useless !== 0 && now - g.useless < 10 * 60_000) return 'pausada (problema é de quem envia)';
    const low = [...layers].sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0];
    return `pronta (cópia ${low.height ?? '?'}p)`;
  }

  /** Volta já para a qualidade máxima (botão "voltar ao máximo"). */
  unshield(id: string) {
    const g = this.guards.get(id);
    if (g === undefined) return;
    g.until = 0;
    g.lastEnd = Date.now();
    g.times = [];
    this.followFocus(this.live);
    this.announce();
  }

  async disconnect() {
    window.clearInterval(this.guardTimer);
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
    // Mesma conta em dois aparelhos: o microfone "passa" para este, e o outro desliga o dele.
    if (on) {
      const others = [...this.room.remoteParticipants.values()].filter((p) => this.isMyOtherDevice(p)).map((p) => p.identity);
      if (others.length > 0)
        void this.room.localParticipant
          .publishData(new TextEncoder().encode('{"t":"mic-moved"}'), { reliable: true, topic: DEVICE_TOPIC, destinationIdentities: others })
          .catch(() => undefined);
    }
  }

  /** Chamado quando meu outro aparelho ligou o microfone e este desligou o seu. */
  onMicMoved: ((toMobile: boolean) => void) | null = null;

  private readonly onDeviceData = (payload: Uint8Array, p?: RemoteParticipant, _k?: unknown, topic?: string) => {
    if (topic !== DEVICE_TOPIC || p === undefined || !this.isMyOtherDevice(p)) return;
    try {
      if (JSON.parse(new TextDecoder().decode(payload)).t !== 'mic-moved') return;
    } catch {
      return;
    }
    if (this.room.localParticipant.isMicrophoneEnabled) {
      void this.setMicrophone(false).then(() => this.onMicMoved?.(p.attributes?.['device'] === 'mobile'));
    }
  };

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
    const owner = this.room.remoteParticipants.get(f.view.ownerIdentity);
    const track = owner?.getTrackPublication(screenAudioSource(owner))?.track as any;
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
        : (owner?.getTrackPublication(screenAudioSource(owner))?.track?.mediaStreamTrack ?? null);
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
      const obs = isObs(p);
      const audio = p.getTrackPublication(screenAudioSource(p));
      const webcam = p.getTrackPublication(Track.Source.Camera);
      const visual = obs
        ? webcam === undefined
          ? null
          : { publication: webcam, kind: 'screen' as const }
        : pickVisual({
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
          obs,
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
      shares: shares.map((s) => {
        const v = this.hidden.has(s.view.id) ? { ...s.view, hidden: true } : s.view;
        const g = this.guards.get(s.view.id);
        return g !== undefined && g.until > Date.now() ? { ...v, shielded: { until: g.until, width: g.width, height: g.height } } : v;
      }),
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
    // O OBS não é uma pessoa: aparece só como tela.
    return this.everyone().filter((p) => !isObs(p)).map((p) => ({ identity: p.identity, name: displayName(p), watching: watchingOf(p.attributes) }));
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
      if (!shown) continue;
      // Travando seguido: segura na cópia menor (só para quem trava), depois tenta voltar.
      if (this.shielded(s.view.id)) pub.setVideoQuality(VideoQuality.LOW);
      else pub.setVideoQuality(grid && (visible > 2 || IS_MOBILE) ? VideoQuality.MEDIUM : VideoQuality.HIGH);
    }
  }

  /** Minha própria transmissão do OBS: o som dela eu já ouço no PC, não toca de novo (com atraso). */
  private isMyObs(p: Participant) {
    if (!isObs(p)) return false;
    const me = this.room.localParticipant;
    const mine = me.attributes?.['discordId'];
    const of = p.attributes?.['obsOf'];
    if (of !== undefined && of !== '') return of === mine;
    return p.attributes?.['obsName'] === displayName(me);
  }

  /** Mesma conta do Discord em outro aparelho (PC + celular na mesma call). */
  private isMyOtherDevice(p: Participant) {
    const mine = this.room.localParticipant.attributes?.['discordId'];
    return mine !== undefined && mine !== '' && p !== this.room.localParticipant && p.attributes?.['discordId'] === mine;
  }

  private mix() {
    for (const p of this.room.remoteParticipants.values()) {
      const id = p.identity;
      // O microfone do meu outro aparelho não toca aqui: eu me ouviria com atraso (e daria eco).
      // (No OBS o "microfone" é o som da tela, tratado logo abaixo.)
      if (!isObs(p)) this.tune(p, Track.Source.Microphone, this.mixer.read('mic', id), !this.isMyOtherDevice(p));
      // Na grade, o som de todas as telas toca (cada uma com seu volume); em foco, só a dela.
      this.tune(
        p,
        screenAudioSource(p),
        this.mixer.read('share', id),
        !this.isMyObs(p) && !this.hidden.has(id) && (this.focusedShareId === null || id === this.focusedShareId),
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
      mobile: p.attributes?.['device'] === 'mobile',
      myOtherDevice: this.isMyOtherDevice(p),
      guest: p.attributes?.['guest'] === '1',
      invitedBy: p.attributes?.['invitedBy'] ?? null,
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
