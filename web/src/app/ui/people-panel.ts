import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { DiscordUser, callMembers, createGuestInvite, inviteToRoom, kickGuest, pingCall } from '../core/api';
import { encodeLink, isCallRoom, newKey, randomRoomName } from '../core/link';
import { IS_MOBILE } from '../core/device';
import { Prefs } from '../core/prefs';
import { RoomStore } from '../core/room-store';
import { Toast } from '../core/toast';
import { Icon } from './icon';
import { VolumeSlider } from './volume-slider';

/** Desenhos em pixel (9x9) das teclas de "chamar gente", no traço da logo. */
const PIXEL_ART: Record<string, string[]> = {
  bell: ['....#....', '...###...', '..#####..', '..#####..', '..#####..', '.#######.', '#########', '.........', '....#....'],
  letter: ['.........', '#########', '##.....##', '#.#...#.#', '#..#.#..#', '#...#...#', '#.......#', '#########', '.........'],
  lock: ['..#####..', '.##...##.', '.#.....#.', '.#.....#.', '#########', '####.####', '###...###', '####.####', '#########'],
};
function pixels(rows: string[]): { x: number; y: number }[] {
  return rows.flatMap((row, y) => [...row].flatMap((c, x) => (c === '#' ? [{ x, y }] : [])));
}

