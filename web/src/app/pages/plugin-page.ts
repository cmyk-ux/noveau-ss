import { Component, computed, signal } from '@angular/core';
import { Me, whoAmI } from '../core/api';
import { DAW_INSTALLERS, DAW_PLUGIN_RELEASES, DesktopOs, confirmDawLink, desktopOs } from '../core/daw';

type Daw = 'geral' | 'logic' | 'protools';

/**
 * /plugin: o passo a passo do plugin de DAW para qualquer músico.
 * Com ?c=CÓDIGO (aberto pelo próprio plugin), é também onde a pessoa confirma a conexão.
 */
@Component({
  selector: 'cen-plugin-page',
  template: `
    <div class="center">
      <div class="card screws">
        <div class="masthead">
          <img class="logo pixel" src="logo.svg" alt="" width="48" height="48" />
          <div>
            <h1>Plugin de DAW</h1>
            <p class="label sub">o som da sua DAW na call · sem compressão</p>
          </div>
        </div>

        @if (code !== '') {
          <section class="confirm" aria-live="polite">
            @switch (step()) {
              @case ('loading') { <p class="hint">Conferindo seu login…</p> }
              @case ('no-discord') {
                <p class="error">Este servidor não tem login com Discord. No plugin, use o código de uma sala.</p>
              }
              @case ('login') {
                <p class="lead">O plugin pediu para conectar. Entre com o Discord para confirmar.</p>
                <a class="btn wide discord-login" [href]="loginUrl">Entrar com Discord</a>
              }
              @case ('ask') {
                <p class="lead">Conectar o plugin à sua conta?</p>
                <div class="who">
                  @if (me()?.user?.avatar; as a) { <img [src]="a" alt="" width="28" height="28" /> }
                  <span>{{ me()?.user?.name }}</span>
                </div>
                <div class="code"><span class="mono big">{{ code }}</span></div>
                <p class="hint">Confira se é o mesmo código que aparece no plugin.</p>
                <button type="button" class="btn primary wide" [disabled]="busy()" (click)="confirm()">Conectar o plugin</button>
              }
              @case ('done') {
                <p class="lead ok"><span class="led ok"></span> Pronto! Pode voltar para a DAW.</p>
                @if (me()?.call; as c) {
                  <p class="hint">Você está na call <strong>{{ c.name }}</strong>: o som já vai para quem abrir a sala dela aqui no site.</p>
                } @else {
                  <p class="hint">Entre numa call do Discord e o som vai junto. Se trocar de call, o plugin vai atrás.</p>
                }
                <p class="hint">Neste computador, não precisa conectar de novo: qualquer projeto com o plugin já sai tocando.</p>
              }
            }
            @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
          </section>
        }

        @if (code === '' || step() === 'done') {
          <p class="label">1 · instalar</p>
          <div class="downloads">
            @if (os === 'mac') {
              <a class="btn primary wide" [href]="installers.mac">Baixar para Mac</a>
              <a class="other" [href]="installers.windows">Windows</a>
            } @else if (os === 'windows') {
              <a class="btn primary wide" [href]="installers.windows">Baixar para Windows</a>
              <a class="other" [href]="installers.mac">Mac</a>
            } @else {
              <a class="btn primary" [href]="installers.windows">Windows</a>
              <a class="btn primary" [href]="installers.mac">Mac</a>
            }
          </div>
          @if (os !== 'mac') {
            <p class="hint">Abra o instalador e avance até o fim. Se o Windows mostrar "O Windows protegeu o computador",
              clique em <em>Mais informações</em> e depois em <em>Executar assim mesmo</em> (o plugin ainda não tem assinatura paga).</p>
          }
          @if (os !== 'windows') {
            <p class="hint">No Mac, se aparecer que o instalador não pode ser verificado: clique em OK, abra
              <em>Ajustes do Sistema › Privacidade e Segurança</em>, desça até o fim e clique em <em>Abrir Mesmo Assim</em>.</p>
          }

          <p class="label">2 · colocar na DAW</p>
          <div class="chips" role="tablist">
            <button type="button" class="chip" role="tab" [class.lit]="daw() === 'geral'" (click)="daw.set('geral')">Reaper, Ableton, FL, Cubase…</button>
            <button type="button" class="chip" role="tab" [class.lit]="daw() === 'logic'" (click)="daw.set('logic')">Logic / GarageBand</button>
            <button type="button" class="chip" role="tab" [class.lit]="daw() === 'protools'" (click)="daw.set('protools')">Pro Tools</button>
          </div>
          <ol class="steps">
            @switch (daw()) {
              @case ('geral') {
                <li>Reabra a DAW (ou mande procurar plugins novos).</li>
                <li>No <strong>master</strong>, coloque <strong>noveau DAW</strong> (VST3) como <strong>último efeito</strong>.</li>
              }
              @case ('logic') {
                <li>Reabra o Logic. Ele confere o plugin novo sozinho na primeira vez.</li>
                <li>No canal <strong>Stereo Out</strong>, último slot de efeito: <em>Audio Units › noveau › noveau DAW</em>.</li>
              }
              @case ('protools') {
                <li>Ainda não funciona no Pro Tools comum: ele só abre plugins com a assinatura da Avid, que está
                  sendo pedida. Quando sair, o instalador passa a incluir a versão para Pro Tools e este passo vira "reabra o Pro Tools".</li>
              }
            }
          </ol>

          <p class="label">3 · conectar</p>
          <ol class="steps" start="1">
            <li>Na tela do plugin, clique em <strong>Conectar com o Discord</strong> e confirme na página que abrir. É uma vez só por computador.</li>
            <li>Entre numa call do Discord. Quem abrir a sala da call aqui no site já ouve, sem fazer nada.</li>
          </ol>
          <p class="hint">Sala fora do Discord? Dentro da sala, abra a tecla do plugin (barra de baixo), gere um código e digite no plugin.</p>
          <p class="hint foot"><a [href]="releases" target="_blank" rel="noopener">Outras versões e o código-fonte</a></p>
        }
      </div>
    </div>
  `,
  styles: `
    .card { width: min(520px, 100%); }
    h1 { margin: 0; font-size: 2.1rem; }
    .masthead { display: flex; align-items: center; gap: 0.8rem; padding-bottom: 1rem; margin-bottom: 0.2rem;
      border-bottom: 1px solid var(--line); }
    .logo { display: block; }
    .sub { margin: 0.3rem 0 0; }
    .confirm { margin: 1rem 0 0.4rem; display: flex; flex-direction: column; gap: 0.5rem; }
    .lead { margin: 0; font-size: 1rem; }
    .lead.ok { display: flex; align-items: center; gap: 0.5rem; }
    .who { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; }
    .who img { border-radius: 50%; }
    .code { display: flex; justify-content: center; padding: 0.55rem; border-radius: 6px; background: #09080c;
      border: 1px solid var(--line-2); box-shadow: inset 0 1px 4px #000a; }
    .big { font-size: 1.5rem; letter-spacing: 0.16em; }
    .discord-login { background: #4f57b8; color: #f1ede4; }
    .discord-login:hover { background: #5961c4 !important; }
    .downloads { display: flex; align-items: center; gap: 0.6rem; }
    .downloads .btn { height: 42px; font-size: 0.95rem; flex: 1; }
    .other { font-size: 0.8rem; white-space: nowrap; }
    .steps { margin: 0.6rem 0 0.4rem; padding-left: 1.2rem; font-size: 0.88rem; line-height: 1.55; }
    .steps li + li { margin-top: 0.3rem; }
    .chips { margin-top: 0.2rem; }
    .foot { margin-top: 1rem; text-align: center; }
    em { font-style: normal; color: var(--text); }
  `,
})
export class PluginPage {
  protected readonly code = normalize(new URLSearchParams(location.search).get('c'));
  protected readonly os: DesktopOs = desktopOs();
  protected readonly installers = DAW_INSTALLERS;
  protected readonly releases = DAW_PLUGIN_RELEASES;
  protected readonly loginUrl = `/api/discord/login?next=${encodeURIComponent(`/plugin?c=${this.code}`)}`;
  protected readonly daw = signal<Daw>('geral');
  protected readonly me = signal<Me | null>(null);
  protected readonly busy = signal(false);
  protected readonly done = signal(false);
  protected readonly error = signal('');
  protected readonly step = computed(() => {
    const m = this.me();
    if (this.done()) return 'done';
    if (m === null) return 'loading';
    if (!m.discord) return 'no-discord';
    return m.user === null ? 'login' : 'ask';
  });

  constructor() {
    if (this.os === 'mac') this.daw.set('logic');
    void whoAmI()
      .then((m) => this.me.set(m))
      .catch((e) => this.error.set(e instanceof Error ? e.message : 'Não foi possível falar com o servidor.'));
  }

  async confirm() {
    this.busy.set(true);
    this.error.set('');
    try {
      await confirmDawLink(this.code);
      this.done.set(true);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Não deu certo. Clique em "Conectar" no plugin de novo.');
    } finally {
      this.busy.set(false);
    }
  }
}

function normalize(raw: string | null) {
  const s = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : '';
}
