import { parseSendHealth } from '../core/diag';
import { Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { IS_IOS, IS_MOBILE } from '../core/device';
import { Prefs } from '../core/prefs';
import { Invites } from '../core/invites';
import { isCallRoom, roomUrl } from '../core/link';
import { ShareView, formatWatchers } from '../core/room-session';
import { RoomStore } from '../core/room-store';
import { shortLimitation } from '../core/stats';
import { Toast } from '../core/toast';
import { DevicesPanel } from './devices-panel';
import { Icon } from './icon';
import { PeoplePanel } from './people-panel';
import { ShareTile } from './share-tile';
import { Stage } from './stage';
import { VolumeSlider } from './volume-slider';
import { StatsPanel } from './stats-panel';
import { StreamPanel } from './stream-panel';
import { ObsPanel } from './obs-panel';
import { DawPanel } from './daw-panel';
import { ClipItem } from '../core/clips';

type Menu = 'mic' | 'screen' | 'camera' | 'daw' | 'obs';

/** Tempo desde que entrou, como o contador de uma fita: 00:12:34. */
function timecode(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(Math.floor(t / 3600))}:${two(Math.floor((t % 3600) / 60))}:${two(t % 60)}`;
}

@Component({
  selector: 'cen-room-screen',
  imports: [Icon, Stage, ShareTile, VolumeSlider, StatsPanel, PeoplePanel, StreamPanel, DevicesPanel, DawPanel, ObsPanel],
  host: {
    '(document:fullscreenchange)': 'isFullscreen.set(fullscreenActive())',
    '(document:keydown.escape)': 'closeAll()',
    '(document:pointerdown)': 'outside($event)',
    '(document:keydown.alt.c)': 'clip()',
  },
  template: `
    <div class="room" [class.mobile]="isMobile" [class.off]="hangingUp()">
      <header class="topbar">
        <div class="brand">
          <img class="mark pixel" src="logo.svg" alt="Noveau" width="32" height="32" />
          <!-- Plaqueta da sala: nome impresso em cima, tipo da sala embaixo, LED e contador no visor. -->
          <div class="plate" [title]="callRoom ? 'Sala da call ' + label() : chipTitle()" [class.clickable]="!callRoom"
            (click)="callRoom ? null : copyInvite()">
            <span class="who">
              <span class="roomname">{{ label() }}</span>
              <span class="kind">{{ callRoom ? 'sala da call' : 'sala privada · clique p/ convidar' }}</span>
            </span>
            <span class="lcd" [title]="statusText()"><span class="led" [class]="ledClass()"></span>{{ clock() }}</span>
          </div>
        </div>

        @if (store.focused(); as f) {
          <div class="now" [class.mine]="f.isLocal">
            <span class="onair mono">{{ f.isLocal ? 'enviando' : 'no ar' }}</span>
            <strong>{{ shareTitle() }}</strong>
            @if (stage()?.measured(); as m) { <span class="tag mono">{{ m }}</span> }
            @if (senderNote(); as n) { <span class="tag warn sender-note" [title]="n.title">{{ n.text }}</span> }
            @if (f.hasAudio) { <span class="tag">com som</span> }
            @for (st of store.studio.streams(); track st.key) {
              <span class="tag accent" title="Som sem compressão, abra 'pessoas' para ajustar">{{ st.source === 'daw' ? 'DAW de ' + st.name : 'estúdio ' + st.bits + '-bit' }}</span>
            }
            @if (adaptedBadge(); as a) { <span class="tag warn" [title]="a.title">{{ a.text }}</span> }
            @if (f.isLocal && store.upload(); as u) {
              @if (u.cap < u.target) {
                <span class="tag warn" [title]="'Sua internet está perdendo pacotes na subida (' + (u.loss * 100).toFixed(1) + '%). O teto baixou um pouco para não travar para ninguém e volta sozinho quando a rede limpar.'">
                  {{ (u.cap / 1e6).toFixed(0) }} de {{ (u.target / 1e6).toFixed(0) }} Mbps por perda</span>
              }
            }
            @if (f.shielded; as sh) {
              <button type="button" class="tag warn shield" (click)="store.unshield(f.id)"
                [title]="'Sua conexão travou várias vezes, então você está recebendo a cópia menor desta tela até ' + clockAt(sh.until) + '. Só você. Clique para voltar ao máximo agora.'">
                {{ sh.height ? sh.height + 'p' : 'menor' }} por travadas · voltar ao máximo
              </button>
            }
            <span class="eye mono" [title]="viewersTitle(f.id)"><cen-icon name="eye" [size]="14" /> {{ store.viewersOf(f.id).length }}</span>
          </div>
        }
        <span class="spacer"></span>
        @if (!isMobile) {
        <div class="cursor-ctl" [class.on]="prefs.cursorOn()">
          <button type="button" class="btn small" [class.on]="prefs.cursorOn()"
            [title]="prefs.cursorOn() ? 'Esconder meu cursor da sala' : 'Mostrar meu cursor para a sala'"
            (click)="prefs.setCursorOn(!prefs.cursorOn())">
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4.2 2.6 19.6 10.3a.8.8 0 0 1-.1 1.5l-6.2 1.9-2.9 5.9a.8.8 0 0 1-1.5-.1L3.1 3.6a.8.8 0 0 1 1.1-1Z"
                [attr.fill]="prefs.cursorOn() ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            </svg>
            cursor
          </button>
          @if (prefs.cursorOn()) {
            <label class="swatch hover-only" title="Cor do seu cursor" [style.background]="prefs.cursorColor()">
              <input type="color" [value]="prefs.cursorColor()" (input)="prefs.setCursorColor($any($event.target).value)" />
            </label>
          }
        </div>
        }
        <div class="diag-wrap">
          <!-- Tecla do diagnóstico: afunda com o LED aceso quando a chave está ligada; o clique só abre o menu. -->
          <button type="button" class="btn small" [class.on]="prefs.diagOn()" [class.alert]="prefs.diagOn() && store.diag.unseen() > 0"
            [title]="prefs.diagOn() ? 'Diagnóstico ligado: por que a tela travou' : 'Diagnóstico (desligado)'"
            aria-haspopup="dialog" [attr.aria-expanded]="diagOpen()" (click)="toggleDiag()">
            <cen-icon name="pulse" [size]="15" />
            @if (prefs.diagOn() && store.diag.unseen() > 0) { <span class="mono">{{ store.diag.unseen() }}</span> }
          </button>
          @if (diagOpen()) {
            <div class="diag panel-surface" role="dialog" aria-label="Diagnóstico">
              <div class="pop-head">
                <span class="label">diagnóstico</span>
                <button class="close" title="Fechar" (click)="diagOpen.set(false)"><cen-icon name="close" [size]="15" /></button>
              </div>
              <label class="switch">
                <input type="checkbox" role="switch" [checked]="prefs.diagOn()" (change)="setDiag(!prefs.diagOn())" />
                <span>Avisar quando a tela travar</span>
              </label>
              <p class="hint">Mostra na tela o motivo de cada travada e guarda o diário abaixo.</p>
              <label class="switch">
                <input type="checkbox" role="switch" [checked]="prefs.showStats()" (change)="prefs.setShowStats(!prefs.showStats())" />
                <span>Números ao vivo</span>
              </label>
              <p class="hint">Bitrate, fps, perda e quadros descartados no canto da tela.</p>
              @if (prefs.diagOn()) {
                <div class="log">
                  <p class="label">diário de travadas</p>
                  @for (e of store.diag.events(); track e.id) {
                    <div class="ev" [attr.data-cause]="e.cause">
                      <span class="when mono">{{ clockAt(e.at) }}</span>
                      <span class="what"><span class="cause">{{ causeLabel(e.cause) }}</span>@if (e.count > 1) { <span class="mono times">×{{ e.count }}</span> }<br />{{ e.text }}</span>
                    </div>
                  } @empty {
                    <p class="hint">Nenhuma travada na tela que você está vendo. Quando travar, aparece aqui o motivo provável.</p>
                  }
                  <p class="hint">Os registros também vão para o servidor (só apelidos e números), para a gente ver o que mais acontece e corrigir.</p>
                </div>
              }
            </div>
          }
        </div>
        <button type="button" class="btn small people-top" [class.on]="peopleOpen()" title="Pessoas e volumes" (click)="togglePeople()">
          <cen-icon name="people" [size]="15" /> <span class="mono">{{ store.participants().length }}</span>
        </button>
        @if (!callRoom) {
          <button type="button" class="btn small" title="Copiar o convite" (click)="copyInvite()"><cen-icon name="link" [size]="15" /> <span class="wide-only">convidar</span></button>
        }
      </header>

      @if (store.soundProblem(); as problem) {
        <div class="banner">
          <span class="flag mono">som</span>
          <span class="msg">
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
          <span class="flag mono">som</span>
          <span class="msg">O navegador bloqueou o áudio até você interagir com a página.</span>
          <button class="btn small primary" (click)="store.unlockAudio()">Ativar áudio</button>
        </div>
      }
      @if (store.status() === 'disconnected') {
        <div class="banner danger"><span class="flag mono">sinal</span><span class="msg">Conexão perdida. Recarregue a página para voltar.</span></div>
      }

      <main #stageArea class="stage-area" [class.controls]="controls()" (wheel)="noZoom($event)">
        @if (store.focused(); as f) {
          <cen-stage (click)="clickFocused()" (contextmenu)="openVolume($event, f)" />
          <div class="viewfinder" aria-hidden="true"></div>
          @if (freshIssue(); as e) {
            <button type="button" class="issue" [attr.data-cause]="e.cause" (click)="openDiag()" title="Abrir o diagnóstico">
              <span class="cause">{{ causeLabel(e.cause) }}</span> {{ e.text }}
            </button>
          }
          <div class="corner">
            @if (store.canClip() && !isMobile) {
              <button class="btn small ghost" (click)="clip()"
                [title]="'Clipa os últimos 2 min desta tela (Alt+C). Guardado até agora: ' + mmss(store.clips.buffered()) + (store.clips.size() ? ' (' + store.clips.size() + ')' : '')">
                <cen-icon name="scissors" [size]="15" /> clipar
                <span class="mono buf">{{ mmss(store.clips.buffered()) }}</span></button>
            }
            @if (store.shares().length > 1) {
              <button class="btn icon small ghost" title="Ver todas as telas" (click)="store.unfocus()"><cen-icon name="grid" [size]="16" /></button>
            }
            @if (!f.isLocal && f.hasAudio) {
              <button class="btn icon small ghost" title="Volume desta tela" (click)="openVolumeAt($event, f)">
                <cen-icon [name]="f.volume.muted || f.volume.level === 0 ? 'speakerOff' : 'speaker'" [size]="16" /></button>
            }
            @if (!f.isLocal || store.shares().length > 1) {
              <button class="btn icon small ghost" title="Esconder esta tela (para de baixar o vídeo e o som dela)" (click)="store.hideShare(f.id)">
                <cen-icon name="eyeOff" [size]="16" /></button>
            }
            <button class="btn icon small ghost" title="Janela flutuante" (click)="stage()?.popout()"><cen-icon name="popout" [size]="16" /></button>
            @if (isMobile && !isIOS && isFullscreen()) {
              <button class="btn icon small ghost" title="Girar a tela" (click)="rotate()"><cen-icon name="rotate" [size]="16" /></button>
            }
            <button class="btn icon small ghost" [title]="isFullscreen() ? 'Sair da tela cheia' : 'Tela cheia'" (click)="toggleFullscreen()">
              <cen-icon [name]="isFullscreen() ? 'fullscreenExit' : 'fullscreen'" [size]="16" />
            </button>
          </div>
        } @else if (store.shares().length > 1) {
          <div class="grid" [style.--cols]="gridCols()">
            @for (s of store.shares(); track s.id) {
              <cen-share-tile [share]="s" (click)="store.focusShare(s.id)" (contextmenu)="openVolume($event, s)"
                [title]="'Clique para focar · botão direito para o volume'" />
            }
          </div>
        } @else {
          <div class="empty">
            <div class="testcard card screws">
              <div class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
              <p class="nosignal mono"><span class="led warn"></span>{{ store.waitingForCamera() ? 'aguardando câmera' : 'sem sinal' }}</p>
              <h2>{{ store.waitingForCamera() ? 'Esperando a câmera.' : store.hiddenShares().length > 0 ? 'Você escondeu todas as telas.' : 'Ninguém está compartilhando.' }}</h2>
              <p class="hint">{{ emptyHint() }}</p>
              @if (store.canPublish() && canShare) {
                <div class="actions">
                  <button class="btn primary" (click)="store.toggleShare()"><cen-icon name="screen" [size]="17" /> Compartilhar tela</button>
                  @if (!callRoom) {
                    <button class="btn" (click)="copyInvite()"><cen-icon name="link" [size]="16" /> Copiar convite</button>
                  }
                </div>
              }
              <div class="slip">
                <p class="label">{{ callRoom ? 'endereço do site' : 'link da sala' }}</p>
                <p class="mono link">{{ link() }}</p>
                <p class="hint">
                  {{ callRoom
                    ? 'quem estiver na mesma call do Discord abre o site, entra com Discord e cai nesta sala'
                    : 'o que vem depois do # é o que deixa alguém entrar' }}
                </p>
              </div>
            </div>
          </div>
        }
        @if (store.hiddenShares().length > 0) {
          <div class="tray">
            <span class="label">escondidas</span>
            @for (h of store.hiddenShares(); track h.id) {
              <button type="button" class="btn small" [title]="'Voltar a ver ' + hiddenName(h)" (click)="store.showShare(h.id)">
                <span class="led"></span>{{ hiddenName(h) }} <cen-icon name="eye" [size]="14" />
              </button>
            }
            @if (store.hiddenShares().length > 1) {
              <button type="button" class="btn small ghost-plain" (click)="showAll()">mostrar todas</button>
            }
          </div>
        }
        <cen-stats-panel />
        @if (volumeMenu(); as m) {
          <div class="menu-backdrop" (click)="volumeMenu.set(null)" (contextmenu)="$event.preventDefault(); volumeMenu.set(null)"></div>
          <div class="volume-menu panel-surface" [style.left.px]="m.x" [style.top.px]="m.y" (click)="$event.stopPropagation()">
            <p class="label">volume · {{ m.name }}</p>
            @if (shareById(m.id); as sh) {
              <cen-volume [volume]="sh.volume" [label]="'som da tela de ' + m.name"
                (levelChange)="store.setVolume('share', sh.id, $event)"
                (muteToggle)="store.toggleMute('share', sh.id)" />
              <button type="button" class="check-row" role="menuitemcheckbox" [attr.aria-checked]="sh.volume.muted"
                (click)="store.toggleMute('share', sh.id)">
                <span>Mutar</span>
                <span class="checkbox" [class.on]="sh.volume.muted">
                  @if (sh.volume.muted) {
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  }
                </span>
              </button>
            }
            @if (shareById(m.id); as sh) {
              <button type="button" class="check-row" (click)="volumeMenu.set(null); store.hideShare(sh.id)">
                <span>Esconder esta tela</span><cen-icon name="eyeOff" [size]="16" />
              </button>
            }
            <p class="hint">Vai até 200%. Vale só para você.</p>
          </div>
        }
      </main>

      @if (store.clips.items().length > 0) {
        <div class="shelf">
          @for (c of store.clips.items(); track c.id) {
            <div class="clip panel-surface">
              <div class="clip-head">
                <span class="label">clipe · {{ c.name }}</span>
                @if (c.seconds) { <span class="mono dim">{{ mmss(c.seconds) }} · {{ (c.mb ?? 0) < 10 ? c.mb?.toFixed(1) : c.mb?.toFixed(0) }} MB</span> }
              </div>
              @switch (c.state) {
                @case ('saving') { <p class="hint">Montando o vídeo…</p> }
                @case ('uploading') {
                  <div class="meter"><i [style.width.%]="c.progress * 100"></i></div>
                  <p class="hint mono">enviando {{ (c.progress * 100).toFixed(0) }}%</p>
                }
                @case ('ready') {
                  <div class="clip-actions">
                    <a class="btn small" [class.primary]="!c.downloaded" [class.got]="c.downloaded" [href]="c.url" rel="noopener"
                      [title]="c.downloaded ? 'Você já baixou este clipe. Clique para baixar de novo.' : 'Baixar o MP4'"
                      (click)="store.clips.markDownloaded(c)"><cen-icon [name]="c.downloaded ? 'check' : 'download'" [size]="15" /> {{ c.downloaded ? 'baixado' : 'baixar' }}</a>
                    <span class="mono countdown" title="Depois disso o clipe é apagado">{{ left(c.expiresAt) }}</span>
                    <button class="btn small" title="Apagar agora do servidor" (click)="deleteClip(c)"><cen-icon name="trash" [size]="14" /> apagar</button>
                  </div>
                }
                @case ('failed') {
                  <p class="error">{{ c.error }}</p>
                  <button class="btn small" (click)="store.clips.dismiss(c)">fechar</button>
                }
              }
            </div>
          }
        </div>
      }

      <footer class="dock">
        <div class="keys">
          <div class="split" [class.open]="menu() === 'mic'">
            <button class="btn icon" [class.off]="!store.micOn()" [title]="store.micOn() ? 'Desligar microfone' : 'Ligar microfone'"
              (click)="store.toggleMic()">
              <cen-icon [name]="store.micOn() ? 'mic' : 'micOff'" />
            </button>
            <button class="btn caret" title="Microfone" aria-label="Escolher microfone" [attr.aria-expanded]="menu() === 'mic'"
              (click)="toggleMenu('mic')"><cen-icon name="caret" [size]="14" /></button>
          </div>

          @if (store.canPublish()) {
            @if (canShare || !isMobile) {
            <div class="split" [class.open]="menu() === 'screen'">
              <button class="btn icon" [class.on]="store.sharing()" [disabled]="!canShare || store.busy()" [title]="shareTitle2()"
                (click)="store.toggleShare()">
                <cen-icon [name]="store.sharing() ? 'screenOff' : 'screen'" />
              </button>
              <button class="btn caret" [class.on]="store.sharing()" title="Qualidade da transmissão" aria-label="Qualidade da transmissão"
                [attr.aria-expanded]="menu() === 'screen'" (click)="toggleMenu('screen')"><cen-icon name="caret" [size]="14" /></button>
            </div>
            }
            <div class="split" [class.open]="menu() === 'camera'">
              <button class="btn icon" [class.on]="store.webcamOn()" [disabled]="store.busy()"
                [title]="store.webcamOn() ? 'Desligar câmera' : 'Ligar câmera'" (click)="store.toggleWebcam()">
                <cen-icon [name]="store.webcamOn() ? 'cameraOff' : 'camera'" />
              </button>
              <button class="btn caret" [class.on]="store.webcamOn()" title="Câmera" aria-label="Escolher câmera"
                [attr.aria-expanded]="menu() === 'camera'" (click)="toggleMenu('camera')"><cen-icon name="caret" [size]="14" /></button>
            </div>
          }

          @if (!isMobile) {
            <button class="btn icon" [class.on]="menu() === 'daw' || dawPlaying()" title="Plugin de DAW: som da sua DAW sem compressão"
              aria-label="Plugin de DAW" [attr.aria-expanded]="menu() === 'daw'" (click)="toggleMenu('daw')"><cen-icon name="fader" /></button>
            @if (store.canPublish()) {
              <button class="btn icon" [class.on]="menu() === 'obs' || obsLive()" title="Transmitir pelo OBS"
                aria-label="Transmitir pelo OBS" [attr.aria-expanded]="menu() === 'obs'" (click)="toggleMenu('obs')"><cen-icon name="broadcast" /></button>
            }
          }

          @if (isMobile) {
            <button class="btn icon" [class.on]="peopleOpen()" title="Pessoas e volumes" (click)="togglePeople()"><cen-icon name="people" /></button>
          }
          <span class="sep" aria-hidden="true"></span>
          <button class="btn danger icon hangup" title="Sair da sala" (click)="hangUp()"><cen-icon name="hangup" /></button>
        </div>

        @if (menu(); as m) {
          <div class="pop panel-surface" [class.wide]="m === 'screen'" role="dialog" [attr.aria-label]="menuTitle(m)">
            <div class="pop-head">
              <span class="label">{{ menuTitle(m) }}</span>
              <button class="close" title="Fechar" (click)="menu.set(null)"><cen-icon name="close" [size]="15" /></button>
            </div>
            @switch (m) {
              @case ('mic') { <cen-devices-panel section="mic" [open]="true" /> }
              @case ('screen') { <cen-stream-panel /> }
              @case ('camera') { <cen-devices-panel section="camera" [open]="true" /> }
              @case ('daw') { <cen-daw-panel /> }
              @case ('obs') { <cen-obs-panel /> }
            }
          </div>
        }
      </footer>

      @if (peopleOpen()) {
        <aside class="panel panel-surface" aria-label="Pessoas">
          <div class="people-head">
            <img class="pixel" src="logo.svg" alt="" width="20" height="20" />
            <h2>Pessoas</h2>
            <span class="tag" title="Na sala">{{ store.participants().length }}</span>
            <button class="close" title="Fechar" (click)="peopleOpen.set(false)"><cen-icon name="close" [size]="16" /></button>
          </div>
          <div class="ribbon" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
          <cen-people-panel />
        </aside>
      }
    </div>
  `,
  styles: `
    :host { display: block; height: 100dvh; overflow: hidden; }
    .room { position: relative; display: flex; flex-direction: column; height: 100%; }
    /* Desligar: a sala apaga como uma TV de tubo (vira uma linha, depois um ponto). */
    .room.off { animation: crt-off 420ms steps(7) forwards; pointer-events: none; }

    /* ---------- barra de cima */
    .topbar { display: flex; align-items: center; gap: 0.9rem; padding: 0.5rem 0.9rem; min-height: 52px; flex-wrap: wrap;
      border-bottom: 1px solid var(--line); box-shadow: 0 1px 0 #000;
      background-color: var(--chassis); background-image: var(--grain), var(--brushed); background-size: 160px 160px, auto;
      box-shadow: inset 0 -1px 0 rgb(255 255 255 / 0.04), 0 1px 0 #000; }
    .brand { display: flex; align-items: center; gap: 0.6rem; min-width: 0; }
    .mark { width: 32px; height: 32px; display: block; }
    .plate { display: flex; align-items: center; gap: 0.75rem; height: 38px; padding: 0 4px 0 0.7rem; min-width: 0;
      border-radius: 3px; background: var(--well); box-shadow: var(--inset); }
    .plate.clickable { cursor: pointer; }
    .plate.clickable:hover .roomname { color: var(--accent-hi); }
    .who { display: flex; flex-direction: column; min-width: 0; }
    .roomname { font-weight: 600; font-size: 0.92rem; line-height: 1.15; max-width: 14rem; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; }
    .kind { font: 500 0.56rem/1.2 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint); white-space: nowrap; }
    .plate .lcd { height: 28px; padding: 0 0.55rem; gap: 0.4rem; }
    /* No visor o LED vira um segmento escuro aceso/apagado, como num LCD. */
    .plate .lcd .led { width: 6px; height: 6px; background: rgb(29 34 25 / 0.25); box-shadow: none; animation: none; }
    .plate .lcd .led.ok { background: var(--lcd-ink); }
    .plate .lcd .led.warn { background: var(--lcd-ink); animation: blink 1.2s steps(1) infinite; }
    .plate .lcd .led.bad { background: #6b1d16; }
    .now { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: 0.9rem; min-width: 0;
      padding-left: 0.9rem; border-left: 1px solid var(--line); animation: slide-in 260ms var(--ease) both; }
    .onair { font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.14em; color: #fff; background: var(--danger);
      padding: 2px 6px; border-radius: 1px; }
    .now.mine .onair { background: var(--accent); }
    .diag-wrap { position: relative; }
    .btn.alert { color: var(--warn); }
    .diag { position: absolute; top: calc(100% + 8px); right: 0; z-index: 30; width: min(380px, calc(100vw - 1.5rem));
      max-height: 60dvh; overflow-y: auto; padding: 0.7rem 0.9rem 0.8rem; animation: unfold-down 160ms steps(5) both; }
    .diag .switch:first-of-type { margin-top: 0.4rem; }
    .diag .switch + .hint { margin: 0.2rem 0 0 calc(30px + 0.6rem); font-size: 0.76rem; }
    /* O diário desce como papel saindo de uma impressora quando a chave liga. */
    .log { margin-top: 0.8rem; padding-top: 0.6rem; border-top: 1px dashed var(--line-2); animation: print 260ms steps(6) both; }
    .log > .label { margin: 0 0 0.3rem; }
    .ev { display: grid; grid-template-columns: auto 1fr; gap: 0.6rem; padding: 0.5rem 0; border-top: 1px solid var(--line); font-size: 0.82rem; }
    .ev .when { color: var(--faint); font-size: 0.72rem; padding-top: 2px; }
    .cause { font: 500 0.62rem/1.4 var(--mono); text-transform: uppercase; letter-spacing: 0.1em; color: var(--warn); }
    [data-cause='my-net'] .cause, [data-cause='my-pc'] .cause { color: var(--accent-hi); }
    .times { color: var(--muted); font-size: 0.72rem; margin-left: 0.35rem; }
    .issue { position: absolute; left: 1rem; bottom: 1rem; z-index: 5; max-width: min(560px, calc(100% - 2rem)); text-align: left;
      padding: 0.45rem 0.7rem; border: 1px solid #0b0b0c; border-left: 3px solid var(--warn); border-radius: 2px;
      background: rgb(16 16 17 / 0.9); color: var(--text); font-size: 0.8rem; cursor: pointer; animation: slide-in 160ms linear both; }
    .issue[data-cause='my-net'], .issue[data-cause='my-pc'] { border-left-color: var(--accent); }
    .issue .cause { margin-right: 0.35rem; }
    .shield { cursor: pointer; border: 0; font: inherit; font-size: 0.7rem; }
    .eye { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--muted); font-size: 0.78rem; }
    .spacer { flex: 1; }
    .cursor-ctl { display: flex; align-items: center; gap: 0.35rem; }
    .swatch { width: 18px; height: 18px; border-radius: 50%; border: 2px solid #fff8; cursor: pointer; position: relative; overflow: hidden; }
    .swatch input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    /* A cor só aparece passando o mouse no controle do cursor. */
    .swatch.hover-only { display: none; }
    .cursor-ctl:hover .swatch.hover-only, .cursor-ctl:focus-within .swatch.hover-only { display: block; }

    /* ---------- avisos: fita de atenção */
    .banner { display: flex; align-items: center; gap: 0.8rem; padding: 0.5rem 0.9rem; font-size: 0.86rem;
      border-bottom: 1px solid var(--line); animation: unfold-down 240ms var(--ease) both;
      background: repeating-linear-gradient(-45deg, rgb(208 154 58 / 0.07) 0 10px, transparent 10px 20px), var(--surface); }
    .banner .msg { flex: 1; }
    .flag { font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.14em; color: #1a1408; background: var(--warn);
      padding: 1px 6px; border-radius: 3px; }
    .banner.danger { background: repeating-linear-gradient(-45deg, rgb(196 73 60 / 0.1) 0 10px, transparent 10px 20px), var(--surface); }
    .banner.danger .flag { background: var(--danger); color: #fff; }

    /* ---------- palco */
    .stage-area { position: relative; flex: 1; min-height: 0; background: #000; touch-action: pan-x pan-y; overscroll-behavior: none; }
    /* Cantos de visor de câmera; aparecem com o mouse por cima. */
    .viewfinder { position: absolute; inset: 14px; pointer-events: none; z-index: 3; opacity: 0; transition: opacity 200ms;
      --m: rgb(221 216 204 / 0.45);
      background:
        linear-gradient(var(--m), var(--m)) 0 0 / 22px 1.5px, linear-gradient(var(--m), var(--m)) 0 0 / 1.5px 22px,
        linear-gradient(var(--m), var(--m)) 100% 0 / 22px 1.5px, linear-gradient(var(--m), var(--m)) 100% 0 / 1.5px 22px,
        linear-gradient(var(--m), var(--m)) 0 100% / 22px 1.5px, linear-gradient(var(--m), var(--m)) 0 100% / 1.5px 22px,
        linear-gradient(var(--m), var(--m)) 100% 100% / 22px 1.5px, linear-gradient(var(--m), var(--m)) 100% 100% / 1.5px 22px;
      background-repeat: no-repeat; }
    .corner { position: absolute; top: 1.4rem; right: 1.4rem; display: flex; gap: 0.35rem; z-index: 4; opacity: 0;
      transform: translateY(-4px); transition: opacity 200ms, transform 200ms var(--ease); }
    .stage-area:hover .viewfinder, .stage-area:hover .corner, .corner:focus-within { opacity: 1; transform: none; }
    .grid { position: absolute; inset: 0; padding: 10px; display: grid; gap: 10px;
      grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); grid-auto-rows: minmax(0, 1fr); }

    /* ---------- sem sinal */
    .empty { height: 100%; display: grid; place-items: center; padding: 1.5rem 1rem; overflow-y: auto;
      background-color: #141415; background-image: var(--grain); background-size: 160px 160px; }
    .testcard { width: min(520px, 100%); text-align: center; padding-top: 0; overflow: visible; }
    /* Barras de teste desbotadas, como uma fita velha. */
    .bars { display: grid; grid-template-columns: repeat(7, 1fr); height: 6px; margin: 0 -2rem 1.6rem; opacity: 0.6; }
    .bars i:nth-child(1) { background: #b9b5aa; } .bars i:nth-child(2) { background: #b3a457; }
    .bars i:nth-child(3) { background: #5c9a9c; } .bars i:nth-child(4) { background: #678f58; }
    .bars i:nth-child(5) { background: #7d6fae; } .bars i:nth-child(6) { background: #a5493f; }
    .bars i:nth-child(7) { background: #4a4a86; }
    .nosignal { display: inline-flex; align-items: center; gap: 0.45rem; margin: 0 0 0.6rem; font-size: 0.7rem;
      text-transform: uppercase; letter-spacing: 0.22em; color: var(--warn); }
    .testcard h2 { margin: 0; }
    .actions { display: flex; gap: 0.5rem; margin: 1.2rem 0 0.4rem; flex-wrap: wrap; justify-content: center; }
    .slip { margin-top: 1.3rem; padding-top: 1rem; border-top: 1px dashed var(--line-2); }
    .slip .label { margin: 0 0 0.3rem; }
    .link { word-break: break-all; font-size: 0.8rem; margin: 0; color: var(--text); }

    /* ---------- menu de volume (botão direito) */
    .menu-backdrop { position: fixed; inset: 0; z-index: 40; }
    .volume-menu { position: fixed; z-index: 41; width: 270px; padding: 0.7rem 0.8rem; animation: win-zoom 160ms steps(4) both; }
    .volume-menu .label { margin: 0 0 0.4rem; }
    /* Igual ao menu do Discord: linha "Mutar" com uma caixinha que ganha um check. */
    .check-row { display: flex; align-items: center; justify-content: space-between; width: 100%; margin-top: 0.5rem;
      padding: 0.45rem 0.5rem; border: 0; border-radius: 5px; background: none; color: inherit; font: inherit; cursor: pointer; }
    .check-row:hover { background: var(--surface-3); }
    .checkbox { width: 18px; height: 18px; border-radius: 2px; background: var(--well); box-shadow: var(--inset); display: grid;
      place-items: center; flex-shrink: 0; border: 1px solid #0b0b0c; }
    .checkbox.on { color: var(--accent-hi); }

    /* ---------- barra de baixo: teclas com setinha, como no Discord */
    .dock { position: relative; display: flex; justify-content: center; padding: 0.6rem 0.8rem 0.75rem;
      border-top: 1px solid var(--line); box-shadow: 0 -1px 0 #000;
      background-color: var(--chassis); background-image: var(--grain), var(--brushed); background-size: 160px 160px, auto; }
    .keys { display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0.4rem 0.45rem; border-radius: 3px;
      background: var(--well); box-shadow: var(--inset); }
    .split { display: inline-flex; }
    .split > .btn:first-child { border-top-right-radius: 0; border-bottom-right-radius: 0; }
    .caret { width: 20px; padding: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; border-left: 0; color: var(--muted); }
    .caret cen-icon { transform: rotate(180deg); transition: transform 180ms var(--ease); }
    .split.open .caret { color: var(--accent-hi); }
    .split.open .caret cen-icon { transform: none; }
    .sep { width: 2px; height: 26px; margin: 0 0.2rem; border-left: 1px solid #0b0b0c; border-right: 1px solid rgb(255 255 255 / 0.06); }
    .hangup { width: 52px; }
    .pop { position: absolute; bottom: calc(100% + 8px); left: 50%; translate: -50% 0; z-index: 20;
      width: min(320px, calc(100vw - 1.5rem)); max-height: calc(100dvh - 9.5rem); overflow-y: auto;
      padding: 0.7rem 0.9rem 0.9rem; animation: unfold-up 180ms steps(5) both; }
    .pop.wide { width: min(400px, calc(100vw - 1.5rem)); }
    .pop-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.3rem; }
    .pop-head .label { margin: 0; }
    .close { background: none; border: 0; color: var(--muted); display: grid; place-items: center; padding: 4px; border-radius: 4px; }
    .close:hover { color: var(--text); background: var(--surface-3); }
    .brand .wordmark { display: none; }

    /* ---------- telas escondidas: faixa sempre à vista, no alto e no meio do palco */
    .tray { position: absolute; left: 50%; top: 0.75rem; translate: -50% 0; z-index: 6; display: flex; align-items: center; flex-wrap: wrap;
      gap: 0.4rem; max-width: calc(100% - 1.5rem); padding: 0.35rem 0.5rem 0.45rem; border-radius: 3px;
      background: rgb(22 22 23 / 0.9); border: 1px solid #0b0b0c; box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.05), 0 6px 18px -8px #000;
      animation: slide-in 160ms linear both; }
    .tray .label { margin: 0 0.2rem 0 0; }
    .ghost-plain { background: transparent; box-shadow: none; color: var(--muted); }

    /* ---------- clipes */
    .shelf { position: absolute; right: 0.75rem; bottom: 5.2rem; z-index: 15; display: flex; flex-direction: column; gap: 0.5rem;
      width: min(300px, calc(100% - 1.5rem)); }
    .clip { padding: 0.6rem 0.75rem 0.7rem; animation: slide-in 220ms var(--ease) both; }
    .clip-head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem; }
    .clip-head .label { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dim { color: var(--faint); font-size: 0.7rem; }
    .btn.got { background: #2b3a26; color: #cfe3bf; box-shadow: inset 0 0 0 1px #4d6b3f; }
    .clip-actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; }
    .countdown { flex: 1; text-align: center; font-size: 0.8rem; color: var(--warn); }
    .meter { height: 6px; margin-top: 0.55rem; border-radius: 1px; background: var(--well); box-shadow: var(--inset); overflow: hidden; }
    .meter i { display: block; height: 100%; background: var(--accent); transition: width 200ms linear; }
    .buf { color: var(--muted); font-size: 0.75rem; margin-left: 0.1rem; }

    /* ---------- painel de pessoas */
    .panel { position: absolute; top: 60px; right: 0.75rem; bottom: 5rem; width: min(340px, calc(100% - 1.5rem));
      overflow-y: auto; padding: 0 0.8rem 1rem; z-index: 10; animation: slide-in 220ms var(--ease) both;
      scrollbar-width: thin; scrollbar-color: var(--plate) transparent; }
    /* Cabeçalho do painel: título impresso e a contagem numa etiqueta. Fica preso no topo. */
    .people-head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 0.55rem; margin: 0 -0.8rem;
      padding: 0.7rem 0.8rem 0.6rem; background-color: var(--surface); background-image: var(--grain), var(--brushed);
      background-size: 160px 160px, auto; }
    /* Faixa nas cores da logo, que se desenrola quando o painel abre. */
    .ribbon { display: grid; grid-template-columns: 3fr 1fr 1fr 1fr 2fr; height: 3px; margin: 0 -0.8rem 0.3rem; }
    .ribbon i { animation: unroll 520ms var(--ease) both; transform-origin: left; }
    .ribbon i:nth-child(1) { background: #57489a; } .ribbon i:nth-child(2) { background: #94cf7c; animation-delay: 60ms; }
    .ribbon i:nth-child(3) { background: #e2a12e; animation-delay: 120ms; } .ribbon i:nth-child(4) { background: #b8b3a6; animation-delay: 180ms; }
    .ribbon i:nth-child(5) { background: #6c685e; animation-delay: 240ms; }
    .people-head h2 { flex: 1; margin: 0; font-size: 1.3rem; line-height: 1; }
    @media (max-width: 640px) { .diag { position: fixed; left: 0.5rem; right: 0.5rem; width: auto; top: 3.4rem; }
    @media (max-width: 640px) { .now { border-left: 0; padding-left: 0; } .roomname { max-width: 8rem; } .kind { display: none; } }

    /* ================= celular ================= */
    /* Toque não tem "passar o mouse": os botões do canto aparecem com um toque na tela e somem sozinhos. */
    .mobile .stage-area.controls .corner, .mobile .stage-area.controls .viewfinder { opacity: 1; transform: none; }
    .mobile .stage-area:hover .viewfinder, .mobile .stage-area:hover .corner { opacity: 0; }
    .mobile .stage-area.controls:hover .corner, .mobile .stage-area.controls:hover .viewfinder { opacity: 1; }
    .mobile .corner { top: 0.7rem; right: 0.7rem; gap: 0.45rem; }
    .mobile .corner .btn { min-width: 40px; height: 40px; }
    .mobile .people-top { display: none; }
    .mobile .wide-only { display: none; }
    .mobile .topbar { gap: 0.6rem; padding: 0.4rem 0.7rem; padding-top: max(0.4rem, env(safe-area-inset-top)); min-height: 0; flex-wrap: nowrap; }
    .mobile .mark { width: 24px; height: 24px; }
    .mobile .plate { height: 34px; }
    .mobile .now { order: 5; flex-basis: 100%; }
    .mobile .now .tag:not(.warn) { display: none; }
    .mobile .topbar:has(.now) { flex-wrap: wrap; }
    .mobile .banner { flex-wrap: wrap; font-size: 0.82rem; }
    /* Dock: teclas grandes para o dedo, longe da barra de gestos do sistema. */
    .mobile .dock { padding: 0.5rem 0.5rem calc(0.6rem + env(safe-area-inset-bottom)); }
    .mobile .keys { gap: 0.4rem; }
    .mobile .keys .btn.icon { width: 50px; height: 48px; }
    .mobile .caret { width: 26px; height: 48px; }
    .mobile .hangup { width: 58px; }
    /* Menus da dock, pessoas e volume viram gaveta de baixo, na largura toda. */
    .mobile .pop, .mobile .pop.wide { position: fixed; left: 0.5rem; right: 0.5rem; width: auto; translate: none;
      bottom: calc(4.6rem + env(safe-area-inset-bottom)); max-height: 70dvh; }
    .mobile .panel { position: fixed; top: auto; left: 0.5rem; right: 0.5rem; width: auto;
      bottom: calc(4.6rem + env(safe-area-inset-bottom)); max-height: 72dvh; animation: unfold-up 160ms linear both; }
    .mobile .volume-menu { left: 0.5rem !important; right: 0.5rem; top: auto !important; width: auto;
      bottom: calc(4.6rem + env(safe-area-inset-bottom)); padding: 0.9rem 1rem; }
    .mobile .check-row { padding: 0.75rem 0.5rem; }
    .mobile .close { padding: 10px; }
    .mobile .diag { position: fixed; left: 0.5rem; right: 0.5rem; width: auto; top: calc(3.2rem + env(safe-area-inset-top)); max-height: 70dvh; }
    .mobile .diag .switch { padding: 0.35rem 0; }
    .mobile .tray { top: 0.5rem; }
    .mobile .tray .btn { height: 36px; }
    .mobile .empty { place-items: start center; }
    .mobile .testcard { padding-left: 1.1rem; padding-right: 1.1rem; }
    .mobile .bars { margin: 0 -1.1rem 1.3rem; }
    .mobile .grid { padding: 6px; gap: 6px; overflow-y: auto; grid-auto-rows: minmax(min(56vw, 40dvh), 1fr); }
  `,
})
export class RoomScreen {
  readonly label = input.required<string>();
  readonly leave = output<void>();
  protected readonly store = inject(RoomStore);
  private readonly toast = inject(Toast);
  private readonly invites = inject(Invites);
  protected readonly prefs = inject(Prefs);
  protected readonly canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  protected readonly menu = signal<Menu | null>(null);
  /** Algum plugin de DAW tocando na sala: a tecla do plugin fica acesa. */
  protected readonly dawPlaying = computed(() => this.store.studio.streams().some((s) => s.source === 'daw'));
  protected readonly obsLive = computed(() => this.store.shares().some((s) => s.obs));
  protected readonly diagOpen = signal(false);
  /** A travada mais recente, por 8 s, numa faixa sobre a tela. Só com a chave do diagnóstico ligada. */
  protected readonly freshIssue = computed(() => {
    if (!this.prefs.diagOn()) return null;
    const e = this.store.diag.events()[0];
    return e !== undefined && this.now() - e.at < 8000 ? e : null;
  });
  protected readonly isMobile = IS_MOBILE;
  protected readonly isIOS = IS_IOS;
  protected readonly controls = signal(false);
  protected readonly portrait = signal(window.innerHeight > window.innerWidth);
  protected readonly peopleOpen = signal(false);
  private readonly joinedAt = Date.now();
  private readonly now = signal(Date.now());
  protected readonly clock = computed(() => timecode(this.now() - this.joinedAt));
  protected readonly ledClass = computed(() => {
    const s = this.store.status();
    return 'led ' + (s === 'connected' ? 'ok' : s === 'disconnected' ? 'bad' : 'warn');
  });
  protected readonly statusText = computed(() => {
    const s = this.store.status();
    return s === 'connected' ? 'Conectado · tempo na sala' : s === 'disconnected' ? 'Desconectado' : 'Reconectando…';
  });
  protected readonly isFullscreen = signal(false);
  protected readonly stage = viewChild(Stage);
  protected readonly volumeMenu = signal<{ id: string; name: string; x: number; y: number } | null>(null);
  /** Colunas da grade: 2 telas lado a lado, 3-4 em 2x2, 5+ em 3 colunas. */
  protected readonly gridCols = computed(() => {
    const n = this.store.shares().length;
    // Celular em pé: uma tela embaixo da outra.
    if (this.isMobile && this.portrait()) return 1;
    return n <= 2 ? n : n <= 4 ? 2 : 3;
  });

  viewersTitle(id: string) {
    const names = this.store.viewersOf(id);
    return names.length === 0 ? 'Ninguém assistindo' : `Assistindo: ${names.join(', ')}`;
  }

  shareById(id: string) {
    return this.store.shares().find((s) => s.id === id) ?? null;
  }

  /** Botão direito numa tela: menu com o volume do som dela. */
  openVolume(e: MouseEvent, s: ShareView) {
    e.preventDefault();
    if (s.isLocal) return;
    const x = Math.min(e.clientX, window.innerWidth - 276);
    const y = Math.min(e.clientY, window.innerHeight - 190);
    this.volumeMenu.set({ id: s.id, name: s.ownerName, x, y });
  }

  /** Botão de som no canto da tela (funciona em tela cheia, onde o botão direito some de vista). */
  openVolumeAt(e: MouseEvent, s: ShareView) {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.max(8, Math.min(r.right - 270, window.innerWidth - 278));
    this.volumeMenu.set({ id: s.id, name: s.ownerName, x, y: r.bottom + 6 });
  }

  /** Clicar na tela em foco volta para a grade (se não estiver usando o cursor, que também clica). */
  clickFocused() {
    // No celular, tocar na tela mostra/esconde os botões (não tem "passar o mouse").
    if (this.isMobile) {
      this.pokeControls(!this.controls());
      return;
    }
    if (this.store.shares().length > 1 && !this.prefs.cursorOn()) this.store.unfocus();
  }
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
  protected readonly callRoom = isCallRoom();
  protected readonly link = computed(() => roomUrl(this.label()));
  protected readonly emptyHint = computed(() =>
    this.store.canPublish()
      ? this.canShare
        ? 'Compartilhe sua tela e todo mundo na sala vê na hora.'
        : 'Esperando alguém compartilhar. Celular assiste, mas só computador compartilha tela.'
      : 'Você entrou como espectador. Quando alguém compartilhar, aparece aqui.',
  );

  constructor() {
    const t = window.setInterval(() => this.now.set(Date.now()), 1000);
    const onResize = () => this.portrait.set(window.innerHeight > window.innerWidth);
    const onVisible = () => {
      if (!document.hidden && this.store.focused() !== null) void this.keepAwake();
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisible);
    // Tem alguém transmitindo: não deixa a tela apagar.
    effect(() => {
      if (this.store.focused() !== null || this.store.shares().length > 0) void this.keepAwake();
      else if (this.wakeLock !== null) {
        void this.wakeLock.release().catch(() => undefined);
        this.wakeLock = null;
      }
    });
    inject(DestroyRef).onDestroy(() => {
      window.clearInterval(t);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisible);
      void this.wakeLock?.release().catch(() => undefined);
    });
  }

  toggleDiag() {
    this.diagOpen.update((v) => !v);
    this.store.diag.markSeen();
  }

  openDiag() {
    this.diagOpen.set(true);
    this.store.diag.markSeen();
  }

  /** A chave do diagnóstico. Ligar não acusa as travadas de antes como novas. */
  setDiag(on: boolean) {
    this.prefs.setDiagOn(on);
    this.store.diag.markSeen();
  }

  /**
   * Por que a tela de quem transmite está mais leve: o PC ou a internet dele não aguentam o máximo
   * e o navegador dele reduziu sozinho. Sem limitação (inclusive quando ele mesmo escolheu menos),
   * não aparece nada.
   */
  senderNote(): { text: string; title: string } | null {
    this.now();
    const s = this.store.focusedSender();
    const tx = s === null ? null : parseSendHealth(s.tx);
    if (s === null || tx === null) return null;
    if (tx.lim === 'cpu' || tx.cpu === 'serious' || tx.cpu === 'critical') {
      return {
        text: `PC de ${s.name} no limite`,
        title: `O PC de ${s.name} não aguenta transmitir no máximo agora, então o navegador dele baixou resolução ou fps para a transmissão não travar. Volta sozinho quando sobrar folga (por exemplo, limitando o fps do jogo).`,
      };
    }
    if (tx.lim === 'bandwidth' || (tx.max > 0 && tx.cap < tx.max)) {
      return {
        text: `internet de ${s.name} no limite`,
        title: `A internet de ${s.name} não comporta o máximo agora, então a transmissão saiu mais leve para não travar. Volta sozinho quando a conexão melhorar.`,
      };
    }
    return null;
  }

  causeLabel(c: string) {
    switch (c) {
      case 'their-net':
        return 'internet de quem transmite';
      case 'their-pc':
        return 'PC de quem transmite';
      case 'their-idle':
        return 'nada novo de quem transmite';
      case 'my-net':
        return 'sua internet';
      case 'my-pc':
        return 'seu PC';
      case 'my-decoder':
        return 'decodificador do seu navegador';
      default:
        return 'sem causa clara';
    }
  }

  toggleMenu(m: Menu) {
    this.menu.set(this.menu() === m ? null : m);
  }

  togglePeople() {
    this.peopleOpen.update((v) => !v);
  }

  menuTitle(m: Menu) {
    return m === 'mic' ? 'microfone' : m === 'screen' ? 'transmissão da tela' : m === 'daw' ? 'plugin de DAW' : m === 'obs' ? 'transmitir pelo OBS' : 'câmera';
  }

  closeAll() {
    this.menu.set(null);
    this.diagOpen.set(false);
    this.volumeMenu.set(null);
  }

  /** Clique fora do submenu da barra (ou do menu do diagnóstico) fecha o menu. */
  outside(e: PointerEvent) {
    const el = e.target instanceof Element ? e.target : null;
    if (this.diagOpen() && el?.closest('.diag-wrap, .issue') == null) this.diagOpen.set(false);
    if (this.menu() === null) return;
    if (el?.closest('.pop, .caret, [aria-label="Plugin de DAW"]') == null) this.menu.set(null);
  }

  /**
   * Ctrl + roda (e a pinça do touchpad, que o navegador entrega como Ctrl + roda) dava zoom na
   * página inteira em cima do vídeo. Na área da tela isso não faz sentido: bloqueia.
   */
  clip() {
    if (!this.store.canClip() || this.store.focused() === null) return;
    if (this.store.clips.buffered() < 1) {
      this.toast.show('Ainda começando a guardar esta tela. Tente de novo em alguns segundos.');
      return;
    }
    this.store.clips.clip();
  }

  /** Apagar com 5 s para desfazer. */
  deleteClip(c: ClipItem) {
    const undo = this.store.clips.removeLater(c, 5000);
    this.toast.show('Clipe apagado.', { ms: 5000, action: { label: 'desfazer', run: undo } });
  }

  clockAt(t: number) {
    return new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  mmss(seconds: number) {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  left(expiresAt: number | undefined) {
    return expiresAt === undefined ? '' : this.mmss((expiresAt - this.now()) / 1000);
  }

  hiddenName(s: ShareView) {
    return s.isLocal ? 'sua tela' : s.ownerName;
  }

  showAll() {
    for (const h of this.store.hiddenShares()) this.store.showShare(h.id);
  }

  noZoom(e: WheelEvent) {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  }

  protected readonly hangingUp = signal(false);
  /** Sai da sala depois do efeito de TV desligando. */
  hangUp() {
    if (this.hangingUp()) return;
    this.hangingUp.set(true);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(() => this.leave.emit(), reduced ? 0 : 430);
  }

  copyInvite() {
    void this.invites.invite(this.label());
  }

  protected fullscreenActive() {
    return document.fullscreenElement !== null;
  }

  toggleFullscreen() {
    const el = this.stageArea().nativeElement;
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen();
      return;
    }
    // iPhone: não tem tela cheia de elemento, só o player do próprio vídeo.
    if (typeof el.requestFullscreen !== 'function') {
      if (!this.stage()?.videoFullscreen()) this.toast.show('Este navegador não tem tela cheia.');
      return;
    }
    el.requestFullscreen({ navigationUI: 'hide' })
      .then(() => {
        // Celular: tela de PC (deitada) já vira o aparelho sozinha.
        if (this.isMobile && this.stage()?.isLandscape() !== false) void this.lockOrientation('landscape');
      })
      .catch(() => {
        if (!this.stage()?.videoFullscreen()) this.toast.show('O navegador recusou a tela cheia.');
      });
  }

  /** Alterna em pé/deitado durante a tela cheia (Android). */
  rotate() {
    void this.lockOrientation(this.portrait() ? 'landscape' : 'portrait');
  }

  private async lockOrientation(o: 'landscape' | 'portrait') {
    const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    try {
      await so.lock?.(o);
    } catch {
      /* navegador não deixa: segue como está */
    }
  }

  /** Mostra os botões por cima da tela por alguns segundos (celular). */
  pokeControls(show = true) {
    window.clearTimeout(this.controlsTimer);
    this.controls.set(show);
    if (show) this.controlsTimer = window.setTimeout(() => this.controls.set(false), 4000);
  }
  private controlsTimer?: number;

  /** Mantém a tela do celular acesa enquanto assiste. */
  private async keepAwake() {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (wl === undefined || document.hidden || this.wakeLock !== null) return;
    try {
      const lock = await wl.request('screen');
      this.wakeLock = lock;
      (lock as unknown as EventTarget).addEventListener?.('release', () => (this.wakeLock = null));
    } catch {
      /* sem bateria sobrando ou negado */
    }
  }
  private wakeLock: { release(): Promise<void> } | null = null;
}
