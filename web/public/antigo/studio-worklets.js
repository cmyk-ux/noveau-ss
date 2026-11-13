// Worklets do "modo estúdio": som da tela sem compressão.
//
// studio-capture: roda no PC de quem transmite. Recebe o som da aba/janela já decodificado
//   pelo navegador (PCM float, 48 kHz) e entrega blocos intercalados L R L R para a página.
// studio-player: roda em quem assiste. Toca de um buffer circular com atraso alvo ajustável.
//   Para compensar a diferença de relógio entre os PCs (alguns ppm), tira ou repete UMA
//   amostra de vez em quando, só quando o buffer sai da faixa alvo. Não reamostra nada:
//   todas as outras amostras saem exatamente como chegaram.

class StudioCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 480; // 10 ms a 48 kHz
    this.buf = new Float32Array(this.frames * 2);
    this.fill = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const l = input[0];
    const r = input[1] ?? input[0];
    for (let i = 0; i < l.length; i++) {
      this.buf[this.fill * 2] = l[i];
      this.buf[this.fill * 2 + 1] = r[i];
      this.fill++;
      if (this.fill === this.frames) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.frames * 2);
        this.fill = 0;
      }
    }
    return true;
  }
}

class StudioPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 48000 * 4; // 4 s de folga
    this.ring = new Float32Array(this.capacity * 2);
    this.read = 0;
    this.write = 0;
    this.level = 0; // frames no buffer
    this.target = 48000 * 0.25;
    this.band = 48000 * 0.04;
    this.playing = false;
    this.underruns = 0;
    this.adjusts = 0;
    this.reportAt = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'pcm') this.push(m.data);
      else if (m.type === 'latency') {
        this.target = Math.round(48000 * m.seconds);
        this.band = Math.max(480, Math.round(this.target * 0.15));
      } else if (m.type === 'reset') {
        this.read = this.write = this.level = 0;
        this.playing = false;
      }
    };
  }
  push(data) {
    const frames = data.length / 2;
    if (this.level + frames > this.capacity) {
      // Estourou (aba ficou em segundo plano?): recomeça do ponto atual.
      this.read = this.write = this.level = 0;
      this.playing = false;
    }
    for (let i = 0; i < frames; i++) {
      const w = this.write * 2;
      this.ring[w] = data[i * 2];
      this.ring[w + 1] = data[i * 2 + 1];
      this.write = (this.write + 1) % this.capacity;
    }
    this.level += frames;
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] ?? out[0];
    const n = L.length;
    if (!this.playing && this.level >= this.target) this.playing = true;
    if (!this.playing) {
      L.fill(0);
      R.fill(0);
    } else {
      // Correção de relógio: no máximo 1 amostra por bloco de 128.
      let skip = 0;
      let hold = 0;
      if (this.level > this.target + this.band) skip = 1;
      else if (this.level < this.target - this.band) hold = 1;
      if (skip || hold) this.adjusts++;
      for (let i = 0; i < n; i++) {
        if (this.level === 0) {
          L[i] = 0;
          R[i] = 0;
          continue;
        }
        const r = this.read * 2;
        L[i] = this.ring[r];
        R[i] = this.ring[r + 1];
        if (hold && i === n >> 1) {
          hold = 0; // repete esta amostra (não avança)
          continue;
        }
        this.read = (this.read + 1) % this.capacity;
        this.level--;
      }
      if (skip && this.level > 0) {
        this.read = (this.read + 1) % this.capacity;
        this.level--;
      }
      if (this.level === 0) {
        this.underruns++;
        this.playing = false; // rebufferiza até o alvo
      }
    }
    if (currentTime >= this.reportAt) {
      this.reportAt = currentTime + 0.5;
      this.port.postMessage({
        level: this.level / 48000,
        target: this.target / 48000,
        playing: this.playing,
        underruns: this.underruns,
        adjusts: this.adjusts,
      });
    }
    return true;
  }
}

registerProcessor('studio-capture', StudioCapture);
registerProcessor('studio-player', StudioPlayer);
