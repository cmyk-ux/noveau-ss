import { Component, effect, inject, signal } from '@angular/core';
import { Prefs } from '../core/prefs';
import { RoomStore } from '../core/room-store';
import { AudioReading, describeLimitation } from '../core/stats';
import { formatBitrate } from '../core/stream';
import { describePressure } from '../core/load';

interface Row {
  label: string;
  value: string;
  warn: boolean;
}
interface Section {
  title: string;
  rows: Row[];
}

const REFRESH_MS = 1000;

/** Taxa de atualização da tela de quem assiste, medida pelos quadros de animação do navegador. */
let monitorHz = 0;
function measureMonitor() {
  let n = 0;
  const start = performance.now();
  const step = (t: number) => {
    n++;
    if (t - start < 1000) requestAnimationFrame(step);
    else {
      const hz = (n * 1000) / (t - start);
      // Arredonda para as taxas comuns (60, 75, 120, 144, 165, 240...).
      const common = [30, 50, 60, 75, 90, 100, 120, 144, 165, 170, 180, 240, 280, 360];
      monitorHz = common.reduce((a, b) => (Math.abs(b - hz) < Math.abs(a - hz) ? b : a));
    }
  };
  requestAnimationFrame(step);
}

function row(label: string, value: string, warn = false): Row {
  return { label, value, warn };
}

function soundRows(a: AudioReading | null): Row[] {
  if (a === null) return [row('som', 'sem faixa de áudio', true)];
  const ch = a.channels === 2 ? 'estéreo' : a.channels === 1 ? 'mono' : '?';
  return [
    row('som', `${formatBitrate(a.bitrate)} ${a.codec} ${ch}`, a.bitrate === 0),
    row('nível do som', `${Math.round(a.level * 100)}%`, a.level === 0),
  ];
}

/** Números ao vivo do que está sendo enviado e recebido. */
function lossPct(lost: number, got: number) {
  const t = lost + got;
  return t === 0 ? '0%' : `${((lost * 100) / t).toFixed(lost * 100 < t ? 2 : 1)}%`;
}

@Component({
  selector: 'cen-stats-panel',
  host: { '[hidden]': '!prefs.showStats()' },
  template: `
    <button type="button" class="x" title="Fechar as estatísticas" aria-label="Fechar as estatísticas" (click)="prefs.setShowStats(false)">×</button>
    @for (s of sections(); track s.title) {
      <div class="title">{{ s.title }}</div>
      @for (r of s.rows; track r.label) {
        <div class="row" [class.warn]="r.warn"><span>{{ r.label }}</span><strong>{{ r.value }}</strong></div>
      }
    } @empty {
      <div class="title">Nenhum vídeo ativo</div>
    }
  `,
  styles: `
    /* Leitura de equipamento: fósforo sobre preto. */
    :host { position: absolute; top: 0.75rem; left: 0.75rem; z-index: 5; min-width: 240px; padding: 0.55rem 0.75rem 0.65rem;
      background: rgb(16 16 17 / 0.88); border: 1px solid #0b0b0c; border-radius: 2px; font: 11.5px/1.55 var(--mono);
      box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.05); pointer-events: none; }
    :host([hidden]) { display: none; }
    .x { position: absolute; top: 2px; right: 2px; width: 22px; height: 22px; display: grid; place-items: center; padding: 0;
      border: 0; border-radius: 2px; background: none; color: var(--muted); font: 16px/1 var(--mono); cursor: pointer; pointer-events: auto; }
    .x:hover { color: var(--text); background: rgb(255 255 255 / 0.08); }
    .title { color: var(--accent-hi); margin-top: 0.35rem; text-transform: uppercase; letter-spacing: 0.14em; font-size: 10px; }
    .row strong { font-weight: 500; color: var(--text); }
    .row { display: flex; justify-content: space-between; gap: 1rem; }
    .row span { color: var(--muted); }
    .row.warn strong { color: var(--danger); }
  `,
})
export class StatsPanel {
  protected readonly prefs = inject(Prefs);
  private readonly store = inject(RoomStore);
  protected readonly sections = signal<Section[]>([]);

  constructor() {
    effect((onCleanup) => {
      if (!this.prefs.showStats()) {
        this.sections.set([]);
        return;
      }
      if (!document.hidden) measureMonitor();
      void this.refresh();
      const t = window.setInterval(() => void this.refresh(), REFRESH_MS);
      onCleanup(() => window.clearInterval(t));
    });
  }

  private async refresh() {
    const out: Section[] = [];
    const sending = await this.readSending();
    if (sending !== null) out.push(sending);
    const receiving = await this.readReceiving();
    if (receiving !== null) out.push(receiving);
    this.sections.set(out);
  }