/** Quem está na sala e o volume de cada um, só para você. Cada pessoa é um canal da mesa. */
@Component({
  selector: 'cen-people-panel',
  imports: [Icon, VolumeSlider],
  template: `
    @if (stageSound(); as s) {
      <p class="label">som da tela</p>
      <div class="strip stage-sound">
        <div class="row">
          <span class="monitor wide" aria-hidden="true"><cen-icon name="screen" [size]="16" /></span>
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
          <span class="led ok" [class.warn]="!st.playing"></span>
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
          buffer {{ (st.level * 1000).toFixed(0) }} / {{ (st.target * 1000).toFixed(0) }} ms
          @if (!st.playing) { · carregando }
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
      @for (p of store.participants(); track p.identity; let i = $index) {
        <li class="strip" [class.speaking]="p.isSpeaking" [class.me]="p.isLocal" [class.twin]="p.myOtherDevice" [style.--i]="i">
          <div class="row">
            <span class="monitor" [class.talk]="p.isSpeaking" aria-hidden="true">
              @if (p.avatar) {
                <img [src]="p.avatar" alt="" width="26" height="26" />
              } @else {
                <b>{{ initial(p.name) }}</b>
              }
            </span>
            <span class="who">
              <span class="name" [title]="p.name">{{ p.name }}</span>
              <span class="sub">
                @if (p.isLocal) { você{{ isMobile ? ' · no celular' : '' }} }
                @else if (p.myOtherDevice) { você · {{ p.mobile ? 'no celular' : 'no PC' }} }
                @else if (p.guest) { convidado{{ p.invitedBy ? ' de ' + p.invitedBy : '' }} }
                @else if (p.mobile) { no celular }
                @else if (p.isSpeaking) { falando }
                @else if (!p.micEnabled) { microfone fechado }
                @else { ouvindo }
              </span>
            </span>
            <span class="eq" [class.on]="p.isSpeaking" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
            <span class="mic" [class.open]="p.micEnabled" [title]="p.micEnabled ? 'Microfone aberto' : 'Microfone fechado'">
              <cen-icon [name]="p.micEnabled ? 'mic' : 'micOff'" [size]="13" />
            </span>
            @if (p.isLocal ? isMobile : p.mobile) { <cen-icon class="device" name="phone" [size]="13" title="Pelo celular" /> }
            @if (p.isSharing) { <span class="onair" title="Compartilhando a tela"><i></i>ao vivo</span> }
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
        @for (m of outside(); track m.id; let i = $index) {
          <li class="strip outside" [style.--i]="i">
            <div class="row">
              <span class="monitor off" aria-hidden="true">
                @if (m.avatar) { <img [src]="m.avatar" alt="" width="26" height="26" /> } @else { <b>{{ initial(m.name) }}</b> }
              </span>
              <span class="who">
                <span class="name">{{ m.name }}</span>
                <span class="sub">na call, sem o site</span>
              </span>
              <button type="button" class="btn small invite" [class.busy]="inviting() === m.id"
                [disabled]="inviting() === m.id" (click)="invite(m)">
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
        <button type="button" class="key" style="--c: #e2a12e" [disabled]="pinging()" (click)="ping()">
          <svg class="px" [class.ring]="pinging()" viewBox="0 0 9 9" aria-hidden="true">
            @for (d of art.bell; track $index) { <rect [attr.x]="d.x" [attr.y]="d.y" width="1" height="1" /> }
          </svg>
          <span class="txt"><strong>{{ pinging() ? 'Avisando…' : 'Chamar a call' }}</strong>
            <span>o bot marca todo mundo no chat do canal de voz</span></span>
        </button>
        <button type="button" class="key" style="--c: #94cf7c" [disabled]="makingGuest()" (click)="guestInvite()"
          title="Link que só uma pessoa usa. Ela escolhe um apelido e entra nesta sala. Qualquer um daqui com Discord pode expulsar.">
          <svg class="px" viewBox="0 0 9 9" aria-hidden="true">
            @for (d of art.letter; track $index) { <rect [attr.x]="d.x" [attr.y]="d.y" width="1" height="1" /> }
          </svg>
          <span class="txt"><strong>{{ makingGuest() ? 'Criando…' : 'Convite de 1 uso' }}</strong>
            <span>para quem não tem Discord</span></span>
        </button>
        <button type="button" class="key" style="--c: #9d8fe0" (click)="privateRoom()">
          <svg class="px" viewBox="0 0 9 9" aria-hidden="true">
            @for (d of art.lock; track $index) { <rect [attr.x]="d.x" [attr.y]="d.y" width="1" height="1" /> }
          </svg>
          <span class="txt"><strong>Sala privada</strong>
            <span>só com quem você convidar</span></span>
        </button>
      </div>
    }
    <p class="foot"><span class="led ok"></span> verde é quem está falando. Os volumes valem só para você.</p>
  `,
  styles: `
    :host { display: block; }
    .label { display: flex; align-items: center; gap: 0.5rem; }
    .label::after { content: ''; flex: 1; height: 1px; background: repeating-linear-gradient(90deg, var(--line-2) 0 2px, transparent 2px 4px); }
    .strips { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }

    /* ---------- canal: chapa rebaixada, entra um depois do outro */
    .strip, .rack { position: relative; padding: 7px 8px 6px; border-radius: 3px; background: rgb(0 0 0 / 0.18);
      border: 1px solid #0b0b0c; box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.035), 0 1px 0 rgb(255 255 255 / 0.03);
      animation: develop 320ms var(--ease) both; animation-delay: calc(var(--i, 0) * 55ms);
      transition: background 160ms, box-shadow 160ms; }
    .strip:hover { background: rgb(255 255 255 / 0.025); }
    /* Quem fala ganha uma régua verde do lado, como o LED de sinal de um canal. */
    .strip::before { content: ''; position: absolute; left: -1px; top: 6px; bottom: 6px; width: 2px; border-radius: 1px;
      background: #94cf7c; opacity: 0; transform: scaleY(0.3); transition: opacity 160ms, transform 220ms var(--ease); }
    .strip.speaking::before { opacity: 1; transform: none; box-shadow: 0 0 6px rgb(148 207 124 / 0.6); }
    .strip.me { background: rgb(87 72 154 / 0.1); }
    .row { display: flex; align-items: center; gap: 0.5rem; min-height: 32px; }

    /* ---------- monitorzinho: a logo, com a pessoa na tela */
    .monitor { position: relative; flex-shrink: 0; width: 34px; height: 32px; display: grid; place-items: center; padding: 3px 3px 4px;
      background: #ebe6da; border: 1px solid #111110;
      box-shadow: inset -2px -2px 0 #b8b3a6, inset 2px 2px 0 #f3efe6, 2px 2px 0 rgb(0 0 0 / 0.45);
      animation: crt-on 420ms var(--ease) both; animation-delay: calc(var(--i, 0) * 55ms + 80ms); }
    .monitor img, .monitor b { width: 26px; height: 24px; display: grid; place-items: center; object-fit: cover;
      background: #0f1311; outline: 1px solid #6c685e; }
    .monitor b { font: 500 0.82rem/1 var(--mono); color: #94cf7c; text-transform: uppercase; text-shadow: 0 0 4px rgb(148 207 124 / 0.6); }
    /* Linhas de tubo por cima da foto. */
    .monitor::before { content: ''; position: absolute; inset: 3px 3px 4px; pointer-events: none; z-index: 1;
      background: repeating-linear-gradient(180deg, rgb(0 0 0 / 0.22) 0 1px, transparent 1px 3px); }
    /* O LEDzinho do monitor (o canto da logo): acende verde quando a pessoa fala. */
    .monitor::after { content: ''; position: absolute; right: 3px; bottom: 1px; width: 3px; height: 2px; background: #6c685e;
      transition: background 120ms, box-shadow 120ms; }
    .monitor.talk::after { background: #94cf7c; box-shadow: 0 0 4px #94cf7c; }
    .monitor.talk img, .monitor.talk b { outline: 1px solid #94cf7c; box-shadow: 0 0 0 1px rgb(148 207 124 / 0.35); }
    .monitor.talk { animation: crt-on 420ms var(--ease) both, bob 0.5s steps(2) infinite; }
    .monitor.wide { width: 34px; color: #94cf7c; }
    .monitor.wide cen-icon { width: 26px; height: 24px; display: grid; place-items: center; background: #0f1311; outline: 1px solid #6c685e; }
    .monitor.off { filter: saturate(0.2) brightness(0.75); }
    .monitor.off img { filter: grayscale(1) contrast(0.9); opacity: 0.7; }

    .who { flex: 1; min-width: 0; display: grid; line-height: 1.15; }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.9rem; font-weight: 600; }
    .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 400 0.64rem/1.3 var(--mono);
      letter-spacing: 0.06em; color: var(--faint); text-transform: lowercase; }
    .speaking .sub { color: #94cf7c; }
    .me .sub { color: #a497cf; }

    /* ---------- equalizador de pixel: parado é uma linha, falando pula */
    .eq { display: flex; align-items: flex-end; gap: 1px; height: 12px; flex-shrink: 0; }
    .eq i { width: 3px; height: 2px; background: var(--led-off); }
    .eq.on i { background: #94cf7c; box-shadow: 0 0 3px rgb(148 207 124 / 0.5); animation: eq 0.9s steps(4) infinite; }
    .eq.on i:nth-child(2) { animation-duration: 0.7s; animation-delay: -0.3s; }
    .eq.on i:nth-child(3) { animation-duration: 1.1s; animation-delay: -0.5s; }
    .eq.on i:nth-child(4) { animation-duration: 0.8s; animation-delay: -0.2s; }
    @keyframes eq { 0%, 100% { height: 3px; } 25% { height: 11px; } 50% { height: 6px; } 75% { height: 9px; } }
    @keyframes bob { 50% { transform: translateY(-1px); } }

    .mic { display: grid; place-items: center; color: var(--faint); flex-shrink: 0; }
    .mic.open { color: var(--muted); }
    .speaking .mic.open { color: #94cf7c; }
    .device { color: var(--muted); flex-shrink: 0; }

    /* ---------- lâmpada de NO AR */
    .onair { display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 5px; flex-shrink: 0; border-radius: 2px;
      font: 500 0.58rem/1 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: #ffd9d2;
      background: #5a1c17; border: 1px solid #0b0b0c; box-shadow: inset 0 0 6px rgb(255 90 70 / 0.35);
      text-shadow: 0 0 4px rgb(255 120 100 / 0.8); animation: onair 2.4s ease-in-out infinite; }
    .onair i { width: 5px; height: 5px; background: #ff5a46; box-shadow: 0 0 5px #ff5a46; animation: blink 1.2s steps(1) infinite; }
    @keyframes onair { 50% { box-shadow: inset 0 0 9px rgb(255 90 70 / 0.55), 0 0 6px rgb(255 90 70 / 0.25); } }

    .fader { margin: 4px 0 0 calc(34px + 0.5rem - 4px); width: auto; }

    .kick { height: 22px; padding: 0 0.5rem; font-size: 0.72rem; }
    .other { margin: 0.35rem 0 0.1rem calc(34px + 0.5rem); font-size: 0.75rem; }
    .alone { margin: 0.6rem 0 0; text-align: center; font: 400 0.95rem var(--display); font-style: italic; color: var(--muted); }

    /* ---------- fora do site */
    .outside { background: transparent; border-style: dashed; border-color: var(--line-2); box-shadow: none; }
    .outside .name { color: var(--muted); font-weight: 500; }
    .invite { height: 24px; min-width: 70px; font-size: 0.72rem; }
    .dots { display: inline-flex; gap: 3px; }
    .dots i { width: 3px; height: 3px; background: currentColor; animation: blink 0.9s steps(1) infinite; }
    .dots i:nth-child(2) { animation-delay: 0.3s; } .dots i:nth-child(3) { animation-delay: 0.6s; }
    .tight { margin-top: 0.4rem; font-size: 0.75rem; }

    /* ---------- teclas de chamar gente, com desenho de pixel */
    .keys { display: grid; gap: 6px; }
    .key { position: relative; display: flex; align-items: center; gap: 0.7rem; width: 100%; padding: 0.5rem 0.6rem; text-align: left;
      border-radius: var(--radius); border: 1px solid #0b0b0c; background: var(--plate); color: var(--text); box-shadow: var(--key-shadow);
      transition: transform 60ms linear, box-shadow 60ms linear, background 120ms; }
    .key:hover:not(:disabled) { background: var(--plate-hi); }
    .key:active:not(:disabled) { transform: translateY(2px); box-shadow: var(--key-pressed); }
    .key .px { width: 27px; height: 27px; flex-shrink: 0; padding: 4px; fill: var(--c); shape-rendering: crispEdges;
      background: #111110; border-radius: 2px; box-shadow: inset 0 0 0 1px #000, 0 1px 0 rgb(255 255 255 / 0.06);
      filter: drop-shadow(0 0 3px color-mix(in srgb, var(--c) 45%, transparent)); transition: transform 160ms var(--ease); }
    .key:hover:not(:disabled) .px { transform: rotate(-6deg) scale(1.06); }
    .px.ring { animation: ring 0.5s steps(2) infinite; }
    @keyframes ring { 0% { transform: rotate(-12deg); } 50% { transform: rotate(12deg); } }
    .txt { display: grid; gap: 1px; min-width: 0; }
    .txt strong { font-size: 0.84rem; font-weight: 600; }
    .txt span { font-size: 0.72rem; color: var(--muted); line-height: 1.3; }
    .key::after { content: ''; position: absolute; top: 6px; right: 6px; width: 4px; height: 4px; background: var(--led-off);
      box-shadow: inset 0 1px 1px #000a; }
    .key:hover:not(:disabled)::after { background: var(--c); box-shadow: 0 0 4px var(--c); }

    /* ---------- som de estúdio: módulo de rack */
    .rack { background: #09080c; box-shadow: inset 0 1px 4px #000a; margin-bottom: 0.3rem; animation: none; }
    .rack .row + .row { margin-top: 2px; }
    .rack input[type=range] { flex: 1; accent-color: var(--accent-hi); }
    .fmt { height: 18px; font-size: 0.62rem; padding: 0 0.35rem; }
    .buffer { height: 4px; margin: 6px 0 2px; background: var(--well); box-shadow: var(--inset); overflow: hidden; }
    .buffer i { display: block; height: 100%; background: #94cf7c; transition: width 200ms linear; }
    .small { font-size: 0.75rem; }
    .chips { margin-top: 0.4rem; }

    .foot { display: flex; align-items: center; gap: 0.45rem; margin: 1rem 0 0; font-size: 0.72rem; color: var(--muted); }

    /* Toque não tem "passar o mouse": no celular tudo fica à mostra e maior. */
    @media (hover: none) {
      .strip { padding: 8px 9px 7px; }
      .key { padding: 0.65rem 0.7rem; }
      .invite { height: 30px; }
    }
  `,
})
export class PeoplePanel {
  protected readonly store = inject(RoomStore);
  private readonly toast = inject(Toast);
  private readonly router = inject(Router);
  protected readonly callRoom = isCallRoom();
  protected readonly isMobile = IS_MOBILE;
  protected readonly art = { bell: pixels(PIXEL_ART['bell']), letter: pixels(PIXEL_ART['letter']), lock: pixels(PIXEL_ART['lock']) };

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
      if (!copied && 'share' in navigator) {
        await navigator.share({ title: 'Convite para a call', url: link }).catch(() => undefined);
      } else if (!copied) {
        window.prompt('Copie o convite:', link);
      }
      if (copied) this.toast.show('Convite de 1 uso copiado. Vale por 12 h ou até alguém usar.');
    } catch (e) {
      this.toast.show(e instanceof Error ? e.message : 'Não foi possível criar o convite.');
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
    try {
      const r = await pingCall();
      this.toast.show(`Avisei ${r.count} ${r.count === 1 ? 'pessoa' : 'pessoas'} no chat da call.`);
    } catch (e) {
      this.toast.show(e instanceof Error ? e.message : 'Não foi possível avisar a call.');
    } finally {
      this.pinging.set(false);
    }
  }

  async invite(m: DiscordUser) {
    this.inviting.set(m.id);
    try {
      // Na sala da call, convida para o site (a pessoa entra com o Discord e cai na call);
      // numa sala privada, manda o link desta sala.
      await inviteToRoom(m.id, this.callRoom ? `${location.origin}/` : location.href);
      this.toast.show(`Mandei o link no privado de ${m.name}.`);
    } catch (e) {
      this.toast.show(e instanceof Error ? e.message : 'Não foi possível convidar.');
    } finally {
      this.inviting.set(null);
    }
  }

  privateRoom() {
    // Sai da sala da call e abre uma sala avulsa nova, com chave própria.
    void this.router.navigateByUrl(`/room/${randomRoomName()}#${encodeLink({ key: newKey(), secret: '' })}`);
  }
}
