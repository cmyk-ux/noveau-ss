// Conversa direta: falar e ouvir só com uma pessoa da sala, como um sussurro.
//
// Cada um conta aos outros com quem está falando direto pelo atributo "direct" ("<identidade>|hold"
// ou "<identidade>|lock"; vazio = falando com todos). Com isso:
// - quem fala direto libera o próprio microfone só para a outra pessoa (permissão de faixa do
//   LiveKit): o servidor nem manda essa voz para o resto da sala, não é só um volume no zero;
// - quem fala direto ouve só a outra pessoa;
// - os outros não ouvem nem veem "falando" quem está numa conversa direta que não é com eles.
//
// Segurar o botão = "hold": vale enquanto segura. A outra pessoa continua ouvindo todo mundo e
// fica sabendo que você está falando só com ela.
// Segurar e arrastar = "lock": fica travado e vira uma conversa a dois. A outra pessoa entra junto
// sozinha (ouve só você e fala só com você) até qualquer uma das duas voltar para todos.
import { ConnectionState, LocalAudioTrack, Participant, Room, Track } from 'livekit-client';

export const DIRECT_ATTR = 'direct';
export type DirectMode = 'hold' | 'lock';

export interface DirectAim {
  to: string;
  mode: DirectMode;
}

/** A minha conversa direta, para a tela. */
export interface DirectView {
  peer: string;
  mode: DirectMode;
  /** Fui eu que comecei (senão a outra pessoa travou comigo). */
  mine: boolean;
  /** Travei, mas a outra pessoa está em outra conversa direta e ainda não entrou na minha. */
  waiting: boolean;
}

export function parseDirect(attrs: Record<string, string> | undefined): DirectAim | null {
  const v = attrs?.[DIRECT_ATTR];
  if (v === undefined || v === '') return null;
  const i = v.lastIndexOf('|');
  if (i <= 0) return null;
  const mode = v.slice(i + 1);
  return mode === 'hold' || mode === 'lock' ? { to: v.slice(0, i), mode } : null;
}

function encode(a: DirectAim | null) {
  return a === null ? '' : `${a.to}|${a.mode}`;
}

/** Quanto esperar o servidor confirmar antes de soltar o som (o normal é bem menos). */
const ACK_MS = 600;

interface Aim extends DirectAim {
  mine: boolean;
}

