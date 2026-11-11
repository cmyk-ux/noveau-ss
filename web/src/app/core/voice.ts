import type { AudioCaptureOptions, AudioProcessorOptions, TrackPublishOptions, TrackProcessor, Track } from 'livekit-client';
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';

/**
 * Como o microfone do PC é tratado antes de ir para a sala.
 *
 * - 'ia': redução de ruído por rede neural (RNNoise, banda cheia 48 kHz, ~10 ms de atraso, menos
 *   de 1% de um núcleo). Tira ventilador, teclado, ar-condicionado e chiado melhor que o filtro do
 *   navegador. O cancelamento de eco e o ganho automático continuam sendo os do navegador.
 * - 'navegador': o filtro de ruído clássico do Chrome (WebRTC). Mais leve ainda, tira menos ruído.
 * - 'cru': nada de filtro, eco ou ganho, e mais bits. Para instrumento ou microfone bom com fone.
 *
 * Só um filtro de ruído por vez: no modo 'ia' o do navegador fica desligado (empilhar os dois
 * piora a voz).
 */
export type VoiceMode = 'ia' | 'navegador' | 'cru';
export const VOICE_MODES: VoiceMode[] = ['ia', 'navegador', 'cru'];

const ASSETS = '/voz/';

export function voiceCapture(mode: VoiceMode): AudioCaptureOptions {
  const clean = mode !== 'cru';
  return {
    echoCancellation: clean,
    noiseSuppression: mode === 'navegador',
    autoGainControl: clean,
    // Isolamento de voz do sistema (ChromeOS/macOS): só no modo do navegador, para não somar com a IA.
    voiceIsolation: mode === 'navegador',
    channelCount: 1,
    sampleRate: 48000,
  };
}

/**
 * Opus mono: 64 kbps já soa igual ao microfone para voz; RED manda cada pacote de novo junto do
 * próximo (perda de pacote não vira buraco na voz). No modo cru, 128 kbps e sem DTX (o DTX corta
 * a cauda de notas baixas achando que é silêncio).
 */
export function voicePublish(mode: VoiceMode): TrackPublishOptions {
  return mode === 'cru'
    ? { audioPreset: { maxBitrate: 128_000 }, dtx: false, red: true }
    : { audioPreset: { maxBitrate: 64_000 }, dtx: true, red: true };
}

export function rnnoiseSupported(): boolean {
  return typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly !== 'undefined';
}

let wasm: Promise<ArrayBuffer> | null = null;
function rnnoiseWasm(): Promise<ArrayBuffer> {
  wasm ??= loadRnnoise({ url: ASSETS + 'rnnoise.wasm', simdUrl: ASSETS + 'rnnoise_simd.wasm' }).catch((e) => {
    wasm = null;
    throw e;
  });
  return wasm;
}

/**
 * Processador do LiveKit: microfone → RNNoise (AudioWorklet) → trilha nova que vai para a sala.
 * Usa um AudioContext próprio a 48 kHz (o RNNoise só funciona a 48 kHz e o do LiveKit segue a
 * taxa da saída de som, que pode ser 44,1 kHz).
 */
export class RnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'noveau-rnnoise';
  processedTrack?: MediaStreamTrack;
  /** Criado já no clique do botão do microfone, para não nascer suspenso. */
  readonly context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: RnnoiseWorkletNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;

  async init(opts: AudioProcessorOptions) {
    const binary = await rnnoiseWasm();
    const ctx = this.context;
    if (ctx.state === 'closed') throw new Error('processador já destruído');
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(ASSETS + 'rnnoise/workletProcessor.js');
    this.node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: binary });
    this.dest = ctx.createMediaStreamDestination();
    this.dest.channelCount = 1;
    this.dest.channelCountMode = 'explicit';
    this.node.connect(this.dest);
    this.connect(opts.track);
    this.processedTrack = this.dest.stream.getAudioTracks()[0];
    if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
  }

  /** O LiveKit chama ao trocar de microfone ou religar: a trilha de saída continua a mesma. */
  async restart(opts: AudioProcessorOptions) {
    if (this.ctx === null) return this.init(opts);
    this.connect(opts.track);
  }

  async destroy() {
    this.source?.disconnect();
    this.node?.disconnect();
    this.node?.destroy();
    this.processedTrack?.stop();
    if (this.context.state !== 'closed') await this.context.close().catch(() => undefined);
    this.ctx = this.source = this.node = this.dest = null;
    this.processedTrack = undefined;
  }

  private connect(track: MediaStreamTrack) {
    this.source?.disconnect();
    this.source = this.ctx!.createMediaStreamSource(new MediaStream([track]));
    this.source.connect(this.node!);
  }
}
