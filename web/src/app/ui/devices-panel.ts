import { Component, computed, effect, inject, input } from '@angular/core';
import { Invites } from '../core/invites';
import { IS_MOBILE } from '../core/device';
import { RoomStore } from '../core/room-store';
import { DENOISE_LABELS, eqActive, roomAudio } from '../core/voice-dsp';
import { Icon } from './icon';
import { PhoneLinkPanel } from './phone-link';

/** Microfone, câmera do computador e câmera externa por RTMP. */
@Component({
  selector: 'cen-devices-panel',
  imports: [Icon, PhoneLinkPanel],
  template: `
    @if (section() !== 'camera') {
    @if (section() === 'all') { <p class="label">microfone</p> }
    @if (store.microphones.devices().length === 0) {
      <p class="hint">{{ store.micOn() ? 'Nenhum microfone encontrado.' : 'Ligue o microfone uma vez para o navegador mostrar a lista.' }}</p>
    } @else {
      @for (d of store.microphones.devices(); track d.deviceId) {
        <button type="button" class="item" [class.selected]="store.microphones.isSelected(d.deviceId)" (click)="pickMic(d.deviceId)">
          <span class="led" [class.accent]="store.microphones.isSelected(d.deviceId)"></span>
          <span class="dev">{{ d.label }}</span>
          @if (store.microphones.isSelected(d.deviceId)) { <cen-icon name="check" [size]="14" /> }
        </button>
      }
    }
    @if (section() !== 'camera' && !isPhoneDevice) {
      <p class="label">sua voz</p>
      <p class="hint">{{ voiceSummary() }}</p>
      <div class="pair">
        <button type="button" class="btn listen" [class.on]="store.micMonitor()" [attr.aria-pressed]="store.micMonitor()" [disabled]="!store.ownMicOn()"
          (click)="store.toggleMicMonitor()" [title]="store.ownMicOn() ? 'Ouvir o que vai para a sala, já tratado (use fone: na caixa vira microfonia)' : 'Ligue o microfone para se ouvir'">
          <cen-icon name="headphones" [size]="14" /> {{ store.micMonitor() ? 'me ouvindo' : 'me ouvir' }}
        </button>
        <button class="btn wide" (click)="store.openVoice(true)">Equalizador, ruído, eco e sala</button>
      </div>
    }
    @if (section() === 'mic' && store.canPublish()) {
      <p class="label">celular como microfone</p>
      <cen-phone-link use="mic" />
    }
    }

    @if (section() !== 'mic' && store.canPublish()) {
      <p class="label">câmera {{ isPhoneDevice ? 'deste aparelho' : 'do pc' }}</p>
      @if (store.webcams.devices().length === 0) {
        <p class="hint">Nenhuma câmera neste aparelho.</p>
      } @else {
        @for (d of store.webcams.devices(); track d.deviceId) {
          <button type="button" class="item" [class.selected]="store.webcams.isSelected(d.deviceId)" (click)="pickCamera(d.deviceId)">
            <span class="led" [class.accent]="store.webcams.isSelected(d.deviceId)"></span>
            <span class="dev">{{ d.label || 'Câmera' }}</span>
            @if (store.webcams.isSelected(d.deviceId)) { <cen-icon name="check" [size]="14" /> }
          </button>
        }
        @if (store.webcams.devices()[0].label === '') {
          <p class="hint">Ligue uma vez e o navegador mostra qual câmera é qual.</p>
        }
        <button class="btn wide" [disabled]="store.busy()" (click)="togglePcCam()">
          {{ store.pcCamOn() ? 'Desligar a câmera' : 'Ligar a câmera' }}
        </button>
        <p class="hint">Vai em até 1080p a 30 fps, junto com a sua tela se você estiver compartilhando.</p>
      }
      @if (!isPhoneDevice) {
        <p class="label">celular como câmera</p>
        <cen-phone-link use="cam" />
      }

      @if (store.cameraOffered()) {
        <p class="label">câmera por RTMP @if (store.camera() !== null) {<span class="live">chave ativa</span>}</p>
        @if (store.camera(); as cam) {
          <p class="hint">No app da câmera (OBS, DJI Mimo, GoPro) em Live Streaming → RTMP, cole estes dois. Apps com um campo só usam o endereço inteiro.</p>
          <p class="label">servidor</p>
          <button type="button" class="copy mono" (click)="invites.copy(cam.url, 'Servidor copiado')">{{ cam.url }}</button>
          <p class="label">chave da transmissão</p>
          <button type="button" class="copy mono" (click)="invites.copy(cam.streamKey, 'Chave copiada')">{{ cam.streamKey }}</button>
          <p class="label">endereço inteiro</p>
          <button type="button" class="copy mono" (click)="invites.copy(cam.pushUrl, 'Endereço copiado')">{{ cam.pushUrl }}</button>
          <p class="hint">Configure a câmera para <strong>{{ cam.sendAt.resolution }}</strong>, cerca de <strong>{{ cam.sendAt.mbps }} Mbps</strong>. Ela aparece como <strong>{{ cam.name }}</strong> alguns segundos depois de começar.</p>
          @if (cam.endsAfterHours > 0) {
            <p class="hint">A sala fecha depois de {{ cam.endsAfterHours }} horas, câmera incluída.</p>
          }
          <button class="btn danger wide" [disabled]="store.cameraBusy()" (click)="store.revokeCameraKey()">Revogar a chave</button>
        } @else {
          <p class="hint">Uma câmera que não é navegador (OBS, GoPro, DJI) não entra na sala: ela envia para um endereço, e é aqui que ele sai.</p>
          <button class="btn wide" [disabled]="store.cameraBusy()" (click)="store.addCamera()">
            {{ store.cameraBusy() ? 'Pedindo…' : 'Pegar o endereço' }}
          </button>
        }
      }
    }
  `,
  styles: `
    :host { display: block; }
    .item { display: flex; gap: 0.6rem; align-items: center; width: 100%; text-align: left;
      padding: 0.5rem 0.55rem; border: 0; border-radius: 5px; background: transparent; font-size: 0.9rem; }
    .item:hover { background: var(--surface-3); }
    .item.selected { color: var(--accent-hi); }
    .dev { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .btn { margin-top: 0.6rem; }
    .copy { display: block; width: 100%; text-align: left; padding: 0.45rem 0.6rem; border-radius: 5px;
      border: 1px solid #0b0b0c; background: var(--well); box-shadow: var(--inset); font-size: 0.78rem;
      word-break: break-all; }
    .copy:hover { color: var(--accent-hi); }
    .live { color: var(--ok); margin-left: 0.5rem; }
    .pair { display: grid; grid-template-columns: auto 1fr; gap: 0.4rem; }
    .listen { display: inline-flex; align-items: center; gap: 0.35rem; }
  `,
})
export class DevicesPanel {
  readonly open = input(false);
  /** 'mic' e 'camera' viram os submenus da barra de baixo. */
  readonly section = input<'all' | 'mic' | 'camera'>('all');
  protected readonly store = inject(RoomStore);
  protected readonly invites = inject(Invites);

