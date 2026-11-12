import { Component, DestroyRef, ElementRef, inject, signal, viewChild } from '@angular/core';
import { RemoteTrack, RemoteTrackPublication, Room, RoomEvent, Track, VideoQuality } from 'livekit-client';
import { requestToken, requiresSecret } from '../core/api';
import { newKey, readLink } from '../core/link';
import { Prefs } from '../core/prefs';
import { ScreenShareCancelledError, startShare, stopShare, type ShareResult } from '../core/share';
import { StatsSampler, type Limitation } from '../core/stats';
import { formatBitrate, planFor, planSize } from '../core/stream';

// /teste: autoteste da transmissão, sem depender de ninguém.
//
// Abre uma sala só sua no servidor de verdade, compartilha a tela com os mesmos ajustes da sala e,
// na mesma aba, entra uma segunda conexão que assiste como qualquer pessoa assistiria. Mede por
// 20 s o que sai do seu navegador e o que chega a quem assiste (passando pelo servidor). Enquanto
// mede, uma animação ocupa a página: compartilhando a tela inteira com esta janela à vista, a tela
// muda a cada quadro e a captura não fica com menos quadros só porque nada se mexeu.

const SECONDS = 20;
const READ_MS = 2000;
/** Só as últimas leituras contam (as primeiras pegam a largada: quadro-chave, estimativa de banda subindo). */
const SETTLED = 5;

interface Reading {
  captureSize: string;
  captureFps: number;
  sentW: number;
  sentH: number;
  sentFps: number;
  sentBps: number;
  encoder: string;
  gpu: boolean | null;
  codec: string;
  limit: string;
  gotW: number;
  gotH: number;
  gotFps: number;
  gotBps: number;
  freezes: number;
}

interface Verdict {
  ok: boolean;
  lines: { label: string; value: string; bad?: boolean }[];
  notes: string[];
}

@Component({
  selector: 'cen-test-page',
  template: `
    <canvas #anim class="anim" [class.on]="state() === 'running'" aria-hidden="true"></canvas>
    <div class="center">
      <div class="card screws">
        <div class="masthead">
          <img class="logo pixel" src="logo.svg" alt="" width="48" height="48" />
          <div>
            <h1>Teste da transmissão</h1>
            <p class="label sub">o que sai do seu PC e o que chega a quem assiste</p>
          </div>
        </div>

        @switch (state()) {
          @case ('idle') {
            <p class="lead">
              Compartilha a sua tela numa sala só sua, no servidor de verdade, e uma segunda conexão nesta mesma aba assiste
              como qualquer pessoa. Em {{ seconds }} s mostra o tamanho e o fps que chegam.
            </p>
            <p class="hint">
              Escolha a <strong>tela inteira</strong> onde está esta janela. Durante o teste uma animação cobre a página, para a
              tela ter movimento em todo quadro (o navegador só captura quando a tela muda).
            </p>
            <p class="hint mono">Ajustes da sala: {{ settingsText }}</p>
            @if (needsSecret()) {
              <div class="field">
                <label class="label" for="secret">Senha da instância</label>
                <input id="secret" class="input" type="password" autocomplete="off"
                  [value]="secret()" (input)="secret.set($any($event.target).value)" />
              </div>
            }
            <button class="btn primary wide" (click)="run()">Começar o teste</button>
          }
          @case ('running') {
            <p class="lead">Medindo… {{ left() }} s</p>
            <p class="hint">Deixe esta janela à vista na tela compartilhada.</p>
          }
          @case ('error') {
            <p class="error">{{ error() }}</p>
            <button class="btn wide" (click)="state.set('idle')">Tentar de novo</button>
          }
          @case ('done') {
            @if (verdict(); as v) {
              <p class="verdict" [class.ok]="v.ok" [class.bad]="!v.ok">{{ v.ok ? 'Tudo certo' : 'Algo segurou a qualidade' }}</p>
              <table class="rows mono">
                @for (l of v.lines; track l.label) {
                  <tr [class.bad]="l.bad"><td>{{ l.label }}</td><td>{{ l.value }}</td></tr>
                }
              </table>
              @for (n of v.notes; track n) { <p class="hint">{{ n }}</p> }
            }
            <button class="btn primary wide" (click)="run()">Testar de novo</button>
          }
        }
        <video #view class="view" [class.on]="state() === 'running' || state() === 'done'" muted playsinline autoplay></video>
      </div>
    </div>
  `,
  styles: `
    :host { display: block; }
    .anim { position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: 0; display: none; }
    .anim.on { display: block; }
    .center { position: relative; z-index: 1; }
    .verdict { font-size: 1.1rem; margin: 0.4rem 0 0.8rem; }
    .verdict.ok { color: var(--ok, #6c6); }
    .verdict.bad { color: var(--danger); }
    .rows { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
    .rows td { padding: 0.18rem 0; vertical-align: top; }
    .rows td:last-child { text-align: right; }
    .rows tr.bad td:last-child { color: var(--danger); }
    .view { display: none; width: 100%; margin-top: 0.8rem; border-radius: 2px; background: #000; }
    .view.on { display: block; }
  `,
})
export class TestPage {
  private readonly prefs = inject(Prefs);
  protected readonly seconds = SECONDS;
  protected readonly state = signal<'idle' | 'running' | 'done' | 'error'>('idle');
  protected readonly left = signal(SECONDS);
  protected readonly error = signal('');
  protected readonly verdict = signal<Verdict | null>(null);
  private readonly anim = viewChild.required<ElementRef<HTMLCanvasElement>>('anim');
  private readonly view = viewChild.required<ElementRef<HTMLVideoElement>>('view');
  private rooms: Room[] = [];
  private raf = 0;
  private frameTimes: number[] = [];
  protected readonly settingsText = (() => {
    const s = this.prefs.stream();
    const res = s.resolution === 'auto' ? 'Auto' : s.resolution === 'source' ? 'Original' : s.resolution.replace('p', '') + 'p';
    return `${res} · ${s.frameRate} fps · bitrate ${s.maxBitrate === 0 ? 'Auto' : formatBitrate(s.maxBitrate)} · codec ${this.prefs.codec()}`;
  })();

