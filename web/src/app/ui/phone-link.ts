import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { PhoneUse } from '../core/api';
import qrcode from 'qrcode-generator';
import { Invites } from '../core/invites';
import { RoomStore } from '../core/room-store';
import { Icon } from './icon';

/** Desenha o QR como pixels (um <path> só), no mesmo jeito da logo. */
function qrPath(text: string): { d: string; size: number } {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      // Junta os pixels escuros seguidos da linha num retângulo só.
      let end = c;
      while (end + 1 < n && qr.isDark(r, end + 1)) end++;
      d += `M${c + 4} ${r + 4}h${end - c + 1}v1h-${end - c + 1}z`;
      c = end;
    }
  }
  return { d, size: n + 8 };
}

/**
 * Celular como câmera/microfone do PC (estilo Iriun e WO Mic): gera um link + QR, mostra quando o
 * celular entra, liga/desliga a câmera e o microfone dele e desconecta para liberar outro link.
 */
@Component({
  selector: 'cen-phone-link',
  imports: [Icon],
  template: `
    @if (store.myPhone(); as ph) {
      <div class="state">
        <span class="lcd"><span class="led ok"></span>celular na sala</span>
      </div>
      <div class="rows">
        <button
          type="button"
          class="row"
          [class.lit]="ph.cam === 'on'"
          (click)="store.controlPhone({ cam: ph.cam !== 'on' })"
        >
          <cen-icon [name]="ph.cam === 'on' ? 'camera' : 'cameraOff'" [size]="16" />
          <span class="what">câmera do celular</span>
          <span class="mono val">{{ ph.cam === 'on' ? 'ligada' : 'desligada' }}</span>
        </button>
        <button
          type="button"
          class="row"
          [class.lit]="ph.mic === 'on'"
          (click)="store.controlPhone({ mic: ph.mic !== 'on' })"
        >
          <cen-icon [name]="ph.mic === 'on' ? 'mic' : 'micOff'" [size]="16" />
          <span class="what">microfone do celular</span>
          <span class="mono val">{{ ph.mic === 'on' ? 'ligado' : 'desligado' }}</span>
        </button>
      </div>
      <p class="hint">
        As teclas de câmera e microfone da barra também comandam o celular enquanto ele estiver
        ligado aqui.
      </p>
      <button class="btn danger wide" [disabled]="store.phoneBusy()" (click)="store.unlinkPhone()">
        Desconectar o celular
      </button>
    } @else {
      @switch (store.phoneLink().state) {
        @case ('waiting') {
          <div class="qr-wrap">
            @if (qr(); as q) {
              <svg
                class="qr"
                [attr.viewBox]="'0 0 ' + q.size + ' ' + q.size"
                shape-rendering="crispEdges"
                role="img"
                aria-label="QR do link do celular"
              >
                <rect [attr.width]="q.size" [attr.height]="q.size" fill="#e8e4d8" />
                <path [attr.d]="q.d" fill="#141415" />
              </svg>
            }
            <div class="qr-side">
              <p class="hint">
                Aponte a câmera do celular para o código, ou mande o link para ele.
              </p>
              <span class="lcd wait"><span class="led warn"></span>aguardando</span>
              <p class="mono dim">vence em {{ left() }}</p>
            </div>
          </div>
          <button
            type="button"
            class="copy mono"
            title="Copiar o link"
            (click)="invites.copy(url(), 'Link do celular copiado')"
          >
            {{ url() }}
          </button>
          <p class="hint">
            Só um aparelho abre este link. Para usar outro, cancele e gere de novo.
          </p>
          <button class="btn wide" [disabled]="store.phoneBusy()" (click)="store.unlinkPhone()">
            Cancelar o link
          </button>
        }
        @case ('claimed') {
          <div class="state">
            <span class="lcd"><span class="led warn"></span>celular fora da sala</span>
          </div>
          <p class="hint">
            O celular abriu o link mas não está na sala agora (a tela apagou ou a página fechou).
            Abra a página de novo nele e ele volta sozinho.
          </p>
          <button
            class="btn danger wide"
            [disabled]="store.phoneBusy()"
            (click)="store.unlinkPhone()"
          >
            Desconectar e liberar outro link
          </button>
        }
        @default {
          <p class="hint">
            @if (use() === 'mic') {
              Use o microfone do celular aqui, sem instalar nada: o celular abre um link e vira o
              microfone deste PC na sala. A câmera dele fica desligada.
            } @else {
              Use a câmera do celular aqui, sem instalar nada: o celular abre um link e vira a
              câmera deste PC na sala. O microfone dele fica desligado.
            }
          </p>
          <button class="btn wide" [disabled]="store.phoneBusy()" (click)="store.makePhoneLink(use())">
            <cen-icon name="phone" [size]="16" />
            {{ store.phoneBusy() ? 'Gerando…' : 'Usar o celular' }}
          </button>
        }
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .state {
      display: flex;
      margin: 0.35rem 0 0.5rem;
    }
    .lcd {
      gap: 0.45rem;
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .lcd .led {
      width: 6px;
      height: 6px;
      background: var(--lcd-ink);
      box-shadow: none;
    }
    .lcd .led.warn {
      animation: blink 1.2s steps(1) infinite;
    }
    .rows {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
    }
    /* Linhas como teclas de painel: afundam quando ligadas. */
    .row {
      display: flex;
      align-items: center;
      gap: 0.55rem;
      width: 100%;
      padding: 0.5rem 0.6rem;
      border: 1px solid #0b0b0c;
      border-radius: 3px;
      background: var(--plate);
      box-shadow: var(--key-shadow);
      color: var(--muted);
      text-align: left;
    }
    .row:hover {
      background: var(--plate-hi);
    }
    .row.lit {
      transform: translateY(1px);
      box-shadow: var(--key-pressed);
      background: #303031;
      color: var(--text);
    }
    .row.lit cen-icon {
      color: var(--accent-hi);
    }
    .what {
      flex: 1;
      font-size: 0.86rem;
    }
    .val {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .row.lit .val {
      color: var(--ok);
    }
    .btn {
      margin-top: 0.6rem;
    }
    .qr-wrap {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      margin: 0.4rem 0 0.5rem;
    }
    /* QR impresso numa etiqueta de papel, com moldura de painel. */
    .qr {
      width: 132px;
      height: 132px;
      flex-shrink: 0;
      display: block;
      border-radius: 2px;
      image-rendering: pixelated;
      box-shadow:
        0 0 0 1px #0b0b0c,
        0 0 0 3px #2a2a2b,
        0 0 0 4px #0b0b0c;
      animation: print 520ms steps(8) both;
    }
    .qr-side {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      min-width: 0;
    }
    .qr-side .hint {
      margin: 0;
    }
    .wait {
      align-self: flex-start;
      white-space: nowrap;
    }
    .dim {
      color: var(--faint);
      font-size: 0.72rem;
      margin: 0;
    }
    .copy {
      display: block;
      width: 100%;
      text-align: left;
      padding: 0.45rem 0.6rem;
      border-radius: 5px;
      border: 1px solid #0b0b0c;
      background: var(--well);
      box-shadow: var(--inset);
      font-size: 0.74rem;
      word-break: break-all;
    }
    .copy:hover {
      color: var(--accent-hi);
    }
  `,
})
export class PhoneLinkPanel {
  protected readonly store = inject(RoomStore);
  protected readonly invites = inject(Invites);
  /** De qual menu veio (câmera ou microfone): o celular começa ligando só isso. */
  readonly use = input<PhoneUse>('cam');
  private readonly now = signal(Date.now());
  protected readonly url = computed(() => {
    const { code, use } = this.store.phoneLink();
    // "?mic": a página do celular pede só o microfone (sem abrir a câmera).
    return code === undefined ? '' : `${location.origin}/celular${use === 'mic' ? '?mic' : ''}#${code}`;
  });
  protected readonly qr = computed(() => (this.url() === '' ? null : qrPath(this.url())));
  protected readonly left = computed(() => {
    const s = Math.max(
      0,
      Math.floor(((this.store.phoneLink().expiresAt ?? 0) - this.now()) / 1000),
    );
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });

  constructor() {
    void this.store.refreshPhone();
    effect((onCleanup) => {
      if (this.store.phoneLink().state !== 'waiting') return;
      const t = window.setInterval(() => {
        this.now.set(Date.now());
        // Venceu sem ninguém abrir: volta para "Usar o celular".
        if ((this.store.phoneLink().expiresAt ?? 0) < Date.now()) void this.store.refreshPhone();
      }, 1000);
      onCleanup(() => window.clearInterval(t));
    });
    // O celular saiu ou entrou: confere de novo o estado do link.
    let had = this.store.myPhone() !== null;
    effect(() => {
      const has = this.store.myPhone() !== null;
      if (has !== had) void this.store.refreshPhone();
      had = has;
    });
  }
}
