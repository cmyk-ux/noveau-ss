import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {
  AudioPresets,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
} from 'livekit-client';
import { requestPhoneToken } from '../core/api';
import { Icon } from '../ui/icon';

const HOLDER_KEY = 'noveau:phone-holder';
/** O PC saiu da sala: espera um pouco (recarregar a página) antes de pausar câmera e microfone. */
const OWNER_GRACE_MS = 20_000;

type Step = 'connecting' | 'live' | 'kicked' | 'lost' | 'error';
type Facing = 'environment' | 'user';

/**
 * Câmera traseira em 1080p a 30 fps, como o Iriun. H.264: o celular codifica no chip de vídeo
 * (esquenta menos e gasta menos bateria que VP8, que seria no processador). Com uma cópia em 360p
 * para a janelinha do canto e para quem tem internet ruim.
 */
const CAPTURE = { width: 1920, height: 1080, frameRate: 30 };
const VIDEO_PUBLISH = {
  videoCodec: 'h264' as const,
  simulcast: true,
  videoEncoding: { maxBitrate: 4_000_000, maxFramerate: 30 },
  videoSimulcastLayers: [VideoPresets.h360],
  degradationPreference: 'balanced' as const,
};
const AUDIO_PUBLISH = { audioPreset: AudioPresets.musicHighQuality, dtx: false, red: true };

function holderId(): string {
  try {
    const saved = localStorage.getItem(HOLDER_KEY);
    if (saved !== null && saved.length >= 16) return saved;
    const b = new Uint8Array(18);
    crypto.getRandomValues(b);
    const id = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(HOLDER_KEY, id);
    return id;
  } catch {
    // Sem localStorage: vale só enquanto a página estiver aberta.
    return Array.from(crypto.getRandomValues(new Uint8Array(18)), (x) =>
      x.toString(16).padStart(2, '0'),
    ).join('');
  }
}

/**
 * /celular#CÓDIGO: o celular vira a câmera (e, se quiser, o microfone) do PC que gerou o link.
 * Entra na sala do PC sem receber nada (não gasta a internet do celular nem faz eco) e manda só
 * o que estiver ligado. O PC também liga e desliga as duas coisas daqui de longe.
 */