  /** Senha da instância (se o servidor pedir): vem no link da sala, ou digitada aqui. */
  protected readonly secret = signal(readLink().secret);
  protected readonly needsSecret = signal(false);

  constructor() {
    inject(DestroyRef).onDestroy(() => void this.cleanup());
    if (this.secret() === '') requiresSecret().then((x) => this.needsSecret.set(x), () => undefined);
  }

  async run() {
    this.verdict.set(null);
    this.error.set('');
    this.left.set(SECONDS);
    const plan = planFor(this.prefs.stream());
    const sender = new Room({ adaptiveStream: false, dynacast: true, disconnectOnPageLeave: true });
    const viewer = new Room({ adaptiveStream: false, dynacast: true, disconnectOnPageLeave: true });
    this.rooms = [sender, viewer];
    let share: ShareResult | null = null;
    try {
      const link = { key: newKey(), secret: this.secret().trim() };
      const [a, b] = await Promise.all([requestToken(link, 'teste-envia'), requestToken(link, 'teste-assiste')]);
      await sender.connect(a.url, a.token);
      await viewer.connect(b.url, b.token);
      viewer.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
        if (pub.source !== Track.Source.ScreenShare) return;
        pub.setVideoQuality(VideoQuality.HIGH);
        track.attach(this.view().nativeElement);
      });
      this.startAnimation();
      this.state.set('running');
      share = await startShare(
        sender,
        {
          plan,
          preferredCodec: this.prefs.codec(),
          includeAudio: false,
          studio: null,
          maxCompatibility: this.prefs.maxCompatibility(),
          adaptToLoad: this.prefs.adaptToLoad(),
        },
        { onEndedByBrowser: () => undefined, onHealth: () => undefined, onSilentAudio: () => undefined, onLoad: () => undefined, onUpload: () => undefined },
      );
      const readings = await this.measure(sender, viewer);
      this.verdict.set(judge(readings, plan.frameRate, planSize(plan).height, plan.resolution, this.monitorHz(), share));
      this.state.set('done');
    } catch (e) {
      this.error.set(e instanceof ScreenShareCancelledError ? 'O compartilhamento foi cancelado.' : String((e as Error)?.message ?? e));
      this.state.set('error');
    } finally {
      share?.watch.stop();
      share?.governor.stop();
      share?.upload.stop();
      share?.guard.stop();
      share?.shrink.stop();
      await this.cleanup();
    }
  }

  private async measure(sender: Room, viewer: Room): Promise<Reading[]> {
    const out: Reading[] = [];
    const tx = new StatsSampler();
    const rx = new StatsSampler();
    for (let t = 0; t < SECONDS * 1000; t += READ_MS) {
      await new Promise((r) => setTimeout(r, READ_MS));
      this.left.set(Math.max(0, Math.round((SECONDS * 1000 - t - READ_MS) / 1000)));
      const s = sender.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.sender;
      const remote = [...viewer.remoteParticipants.values()][0]?.getTrackPublication(Track.Source.ScreenShare)?.track as
        | { getRTCStatsReport?: () => Promise<RTCStatsReport | undefined> }
        | undefined;
      const [sr, rr] = await Promise.all([s?.getStats().catch(() => undefined), remote?.getRTCStatsReport?.().catch(() => undefined)]);
      const o = sr ? tx.readOutbound(sr) : null;
      const i = rr ? rx.readInbound(rr) : null;
      out.push({
        captureSize: o?.captureSize ?? '?',
        captureFps: o?.captureFps ?? 0,
        sentW: o?.width ?? 0,
        sentH: o?.height ?? 0,
        sentFps: o?.fps ?? 0,
        sentBps: o?.bitrate ?? 0,
        encoder: o?.encoder ?? '',
        gpu: o?.gpu ?? null,
        codec: o?.codec ?? '',
        limit: o === null ? '' : LIMITS[o.limitation],
        gotW: i?.width ?? 0,
        gotH: i?.height ?? 0,
        gotFps: i?.fps ?? 0,
        gotBps: i?.bitrate ?? 0,
        freezes: i?.freezeCount ?? 0,
      });
    }
    return out;
  }

  /** Animação em tela cheia: blocos e um contador mudando a cada quadro do monitor. */
  private startAnimation() {
    const c = this.anim().nativeElement;
    const x = c.getContext('2d');
    if (x === null) return;
    this.frameTimes = [];
    let n = 0;
    const draw = (now: number) => {
      this.frameTimes = [...this.frameTimes, now].slice(-120);
      const w = (c.width = Math.round(window.innerWidth * (window.devicePixelRatio || 1)));
      const h = (c.height = Math.round(window.innerHeight * (window.devicePixelRatio || 1)));
      n++;
      x.fillStyle = `hsl(${(n * 3) % 360},30%,14%)`;
      x.fillRect(0, 0, w, h);
      for (let i = 0; i < 40; i++) {
        x.fillStyle = `hsl(${(n * 5 + i * 37) % 360},70%,${35 + (i % 4) * 8}%)`;
        x.fillRect((i * 173 + n * 11) % w, (i * 97 + n * 7) % h, w / 14, h / 12);
      }
      x.fillStyle = '#fff';
      x.font = `${Math.round(h / 14)}px monospace`;
      x.fillText(String(n), h / 30, h / 10);
      this.raf = requestAnimationFrame(draw);
    };
    this.raf = requestAnimationFrame(draw);
  }

  /** Taxa do monitor desta janela, medida pela animação (a captura de tela não passa disso). */
  private monitorHz(): number {
    const t = this.frameTimes;
    if (t.length < 20) return 0;
    const d = (t[t.length - 1] - t[0]) / (t.length - 1);
    return d > 0 ? Math.round(1000 / d) : 0;
  }

  private async cleanup() {
    cancelAnimationFrame(this.raf);
    const rooms = this.rooms;
    this.rooms = [];
    for (const r of rooms) {
      if (r.localParticipant.getTrackPublication(Track.Source.ScreenShare) !== undefined) await stopShare(r).catch(() => undefined);
      await r.disconnect().catch(() => undefined);
    }
  }
}