  constructor() {
    effect(() => {
      if (!this.open()) return;
      void this.store.microphones.refresh();
      void this.store.webcams.refresh();
    });
  }

  /** Resumo do tratamento da voz; o ajuste fino fica na janela "sua voz". */
  protected readonly voiceSummary = computed(() => {
    const v = this.store.voice();
    const parts = [`Ruído: ${DENOISE_LABELS[v.denoise].toLowerCase()}`];
    if (v.denoise === 'leve' || v.denoise === 'forte') parts[0] += ` (${v.strength >= 60 ? 'máxima' : `${v.strength} dB`})`;
    parts.push(eqActive(v) ? 'equalizador ligado' : 'sem equalizador');
    parts.push(v.echo === 'off' ? 'sem cancelar eco' : 'com cancelamento de eco');
    parts.push(`sala em ${roomAudio(this.store.roomAudio().preset).label.toLowerCase()}`);
    return parts.join(' · ') + '.';
  });

  pickMic(id: string) {
    void this.store.switchMicrophone(id).then(() => this.store.microphones.refresh());
  }

  /** No celular (participante comum) não faz sentido ligar outro celular como câmera. */
  protected readonly isPhoneDevice = IS_MOBILE;

  togglePcCam() {
    void this.store.toggleWebcam(undefined, 'pc');
  }

  pickCamera(id: string) {
    const step = this.store.pcCamOn() ? this.store.switchWebcam(id) : this.store.toggleWebcam(id);
    void step.then(() => this.store.webcams.refresh());
  }
}