@Component({
  selector: 'cen-phone-page',
  imports: [Icon],
  template: `
    <div class="phone">
      <header class="masthead">
        <img class="logo pixel" src="logo.svg" alt="" width="36" height="36" />
        <div class="titles">
          <h1>Câmera do PC</h1>
          <p class="label sub">
            {{ owner() ? 'celular de ' + owner() : 'celular como câmera e microfone' }}
          </p>
        </div>
      </header>

      @switch (step()) {
        @case ('connecting') {
          <div class="card note">
            <p class="hint"><span class="led warn"></span> Conectando à sala…</p>
          </div>
        }
        @case ('kicked') {
          <div class="card note">
            <p class="lead">O PC desconectou este celular.</p>
            <p class="hint">
              Para usar de novo, gere outro link no PC (tecla da câmera › Usar o celular).
            </p>
          </div>
        }
        @case ('lost') {
          <div class="card note">
            <p class="lead">A conexão caiu.</p>
            <button class="btn primary wide" (click)="reconnect()">Conectar de novo</button>
          </div>
        }
        @case ('error') {
          <div class="card note">
            <p class="error" role="alert">{{ error() }}</p>
          </div>
        }
        @case ('live') {
          <div class="monitor" [class.dark]="!camOn()">
            <video #preview autoplay playsinline muted [class.mirror]="facing() === 'user'"></video>
            @if (!camOn()) {
              <div class="bars" aria-hidden="true">
                <i></i><i></i><i></i><i></i><i></i><i></i><i></i>
              </div>
              <p class="off mono">câmera desligada</p>
            }
            <span class="lcd readout">
              <span class="led" [class.on]="sending()"></span>{{ readout() }}
            </span>
          </div>

          @if (paused()) {
            <p class="banner mono">o PC saiu da sala · volta sozinho quando ele entrar de novo</p>
          }

          <div class="keys">
            <button
              type="button"
              class="key"
              [class.lit]="camOn()"
              [disabled]="busy()"
              (click)="setCam(!camOn())"
            >
              <span class="led" [class.on]="camOn()"></span>
              <cen-icon [name]="camOn() ? 'camera' : 'cameraOff'" [size]="22" />
              <span class="cap">câmera</span>
            </button>
            <button
              type="button"
              class="key"
              [class.lit]="micOn()"
              [disabled]="busy()"
              (click)="setMic(!micOn())"
            >
              <span class="led" [class.on]="micOn()"></span>
              <cen-icon [name]="micOn() ? 'mic' : 'micOff'" [size]="22" />
              <span class="cap">microfone</span>
            </button>
            <button type="button" class="key" [disabled]="busy() || !camOn()" (click)="flip()">
              <span class="led"></span>
              <cen-icon name="rotate" [size]="22" />
              <span class="cap">{{ facing() === 'environment' ? 'traseira' : 'frontal' }}</span>
            </button>
          </div>

          <p class="label">som do microfone</p>
          <div class="chips" role="radiogroup">
            <button
              type="button"
              class="chip"
              role="radio"
              [class.lit]="voice()"
              [attr.aria-checked]="voice()"
              (click)="setVoice(true)"
            >
              voz limpa
            </button>
            <button
              type="button"
              class="chip"
              role="radio"
              [class.lit]="!voice()"
              [attr.aria-checked]="!voice()"
              (click)="setVoice(false)"
            >
              som cru (música)
            </button>
          </div>
          <p class="hint">
            {{
              voice()
                ? 'Tira eco e ruído de fundo, como num app de chamada.'
                : 'Sem filtro nenhum: para instrumento, música ou som ambiente.'
            }}
          </p>

          <p class="hint">
            Deixe esta página aberta e a tela ligada: com a tela apagada o celular corta a câmera. O
            som e a imagem vão direto para a sala; este celular não recebe nada dela.
          </p>
          <button type="button" class="btn small ghost-plain" (click)="leave()">sair</button>
        }
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-height: 100dvh;
      background-color: #141415;
      background-image: var(--grain);
      background-size: 160px 160px;
    }
    .phone {
      width: min(480px, 100%);
      margin: 0 auto;
      padding: max(0.9rem, env(safe-area-inset-top)) 1rem calc(1.2rem + env(safe-area-inset-bottom));
      display: flex;
      flex-direction: column;
      gap: 0.8rem;
    }
    .masthead {
      display: flex;
      align-items: center;
      gap: 0.7rem;
      padding-bottom: 0.7rem;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0;
      font-size: 1.8rem;
    }
    .sub {
      margin: 0.15rem 0 0;
    }
    .note {
      padding: 1rem 1.1rem;
    }
    .lead {
      margin: 0 0 0.4rem;
      font-size: 1.05rem;
    }
    .note .led {
      width: 7px;
      height: 7px;
      display: inline-block;
      margin-right: 0.3rem;
    }
    /* Monitor de estúdio: a prévia da câmera dentro de uma moldura, com o visor por cima. */
    .monitor {
      position: relative;
      aspect-ratio: 16 / 9;
      border-radius: 3px;
      overflow: hidden;
      background: #000;
      box-shadow:
        0 0 0 1px #0b0b0c,
        0 0 0 4px #2a2a2b,
        0 0 0 5px #0b0b0c;
      animation: crt-on 420ms var(--ease) both;
    }
    .monitor video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .monitor video.mirror {
      transform: scaleX(-1);
    }
    .monitor.dark video {
      visibility: hidden;
    }
    .bars {
      position: absolute;
      inset: 0 0 auto;
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      height: 40%;
      opacity: 0.35;
    }
    .bars i:nth-child(1) {
      background: #b9b5aa;
    }
    .bars i:nth-child(2) {
      background: #b3a457;
    }
    .bars i:nth-child(3) {
      background: #5c9a9c;
    }
    .bars i:nth-child(4) {
      background: #678f58;
    }
    .bars i:nth-child(5) {
      background: #7d6fae;
    }
    .bars i:nth-child(6) {
      background: #a5493f;
    }
    .bars i:nth-child(7) {
      background: #4a4a86;
    }
    .off {
      position: absolute;
      left: 0;
      right: 0;
      top: 55%;
      text-align: center;
      margin: 0;
      font-size: 0.72rem;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: var(--warn);
    }
    .readout {
      position: absolute;
      left: 8px;
      bottom: 8px;
      height: 24px;
      padding: 0 0.5rem;
      gap: 0.4rem;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .readout .led {
      width: 6px;
      height: 6px;
      background: rgb(29 34 25 / 0.25);
      box-shadow: none;
    }
    .readout .led.on {
      background: var(--lcd-ink);
      animation: blink 1.6s steps(1) infinite;
    }
    .banner {
      margin: 0;
      padding: 0.45rem 0.6rem;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--warn);
      border-left: 3px solid var(--warn);
      background:
        repeating-linear-gradient(-45deg, rgb(208 154 58 / 0.08) 0 10px, transparent 10px 20px),
        var(--surface);
    }
    /* Teclas grandes de painel, com LED em cima, para o dedo. */
    .keys {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.55rem;
      padding: 0.5rem;
      border-radius: 3px;
      background: var(--well);
      box-shadow: var(--inset);
    }
    .key {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.35rem;
      padding: 0.8rem 0.3rem 0.6rem;
      border: 1px solid #0b0b0c;
      border-radius: 3px;
      background: var(--plate);
      color: var(--muted);
      box-shadow: var(--key-shadow);
    }
    .key:active:not(:disabled) {
      transform: translateY(2px);
      box-shadow: var(--key-pressed);
    }
    .key.lit {
      transform: translateY(2px);
      box-shadow: var(--key-pressed);
      background: #303031;
      color: var(--text);
    }
    .key .led {
      position: absolute;
      top: 6px;
      right: 7px;
      width: 6px;
      height: 6px;
      background: #3a2422;
      box-shadow: inset 0 1px 1px #0008;
    }
    .key .led.on {
      background: var(--danger);
      box-shadow:
        0 0 0 1px #0008,
        0 0 5px rgb(196 73 60 / 0.6);
      animation: led-on 380ms steps(1) both;
    }
    .cap {
      font: 500 0.64rem/1 var(--mono);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .label {
      margin: 0.2rem 0 0;
    }
    .hint {
      margin: 0;
    }
    .ghost-plain {
      align-self: center;
      background: transparent;
      box-shadow: none;
      color: var(--muted);
    }
  `,
})
export class PhonePage {
  private readonly code = decodeURIComponent(location.hash.replace(/^#/, ''));
  private readonly preview = viewChild<ElementRef<HTMLVideoElement>>('preview');
  protected readonly step = signal<Step>('connecting');
  protected readonly error = signal('');
  protected readonly owner = signal('');
  protected readonly camOn = signal(false);
  protected readonly micOn = signal(false);
  protected readonly busy = signal(false);
  protected readonly facing = signal<Facing>('environment');
  protected readonly voice = signal(true);
  protected readonly paused = signal(false);
  private readonly settings = signal('');
  protected readonly sending = computed(() => !this.paused() && (this.camOn() || this.micOn()));
  protected readonly readout = computed(() => {
    if (this.paused()) return 'pausado';
    const parts = [
      this.camOn() ? this.settings() || 'câmera' : '',
      this.micOn() ? 'mic' : '',
    ].filter((p) => p !== '');
    return parts.length === 0 ? 'nada no ar' : `no ar · ${parts.join(' · ')}`;
  });

  private room: Room | null = null;
  /** O que o PC (ou você aqui) quer ligado; a pausa (PC fora da sala) não muda isso. */
  private want = { cam: true, mic: false };
  private ctlSeen = -1;
  private sawOwner = false;
  private ownerTimer?: number;
  private wakeLock: { release(): Promise<void> } | null = null;

  constructor() {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void this.keepAwake();
      void this.reviveCamera();
    };
    document.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('visibilitychange', onVisible);
      window.clearTimeout(this.ownerTimer);
      void this.wakeLock?.release().catch(() => undefined);
      void this.room?.disconnect();
    });
    void this.connect();
  }

  private async connect() {
    this.step.set('connecting');
    if (this.code === '')
      return this.fail(
        'Este link está incompleto. Abra de novo o link (ou o QR) que aparece no PC.',
      );
    if (navigator.mediaDevices?.getUserMedia === undefined) {
      return this.fail(
        'Este navegador não deixa usar a câmera nesta página. Abra o link pelo endereço https do site, no Chrome ou no Safari.',
      );
    }
    try {
      const grant = await requestPhoneToken(this.code, holderId());
      this.owner.set(grant.name);
      const room = new Room({ adaptiveStream: false, dynacast: true });
      this.room = room;
      room
        .on(RoomEvent.Disconnected, (reason) => {
          this.camOn.set(false);
          this.micOn.set(false);
          this.step.set(
            reason === DisconnectReason.PARTICIPANT_REMOVED
              ? 'kicked'
              : this.step() === 'kicked'
                ? 'kicked'
                : 'lost',
          );
        })
        .on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
          if (p === room.localParticipant) this.readAttributes();
        })
        .on(RoomEvent.ParticipantConnected, () => this.checkOwner())
        .on(RoomEvent.ParticipantDisconnected, () => this.checkOwner())
        .on(RoomEvent.LocalTrackPublished, () => this.showPreview())
        .on(RoomEvent.MediaDevicesError, () =>
          this.fail(
            'O celular não deixou usar a câmera ou o microfone. Dê a permissão no navegador e recarregue.',
          ),
        );
      await room.connect(grant.url, grant.token, { autoSubscribe: false });
      this.step.set('live');
      void this.keepAwake();
      this.readAttributes();
      this.checkOwner();
      await this.apply();
    } catch (e) {
      this.fail(e instanceof Error ? e.message : 'Não foi possível conectar.');
    }
  }

  reconnect() {
    void this.room?.disconnect();
    this.room = null;
    void this.connect();
  }

  leave() {
    void this.room?.disconnect();
    this.step.set('lost');
  }

  private fail(msg: string) {
    this.error.set(msg);
    this.step.set('error');
  }

  /** O PC mandou ligar/desligar algo (atributo "ctl", com um contador para cada pedido). */
  private readAttributes() {
    const raw = this.room?.localParticipant.attributes?.['ctl'];
    if (raw === undefined) return;
    try {
      const c = JSON.parse(raw);
      if (typeof c.n !== 'number' || c.n === this.ctlSeen) return;
      this.ctlSeen = c.n;
      this.want = { cam: c.cam === true, mic: c.mic === true };
      void this.apply();
    } catch {
      /* atributo estranho: ignora */
    }
  }

  /** O PC dono deste celular está na sala? Se sair (e não voltar logo), pausa tudo. */
  private checkOwner() {
    const room = this.room;
    if (room === null) return;
    const of = room.localParticipant.attributes?.['phoneOf'];
    const here = of !== undefined && room.remoteParticipants.has(of);
    window.clearTimeout(this.ownerTimer);
    if (here) {
      this.sawOwner = true;
      if (this.paused()) {
        this.paused.set(false);
        void this.apply();
      }
      return;
    }
    // Só pausa se já tinha visto o PC (se a sala não mostrar os outros, nunca pausa à toa).
    if (!this.sawOwner) return;
    this.ownerTimer = window.setTimeout(() => {
      this.paused.set(true);
      void this.apply();
    }, OWNER_GRACE_MS);
  }

  setCam(on: boolean) {
    this.want = { ...this.want, cam: on };
    void this.apply();
  }

  setMic(on: boolean) {
    this.want = { ...this.want, mic: on };
    void this.apply();
  }

  /** Liga/desliga de verdade conforme o pedido e a pausa. Câmera desligada solta o sensor (sem luz). */
  private async apply() {
    const room = this.room;
    if (room === null || this.step() !== 'live') return;
    const cam = this.want.cam && !this.paused();
    const mic = this.want.mic && !this.paused();
    this.busy.set(true);
    try {
      if (cam !== this.camOn()) {
        await room.localParticipant.setCameraEnabled(
          cam,
          { facingMode: this.facing(), resolution: CAPTURE },
          VIDEO_PUBLISH,
        );
        this.camOn.set(cam);
        this.readSettings();
        this.showPreview();
      }
      if (mic !== this.micOn()) {
        await room.localParticipant.setMicrophoneEnabled(mic, this.micOptions(), AUDIO_PUBLISH);
        this.micOn.set(mic);
      }
    } catch (e) {
      this.fail(
        e instanceof Error && /Permission|NotAllowed/i.test(e.name + e.message)
          ? 'O celular não deixou usar a câmera ou o microfone. Dê a permissão no navegador e recarregue a página.'
          : e instanceof Error
            ? e.message
            : 'Não foi possível ligar a câmera ou o microfone.',
      );
    } finally {
      this.busy.set(false);
    }
  }

  private micOptions() {
    const v = this.voice();
    return { echoCancellation: v, noiseSuppression: v, autoGainControl: v, channelCount: 1 };
  }

  async setVoice(v: boolean) {
    if (this.voice() === v) return;
    this.voice.set(v);
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (track instanceof LocalAudioTrack)
      await track.restartTrack(this.micOptions()).catch(() => undefined);
  }

  /** Troca câmera traseira/frontal sem sair do ar. */
  async flip() {
    const next: Facing = this.facing() === 'environment' ? 'user' : 'environment';
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (!(track instanceof LocalVideoTrack)) return;
    this.busy.set(true);
    try {
      await track.restartTrack({ facingMode: next, resolution: CAPTURE });
      this.facing.set(next);
      this.readSettings();
      this.showPreview();
    } catch {
      /* celular com uma câmera só */
    } finally {
      this.busy.set(false);
    }
  }

  /** Voltou para a página: o celular pode ter cortado a câmera enquanto estava em segundo plano. */
  private async reviveCamera() {
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (
      !(track instanceof LocalVideoTrack) ||
      !this.camOn() ||
      track.mediaStreamTrack.readyState !== 'ended'
    )
      return;
    await track
      .restartTrack({ facingMode: this.facing(), resolution: CAPTURE })
      .catch(() => undefined);
    this.showPreview();
  }

  private showPreview() {
    const el = this.preview()?.nativeElement;
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (el === undefined || track === undefined) return;
    track.attach(el);
  }

  private readSettings() {
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    const s = track?.mediaStreamTrack.getSettings();
    this.settings.set(
      s?.width && s.height
        ? `${Math.max(s.width, s.height) === s.width ? s.height : s.width}p${s.frameRate ? Math.round(s.frameRate) : ''}`
        : '',
    );
  }

  /** Tela do celular apagada corta a câmera: pede para ela ficar acesa. */
  private async keepAwake() {
    const wl = (
      navigator as Navigator & {
        wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> };
      }
    ).wakeLock;
    if (wl === undefined || document.hidden || this.wakeLock !== null) return;
    try {
      const lock = await wl.request('screen');
      this.wakeLock = lock;
      (lock as unknown as EventTarget).addEventListener?.('release', () => (this.wakeLock = null));
    } catch {
      /* bateria fraca ou negado */
    }
  }
}
