import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { DiscordUser, callMembers, createGuestInvite, inviteToRoom, kickGuest, pingCall } from '../core/api';
import { encodeLink, isCallRoom, newKey, randomRoomName } from '../core/link';
import { IS_MOBILE } from '../core/device';
import { Prefs } from '../core/prefs';
import { RoomStore } from '../core/room-store';
import { Toast } from '../core/toast';
import { SendFx } from '../core/send-fx';
import { Icon } from './icon';
import { VolumeSlider } from './volume-slider';
import { PixelIcon } from './pixel-icon';
import { Activity, Surface, activityLine } from '../core/activity';

/** Quem está na sala e o volume de cada um, só para você. Cada pessoa é uma linha, como um canal de mesa. */
@Component({
  selector: 'cen-people-panel',
  imports: [Icon, VolumeSlider, PixelIcon],
  template: `
    @if (stageSound(); as s) {
      <p class="label">som da tela</p>
      <div class="strip stage-sound">
        <div class="row">
          <span class="avatar icon" aria-hidden="true"><cen-icon name="screen" [size]="15" /></span>
          <span class="who"><span class="name">{{ s.label }}</span></span>
        </div>
        <cen-volume class="fader" [volume]="s.share.volume" [label]="s.label"
          (levelChange)="store.setVolume('share', s.share.id, $event)"
          (muteToggle)="store.toggleMute('share', s.share.id)" />
      </div>
    }
    @for (st of store.studio.streams(); track st.key) {
      <p class="label">som de estúdio · sem compressão</p>
      <div class="rack">
        <div class="row">
          <span class="led" [class.ok]="!st.idle" [class.warn]="!st.idle && !st.playing"></span>
          <span class="who"><span class="name">{{ st.name }}</span></span>
          <span class="lcd fmt">{{ st.source === 'daw' ? 'DAW ' : '' }}{{ st.bits === 32 ? '32F' : st.bits + 'B' }} {{ st.rate / 1000 }}K</span>
        </div>
        <div class="row">
          <input type="range" min="0" max="1" step="0.01" [value]="studioVolume()" aria-label="Volume do som de estúdio"
            (input)="setStudioVolume(+$any($event.target).value)" />
          <span class="mono small">{{ (studioVolume() * 100).toFixed(0) }}%</span>
        </div>
        <div class="buffer" [title]="'Buffer: ' + (st.level * 1000).toFixed(0) + ' de ' + (st.target * 1000).toFixed(0) + ' ms'">
          <i [style.width.%]="bufferFill(st.level, st.target)"></i>
        </div>
        <p class="hint mono">
          @if (st.idle) {
            parada · nada tocando na DAW
          } @else {
          buffer {{ (st.level * 1000).toFixed(0) }} / {{ (st.target * 1000).toFixed(0) }} ms
          @if (!st.playing) { · carregando }
          }
          @if (st.underruns > 0) { · {{ st.underruns }} engasgo(s) }
          @if (st.lost > 0) { · {{ st.lost }} pacote(s) perdido(s) }
        </p>
        <div class="chips">
          @for (l of latencies; track l) {
            <button type="button" class="chip" [class.lit]="l === prefs.studioLatency()" (click)="setLatency(l)">{{ l * 1000 }} ms</button>
          }
        </div>
        <p class="hint">Engasgando? Aumente o atraso. Ele só afeta o som de estúdio.</p>
      </div>
    }

    <p class="label">na sala</p>
    <ul class="strips">
      @for (p of store.participants(); track p.identity) {
        <li class="strip" [class.speaking]="p.isSpeaking" [class.me]="p.isLocal" animate.enter="row-in" animate.leave="row-out">
          <div class="row">
            <span class="avatar" aria-hidden="true">
              @if (p.avatar) { <img [src]="p.avatar" alt="" width="28" height="28" /> } @else { <b>{{ initial(p.name) }}</b> }
            </span>
            <span class="who">
              <span class="name" [title]="p.name">{{ p.name }}</span>
              <span class="sub" [class.doing]="p.activity !== null">
                @if (p.activity; as a) {
                  <cen-pixel class="act-icon" [name]="actIcon(a.surface)" [size]="9" />{{ p.isLocal ? 'você · ' : '' }}{{ actText(a) }}
                }
                @else if (p.isLocal) { você{{ isMobile ? ' · no celular' : '' }} }
                @else if (p.myOtherDevice) { você · {{ p.mobile ? 'no celular' : 'no PC' }} }
                @else if (p.guest) { convidado{{ p.invitedBy ? ' de ' + p.invitedBy : '' }} }
                @else if (p.mobile) { no celular }
                @else if (p.isSpeaking) { falando }
                @else if (!p.micEnabled) { microfone fechado }
                @else { ouvindo }
              </span>
            </span>
            <span class="mic" [class.open]="p.micEnabled" [title]="p.micEnabled ? 'Microfone aberto' : 'Microfone fechado'">
              <cen-icon [name]="p.micEnabled ? 'mic' : 'micOff'" [size]="13" />
            </span>
            @if (p.isLocal ? isMobile : p.mobile) { <cen-icon class="device" name="phone" [size]="13" title="Pelo celular" /> }
            @if (p.activity; as a) {
              <span class="onair" [class.cam]="a.surface === 'camera'" [title]="a.surface === 'camera' ? 'Com a câmera ligada' : 'Transmitindo a tela'">
                <span class="led"></span>{{ a.surface === 'camera' ? 'câmera' : 'ao vivo' }}</span>
            }
            @if (p.guest && !p.isLocal && iAmDiscord()) {
              <button type="button" class="btn small kick" [class.danger]="kicking() === p.identity"
                [title]="'Tirar ' + p.name + ' da sala (o convite deixa de valer)'" (click)="kick(p.identity, p.name)">
                {{ kicking() === p.identity ? 'confirmar' : 'expulsar' }}
              </button>
            }
          </div>
          @if (p.myOtherDevice) {
            <p class="hint other">Seu outro aparelho. A voz dele não toca aqui, para não dar eco. Ligar o microfone num desliga no outro.</p>
          } @else if (!p.isLocal) {
            <cen-volume class="fader" [volume]="p.volume" [label]="'a voz de ' + p.name"
              (levelChange)="store.setVolume('mic', p.identity, $event)"
              (muteToggle)="store.toggleMute('mic', p.identity)" />
          }
        </li>
      }
    </ul>
    @if (store.participants().length === 1) {
      <p class="alone">Só você por aqui. Chame alguém!</p>
    }

    @if (outside().length > 0) {
      <p class="label">{{ callRoom ? 'na call, fora do site' : 'na sua call do Discord' }}</p>
      <ul class="strips">
        @for (m of outside(); track m.id) {
          <li class="strip outside" animate.enter="row-in" animate.leave="row-out">
            <div class="row">
              <span class="avatar" aria-hidden="true">
                @if (m.avatar) { <img [src]="m.avatar" alt="" width="28" height="28" /> } @else { <b>{{ initial(m.name) }}</b> }
              </span>
              <span class="who">
                <span class="name">{{ m.name }}</span>
                <span class="sub">na call, sem o site</span>
              </span>
              <button type="button" class="btn small invite" [class.busy]="inviting() === m.id"
                [disabled]="inviting() === m.id" (click)="invite(m)">
                <span class="env" aria-hidden="true"><cen-pixel name="letter" [size]="14" /></span>
                @if (inviting() === m.id) { <span class="dots"><i></i><i></i><i></i></span> } @else { convidar }
              </button>
            </div>
          </li>
        }
      </ul>
      <p class="hint tight">O bot manda o link no privado.</p>
    }

    @if (callRoom && iAmDiscord()) {
      <p class="label">chamar gente</p>
      <div class="keys">
        <button type="button" class="key" [disabled]="pinging()" (click)="ping()">
          <span class="px bell" style="color: #e2a12e"><cen-pixel name="bell" [size]="18" /></span>
          <span class="txt"><strong>{{ pinging() ? 'Avisando…' : 'Chamar a call' }}</strong>
            <span>o bot marca todo mundo no chat do canal de voz</span></span>
        </button>
        <button type="button" class="key" [disabled]="makingGuest()" (click)="guestInvite()"
          title="Link que só uma pessoa usa. Ela escolhe um apelido e entra nesta sala. Qualquer um daqui com Discord pode expulsar.">
          <span class="px letter" style="color: #94cf7c"><cen-pixel name="letter" [size]="18" /></span>
          <span class="txt"><strong>{{ makingGuest() ? 'Criando…' : 'Convite de 1 uso' }}</strong>
            <span>para quem não tem Discord</span></span>
        </button>
        <button type="button" class="key" (click)="privateRoom()">
          <span class="px lock" style="color: #9d8fe0"><cen-pixel name="lock" [size]="18" /></span>
          <span class="txt"><strong>Sala privada</strong>
            <span>só com quem você convidar</span></span>
        </button>
      </div>
    }
    <p class="foot">Os volumes valem só para você. O contorno verde é quem está falando.</p>
  `,
  styles: `
    :host { display: block; }
    .strips { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); box-shadow: 0 1px 0 rgb(255 255 255 / 0.03) inset; }

    /* Uma linha por pessoa, separadas por um sulco no metal (risco escuro + reflexo claro). */
    .strip { padding: 7px 2px 8px; border-bottom: 1px solid var(--line); box-shadow: 0 1px 0 rgb(255 255 255 / 0.035); }
    .row { display: flex; align-items: center; gap: 0.55rem; min-height: 30px; }

    /* Foto num rebaixo quadrado; quem fala ganha o contorno verde, sem brilho. */
    .avatar { flex-shrink: 0; width: 32px; height: 32px; padding: 2px; border-radius: 2px; background: var(--well);
      box-shadow: var(--inset); display: grid; place-items: center; color: var(--muted); }
    .avatar img, .avatar b { width: 28px; height: 28px; border-radius: 1px; object-fit: cover; display: grid; place-items: center;
      outline: 1px solid transparent; outline-offset: 1px; transition: outline-color 120ms; }
    .avatar b { font: 500 0.8rem/1 var(--mono); text-transform: uppercase; color: var(--muted); background: var(--surface-2); }
    .speaking .avatar img, .speaking .avatar b { outline-color: var(--ok); }

    .who { flex: 1; min-width: 0; display: grid; line-height: 1.2; }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.88rem; font-weight: 600; }
    .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 400 0.66rem/1.3 var(--mono);
      letter-spacing: 0.04em; color: var(--faint); }

    .mic { display: grid; place-items: center; color: var(--faint); flex-shrink: 0; }
    .mic.open { color: var(--muted); }
    .device { color: var(--faint); flex-shrink: 0; }
    /* Selo "ao vivo", como o do Discord, numa plaqueta vermelha com a lâmpada piscando. */
    .onair { display: inline-flex; align-items: center; gap: 0.3rem; flex-shrink: 0; height: 17px; padding: 0 0.4rem 0 0.35rem;
      border-radius: 1px; background: #8f2f26; color: #f6e7e2; font: 500 0.58rem/1 var(--mono); letter-spacing: 0.12em;
      text-transform: uppercase; box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.12), 0 1px 0 #000; animation: led-on 380ms steps(1) both; }
    .onair .led { width: 5px; height: 5px; background: #ff8a7a; box-shadow: 0 0 4px rgb(255 120 100 / 0.7); animation: blink 1.6s steps(1) infinite; }
    .onair.cam { background: var(--plate); color: var(--text); }
    .onair.cam .led { background: var(--ok); box-shadow: 0 0 4px rgb(127 168 100 / 0.5); animation: none; }
    /* O que está passando, no lugar do "ouvindo": como "Jogando Fortnite" no Discord. */
    .sub.doing { color: var(--accent-hi); display: flex; align-items: center; gap: 0.3rem; }
    .act-icon { flex-shrink: 0; }

    .fader { margin: 3px 0 0 calc(32px + 0.55rem - 4px); width: auto; }
    .kick { height: 22px; padding: 0 0.5rem; font-size: 0.72rem; }
    .other { margin: 0.3rem 0 0 calc(32px + 0.55rem); font-size: 0.75rem; }
    .alone { margin: 0.7rem 0 0; font-size: 0.82rem; color: var(--muted); }

    /* Na call, fora do site: a mesma linha, apagada. */
    .outside .avatar img { filter: grayscale(1); opacity: 0.55; }
    .outside .name { color: var(--muted); font-weight: 500; }
    .invite { position: relative; height: 24px; min-width: 68px; font-size: 0.72rem; }
    /* Passar o mouse em convidar: uma cartinha sai de dentro da tecla e fica flutuando, pronta para ir. */
    .env { position: absolute; left: 50%; top: 2px; margin-left: -7px; color: #ebe6da; pointer-events: none; opacity: 0;
      clip-path: inset(0 0 100% 0); transition: transform 200ms steps(4), opacity 1ms 0ms, clip-path 200ms steps(4); }
    .invite:hover:not(:disabled) .env { opacity: 1; clip-path: inset(0 0 0 0); transform: translateY(-17px);
      animation: env-bob 900ms steps(2) 220ms infinite; }
    .invite.busy .env { opacity: 1; clip-path: none; animation: env-go 520ms steps(6) forwards; }
    @keyframes env-bob { 50% { translate: 0 -2px; } }
    @keyframes env-go { from { transform: translateY(-17px); } 40% { transform: translate(-6px, -24px); }
      to { transform: translate(70px, -40px); opacity: 0; } }

    /* Entrou alguém: a linha liga como um visor, de cima para baixo. Saiu: espreme e some. */
    .row-in { animation: row-in 360ms steps(6) both; }
    .row-out { animation: row-out 300ms steps(5) both; }
    @keyframes row-in { from { clip-path: inset(0 0 100% 0); filter: brightness(1.8); } 60% { filter: brightness(1.3); }
      to { clip-path: inset(0 0 0 0); filter: none; } }
    @keyframes row-out { 40% { transform: scaleY(0.06); filter: brightness(2); } to { transform: scale(0, 0.06); opacity: 0; } }
    .dots { display: inline-flex; gap: 3px; }
    .dots i { width: 3px; height: 3px; background: currentColor; animation: blink 0.9s steps(1) infinite; }
    .dots i:nth-child(2) { animation-delay: 0.3s; } .dots i:nth-child(3) { animation-delay: 0.6s; }
    .tight { margin-top: 0.45rem; font-size: 0.75rem; }

    /* Chamar gente: teclas duras, uma embaixo da outra. */
    .keys { display: grid; gap: 6px; }
    .key { display: flex; align-items: center; gap: 0.7rem; width: 100%; padding: 0.5rem 0.7rem 0.55rem; text-align: left;
      border-radius: var(--radius); border: 1px solid #0b0b0c; background: var(--plate); color: var(--text); box-shadow: var(--key-shadow);
      transition: transform 60ms linear, box-shadow 60ms linear, background 120ms; }
    .key:hover:not(:disabled) { background: var(--plate-hi); }
    .key:active:not(:disabled) { transform: translateY(2px); box-shadow: var(--key-pressed); }
    /* Ícone de pixel num visor escuro, sem brilho. */
    .px { flex-shrink: 0; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 2px;
      background: #111110; box-shadow: var(--inset); }
    .key:active:not(:disabled) .px { translate: 0 1px; }
    /* Cada ícone faz o seu ao passar o mouse: o sino toca, a carta pula, o cadeado abre e fecha. */
    .key:hover:not(:disabled) .px.bell cen-pixel { animation: ring 480ms steps(2) 2; transform-origin: 50% 0; }
    .key:hover:not(:disabled) .px.letter cen-pixel { animation: hop 520ms steps(3) infinite; }
    .key:hover:not(:disabled) .px.lock cen-pixel { animation: unlock 700ms steps(2) infinite; }
    @keyframes ring { 0%, 100% { transform: rotate(0); } 25% { transform: rotate(-16deg); } 75% { transform: rotate(16deg); } }
    @keyframes hop { 50% { transform: translateY(-3px); } }
    @keyframes unlock { 50% { clip-path: inset(0 0 0 0); transform: translateY(-2px); } }
    .txt { display: grid; gap: 1px; min-width: 0; }
    .txt strong { font-size: 0.84rem; font-weight: 600; }
    .txt span { font-size: 0.72rem; color: var(--muted); line-height: 1.3; }

    /* Som de estúdio: visor rebaixado. */
    .rack { padding: 6px 8px 8px; border-radius: 2px; background: var(--well); box-shadow: var(--inset); margin-bottom: 0.3rem; }
    .rack .row + .row { margin-top: 2px; }
    .rack input[type=range] { flex: 1; accent-color: var(--accent-hi); }
    .fmt { height: 18px; font-size: 0.62rem; padding: 0 0.35rem; }
    .buffer { height: 4px; margin: 6px 0 2px; background: #0a0a0b; overflow: hidden; }
    .buffer i { display: block; height: 100%; background: var(--ok); transition: width 200ms linear; }
    .small { font-size: 0.75rem; }
    .chips { margin-top: 0.4rem; }

    .foot { margin: 1rem 0 0; font-size: 0.72rem; color: var(--muted); }

    @media (hover: none) {
      .key { padding: 0.65rem 0.75rem; }
      .invite { height: 30px; }
    }
  `,
})
export class PeoplePanel {
  protected readonly store = inject(RoomStore);
  private readonly toast = inject(Toast);
  private readonly fx = inject(SendFx);
  private readonly router = inject(Router);
  protected readonly callRoom = isCallRoom();
  protected readonly isMobile = IS_MOBILE;

