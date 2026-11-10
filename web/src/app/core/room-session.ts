// Tudo que fala direto com o Room do LiveKit: participantes, telas, áudio e dados.
import {
  ConnectionState,
  Participant,
  ParticipantKind,
  RemoteParticipant,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  TrackEvent,
  Track,
  TrackPublication,
  VideoPresets,
  VideoQuality,
} from 'livekit-client';
import type { ClipSource } from './clips';
import { ShareCallbacks, ShareRequest, ShareResult, startShare, stopShare, stopShareAudio } from './share';
import { Channel, isSilent, Mixer, Volume } from './volume';
import { IS_MOBILE } from './device';
import { installStereoReceive } from './stereo';
import { ACTIVITY_ATTR, Activity, parseActivity } from './activity';
import { gpuEncodes, hardwareDecoders } from './stream';

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
  /** De onde vem a imagem (tela inteira, janela, aba, câmera, OBS). */
  activity: Activity;
  /** A imagem principal é a sua própria câmera: aparece espelhada, como num espelho. */
  mirror: boolean;
  /** Câmera junto da tela (a pessoa transmite as duas): aparece numa janelinha no canto. */
  cam: CamView | null;
}

export interface CamView {
  trackSid: string;
  /** Sua própria câmera do PC: espelhada só para você. */
  mirror: boolean;
  /** Vem do celular da pessoa (link de celular como câmera). */
  fromPhone: boolean;
}

/** 'none' = o celular não publicou; 'off' = publicou e está desligado; 'on' = ao vivo. */
export type PhoneTrackState = 'none' | 'on' | 'off';

/** Seus aparelhos: câmera e microfone do PC e do celular ligado por link. */
export interface MyDevices {
  cam: boolean;
  mic: boolean;
  phone: { identity: string; cam: PhoneTrackState; mic: PhoneTrackState } | null;
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
  /** Está usando o celular como câmera ou microfone. */
  phone: boolean;
  /** O que está transmitindo agora (null = não está transmitindo). */
  activity: Activity | null;
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
  me: MyDevices;
}