export class DirectTalk {
  private aim: Aim | null = null;
  /** A outra pessoa já travou de volta comigo (conversa a dois formada). */
  private paired = false;
  /** Acabei uma conversa a dois com esta pessoa: não entro de novo enquanto ela ainda aponta para mim. */
  private declined: string | null = null;
  /** Abri o microfone só para a conversa direta: fecha de novo no fim. */
  private micOpenedForTalk = false;
  /** O que o servidor já sabe (permissões e atributo), aplicado em ordem. */
  private applied: DirectAim | null = null;
  private permsSig = 'all';
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly room: Room,
    private readonly hooks: {
      changed: () => void;
      /** Meu microfone está mandando som (o do PC ou o do celular ligado por link). */
      micLive: () => boolean;
      setMic: (on: boolean) => Promise<void>;
    },
  ) {}

  /** Com quem estou falando direto (null = com todos). */
  get target() {
    return this.aim?.to ?? null;
  }

  view(): DirectView | null {
    const a = this.aim;
    if (a === null) return null;
    return { peer: a.to, mode: a.mode, mine: a.mine, waiting: a.mode === 'lock' && !this.paired };
  }

  /** Segurando o botão: fala e ouve só com esta pessoa até soltar. */
  hold(to: string) {
    // Travado numa conversa a dois: segurar não muda nada (sai primeiro).
    if (this.aim?.mode === 'lock' || !this.room.remoteParticipants.has(to)) return;
    this.set({ to, mode: 'hold', mine: true });
  }

  /** Arrastou: fica falando só com esta pessoa até alguém desligar. */
  lock(to: string) {
    if (!this.room.remoteParticipants.has(to)) return;
    if (this.aim?.mode === 'lock' && this.aim.to === to) return;
    this.set({ to, mode: 'lock', mine: true });
  }

  /** Soltou o botão (hold) ou desligou a conversa a dois: volta a falar com todos. */
  end() {
    if (this.aim === null) return;
    if (this.aim.mode === 'lock') this.declined = this.aim.to;
    this.set(null);
  }

  /** Soltou o botão: só acaba se ainda for o "segurando" (arrastou = continua travado). */
  release(to: string) {
    if (this.aim?.mode === 'hold' && this.aim.to === to) this.set(null);
  }

  /** Esta voz toca para mim? */
  audible(identity: string): boolean {
    const me = this.room.localParticipant.identity;
    const theirs = parseDirect(this.room.remoteParticipants.get(identity)?.attributes);
    // Está falando direto com outra pessoa: não é para mim.
    if (theirs !== null && theirs.to !== me) return false;
    // Estou falando direto: só a outra pessoa.
    return this.aim === null || this.aim.to === identity;
  }

  /** Com quem cada um está falando direto (para mostrar na lista de pessoas). */
  aimOf(p: Participant): DirectAim | null {
    if (p === this.room.localParticipant) return this.aim === null ? null : { to: this.aim.to, mode: this.aim.mode };
    return parseDirect(p.attributes);
  }

  /** Quem está segurando o botão para falar só comigo agora. */
  whisperingToMe(): string[] {
    const me = this.room.localParticipant.identity;
    const out: string[] = [];
    for (const p of this.room.remoteParticipants.values()) {
      const a = parseDirect(p.attributes);
      if (a?.to === me && (a.mode === 'hold' || this.aim?.to !== p.identity)) out.push(p.identity);
    }
    return out;
  }

  /** A cada mudança na sala: entra/sai de conversas a dois e acerta as permissões. */
  sync() {
    if (this.room.state !== ConnectionState.Connected) {
      if (this.aim !== null || this.applied !== null) {
        this.aim = null;
        this.applied = null;
        this.paired = false;
        this.micOpenedForTalk = false;
        this.permsSig = 'all';
      }
      return;
    }
    const me = this.room.localParticipant.identity;
    const pointsAtMe = (id: string) => {
      const a = parseDirect(this.room.remoteParticipants.get(id)?.attributes);
      return a !== null && a.to === me && a.mode === 'lock';
    };
    const a = this.aim;
    if (a !== null && !this.room.remoteParticipants.has(a.to)) {
      this.set(null); // a pessoa saiu da sala
    } else if (a?.mode === 'lock') {
      if (pointsAtMe(a.to)) this.paired = true;
      else if (this.paired) {
        // Era a dois e a outra pessoa voltou para todos: volto também.
        this.declined = null;
        this.set(null);
      }
    }
    if (this.declined !== null && !pointsAtMe(this.declined)) this.declined = null;
    // Alguém travou uma conversa a dois comigo: entro junto (se não estou noutra).
    if (this.aim === null) {
      for (const p of this.room.remoteParticipants.values()) {
        if (p.identity !== this.declined && pointsAtMe(p.identity)) {
          this.set({ to: p.identity, mode: 'lock', mine: false });
          break;
        }
      }
    }
    // Entrou gente ou publiquei outra faixa: refaz a lista de quem pode receber o quê.
    this.applyPermissions(this.applied);
  }

  private set(next: Aim | null) {
    const before = this.aim;
    this.aim = next;
    if (next === null || before?.to !== next.to) this.paired = next !== null && !next.mine;
    this.queue = this.queue.then(() => this.converge()).catch(() => undefined);
  }

  /** Leva o servidor até o estado atual, um passo de cada vez (apertar e soltar rápido não embaralha). */
  private async converge() {
    if (this.room.state !== ConnectionState.Connected) return;
    const want = this.aim === null ? null : { to: this.aim.to, mode: this.aim.mode };
    if (encode(want) === encode(this.applied) && (want === null || this.micLiveOrOpened())) return;
    const lp = this.room.localParticipant;
    if (want !== null) {
      // Fecha o microfone para os outros ANTES de soltar o som: segura a voz (silêncio) até o
      // servidor confirmar, para o começo da frase não vazar para a sala.
      const wasOpen = this.applied === null;
      const track = lp.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
      const gate = wasOpen && track !== undefined && !track.isMuted ? track.mediaStreamTrack : undefined;
      if (gate !== undefined) gate.enabled = false;
      this.applyPermissions(want);
      await this.publish(want);
      if (gate !== undefined && track !== undefined && !track.isMuted && track.mediaStreamTrack === gate) gate.enabled = true;
      this.applied = want;
      // Segurar o botão é como apertar para falar: com o microfone fechado, abre só durante a conversa.
      if (this.aim?.mine === true && !this.hooks.micLive()) {
        this.micOpenedForTalk = true;
        await this.hooks.setMic(true).catch(() => (this.micOpenedForTalk = false));
      }
    } else {
      // Fecha o microfone aberto só para a conversa antes de liberar para a sala.
      if (this.micOpenedForTalk) {
        this.micOpenedForTalk = false;
        await this.hooks.setMic(false).catch(() => undefined);
      }
      this.applyPermissions(null);
      this.applied = null;
      await this.publish(null);
    }
    this.hooks.changed();
  }

  private micLiveOrOpened() {
    return this.micOpenedForTalk || this.hooks.micLive() || this.aim?.mine !== true;
  }

  private async publish(a: DirectAim | null) {
    const done = this.room.localParticipant.setAttributes({ [DIRECT_ATTR]: encode(a) }).catch(() => undefined);
    await Promise.race([done, new Promise((r) => setTimeout(r, ACK_MS))]);
  }

  /**
   * Quem pode receber cada faixa minha. Falando com todos: todo mundo, tudo. Falando direto: a outra
   * pessoa recebe tudo; o resto recebe tudo menos o microfone. Uma faixa nova (ex.: microfone
   * publicado agora) fica fechada para o resto até entrar nesta lista: seguro por padrão.
   */
  private applyPermissions(a: DirectAim | null) {
    const lp = this.room.localParticipant;
    if (a === null) {
      if (this.permsSig === 'all') return;
      this.permsSig = 'all';
      lp.setTrackSubscriptionPermissions(true);
      return;
    }
    const mic = lp.getTrackPublication(Track.Source.Microphone)?.trackSid;
    const rest = [...lp.trackPublications.values()].map((p) => p.trackSid).filter((sid) => sid !== mic).sort();
    const others = [...this.room.remoteParticipants.keys()].filter((id) => id !== a.to).sort();
    const sig = JSON.stringify([a.to, rest, others]);
    if (sig === this.permsSig) return;
    this.permsSig = sig;
    lp.setTrackSubscriptionPermissions(false, [
      { participantIdentity: a.to, allowAll: true },
      ...others.map((id) => ({ participantIdentity: id, allowedTrackSids: rest })),
    ]);
  }
}