  actIcon(s: Surface): string {
    return s === 'window' ? 'window' : s === 'browser' ? 'tab' : s === 'camera' ? 'webcam' : s === 'obs' ? 'obs' : 'monitor';
  }

  actText(a: Activity): string {
    if (a.surface === 'camera') return 'câmera ligada';
    return a.surface === 'monitor' || a.surface === '' ? 'transmitindo a tela' : `transmitindo ${activityLine(a)}`;
  }

  /** Primeira letra do nome, para a telinha de quem não tem foto. */
  initial(name: string): string {
    return [...name.trim()][0] ?? '?';
  }

  bufferFill(level: number, target: number): number {
    return target > 0 ? Math.min(100, (level / target) * 100) : 0;
  }
  /** Entrei com Discord (convidado não gera convite nem expulsa ninguém). */
  protected readonly iAmDiscord = computed(() => this.store.participants().some((p) => p.isLocal && p.discordId !== null));
  protected readonly makingGuest = signal(false);
  protected readonly kicking = signal<string | null>(null);
  private kickTimer?: number;

  async guestInvite() {
    this.makingGuest.set(true);
    const run = this.fx.start({
      title: 'Criando convite de 1 uso',
      from: 'folder',
      item: 'ticket',
      to: 'clipboard',
      line: 'Imprimindo um convite que só uma pessoa usa',
    });
    try {
      const { id } = await createGuestInvite();
      const link = `${location.origin}/call#convite=${id}`;
      let copied = false;
      try {
        await navigator.clipboard.writeText(link);
        copied = true;
      } catch {
        /* sem permissão de copiar */
      }
      if (copied) {
        run.done('Convite copiado. Vale por 12 h ou até alguém usar.');
      } else {
        run.done('Convite criado. Mande o link para a pessoa.');
        if ('share' in navigator) await navigator.share({ title: 'Convite para a call', url: link }).catch(() => undefined);
        else window.prompt('Copie o convite:', link);
      }
    } catch (e) {
      run.fail(e instanceof Error ? e.message : 'Não foi possível criar o convite.');
    } finally {
      this.makingGuest.set(false);
    }
  }