  private async readSending(): Promise<Section | null> {
    const s = await this.store.sendingStats();
    if (s === null) return null;
    const h = this.store.health();
    return {
      title: 'Enviando',
      rows: [
        row('tamanho', `${s.width}x${s.height}`),
        row('fps capturados', `${s.captureFps} / ${this.prefs.stream().frameRate}`, s.captureFps > 0 && s.captureFps < this.prefs.stream().frameRate * 0.9),
        row('fps enviados', String(s.fps), s.captureFps > 0 && s.fps < s.captureFps * 0.85),
        row('bitrate', formatBitrate(s.bitrate)),
        row('alvo', formatBitrate(s.targetBitrate)),
        row('codec', `${s.codec} ${s.scalabilityMode}`),
        row('encoder', `${s.encoder}${s.gpu === null ? '' : s.gpu ? ' · GPU' : ' · CPU'}`, s.gpu === false),
        row('tempo por quadro', `${s.encodeMs} ms`, s.encodeMs > 1000 / Math.max(s.fps, 1)),
        ...this.loadRows(),
        row('limitado por', describeLimitation(s.limitation)),
        row('sustentado', h?.sustained === true ? describeLimitation(h.reason) : 'não', h?.sustained === true),
        row('mudanças de tamanho', String(s.resolutionChanges), s.resolutionChanges > 0),
        row('quadros gigantes', String(s.hugeFrames), s.hugeFrames > 0),
        row('quadros-chave', `${s.keyFrames} (${s.keyRequests} pedidos)`, s.keyRequests > 0),
        ...this.uploadRows(),
        ...soundRows(await this.store.sendingAudioStats()),
        ...this.tipRows(s),
      ],
    };
  }

  /** Dicas a partir da pesquisa: OpenH264 = H.264 no processador; captura acima de 1080p presa no orçamento do Chrome. */
  private tipRows(s: { encoder: string; width: number; height: number; captureFps: number }): Row[] {
    const want = this.prefs.stream().frameRate;
    const out: Row[] = [];
    if (/openh264/i.test(s.encoder)) out.push(row('dica', 'H.264 no processador: abra com a flag PlatformH264CbpEncoding', true));
    if (s.captureFps > 0 && s.captureFps < want * 0.9 && s.width * s.height > 1920 * 1080)
      out.push(row('dica', 'captura acima de 1080p limitada pelo navegador: tente 1080p ou Auto', true));
    return out;
  }

  private uploadRows(): Row[] {
    const u = this.store.upload();
    if (u === null) return [];
    const pct = (u.loss * 100).toFixed(u.loss < 0.01 ? 2 : 1);
    return [
      row('perda na subida', `${pct}%`, u.loss > 0.005),
      row('teto por perda', u.cap >= u.target ? 'no máximo' : `${formatBitrate(u.cap)} de ${formatBitrate(u.target)}`, u.cap < u.target),
    ];
  }

  private loadRows(): Row[] {
    const l = this.store.load();
    if (l === null) return [];
    if (!l.supported) return [row('uso do PC', 'navegador não informa')];
    return [
      row('uso do PC', describePressure(l.pressure), l.pressure === 'serious' || l.pressure === 'critical'),
      row('degrau', l.step === 0 ? 'qualidade total' : `${l.width}x${l.height} ≤${l.fps}fps`, l.step > 0),
    ];
  }

  private async readReceiving(): Promise<Section | null> {
    const f = this.store.focused();
    if (f === null || f.isLocal) return null;
    const r = await this.store.receivingStats();
    if (r === null) return null;
    return {
      title: `Recebendo de ${f.ownerName}`,
      rows: [
        row('tamanho', `${r.width}x${r.height}`),
        row('fps', String(r.fps)),
        // Mais quadros que o monitor atualiza não aparecem: 120 fps só se vê num monitor de 120 Hz+.
        row('seu monitor', monitorHz > 0 ? `${monitorHz} Hz` : 'medindo…', monitorHz > 0 && r.fps > monitorHz + 3),
        row('bitrate', formatBitrate(r.bitrate)),
        row('codec', r.codec),
        row('decoder', `${r.decoder}${r.gpu === null ? '' : r.gpu ? ' · GPU' : ' · CPU'}`),
        row('pacotes perdidos', `${r.packetsLost} (${lossPct(r.packetsLost, r.packetsReceived)})`, r.packetsLost > 0),
        row('reenvios', `${r.recovered} recuperados / ${r.nacks} pedidos`),
        row('proteção', this.store.shieldStatus() || '—'),
        row('quadros descartados', String(r.framesDropped), r.framesDropped > 0),
        row('travadas', `${r.freezeCount} (${r.freezeSeconds}s)`, r.freezeCount > 0),
        row('quadro-chave pedido', String(r.keyRequests), r.keyRequests > 0),
        row('jitter', `${r.jitterMs} ms`, r.jitterMs > 50),
        ...soundRows(await this.store.receivingAudioStats()),
      ],
    };
  }
}
