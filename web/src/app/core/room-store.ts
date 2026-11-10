// Estado da sala para a interface. Uma instância por página de sala.
import { LoadGovernor, LoadState } from './load';
import { UploadGuard, UploadState } from './upload-guard';
import { Diagnostics, encodeSendHealth } from './diag';
import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { CameraAddress, JoinGrant, requestCamera, requestObsKey, requestToken, revokeCamera } from './api';
import { DeviceList, listMicrophones, listWebcams } from './devices';
import { RoomLink } from './link';
import { Prefs } from './prefs';
import {
  focusedShare,
  focusedWatchers,
  isMicOn,
  isSharingScreen,
  isWaitingForCamera,
  isWebcamOn,
  localPerson,
  RoomSession,
  RoomSnapshot,
  watchersOf,
  viewersOf,
} from './room-session';
import { ScreenShareCancelledError } from './share';
import { StudioHub } from './studio';
import { DawListener, requestDawCode } from './daw';
import { ShareHealth, StatsSampler } from './stats';
import { formatBitrate, planFor } from './stream';
import { Toast } from './toast';
import { Channel } from './volume';
import { ClipRecorder, ClipServer, clipServer, clipsSupported } from './clips';
import { ShareWatch } from './stats';

function audioContainer(): HTMLElement {
  const existing = document.getElementById('audio');
  if (existing !== null) return existing;
  const el = document.createElement('div');
  el.id = 'audio';
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  return el;
}

@Injectable()
export class RoomStore {
  private readonly prefs = inject(Prefs);
  private readonly toast = inject(Toast);
  private readonly session = new RoomSession(audioContainer());
  private readonly sampler = new StatsSampler();

  private readonly _snapshot = signal<RoomSnapshot>(this.session.read());
  private readonly _join = signal<'idle' | 'joining' | 'joined' | 'failed'>('idle');
  private readonly _error = signal('');
  private readonly _canPublish = signal(false);
  private readonly _health = signal<ShareHealth | null>(null);
  private readonly _soundProblem = signal<'refused' | 'silent' | 'whole-pc' | null>(null);
  private readonly _busy = signal(false);
  private readonly _camera = signal<CameraAddress | null>(null);
  private readonly _cameraOffered = signal(false);
  private readonly _cameraBusy = signal(false);
  private readonly _liveSignature = signal<string | null>(null);

  private link: RoomLink = { key: '', secret: '' };
  private token = '';
  /** Gravador de clipes (últimos 2 min de cada tela). */
  readonly clips = new ClipRecorder(() => this.token);
  private readonly _clipServer = signal<ClipServer | null>(null);
  /** O servidor tem onde guardar clipes e este navegador consegue gravar. */
  readonly canClip = computed(() => this._clipServer() !== null && clipsSupported());
  readonly webcams = new DeviceList(listWebcams, () => this.session.activeDevice('videoinput'));
  readonly microphones = new DeviceList(listMicrophones, () => this.session.activeDevice('audioinput'));
  private watch: ShareWatch | null = null;
  private governor: LoadGovernor | null = null;
  private uploadGuard: UploadGuard | null = null;
  private readonly _upload = signal<UploadState | null>(null);
  /** Diário de problemas da tela que estou assistindo. */
  readonly diag = new Diagnostics(() => this.session.focusedProbe(), () => this.token);
  /** Teto de bitrate por perda na subida (null = sem transmitir). */
  readonly upload = this._upload.asReadonly();
  private readonly _load = signal<LoadState | null>(null);
  /** Degrau de qualidade por uso do PC (null = não está transmitindo ou desligado). */
  readonly load = this._load.asReadonly();
  private readonly _encoder = signal<{ codec: string; gpu: boolean } | null>(null);
  /** Codec escolhido e se ele roda na placa de vídeo. */
  readonly encoder = this._encoder.asReadonly();