const LIMITS: Record<Limitation, string> = {
  none: 'nada',
  cpu: 'processador (o codificador não dá conta)',
  bandwidth: 'banda (ou o controle de qualidade do navegador)',
  other: 'o navegador não disse',
};

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function judge(all: Reading[], wantFps: number, planHeight: number, resolution: string, hz: number, share: ShareResult | null): Verdict {
  const r = all.slice(-SETTLED);
  const last = r[r.length - 1] ?? all[all.length - 1];
  const capH = Number(last?.captureSize.split('x')[1] ?? 0);
  // O tamanho que deveria sair: a captura inteira, ou o teto escolhido (720p/1080p/1440p, ou o Auto
  // acima de 60 fps) se a captura for maior.
  const capped = resolution !== 'source' && resolution !== 'auto' && capH > planHeight;
  const expectH = capped ? planHeight : capH;
  const gotH = Math.max(...r.map((x) => x.gotH));
  const gotFps = avg(r.map((x) => x.gotFps));
  const captureFps = avg(r.map((x) => x.captureFps));
  const sentFps = avg(r.map((x) => x.sentFps));
  // A captura de tela não passa da taxa do monitor.
  const fpsTarget = hz > 0 ? Math.min(wantFps, hz) : wantFps;
  const sizeOk = expectH > 0 && gotH >= expectH - 2;
  const fpsOk = gotFps >= fpsTarget * 0.85;
  const freezes = (last?.freezes ?? 0) - (all[0]?.freezes ?? 0);
  const notes: string[] = [];
  if (!sizeOk && last !== undefined && last.sentH < expectH - 2)
    notes.push(`O seu navegador já está mandando menor (${last.sentW}x${last.sentH}) do que captura. Limitado por: ${last.limit}.`);
  else if (!sizeOk) notes.push(`O seu navegador manda ${last?.sentW}x${last?.sentH}, mas quem assiste recebe ${gotH}p: o servidor ou a rede no caminho.`);
  if (!fpsOk && captureFps < fpsTarget * 0.85)
    notes.push(
      `A captura entregou só ${captureFps} fps. Com esta janela (e a animação) à vista na tela compartilhada isso é o navegador ou a placa de vídeo, não a rede.`,
    );
  else if (!fpsOk && sentFps < captureFps * 0.85) notes.push(`A captura entrega ${captureFps} fps, mas saem ${sentFps}: o codificador perde quadros.`);
  else if (!fpsOk) notes.push(`Saem ${sentFps} fps, mas chegam ${gotFps}: perda no caminho (rede ou servidor).`);
  if (hz > 0 && hz < wantFps) notes.push(`Este monitor roda a ${hz} Hz: a captura de tela não passa disso.`);
  return {
    ok: sizeOk && fpsOk,
    lines: [
      { label: 'quem assiste recebe', value: `${last?.gotW ?? 0}x${gotH} a ${gotFps} fps`, bad: !sizeOk || !fpsOk },
      { label: 'deveria', value: `${expectH}p a ${fpsTarget} fps` },
      { label: 'seu PC captura', value: `${last?.captureSize ?? '?'} a ${captureFps} fps` },
      { label: 'seu PC manda', value: `${last?.sentW ?? 0}x${last?.sentH ?? 0} a ${sentFps} fps, ${formatBitrate(avg(r.map((x) => x.sentBps)))}` },
      { label: 'chega', value: formatBitrate(avg(r.map((x) => x.gotBps))) },
      { label: 'codec', value: `${last?.codec ?? '?'} · ${last?.encoder || '?'}${last?.gpu === true ? ' (placa de vídeo)' : last?.gpu === false ? ' (processador)' : ''}` },
      { label: 'limitado por', value: last?.limit || '?' },
      { label: 'travadas', value: String(freezes), bad: freezes > 0 },
      { label: 'monitor', value: hz > 0 ? `${hz} Hz` : '?' },
      { label: 'teto do codificador', value: share === null ? '?' : formatBitrate(share.bitrate) },
    ],
    notes,
  };
}