  /** Primeiro clique arma, o segundo (em até 3 s) expulsa. */
  async kick(identity: string, name: string) {
    window.clearTimeout(this.kickTimer);
    if (this.kicking() !== identity) {
      this.kicking.set(identity);
      this.kickTimer = window.setTimeout(() => this.kicking.set(null), 3000);
      return;
    }
    this.kicking.set(null);
    try {
      await kickGuest(identity);
      this.toast.show(`${name} saiu da sala. O convite dele não vale mais.`);
    } catch (e) {
      this.toast.show(e instanceof Error ? e.message : 'Não foi possível expulsar.');
    }
  }
  private readonly members = signal<DiscordUser[]>([]);
  protected readonly pinging = signal(false);
  protected readonly inviting = signal<string | null>(null);
  protected readonly prefs = inject(Prefs);
  protected readonly latencies = [0.1, 0.25, 0.5, 1];
  protected readonly studioVolume = signal(1);

  setStudioVolume(v: number) {
    this.studioVolume.set(v);
    this.store.studio.setVolume(v);
  }

  setLatency(seconds: number) {
    this.prefs.setStudioLatency(seconds);
    this.store.studio.setLatency(seconds);
  }
  protected readonly stageSound = computed(() => {
    const f = this.store.focused();
    if (f === null || f.isLocal || !f.hasAudio) return null;
    return { share: f, label: f.isIngress ? f.ownerName : f.obs ? `${f.ownerName} (OBS)` : `${f.ownerName} (${f.kind === 'camera' ? 'câmera' : 'tela'})` };
  });
  /** Quem está na call do Discord mas não está nesta sala do site. */
  protected readonly outside = computed(() => {
    const inside = new Set(this.store.participants().map((p) => p.discordId));
    return this.members().filter((m) => !inside.has(m.id));
  });

