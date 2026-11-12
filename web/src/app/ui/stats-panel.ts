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
    // O pedido de agora: o fps escolhido, ou o degrau do "Ceder".
    const want = h?.wantFps || this.prefs.stream().frameRate;
    return {
      title: 'Enviando',
      rows: [
        row('tamanho', `${s.width}x${s.height}`),
        row('fps capturados', `${s.captureFps} / ${want}`, s.captureFps > 0 && s.captureFps < want * 0.9),
        row('fps enviados', String(s.fps), s.captureFps > 0 && s.fps < s.captureFps * 0.85),
        row('bitrate', formatBitrate(s.bitrate)),
        row('alvo', formatBitrate(s.targetBitrate)),
        row('codec', `${s.codec} ${s.scalabilityMode}`),
        row('encoder', `${s.encoder}${s.gpu === null ? '' : s.gpu ? ' · GPU' : ' · CPU'}`, s.gpu === false),
        row('tempo por quadro', `${s.encodeMs} ms`, s.encodeMs > 1000 / Math.max(s.fps, 1)),
        ...this.loadRows(),
        // "bandwidth" com bits de sobra para o tamanho que sai é o controle de qualidade do navegador
        // encolhendo a imagem, não a rede (ver shrink-guard.ts).
        row('limitado por', spareBits(s) ? 'controle de qualidade do navegador (não é a rede)' : describeLimitation(s.limitation), spareBits(s)),
        row('sustentado', h?.sustained === true ? describeLimitation(h.reason) : 'não', h?.sustained === true),
        row('mudanças de tamanho', String(s.resolutionChanges), s.resolutionChanges > 0),
        row('quadros gigantes', String(s.hugeFrames), s.hugeFrames > 0),
        row('quadros-chave', `${s.keyFrames} (${s.keyRequests} pedidos)`, s.keyRequests > 0),
        ...this.uploadRows(),
        ...soundRows(await this.store.sendingAudioStats()),
        ...this.tipRows(s),
        ...(spareBits(s) ? [row('dica', 'o navegador encolheu a imagem sozinho; em ~6 s a tela passa a manter a resolução', true)] : []),
      ],
    };
  }

  /**
   * Dicas a partir da pesquisa. OpenH264 = H.264 no processador (o site pede o perfil que vai para a
   * placa; se ainda assim sair aqui, a placa recusou). Captura abaixo do pedido = a thread de captura
   * do Chrome, limitada a meio núcleo, não deu conta (jogo disputando o processador); o tamanho
   * escolhido não muda isso, porque a captura é sempre no tamanho original.
   */
  private tipRows(s: { encoder: string; width: number; height: number; captureFps: number }): Row[] {
    const want = this.store.health()?.wantFps || this.prefs.stream().frameRate;
    const out: Row[] = [];
    if (/openh264/i.test(s.encoder)) out.push(row('dica', 'H.264 saiu no processador: escolha H.265 ou reinicie a transmissão', true));
    const h = this.store.health();
    if (h?.short === 'capture')
      out.push(row('dica', 'jogo ocupando a placa de vídeo: limite o FPS do jogo um pouco abaixo do que ele faz hoje, ou use o OBS', true));
    else if (h?.short === 'encoder') out.push(row('dica', 'o codificador perde quadros: limite o FPS do jogo para sobrar placa de vídeo', true));
    else if (s.captureFps > 0 && s.captureFps < want * 0.9)
      out.push(row('dica', 'captura abaixo do pedido: com a imagem parada é normal (o navegador só captura o que muda)'));
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
      row('uso do PC', describePressure(l.pressure), l.pressure === 'critical'),
      row('ceder', !l.active ? 'desligado' : l.step === 0 ? 'qualidade total' : `${l.width}x${l.height} ≤${l.fps}fps`, l.step > 0),
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
        // nackCount conta mensagens (cada uma pode pedir vários pacotes, e repete): não dá para dividir.
        row('pedidos de reenvio', `${r.nacks} (chegaram ${r.recovered})`),
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

/** Limitado por "banda" com mais de 0,3 bit por pixel por quadro no alvo: sobra bits, não é a rede. */
function spareBits(s: { limitation: string; width: number; height: number; fps: number; targetBitrate: number }): boolean {
  const px = s.width * s.height * Math.max(30, s.fps);
  return s.limitation === 'bandwidth' && px > 0 && s.targetBitrate / px > 0.3;
}