interface LiveShare {
  view: ShareView;
  publication: TrackPublication;
  /** Câmera que acompanha a tela (do PC ou do celular da pessoa). */
  cam?: TrackPublication;
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
  return s.me.cam || s.me.phone?.cam === 'on';
}
export function isMicOn(s: RoomSnapshot) {
  return s.me.mic || s.me.phone?.mic === 'on';
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

/** Celular usado como câmera/microfone de alguém: a identidade do dono (veja server/phone.mjs). */
export function phoneOf(p: Participant | undefined): string | null {
  const v = p?.attributes?.['phoneOf'];
  return v === undefined || v === '' ? null : v;
}

function isLive(pub: TrackPublication | undefined): pub is TrackPublication {
  return pub !== undefined && !pub.isMuted;
}

function phoneState(pub: TrackPublication | undefined): PhoneTrackState {
  return pub === undefined ? 'none' : pub.isMuted ? 'off' : 'on';
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

/**
 * Câmera do PC: pede 1080p a 30 fps (a câmera entrega o máximo que tiver até isso). Antes era 720p a
 * 1,7 Mbps, o padrão do LiveKit, que borrava rosto e fundo. Agora vai a até 4 Mbps em 1080p, com
 * uma cópia em 360p para a janelinha do canto e para quem está com a internet ruim.
 * Codec: H.264 quando a placa de vídeo codifica H.264 (todo navegador decodifica, inclusive iPhone).
 * Antes era sempre VP8, que nenhuma placa codifica: 1080p30 + 360p no processador de quem está
 * jogando, somando com a tela. Sem placa para H.264, fica VP8 mas em 720p.
 */
const WEBCAM_FULL = { width: 1920, height: 1080, frameRate: 30 };
const WEBCAM_LIGHT = { width: 1280, height: 720, frameRate: 30 };
async function webcamPlan() {
  const gpu = await gpuEncodes('h264', WEBCAM_FULL, 30);
  return {
    capture: gpu ? WEBCAM_FULL : WEBCAM_LIGHT,
    publish: {
      videoCodec: gpu ? ('h264' as const) : ('vp8' as const),
      simulcast: true,
      videoEncoding: { maxBitrate: gpu ? 4_000_000 : 2_500_000, maxFramerate: 30 },
      videoSimulcastLayers: [VideoPresets.h360],
      degradationPreference: 'balanced' as const,
    },
  };
}

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
      .on(RoomEvent.TrackUnmuted, (pub, p) => {
        this.micMovedToPhone(pub, p);
        changed();
      })
      // A minha própria tela não vai para o palco (ver stageIds); a prévia dela fica na barra de baixo.
      .on(RoomEvent.LocalTrackPublished, changed)
      .on(RoomEvent.LocalTrackUnpublished, changed)
      .on(RoomEvent.TrackPublished, (pub, p) => {
        // A câmera do celular conta como a câmera do dono dele.
        if (isVisual(pub.source)) this.focusedShareId = focusIfOnly(this.liveIds(), phoneOf(p) ?? p.identity, this.focusedShareId);
        this.micMovedToPhone(pub, p);
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
    void this.publishDecoders();
  }

  /** Conta aos outros o que este PC decodifica na placa de vídeo, para quem transmite escolher o codec. */
  private async publishDecoders() {
    const list = await hardwareDecoders();
    if (this.room.state !== ConnectionState.Connected) return;
    await this.room.localParticipant.setAttributes({ hwdec: list.join(',') }).catch(() => undefined);
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

  /** Conta aos outros o que estou transmitindo (atributo "act"; vazio = nada). */
  private publishedAct = '';
  publishActivity(act: string) {
    if (act === this.publishedAct || this.room.state !== ConnectionState.Connected) return;
    this.publishedAct = act;
    this.room.localParticipant.setAttributes({ [ACTIVITY_ATTR]: act }).catch(() => (this.publishedAct = ''));
  }

  // ---------- prévia (mouse em cima da foto de quem transmite)
  // Uma tela fora de foco não está sendo recebida. Para a prévia ela é ligada na cópia menor
  // (simulcast), que custa pouco para baixar e decodificar, e desligada assim que o mouse sai.
  private previewId: string | null = null;

  /** Liga a prévia de uma tela num elemento de vídeo. Devolve false se a tela não existe mais. */
  startPreview(id: string, el: HTMLMediaElement): boolean {
    const s = this.live.find((x) => x.view.id === id);
    if (s === undefined) return false;
    this.previewId = id;
    this.followFocus(this.live);
    const track = s.publication.track;
    if (track === undefined) return false;
    track.attach(el);
    return true;
  }

  /**
   * Prévia da minha própria tela (ou câmera): uma cópia da captura que o navegador já entrega
   * reduzida a 360p e 15 fps. Mostrar a original custava ~0,6 núcleo a mais; esta, ~0,05
   * (medido no Chrome com uma tela de 1440p60). A transmissão e o clipe não mudam.
   */
  startLocalPreview(el: HTMLVideoElement, which: 'main' | 'cam'): () => void {
    const lp = this.room.localParticipant;
    const screen = lp.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
    const cam = lp.getTrackPublication(Track.Source.Camera)?.track?.mediaStreamTrack;
    const source = which === 'cam' ? cam : (screen ?? cam);
    // Câmera pelo celular: ela não é local, chega pela sala.
    if (source === undefined && (which === 'cam' || screen === undefined)) return this.watchMyPhoneCam(el);
    if (source === undefined || source.readyState === 'ended') return () => undefined;
    const copy = source.clone();
    void copy.applyConstraints({ width: { max: 640 }, height: { max: 360 }, frameRate: { max: 15 } }).catch(() => undefined);
    el.srcObject = new MediaStream([copy]);
    // A captura acabou (parou de compartilhar): a cópia acaba junto.
    const end = () => copy.stop();
    source.addEventListener('ended', end, { once: true });
    return () => {
      source.removeEventListener('ended', end);
      copy.stop();
      if (el.srcObject !== null) el.srcObject = null;
    };
  }

  /**
   * A câmera do meu celular, vista por mim (prévia e retorno). Ela chega pela sala como a de outra
   * pessoa: só é baixada enquanto alguém aqui olha, e na cópia menor (360p).
   */
  private readonly selfViews = new Set<HTMLMediaElement>();
  private watchMyPhoneCam(el: HTMLMediaElement): () => void {
    const pub = this.phones().get(this.room.localParticipant.identity)?.getTrackPublication(Track.Source.Camera);
    if (!(pub instanceof RemoteTrackPublication) || !isLive(pub)) return () => undefined;
    this.selfViews.add(el);
    this.followFocus(this.live);
    const attach = () => {
      if (pub.track === undefined || !this.selfViews.has(el)) return;
      this.release(el);
      pub.track.attach(el);
    };
    attach();
    // Ainda não chegou (acabou de ligar a cópia): liga quando chegar.
    pub.on(TrackEvent.Subscribed, attach);
    return () => {
      pub.off(TrackEvent.Subscribed, attach);
      pub.track?.detach(el);
      this.selfViews.delete(el);
      this.followFocus(this.live);
    };
  }

  stopPreview(id: string, el: HTMLMediaElement) {
    this.live.find((x) => x.view.id === id)?.publication.track?.detach(el);
    if (this.previewId !== id) return;
    this.previewId = null;
    this.followFocus(this.live);
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
    if (this.live.some((s) => s.view.id === id && s.view.isLocal)) return;
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

  /**
   * Solta o elemento de qualquer vídeo em que ele esteja ligado. Sem isso, trocar a câmera com a tela
   * deixava o elemento ainda preso ao vídeo antigo, e quando aquele vídeo acabasse o LiveKit apagava
   * o elemento junto (mesmo mostrando outra coisa).
   */
  private release(el: HTMLMediaElement) {
    for (const s of this.live) {
      for (const t of [s.publication.track, s.cam?.track]) if (t !== undefined && t.attachedElements.includes(el)) t.detach(el);
    }
  }

  /** Liga o vídeo de uma tela qualquer (para a grade). */
  attachShare(id: string, el: HTMLMediaElement): boolean {
    const track = this.live.find((s) => s.view.id === id)?.publication.track;
    if (track === undefined) return false;
    this.release(el);
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
    const lp = this.room.localParticipant;
    const plan = await webcamPlan();
    try {
      await lp.setCameraEnabled(true, { deviceId, resolution: plan.capture }, plan.publish);
    } catch (e) {
      // A câmera escolhida da outra vez sumiu (desplugada): usa a padrão.
      if (deviceId === undefined) throw e;
      await lp.setCameraEnabled(true, { resolution: plan.capture }, plan.publish);
    }
    this.emit();
  }

  /** Meu celular ligou o microfone: o do PC desliga, para a voz não sair dobrada. */
  private micMovedToPhone(pub: TrackPublication, p: Participant) {
    const lp = this.room.localParticipant;
    if (pub.source !== Track.Source.Microphone || pub.isMuted || phoneOf(p) !== lp.identity || !lp.isMicrophoneEnabled) return;
    void this.setMicrophone(false).then(() => this.onMicMoved?.(true));
  }

  /** Janelinha da câmera: grande (trocou com a tela) ou fechada. Só para você. */
  setCamLayout(id: string, layout: { big: boolean; closed: boolean }) {
    if (layout.big) this.camBig.add(id);
    else this.camBig.delete(id);
    if (layout.closed) this.camClosed.add(id);
    else this.camClosed.delete(id);
    this.followFocus(this.live);
  }
  private readonly camBig = new Set<string>();
  private readonly camClosed = new Set<string>();

  /** Liga a câmera que acompanha a tela de alguém (a janelinha do canto). */
  attachCam(id: string, el: HTMLMediaElement): boolean {
    const track = this.live.find((s) => s.view.id === id)?.cam?.track;
    if (track === undefined) return false;
    this.release(el);
    track.attach(el);
    return true;
  }

  detachCam(id: string, el: HTMLMediaElement) {
    this.live.find((s) => s.view.id === id)?.cam?.track?.detach(el);
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

  /** Liga o vídeo da tela em foco ('main') ou da câmera que acompanha ela ('cam'). */
  attachFocused(el: HTMLMediaElement, which: 'main' | 'cam' = 'main'): boolean {
    const f = this.focusedLive();
    const track = which === 'cam' ? f?.cam?.track : f?.publication.track;
    if (track === undefined) return false;
    this.release(el);
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

  /**
   * Faixas cruas (vídeo e o som dela) de todas as telas que você não escondeu, a em foco primeiro,
   * para o gravador de clipes guardar sempre. As fora de foco não recebem vídeo agora, mas o
   * buffer delas fica (e o som continua chegando).
   */
  clipSources(): ClipSource[] {
    const out: ClipSource[] = [];
    const order = [...this.live].sort((a, b) => rank(b) - rank(a));
    const focused = this.focusedShareId;
    function rank(s: LiveShare) {
      return s.view.id === focused ? 2 : s.view.isLocal ? 1 : 0;
    }
    for (const s of order) {
      // Só as telas dos outros: gravar a própria custava a quem transmite (que está jogando) um
      // segundo codificador na placa de vídeo, além da transmissão.
      if (this.hidden.has(s.view.id) || s.view.isLocal) continue;
      const video = s.publication.track?.mediaStreamTrack;
      if (video === undefined) continue;
      const owner = s.view.isLocal ? this.room.localParticipant : this.room.remoteParticipants.get(s.view.ownerIdentity);
      const audio =
        s.view.kind === 'camera' && !s.view.isIngress
          ? null
          : (owner?.getTrackPublication(screenAudioSource(owner))?.track?.mediaStreamTrack ?? null);
      const dims = s.view.isLocal ? undefined : s.publication.dimensions;
      out.push({
        id: s.view.id,
        video,
        audio,
        name: s.view.isLocal ? 'minha-tela' : s.view.ownerName,
        local: s.view.isLocal,
        size: dims !== undefined && dims.width > 0 && dims.height > 0 ? { width: dims.width, height: dims.height } : undefined,
      });
    }
    return out;
  }

  private focusedLive() {
    return this.live.find((s) => s.view.id === this.focusedShareId);
  }

  private everyone(): Participant[] {
    return [this.room.localParticipant, ...this.room.remoteParticipants.values()];
  }

  /** Celular-câmera de cada pessoa (identidade do dono -> participante do celular). */
  private phones(): Map<string, RemoteParticipant> {
    const out = new Map<string, RemoteParticipant>();
    for (const p of this.room.remoteParticipants.values()) {
      const of = phoneOf(p);
      if (of !== null && !out.has(of)) out.set(of, p);
    }
    return out;
  }

  private collectShares(): LiveShare[] {
    const out: LiveShare[] = [];
    const phones = this.phones();
    for (const p of this.everyone()) {
      // O celular não aparece sozinho: a câmera dele vira a câmera do dono.
      if (phoneOf(p) !== null) continue;
      const isIngress = p.kind === ParticipantKind.INGRESS;
      const obs = isObs(p);
      const audio = p.getTrackPublication(screenAudioSource(p));
      const ownCam = p.getTrackPublication(Track.Source.Camera);
      const phoneCam = phones.get(p.identity)?.getTrackPublication(Track.Source.Camera);
      // A câmera do PC tem preferência; sem ela, a do celular.
      const camPub = obs ? undefined : isLive(ownCam) ? ownCam : isLive(phoneCam) ? phoneCam : undefined;
      const visual = obs
        ? ownCam === undefined
          ? null
          : { publication: ownCam, kind: 'screen' as const }
        : pickVisual({
            screen: p.getTrackPublication(Track.Source.ScreenShare),
            webcam: camPub,
            isIngress,
          });
      if (visual === null) continue;
      const isLocal = p === this.room.localParticipant;
      // Tela e câmera ao mesmo tempo: a câmera vai junto, numa janelinha.
      const cam = visual.kind === 'screen' && !isIngress && camPub !== undefined ? camPub : undefined;
      out.push({
        view: {
          id: p.identity,
          ownerIdentity: p.identity,
          ownerName: displayName(p),
          isLocal,
          kind: visual.kind,
          isIngress,
          obs,
          hasAudio: audio !== undefined && !audio.isMuted,
          trackSid: visual.publication.trackSid,
          volume: this.mixer.read('share', p.identity),
          mirror: isLocal && visual.publication === ownCam && visual.kind === 'camera',
          cam:
            cam === undefined
              ? null
              : { trackSid: cam.trackSid, mirror: isLocal && cam === ownCam, fromPhone: cam !== ownCam },
          activity: obs
            ? { surface: 'obs' }
            : visual.kind === 'camera' && !isIngress
              ? { surface: 'camera' }
              : (parseActivity(p.attributes?.[ACTIVITY_ATTR]) ?? { surface: '' }),
        },
        publication: visual.publication,
        cam,
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
    this.focusedShareId = keepFocus(this.stageIds(shares), this.focusedShareId);
    this.followFocus(shares);
    this.mix();
    this.publishWatching();
    return this.describe(shares);
  }

  private liveIds() {
    return this.stageIds(this.collectShares());
  }

  /**
   * Telas que podem ir para o palco: as dos outros, menos as escondidas. A minha fica de fora:
   * mostrar a própria tela grande, a 60 fps e na resolução cheia, custava ~0,6 núcleo a mais para
   * quem transmite (que normalmente está jogando). A prévia dela abre na barra de baixo, pequena.
   */
  private stageIds(shares: LiveShare[]) {
    return shares.filter((s) => !s.view.isLocal && !this.hidden.has(s.view.id)).map((s) => s.view.id);
  }

  private describe(shares: LiveShare[]): RoomSnapshot {
    return {
      status: statusOf(this.room.state),
      participants: this.collectParticipants(new Map(shares.map((s) => [s.view.id, s.view.activity]))),
      shares: shares.map((s) => {
        const v = this.hidden.has(s.view.id) ? { ...s.view, hidden: true } : s.view;
        const g = this.guards.get(s.view.id);
        return g !== undefined && g.until > Date.now() ? { ...v, shielded: { until: g.until, width: g.width, height: g.height } } : v;
      }),
      focusedShareId: this.focusedShareId,
      needsAudioUnlock: !this.room.canPlaybackAudio,
      me: this.readMe(),
      ...(() => {
        const viewers = viewersByShare(this.collectWatchers(), shares.map((s) => s.view.id));
        return { viewers, watchers: new Map([...viewers].map(([k, v]) => [k, v.length])) };
      })(),
    };
  }

  private readMe(): MyDevices {
    const lp = this.room.localParticipant;
    const phone = this.phones().get(lp.identity);
    return {
      cam: isLive(lp.getTrackPublication(Track.Source.Camera)),
      mic: lp.isMicrophoneEnabled,
      phone:
        phone === undefined
          ? null
          : {
              identity: phone.identity,
              cam: phoneState(phone.getTrackPublication(Track.Source.Camera)),
              mic: phoneState(phone.getTrackPublication(Track.Source.Microphone)),
            },
    };
  }

  /** Conta pros outros qual tela estou assistindo (atributo "watching"). */
  private publishWatching() {
    const id = this.focusedShareId ?? (this.stageIds(this.live).length > 1 ? '*' : null);
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
    return this.everyone().filter((p) => !isObs(p) && phoneOf(p) === null).map((p) => ({ identity: p.identity, name: displayName(p), watching: watchingOf(p.attributes) }));
  }

  /**
   * Com uma tela em foco, só ela é recebida, em alta qualidade. Na grade, todas são recebidas;
   * até 2 telas em alta, mais que isso em média (cada uma ocupa menos espaço).
   */
  private followFocus(shares: LiveShare[]) {
    const grid = this.focusedShareId === null;
    const visible = this.stageIds(shares).length;
    const used = new Set<TrackPublication>();
    for (const s of shares) {
      // A minha nunca vai para o palco (só para a prévia e o retorno da câmera).
      const shown =
        !s.view.isLocal && !this.away && !this.hidden.has(s.view.id) && (grid || s.view.id === this.focusedShareId);
      used.add(s.publication);
      if (s.cam !== undefined) used.add(s.cam);
      // A câmera junto da tela, se você não escondeu. Na grade, num cantinho de cada monitor: a cópia
      // menor. Em foco, na janelinha: a média; trocada com a tela (grande), a máxima.
      // Escondida, o servidor para de mandar: não baixa nem decodifica nada.
      if (s.cam instanceof RemoteTrackPublication) {
        const camShown = s.view.isLocal ? this.selfViews.size > 0 : shown && !this.camClosed.has(s.view.id);
        s.cam.setSubscribed(true);
        s.cam.setEnabled(camShown);
        if (camShown)
          s.cam.setVideoQuality(
            grid || s.view.isLocal ? VideoQuality.LOW : this.camBig.has(s.view.id) ? VideoQuality.HIGH : VideoQuality.MEDIUM,
          );
      }
      // Minha própria câmera pelo celular também chega pela sala (as do PC são locais).
      if (!(s.publication instanceof RemoteTrackPublication)) continue;
      const pub = s.publication;
      pub.setSubscribed(true);
      if (s.view.isLocal) {
        const want = this.selfViews.size > 0 && !this.away;
        pub.setEnabled(want);
        if (want) pub.setVideoQuality(VideoQuality.LOW);
        continue;
      }
      if (!shown && s.view.id === this.previewId && !this.away) {
        // Só a prévia: a cópia menor basta para a miniatura.
        pub.setEnabled(true);
        pub.setVideoQuality(VideoQuality.LOW);
        continue;
      }
      pub.setEnabled(shown);
      if (!shown) continue;
      // Travando seguido: segura na cópia menor (só para quem trava), depois tenta voltar.
      if (this.shielded(s.view.id)) pub.setVideoQuality(VideoQuality.LOW);
      else pub.setVideoQuality(grid && (visible > 2 || IS_MOBILE) ? VideoQuality.MEDIUM : VideoQuality.HIGH);
    }
    // Câmeras que ninguém está mostrando (ex.: celular de quem já tem câmera no PC): não baixa.
    for (const p of this.room.remoteParticipants.values()) {
      const camPub = p.getTrackPublication(Track.Source.Camera);
      if (camPub instanceof RemoteTrackPublication && !used.has(camPub)) camPub.setEnabled(false);
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
    const me = this.room.localParticipant;
    for (const p of this.room.remoteParticipants.values()) {
      const id = p.identity;
      // Microfone do celular de alguém: é a voz dele, com o volume dele. O do meu celular não toca
      // aqui (eu me ouviria), e o de quem já saiu da sala também não.
      const of = phoneOf(p);
      if (of !== null) {
        const owner = this.room.remoteParticipants.get(of);
        const audible = of !== me.identity && owner !== undefined && !this.isMyOtherDevice(owner);
        this.tune(p, Track.Source.Microphone, this.mixer.read('mic', of), audible);
        continue;
      }
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

  private collectParticipants(activities: Map<string, Activity>): PersonView[] {
    const speaking = new Set(this.room.activeSpeakers.map((p) => p.identity));
    const phones = this.phones();
    return this.everyone().filter((p) => phoneOf(p) === null).map((p) => {
      const phone = phones.get(p.identity);
      return {
        identity: p.identity,
        name: displayName(p),
        isLocal: p === this.room.localParticipant,
        isSpeaking: speaking.has(p.identity) || (phone !== undefined && speaking.has(phone.identity)),
        micEnabled: p.getTrackPublication(Track.Source.Microphone)?.isMuted === false || isLive(phone?.getTrackPublication(Track.Source.Microphone)),
        isSharing:
          p.getTrackPublication(Track.Source.ScreenShare) !== undefined ||
          p.getTrackPublication(Track.Source.Camera) !== undefined ||
          isLive(phone?.getTrackPublication(Track.Source.Camera)),
        canPublish: p.permissions?.canPublish === true,
        volume: this.mixer.read('mic', p.identity),
        discordId: p.attributes?.['discordId'] ?? null,
        avatar: p.attributes?.['avatar'] ?? null,
        mobile: p.attributes?.['device'] === 'mobile',
        myOtherDevice: this.isMyOtherDevice(p),
        guest: p.attributes?.['guest'] === '1',
        invitedBy: p.attributes?.['invitedBy'] ?? null,
        phone: phone !== undefined,
        activity: activities.get(p.identity) ?? null,
      };
    });
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
    me: { cam: false, mic: false, phone: null },
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
