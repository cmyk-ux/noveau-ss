import { Component, effect, inject, input } from '@angular/core';
import { Invites } from '../core/invites';
import { RoomStore } from '../core/room-store';
import { Icon } from './icon';

/** Microfone, câmera do computador e câmera externa por RTMP. */
@Component({
  selector: 'cen-devices-panel',
  imports: [Icon],
  template: `
    <p class="label">microfone</p>
    @if (store.microphones.devices().length === 0) {
      <p class="hint">{{ store.micOn() ? 'Nenhum microfone encontrado.' : 'Ligue o microfone uma vez para o navegador mostrar a lista.' }}</p>
    } @else {
      @for (d of store.microphones.devices(); track d.deviceId) {
        <button type="button" class="item" [class.selected]="store.microphones.isSelected(d.deviceId)" (click)="pickMic(d.deviceId)">
          <span>{{ d.label }}</span>
          @if (store.microphones.isSelected(d.deviceId)) { <cen-icon name="check" [size]="14" /> }
        </button>
      }
    }

    @if (store.canPublish()) {
      <p class="label">câmera</p>
      @if (store.webcams.devices().length === 0) {
        <p class="hint">Nenhuma câmera neste aparelho.</p>
      } @else {
        @for (d of store.webcams.devices(); track d.deviceId) {
          <button type="button" class="item" [class.selected]="store.webcams.isSelected(d.deviceId)" (click)="pickCamera(d.deviceId)">
            <span>{{ d.label || 'Câmera' }}</span>
            @if (store.webcams.isSelected(d.deviceId)) { <cen-icon name="check" [size]="14" /> }
          </button>
        }
        @if (store.webcams.devices()[0].label === '') {
          <p class="hint">Ligue uma vez e o navegador mostra qual câmera é qual.</p>
        }
        <button class="btn wide" [disabled]="store.busy()" (click)="store.toggleWebcam()">
          {{ store.webcamOn() ? 'Desligar a câmera' : 'Ligar a câmera' }}
        </button>
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
    .item { display: flex; justify-content: space-between; align-items: center; width: 100%; text-align: left;
      padding: 0.5rem 0.6rem; border: 0; border-radius: var(--radius); background: transparent; }
    .item:hover { background: var(--surface-2); }
    .item.selected { color: var(--accent); }
    .btn { margin-top: 0.5rem; }
    .copy { display: block; width: 100%; text-align: left; padding: 0.45rem 0.6rem; border-radius: var(--radius);
      border: 1px solid var(--line); background: var(--bg); font-size: 0.8rem; word-break: break-all; }
    .live { color: var(--ok); margin-left: 0.5rem; }
  `,
})
export class DevicesPanel {
  readonly open = input(false);
  protected readonly store = inject(RoomStore);
  protected readonly invites = inject(Invites);

  constructor() {
    effect(() => {
      if (!this.open()) return;
      void this.store.microphones.refresh();
      void this.store.webcams.refresh();
    });
  }

  pickMic(id: string) {
    void this.store.switchMicrophone(id).then(() => this.store.microphones.refresh());
  }

  pickCamera(id: string) {
    const step = this.store.webcamOn() ? this.store.switchWebcam(id) : this.store.toggleWebcam(id);
    void step.then(() => this.store.webcams.refresh());
  }
}
