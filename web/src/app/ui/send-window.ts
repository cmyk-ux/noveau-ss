import { Component, inject } from '@angular/core';
import { SendFx } from '../core/send-fx';
import { PixelIcon } from './pixel-icon';

/** A janela de envio (convites, links, avisos): papel pulando de um ícone pro outro e barra de blocos. */
@Component({
  selector: 'cen-send-window',
  imports: [PixelIcon],
  template: `
    @if (fx.view(); as v) {
      @let busy = v.state === 'running';
      <div class="win" [class.done]="v.state === 'done'" [class.failed]="v.state === 'failed'" role="status" aria-live="polite">
        <div class="bar">
          <img class="pixel" src="logo.svg" alt="" width="14" height="14" />
          <span class="title">{{ v.title }}</span>
          <button type="button" class="x" title="Fechar" (click)="fx.close()">×</button>
        </div>
        <div class="body">
          <div class="scene">
            <span class="end from"><cen-pixel [name]="v.from" [size]="27" /></span>
            <span class="path">
              @if (busy) {
                @for (k of trail; track k) {
                  <span class="fly" [style.--k]="k"><span class="hop"><cen-pixel [name]="v.item" [size]="14" /></span></span>
                }
              }
            </span>
            <span class="end to" [class.got]="!busy"><cen-pixel [name]="v.to" [size]="27" /></span>
          </div>
          <p class="line">{{ busy ? v.line + '…' : v.result }}</p>
          <div class="blocks" aria-hidden="true">
            @for (b of blocks; track b) { <i [style.--b]="b"></i> }
          </div>
          @if (!busy) {
            <div class="foot"><button type="button" class="btn small ok" (click)="fx.close()">OK</button></div>
          }
        </div>
      </div>
    }
  `,
  styles: `
    :host { position: fixed; left: 50%; bottom: 6.2rem; translate: -50% 0; z-index: 61; width: min(340px, calc(100vw - 1.5rem)); }
    /* Janela: chapa do site com a barra de título do Windows 98 nas cores da logo. Abre em degraus, como lá. */
    .win { border: 1px solid #0b0b0c; border-radius: 3px; overflow: hidden; background-color: var(--chassis);
      background-image: var(--grain), var(--brushed); background-size: 160px 160px, auto;
      box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.06), 0 18px 40px -14px #000, 0 2px 0 #0a0a0b;
      animation: win-open 260ms steps(5) both; transform-origin: 50% 100%; }
    .bar { display: flex; align-items: center; gap: 0.45rem; height: 24px; padding: 0 3px 0 6px;
      background: linear-gradient(90deg, #3d3270, #57489a 60%, #6c5fb0); color: #f1ede4; }
    .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 0.74rem/1 var(--ui);
      letter-spacing: 0.02em; }
    .x { width: 18px; height: 16px; padding: 0; display: grid; place-items: center; border-radius: 1px; border: 1px solid #0b0b0c;
      background: var(--plate); color: var(--text); font: 600 0.8rem/1 var(--ui); box-shadow: var(--key-shadow); }
    .x:active { box-shadow: var(--key-pressed); translate: 0 1px; }
    .body { padding: 0.75rem 0.85rem 0.8rem; }

    /* Cena: de um ícone pro outro, três papéis em fila pulando em arco. */
    .scene { display: flex; align-items: flex-end; gap: 0.4rem; height: 50px; }
    .end { flex-shrink: 0; width: 40px; height: 40px; display: grid; place-items: center; border-radius: 2px; background: #111110;
      box-shadow: var(--inset); color: #ebe6da; }
    .from { color: #e2a12e; }
    .to { color: #b8b3a6; transition: color 160ms; }
    .to.got { color: #94cf7c; animation: got 360ms steps(3) both; }
    .failed .to { color: var(--danger); animation: shake 300ms steps(4) both; }
    .path { position: relative; flex: 1; height: 100%; }
    .fly { position: absolute; left: 0; bottom: 10px; color: #ebe6da;
      animation: fly-x 900ms steps(10) infinite; animation-delay: calc(var(--k) * -300ms); }
    .hop { display: block; animation: fly-y 900ms steps(10) infinite; animation-delay: calc(var(--k) * -300ms); }
    .line { margin: 0.55rem 0 0.45rem; font: 400 0.74rem/1.35 var(--mono); color: var(--muted); overflow-wrap: anywhere; min-height: 2.7em; }
    .done .line { color: var(--text); }
    .failed .line { color: var(--danger); }

    /* Barra de progresso de blocos: enche até quase o fim e espera; quando termina, completa. */
    .blocks { display: grid; grid-template-columns: repeat(14, 1fr); gap: 2px; height: 12px; padding: 2px; border-radius: 1px;
      background: #0a0a0b; box-shadow: var(--inset); }
    .blocks i { background: #94cf7c; opacity: 0; animation: block-on 1ms linear forwards; animation-delay: calc(var(--b) * 85ms); }
    .blocks i:nth-child(n + 12) { animation: none; }
    .done .blocks i, .failed .blocks i { opacity: 1; animation: none; }
    .failed .blocks i { background: var(--danger); }
    .foot { display: flex; justify-content: flex-end; margin-top: 0.6rem; }
    .ok { min-width: 64px; }

    @keyframes win-open { from { opacity: 0.2; transform: scale(0.2, 0.08); } 60% { transform: scale(1, 0.08); } to { opacity: 1; transform: none; } }
    @keyframes fly-x { from { left: 0; opacity: 0; } 10% { opacity: 1; } 90% { opacity: 1; } to { left: calc(100% - 14px); opacity: 0; } }
    @keyframes fly-y { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-22px); } }
    @keyframes block-on { to { opacity: 1; } }
    @keyframes got { 50% { transform: scale(1.18); } }
    @keyframes shake { 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }
  `,
})
export class SendWindow {
  protected readonly fx = inject(SendFx);
  protected readonly trail = [0, 1, 2];
  protected readonly blocks = Array.from({ length: 14 }, (_, i) => i);
}
