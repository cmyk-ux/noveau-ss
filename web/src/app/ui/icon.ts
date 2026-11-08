import { Component, computed, inject, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';

// Ícones SVG recuperados do Cenaculum (traço de 2px, 24x24).
const FILLED = new Set(['logo', 'hangup']);
const ICONS: Record<string, string> = {
  logo: `<path fill-rule="evenodd" d="M5 20V12a7 7 0 0 1 14 0v8Zm6.1-14.9h1.8V20h-1.8zM5 14.2h14V16H5z"/>`,
  arch: `<path d="M5 20v-8a7 7 0 0 1 14 0v8"/><path d="M12 5.2V20"/><path d="M5 15h14"/><path d="M3 20h18"/>`,
  mic: `<rect x="9" y="2.5" width="6" height="11.5" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><line x1="12" y1="18" x2="12" y2="21.5"/><line x1="8" y1="21.5" x2="16" y2="21.5"/>`,
  micOff: `<rect x="9" y="2.5" width="6" height="11.5" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><line x1="12" y1="18" x2="12" y2="21.5"/><line x1="8" y1="21.5" x2="16" y2="21.5"/><line x1="3.5" y1="3" x2="20.5" y2="21"/>`,
  screen: `<rect x="2.5" y="4" width="19" height="13" rx="2.5"/><path d="M12 7.5v6"/><path d="m9.5 10 2.5-2.5L14.5 10"/><line x1="8.5" y1="20.5" x2="15.5" y2="20.5"/>`,
  screenOff: `<rect x="2.5" y="4" width="19" height="13" rx="2.5"/><line x1="8.5" y1="20.5" x2="15.5" y2="20.5"/><line x1="3" y1="3" x2="21" y2="21"/>`,
  camera: `<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="m15.5 11.2 5-2.7v7l-5-2.7z"/>`,
  cameraOff: `<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="m15.5 11.2 5-2.7v7l-5-2.7z"/><line x1="3" y1="3" x2="21" y2="21"/>`,
  hangup: `<path d="M2.8 10.2c5.1-4.3 13.3-4.3 18.4 0a1.6 1.6 0 0 1 .4 1.9l-1 2.1a1.6 1.6 0 0 1-1.9.8l-3-1a1.6 1.6 0 0 1-1.1-1.5v-1.4a11.6 11.6 0 0 0-5.2 0v1.4a1.6 1.6 0 0 1-1.1 1.5l-3 1a1.6 1.6 0 0 1-1.9-.8l-1-2.1a1.6 1.6 0 0 1 .4-1.9Z"/>`,
  link: `<path d="M10.5 13.5a4.5 4.5 0 0 0 6.4 0l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4l-1.3 1.3"/><path d="M13.5 10.5a4.5 4.5 0 0 0-6.4 0l-2.6 2.6a4.5 4.5 0 0 0 6.4 6.4l1.3-1.3"/>`,
  lock: `<rect x="4" y="10.5" width="16" height="10.5" rx="2.5"/><path d="M7.8 10.5V7.6a4.2 4.2 0 0 1 8.4 0v2.9"/><circle cx="12" cy="15.7" r="1.3"/>`,
  people: `<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16.5 5.2a3.5 3.5 0 0 1 0 6.6"/><path d="M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>`,
  caret: `<path d="m6 9 6 6 6-6"/>`,
  speaker: `<path d="M4.5 9.5v5h3.2L13 18.5v-13L7.7 9.5z"/><path d="M16.5 9a4.5 4.5 0 0 1 0 6"/><path d="M19.2 6.3a8 8 0 0 1 0 11.4"/>`,
  speakerLow: `<path d="M4.5 9.5v5h3.2L13 18.5v-13L7.7 9.5z"/><path d="M16.5 9a4.5 4.5 0 0 1 0 6"/>`,
  speakerOff: `<path d="M4.5 9.5v5h3.2L13 18.5v-13L7.7 9.5z"/><path d="m16.5 9.5 5 5"/><path d="m21.5 9.5-5 5"/>`,
  dots: `<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>`,
  close: `<path d="m6 6 12 12"/><path d="M18 6 6 18"/>`,
  check: `<path d="m4.5 12.5 5 5 10-11"/>`,
  fullscreen: `<path d="M8 3H5.5A2.5 2.5 0 0 0 3 5.5V8"/><path d="M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8"/><path d="M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16"/><path d="M16 21h2.5a2.5 2.5 0 0 0 2.5-2.5V16"/>`,
  fullscreenExit: `<path d="M3 8h2.5A2.5 2.5 0 0 0 8 5.5V3"/><path d="M21 8h-2.5A2.5 2.5 0 0 1 16 5.5V3"/><path d="M3 16h2.5A2.5 2.5 0 0 1 8 18.5V21"/><path d="M21 16h-2.5a2.5 2.5 0 0 0-2.5 2.5V21"/>`,
  grid: `<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.5"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.5"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.5"/><rect x="13" y="13" width="7.5" height="7.5" rx="1.5"/>`,
  popout: `<path d="M13 4h7v7"/><path d="M20 4 11 13"/><path d="M18 14v4.5A2.5 2.5 0 0 1 15.5 21h-9A2.5 2.5 0 0 1 4 18.5v-9A2.5 2.5 0 0 1 6.5 7H11"/>`,
  pen: `<path d="M4 20.5 4.8 16.2 16.3 4.7a2.3 2.3 0 0 1 3.2 3.2L8 19.4z"/><path d="m14.6 6.4 3.2 3.2"/>`,
  penOff: `<path d="M4 20.5 4.8 16.2 16.3 4.7a2.3 2.3 0 0 1 3.2 3.2L8 19.4z"/><path d="m14.6 6.4 3.2 3.2"/><line x1="3" y1="3" x2="21" y2="21"/>`,
  undo: `<path d="M8 5 3.5 9.5 8 14"/><path d="M3.5 9.5H14a5.5 5.5 0 0 1 0 11H8.5"/>`,
  line: `<path d="M4.5 19.5 19.5 4.5"/>`,
  arrow: `<path d="M4.5 19.5 19.5 4.5"/><path d="M12.5 4.5h7v7"/>`,
  rect: `<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/>`,
  ellipse: `<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>`,
  widthThin: `<path d="M4 12h16" stroke-width="1.5"/>`,
  widthMedium: `<path d="M4 12h16" stroke-width="4"/>`,
  widthThick: `<path d="M4 12h16" stroke-width="7"/>`,
  trash: `<path d="M4.5 7h15"/><path d="M9.5 7V4.5h5V7"/><path d="m6.5 7 1 13h9l1-13"/>`,
  trashAll: `<path d="M2.5 7h11"/><path d="M6 7V4.5h4V7"/><path d="m4 7 .9 13h6.2L12 7"/><path d="M16 7.5h5.5"/><path d="M16 12h5.5"/><path d="M16 16.5h5.5"/>`,
  wipe: `<path d="m10 20.5-5.4-5.4a2 2 0 0 1 0-2.9l7.6-7.6a2 2 0 0 1 2.9 0l4.3 4.3a2 2 0 0 1 0 2.9l-8.7 8.7z"/><path d="m8.4 10.3 6.8 6.8"/><line x1="10" y1="20.5" x2="20.5" y2="20.5"/>`,
};

export function iconSvg(name: string, size = 20): string {
  const paint = FILLED.has(name)
    ? 'fill="currentColor"'
    : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" ${paint}>${ICONS[name] ?? ''}</svg>`;
}

@Component({
  selector: 'cen-icon',
  template: '',
  host: { class: 'cen-icon', '[innerHTML]': 'markup()' },
  styles: ':host{display:inline-flex}',
})
export class Icon {
  readonly name = input.required<string>();
  readonly size = input(20);
  private readonly sanitizer = inject(DomSanitizer);
  protected readonly markup = computed(() => this.sanitizer.bypassSecurityTrustHtml(iconSvg(this.name(), this.size())));
}