  constructor() {
    // Em qualquer sala, se a pessoa está logada e numa call, mostra quem está na call
    // (na sala da call para ver quem falta; numa sala privada para convidar).
    const load = () =>
      // Convidado (sem Discord) não tem call para olhar.
      this.store.participants().some((p) => p.isLocal && p.guest)
        ? Promise.resolve()
        : callMembers()
        .then((r) => this.members.set(r.people))
        .catch(() => this.members.set([]));
    void load();
    // Vem do cache do bot (não chama a API do Discord), então dá para olhar a cada 2 s.
    const timer = setInterval(load, 2000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  async ping() {
    this.pinging.set(true);
    const run = this.fx.start({
      title: 'Chamando a call',
      from: 'bell',
      item: 'letter',
      to: 'people',
      line: 'O bot está marcando todo mundo no chat do canal de voz',
    });
    try {
      const r = await pingCall();
      run.done(`Avisei ${r.count} ${r.count === 1 ? 'pessoa' : 'pessoas'} no chat da call.`);
    } catch (e) {
      run.fail(e instanceof Error ? e.message : 'Não foi possível avisar a call.');
    } finally {
      this.pinging.set(false);
    }
  }

  async invite(m: DiscordUser) {
    this.inviting.set(m.id);
    const run = this.fx.start({
      title: `Convidando ${m.name}`,
      from: 'letter',
      item: 'letter',
      to: 'mailbox',
      line: `Mandando o link no privado de ${m.name}`,
    });
    try {
      // Na sala da call, convida para o site (a pessoa entra com o Discord e cai na call);
      // numa sala privada, manda o link desta sala.
      await inviteToRoom(m.id, this.callRoom ? `${location.origin}/` : location.href);
      run.done(`Pronto, o link chegou no privado de ${m.name}.`);
    } catch (e) {
      run.fail(e instanceof Error ? e.message : 'Não foi possível convidar.');
    } finally {
      this.inviting.set(null);
    }
  }

  privateRoom() {
    // Sai da sala da call e abre uma sala avulsa nova, com chave própria.
    void this.router.navigateByUrl(`/room/${randomRoomName()}#${encodeLink({ key: newKey(), secret: '' })}`);
  }
}