  readonly joinState = this._join.asReadonly();
  readonly error = this._error.asReadonly();
  readonly canPublish = this._canPublish.asReadonly();
  readonly health = this._health.asReadonly();
  readonly soundProblem = this._soundProblem.asReadonly();
  readonly busy = this._busy.asReadonly();
  readonly camera = this._camera.asReadonly();
  readonly cameraOffered = this._cameraOffered.asReadonly();
  readonly cameraBusy = this._cameraBusy.asReadonly();
  readonly liveSignature = this._liveSignature.asReadonly();
  readonly status = computed(() => this._snapshot().status);
  readonly participants = computed(() => this._snapshot().participants);
  /** Telas à mostra (sem as que você escondeu). */
  readonly shares = computed(() => this._snapshot().shares.filter((s) => !s.hidden));
  /** Telas que você escondeu, para a faixa de "voltar a ver". */
  readonly hiddenShares = computed(() => this._snapshot().shares.filter((s) => s.hidden));
  readonly needsAudioUnlock = computed(() => this._snapshot().needsAudioUnlock);
  readonly sharing = computed(() => isSharingScreen(this._snapshot()));
  readonly webcamOn = computed(() => isWebcamOn(this._snapshot()));
  readonly micOn = computed(() => isMicOn(this._snapshot()));
  readonly focused = computed(() => focusedShare(this._snapshot()));
  focusedSender() {
    return this.session.focusedSender();
  }
  readonly focusedWatchers = computed(() => focusedWatchers(this._snapshot()));
  readonly waitingForCamera = computed(() => isWaitingForCamera(this._snapshot(), this._camera() !== null));

