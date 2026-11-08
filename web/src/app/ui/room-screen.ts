import { Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { Invites } from '../core/invites';
import { roomUrl } from '../core/link';
import { formatWatchers } from '../core/room-session';
import { RoomStore } from '../core/room-store';
import { shortLimitation } from '../core/stats';
import { Toast } from '../core/toast';
import { DevicesPanel } from './devices-panel';
import { Icon } from './icon';
import { PeoplePanel } from './people-panel';
import { Stage } from './stage';
import { StatsPanel } from './stats-panel';
import { StreamPanel } from './stream-panel';

type Tab = 'people' | 'share' | 'devices';

@Component({
  selector: 'cen-room-screen',
  imports: [Icon, Stage, StatsPanel, PeoplePanel, StreamPanel, DevicesPanel],
  host: { '(document:fullscreenchange)': 'isFullscreen.set(fullscreenActive())', '(keydown.escape)': 'tab.set(null)' },
  template: `
    <div class="room">
      <header class="topbar">
        <button type="button" class="roomname" [title]="chipTitle()" (click)="copyInvite()">
          <span class="status" [class]="store.status()"></span>
          <span class="mono">{{ label() }}</span>
          <cen-icon name="link" [size]="14" />
        </button>
        @if (store.focused(); as f) {
          <div class="now">
            <strong>{{ shareTitle() }}</strong>
            @if (stage()?.measured(); as m) { <span class="tag mono">{{ m }}</span> }
            @if (f.hasAudio) { <span class="tag">com som</span> }
            @if (adaptedBadge(); as a) { <span class="tag warn" [title]="a.title">{{ a.text }}</span> }
            <span class="tag">{{ watchersText() }}</span>
          </div>
        }
        <span class="spacer"></span>
        <button type="button" class="btn small" [class.on]="tab() === 'people'" (click)="toggle('people')">
          <cen-icon name="people" [size]="15" /> {{ store.participants().length }}
        </button>
        <button type="button" class="btn small" (click)="copyInvite()"><cen-icon name="link" [size]="15" /> convidar</button>
      </header>

      @if (store.soundProblem(); as problem) {
        <div class="banner">
          <span>
            @if (problem === 'refused') {
              Compartilhando sem som: o navegador não entregou faixa de áudio. Na janela de escolha, marque
              "compartilhar o áudio deste app" (janela), "áudio da aba" (aba) ou "áudio do sistema" (tela inteira).
            } @else if (problem === 'whole-pc') {
              Tela inteira manda o som do PC todo, inclusive o Discord, e quem está na call se escuta.
              Para mandar só o som do jogo ou programa, compartilhe a janela dele.
            } @else {
              Compartilhando sem som: a faixa de áudio veio totalmente muda e foi descartada para não gastar upload.
              No Linux isso costuma significar que o áudio do sistema não chegou ao navegador.
            }
          </span>
          <button class="btn small" (click)="store.restartShare()">Escolher de novo</button>
          @if (problem === 'whole-pc') {
            <button class="btn small" (click)="store.dropShareAudio()">Tirar o som</button>
          }
        </div>
      }
      @if (store.needsAudioUnlock()) {
        <div class="banner">
          <span>O navegador bloqueou o áudio até você interagir com a página.</span>
          <button class="btn small primary" (click)="store.unlockAudio()">Ativar áudio</button>
        </div>
      }
      @if (store.status() === 'disconnected') {
        <div class="banner danger"><span>Conexão perdida. Recarregue a página para voltar.</span></div>
      }

      <main #stageArea class="stage-area">
        @if (store.focused()) {
          <cen-stage />
          <div class="corner">
            <button class="btn icon small" title="Janela flutuante" (click)="stage()?.popout()"><cen-icon name="popout" [size]="16" /></button>
            <button class="btn icon small" [title]="isFullscreen() ? 'Sair da tela cheia' : 'Tela cheia'" (click)="toggleFullscreen()">
              <cen-icon [name]="isFullscreen() ? 'fullscreenExit' : 'fullscreen'" [size]="16" />
            </button>
          </div>
        } @else {
          <div class="empty">
            <h2>{{ store.waitingForCamera() ? 'Esperando a câmera.' : 'Ninguém está compartilhando.' }}</h2>
            <p class="hint">{{ emptyHint() }}</p>
            @if (store.canPublish() && canShare) {
              <div class="actions">
                <button class="btn primary" (click)="store.toggleShare()"><cen-icon name="screen" [size]="17" /> Compartilhar tela</button>
                <button class="btn" (click)="copyInvite()"><cen-icon name="link" [size]="16" /> Copiar convite</button>
              </div>
            }
            <p class="label">o link inteiro</p>
            <p class="mono link">{{ link() }}</p>
            <p class="hint">o que vem depois do # é o que deixa alguém entrar</p>
          </div>
        }
        <cen-stats-panel />
        @if (store.shares().length > 1) {
          <div class="strip">
            @for (s of store.shares(); track s.id) {
              <button type="button" class="btn small" [class.on]="s.id === store.focused()?.id" (click)="store.focusShare(s.id)"
                [title]="formatWatchers(store.watchersOf(s.id))">
                {{ s.isLocal ? 'Sua tela' : s.ownerName }} · {{ store.watchersOf(s.id) }}
              </button>
            }
          </div>
        }
      </main>

      <footer class="dock">
        <button class="btn icon" [class.off]="!store.micOn()" [title]="store.micOn() ? 'Desligar microfone' : 'Ligar microfone'"
          (click)="store.toggleMic()">
          <cen-icon [name]="store.micOn() ? 'mic' : 'micOff'" />
        </button>
        @if (store.canPublish()) {
          <button class="btn icon" [class.on]="store.sharing()" [disabled]="!canShare || store.busy()" [title]="shareTitle2()"
            (click)="store.toggleShare()">
            <cen-icon [name]="store.sharing() ? 'screenOff' : 'screen'" />
          </button>
          <button class="btn small" [class.on]="tab() === 'share'" (click)="toggle('share')">qualidade</button>
          <button class="btn icon" [class.on]="store.webcamOn()" [disabled]="store.busy()"
            [title]="store.webcamOn() ? 'Desligar câmera' : 'Ligar câmera'" (click)="store.toggleWebcam()">
            <cen-icon [name]="store.webcamOn() ? 'cameraOff' : 'camera'" />
          </button>
        }
        <button class="btn small" [class.on]="tab() === 'devices'" (click)="toggle('devices')">dispositivos</button>
        <button class="btn danger icon" title="Sair da sala" (click)="leave.emit()"><cen-icon name="hangup" /></button>
      </footer>

      @if (tab(); as t) {
        <aside class="panel">
          <div class="tabs">
            <button class="chip" [class.lit]="t === 'people'" (click)="tab.set('people')">pessoas</button>
            @if (store.canPublish()) {
              <button class="chip" [class.lit]="t === 'share'" (click)="tab.set('share')">transmissão</button>
            }
            <button class="chip" [class.lit]="t === 'devices'" (click)="tab.set('devices')">dispositivos</button>
            <button class="close" title="Fechar" (click)="tab.set(null)"><cen-icon name="close" [size]="16" /></button>
          </div>
          @switch (t) {
            @case ('people') { <cen-people-panel /> }
            @case ('share') { <cen-stream-panel /> }
            @case ('devices') { <cen-devices-panel [open]="true" /> }
          }
        </aside>
      }
    </div>
  `,
  styles: `
    :host { display: block; height: 100dvh; }
    .room { position: relative; display: flex; flex-direction: column; height: 100%; }
    .topbar { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 1rem; border-bottom: 1px solid var(--line);
      flex-wrap: wrap; }
    .roomname { display: flex; align-items: center; gap: 0.5rem; background: none; border: 0; padding: 0; }
    .status { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
    .status.connected { background: var(--ok); }
    .status.reconnecting, .status.connecting { background: var(--accent); }
    .status.disconnected { background: var(--danger); }
    .now { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: 0.9rem; }
    .tag { font-size: 0.75rem; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 0.5rem; }
    .tag.warn { color: var(--accent); border-color: var(--accent); }
    .spacer { flex: 1; }
    .banner { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.55rem 1rem;
      background: var(--surface-2); border-bottom: 1px solid var(--line); font-size: 0.88rem; }
    .banner.danger { background: #d2463c33; }
    .stage-area { position: relative; flex: 1; min-height: 0; background: #000; }
    .corner { position: absolute; top: 0.75rem; right: 0.75rem; display: flex; gap: 0.4rem; z-index: 4; }
    .empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
      text-align: center; padding: 1rem; background: var(--bg); }
    .empty h2 { margin: 0; }
    .actions { display: flex; gap: 0.5rem; margin: 1rem 0; flex-wrap: wrap; justify-content: center; }
    .link { word-break: break-all; font-size: 0.85rem; max-width: 40rem; margin: 0; }
    .strip { position: absolute; bottom: 0.75rem; left: 50%; transform: translateX(-50%); display: flex; gap: 0.4rem; z-index: 4; }
    .dock { display: flex; justify-content: center; gap: 0.5rem; padding: 0.7rem; border-top: 1px solid var(--line);
      flex-wrap: wrap; }
    .panel { position: absolute; top: 3.2rem; right: 0.75rem; bottom: 4.6rem; width: min(360px, calc(100% - 1.5rem));
      overflow-y: auto; padding: 0.8rem 1rem; z-index: 10; background: var(--surface); border: 1px solid var(--line);
      border-radius: 12px; }
    .tabs { display: flex; gap: 0.35rem; align-items: center; }
    .close { margin-left: auto; background: none; border: 0; color: var(--muted); display: grid; place-items: center; }
  `,
})
export class RoomScreen {
  readonly label = input.required<string>();
  readonly leave = output<void>();
  protected readonly store = inject(RoomStore);
  private readonly toast = inject(Toast);
  private readonly invites = inject(Invites);
  protected readonly canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  protected readonly tab = signal<Tab | null>(null);
  protected readonly isFullscreen = signal(false);
  protected readonly stage = viewChild(Stage);
  private readonly stageArea = viewChild.required<ElementRef<HTMLElement>>('stageArea');
  protected readonly formatWatchers = formatWatchers;

  protected readonly chipTitle = computed(() =>
    this.store.status() === 'connected' ? 'Copiar o link de convite' : `Copiar o link (${this.store.status()})`,
  );
  protected readonly watchersText = computed(() => formatWatchers(this.store.focusedWatchers()));
  protected readonly shareTitle = computed(() => {
    const f = this.store.focused();
    if (f === null) return '';
    const what = f.kind === 'camera' ? 'câmera' : 'tela';
    return f.isIngress ? f.ownerName : f.isLocal ? `Sua ${what}` : `${what} de ${f.ownerName}`;
  });
  protected readonly shareTitle2 = computed(() =>
    this.canShare
      ? this.store.sharing()
        ? 'Parar de compartilhar'
        : 'Compartilhar tela'
      : 'Este navegador não compartilha tela. Use Chrome ou Edge num computador.',
  );
  protected readonly adaptedBadge = computed(() => {
    const h = this.store.health();
    return h === null || !h.sustained
      ? null
      : { text: `qualidade reduzida (${shortLimitation(h.reason)})`, title: `Enviando ${h.width}x${h.height} a ${h.fps} fps. Volta sozinho.` };
  });
  protected readonly link = computed(() => roomUrl(this.label()));
  protected readonly emptyHint = computed(() =>
    this.store.canPublish()
      ? this.canShare
        ? 'Compartilhe sua tela e todo mundo na sala vê na hora.'
        : 'Esperando alguém compartilhar. Celular assiste, mas só computador compartilha tela.'
      : 'Você entrou como espectador. Quando alguém compartilhar, aparece aqui.',
  );

  toggle(t: Tab) {
    this.tab.set(this.tab() === t ? null : t);
  }

  copyInvite() {
    void this.invites.invite(this.label());
  }

  protected fullscreenActive() {
    return document.fullscreenElement !== null;
  }

  toggleFullscreen() {
    if (document.fullscreenElement === null)
      this.stageArea()
        .nativeElement.requestFullscreen()
        .catch(() => this.toast.show('O navegador recusou a tela cheia.'));
    else void document.exitFullscreen();
  }
}
