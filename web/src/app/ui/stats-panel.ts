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
@Component({
  selector: 'cen-stats-panel',
  host: { '[hidden]': '!prefs.showStats()' },
  template: `
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
    :host { position: absolute; top: 0.75rem; left: 0.75rem; z-index: 5; min-width: 230px; padding: 0.6rem 0.75rem;
      background: #000a; border: 1px solid var(--line); border-radius: var(--radius); font: 12px/1.5 var(--mono); }
    :host([hidden]) { display: none; }
    .title { color: var(--accent); margin-top: 0.3rem; }
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
        ...soundRows(await this.store.sendingAudioStats()),
      ],
    };
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
        row('bitrate', formatBitrate(r.bitrate)),
        row('codec', r.codec),
        row('decoder', `${r.decoder}${r.gpu === null ? '' : r.gpu ? ' · GPU' : ' · CPU'}`),
        row('pacotes perdidos', String(r.packetsLost), r.packetsLost > 0),
        row('quadros descartados', String(r.framesDropped), r.framesDropped > 0),
        row('travadas', `${r.freezeCount} (${r.freezeSeconds}s)`, r.freezeCount > 0),
        row('jitter', `${r.jitterMs} ms`, r.jitterMs > 50),
        ...soundRows(await this.store.receivingAudioStats()),
      ],
    };
  }
}