  constructor() {
    this.session.onMicMoved = (toMobile) =>
      this.toast.show(`Seu microfone passou para o ${toMobile ? 'celular' : 'computador'}. Este aqui ficou mudo.`);
    const offChange = this.session.onChange((s) => {
      if (!s.shares.some((x) => x.isLocal && x.kind === 'screen')) this.forgetShare();
      this._snapshot.set(s);
      this.hintVolume(s);
    });
    const leave = () => void this.session.disconnect();
    // 'pagehide' e não 'beforeunload': baixar um clipe dispara 'beforeunload' sem sair da página.
    window.addEventListener('pagehide', leave);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('pagehide', leave);
      offChange();
      this.watch?.stop();
      this.daw.stop();
      this.studio.dispose();
      this.clips.stop();
      this.diag.stop();
      void this.session.disconnect();
    });
    // Quem transmite conta aos outros como está o envio, para o diagnóstico deles dizer o motivo.
    effect(() => {
      const u = this._upload();
      const l = this._load();
      const h = this._health();
      if (u === null || this._join() !== 'joined') return;
      const round = (n: number) => Math.round(n * 10) / 10;
      this.session.publishSendHealth(
        encodeSendHealth({
          // Em degraus de 0,25%, para não reescrever o atributo a cada leitura.
          l: Math.round(u.loss * 400) / 4,
          cap: round(u.cap / 1e6),
          max: round(u.target / 1e6),
          cpu: l?.pressure ?? '',
          lim: h?.sustained ? h.reason : 'none',
        }),
      );
    });
    void clipServer().then((c) => this._clipServer.set(c));
    // Gravação contínua para clipes: guarda sempre todas as telas (com o som delas), com ou sem
    // foco, enquanto estiver ligada. A lista é conferida de novo a cada 2 s pelo próprio gravador.
    effect(() => {
      const on = this.prefs.clips() && this.canClip() && this._join() === 'joined';
      for (const s of this.shares()) void [s.trackSid, s.hasAudio];
      void this.focused()?.id;
      if (!on) {
        this.clips.stop();
        return;
      }
      this.clips.watch(() => this.session.clipSources());
    });
    this.studio.setLatency(this.prefs.studioLatency());
    // Som de estúdio segue a mesma regra do som da tela: na grade todas, em foco só a dela.
    effect(() => {
      const focus = this.focused()?.id ?? null;
      this.studio.setAudible((id) => focus === null || focus === id);
    });
  }

  viewersOf(id: string) {
    return viewersOf(this._snapshot(), id);
  }
  watchersOf(id: string) {
    return watchersOf(this._snapshot(), id);
  }

  /** Sala da call do Discord (entrou sem link)? Aí o plugin ligado à conta já toca aqui. */
  get isCallRoom() {
    return this.link.key === '';
  }

  async join(link: RoomLink, name: string) {
    await this.joinWith(() => requestToken(link, name), link);
  }

  /** Entra com um token obtido de outro jeito (ex.: sala da call do Discord, sem link). */
  async joinWith(getGrant: () => Promise<JoinGrant>, link: RoomLink | null) {
    this._join.set('joining');
    this._error.set('');
    try {
      const grant = await getGrant();
      await this.session.connect(grant.url, grant.token);
      this.token = grant.token;
      this._canPublish.set(grant.canPublish);
      this._cameraOffered.set(grant.camera);
      this.link = link ?? { key: '', secret: '' };
      this._join.set('joined');
      this.diag.start();
      this.daw.start();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      this._error.set(
        /signal connection|Failed to fetch|websocket/i.test(msg)
          ? 'Não consegui falar com o servidor LiveKit. Ele está rodando? (npm run dev sobe tudo)'
          : msg || 'Não foi possível entrar.',
      );
      this._join.set('failed');
    }
  }

  unfocus() {
    this.session.unfocus();
  }
  detachShare(id: string, el: HTMLMediaElement) {
    this.session.detachShare(id, el);
  }
  attachShare(id: string, el: HTMLMediaElement) {
    return this.session.attachShare(id, el);
  }
  hideShare(id: string) {
    this.session.hideShare(id);
  }

  shieldStatus() {
    return this.session.shieldStatus();
  }

  /** Sai da proteção contra travadas e volta já para a qualidade máxima. */
  unshield(id: string) {
    this.session.unshield(id);
  }

  showShare(id: string) {
    this.session.showShare(id);
  }

  focusShare(id: string) {
    this.session.focusShare(id);
  }
  async unlockAudio() {
    await this.session.unlockAudio();
  }
  setVolume(channel: Channel, identity: string, level: number) {
    if (channel === 'share') this.studio.setVolumeFor(identity, level);
    this.session.setVolume(channel, identity, level);
  }
  toggleMute(channel: Channel, identity: string) {
    this.session.toggleMute(channel, identity);
    if (channel === 'share') {
      const v = this.session.read().shares.find((s) => s.id === identity)?.volume;
      if (v !== undefined) this.studio.setVolumeFor(identity, v.muted ? 0 : v.level);
    }
  }

  async sendingStats() {
    const r = await this.session.shareReport();
    return r === null ? null : this.sampler.readOutbound(r);
  }
  async sendingAudioStats() {
    const r = await this.session.shareAudioReport();
    return r === null ? null : this.sampler.readOutboundAudio(r);
  }
  async receivingStats() {
    const r = await this.session.focusedReport();
    return r === null ? null : this.sampler.readInbound(r);
  }
  async receivingAudioStats() {
    const r = await this.session.focusedAudioReport();
    return r === null ? null : this.sampler.readInboundAudio(r);
  }

  /** Som de estúdio (sem compressão) que chega de quem transmite. */
  readonly studio = new StudioHub(this.session.room);
  /** Som dos plugins de DAW desta sala (chega pelo servidor, não pelo LiveKit). */
  readonly daw = new DawListener(this.studio, () => this.token);

  /** Endereço e chave para o OBS transmitir nesta sala (ou na call, nas salas do Discord). */
  obsKey() {
    return requestObsKey(this.token);
  }

  /** Código para digitar no plugin de DAW (vale 10 min). */
  dawCode() {
    return requestDawCode(this.token);
  }

  /** A sala do LiveKit, para recursos que falam direto por ela (cursores). */
  get liveRoom() {
    return this.session.room;
  }

  attachFocused(el: HTMLMediaElement) {
    return this.session.attachFocused(el);
  }

  async toggleShare() {
    this._busy.set(true);
    try {
      if (this.sharing()) await this.session.stopShare();
      else await this.beginShare();
    } catch (e) {
      this.reportShareFailure(e, 'Não foi possível compartilhar a tela.');
    } finally {
      this._busy.set(false);
    }
  }

  async restartShare() {
    this._busy.set(true);
    try {
      await this.session.stopShare();
      await this.beginShare();
    } catch (e) {
      this.reportShareFailure(e, 'Não foi possível reiniciar o compartilhamento.');
    } finally {
      this._busy.set(false);
    }
  }

  async toggleWebcam(deviceId?: string) {
    this._busy.set(true);
    try {
      if (this.webcamOn()) await this.session.stopWebcam();
      else {
        if (this.sharing()) await this.session.stopShare();
        await this.session.startWebcam(deviceId);
      }
    } catch {
      this.toast.show('Não foi possível usar a câmera. Veja se o navegador tem permissão.');
    } finally {
      this._busy.set(false);
    }
  }

  async switchWebcam(id: string) {
    try {
      await this.session.switchDevice('videoinput', id);
    } catch {
      this.toast.show('Não foi possível trocar de câmera.');
    }
  }

  async switchMicrophone(id: string) {
    try {
      await this.session.switchDevice('audioinput', id);
    } catch {
      this.toast.show('Não foi possível trocar de microfone.');
    }
  }

  async toggleMic() {
    try {
      await this.session.setMicrophone(!this.micOn());
    } catch {
      this.toast.show('Não foi possível acessar o microfone.');
    }
  }

  async addCamera() {
    if (this._cameraBusy()) return;
    this._cameraBusy.set(true);
    try {
      this._camera.set(await requestCamera(this.link));
    } catch (e) {
      this.toast.show(e instanceof Error ? e.message : 'Não foi possível pegar um endereço de câmera.');
    } finally {
      this._cameraBusy.set(false);
    }
  }

  async revokeCameraKey() {
    this._cameraBusy.set(true);
    try {
      await revokeCamera(this.link);
      this._camera.set(null);
      this.toast.show('Essa chave de câmera não funciona mais.');
    } catch (e) {
      this.toast.show(e instanceof Error ? e.message : 'Não foi possível revogar a chave da câmera.');
    } finally {
      this._cameraBusy.set(false);
    }
  }

  private async beginShare() {
    if (this.webcamOn()) await this.session.stopWebcam();
    const r = await this.session.startShare(
      {
        plan: planFor(this.prefs.stream()),
        preferredCodec: this.prefs.codec(),
        includeAudio: this.prefs.shareAudio(),
        studio: this.prefs.studio() === 'off' ? null : (Number(this.prefs.studio()) as 16 | 24),
        maxCompatibility: this.prefs.maxCompatibility(),
        adaptToLoad: this.prefs.adaptToLoad(),
      },
      {
        onEndedByBrowser: () => void this.session.stopShare(),
        onHealth: (h) => this.handleHealth(h),
        onSilentAudio: () => void this.dropSilentAudio(),
        onLoad: (l) => this._load.set(l),
        onUpload: (u) => this._upload.set(u),
      },
    );
    this.watch = r.watch;
    this.governor = r.governor;
    this.uploadGuard?.stop();
    this.uploadGuard = r.upload;
    this._encoder.set({ codec: r.codec, gpu: r.gpu });
    this._liveSignature.set(this.prefs.signature());
    this._soundProblem.set(
      r.audio === 'refused' ? 'refused' : r.audio === 'published' && r.surface === 'monitor' ? 'whole-pc' : null,
    );
    this.toast.show(
      `Compartilhando ${r.resolution.width}x${r.resolution.height} em ${r.codec.toUpperCase()} ` +
        `(${r.gpu ? 'placa de vídeo' : 'processador'}) a até ${formatBitrate(r.bitrate)}`,
    );
  }

  private handleHealth(h: ShareHealth) {
    const wasLimited = this._health()?.sustained ?? false;
    this._health.set(h);
    if (wasLimited && !h.sustained) this.toast.show('A transmissão voltou à qualidade total.');
  }

  /** Para de mandar o som da tela, mantendo a imagem. */
  async dropShareAudio() {
    await this.session.stopAudio();
    this._soundProblem.set(null);
    this.toast.show('Som da tela desligado. A imagem continua.');
  }

  private async dropSilentAudio() {
    await this.session.stopAudio();
    this._soundProblem.set('silent');
  }

  private hintVolume(s: RoomSnapshot) {
    if (this.prefs.volumeHinted() || !s.participants.some((p) => p.isSpeaking && !p.isLocal)) return;
    this.prefs.setVolumeHinted(true);
    this.toast.show('Alto ou baixo demais? Abra "pessoas" no canto de cima para ajustar cada voz só pra você.');
  }

  private forgetShare() {
    this.governor?.stop();
    this.governor = null;
    this.uploadGuard?.stop();
    this.uploadGuard = null;
    this._upload.set(null);
    this._load.set(null);
    this._encoder.set(null);
    if (this._liveSignature() === null && this.watch === null) return;
    this.watch?.stop();
    this.watch = null;
    this._health.set(null);
    this._soundProblem.set(null);
    this._liveSignature.set(null);
  }

  private reportShareFailure(e: unknown, fallback: string) {
    if (e instanceof ScreenShareCancelledError) return;
    this.toast.show(e instanceof Error ? e.message : fallback);
  }
}
