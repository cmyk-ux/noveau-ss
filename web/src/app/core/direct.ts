// 1o1 ("one o one"; no código, "conversa direta"): falar e ouvir só com uma pessoa da sala.
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
import { ConnectionState, LocalAudioTrack, LocalParticipant, Participant, RemoteTrackPublication, Room, Track } from 'livekit-client';

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

/**
 * "<identidade>|out": saí do 1o1 com essa pessoa e ela ainda aponta para mim. Fica enquanto ela
 * apontar, e para quem está de fora vale como "falando com todos" (parseDirect devolve null).
 */
function outOf(attrs: Record<string, string> | undefined): string | null {
  const v = attrs?.[DIRECT_ATTR];
  return v !== undefined && v.endsWith('|out') ? v.slice(0, -4) : null;
}

/** Som de entrar e sair do 1o1, e o "toc toc" de quem tenta puxar você enquanto está noutro (veja sfx.ts). */
export type DirectCue = 'pull' | 'pulled' | 'leave' | 'knock';

/** A mesma pessoa só faz o "toc toc" tocar de novo depois disso (arrastar e cancelar várias vezes). */
export const KNOCK_EACH_MS = 20_000;
/** Entre dois "toc toc" quaisquer (várias pessoas tentando ao mesmo tempo). */
export const KNOCK_ANY_MS = 5_000;

/**
 * Quem pode receber cada faixa de `lp` estando num 1o1 com `to`: a outra pessoa recebe tudo; o
 * resto, tudo menos o microfone. Uma faixa nova (ex.: microfone publicado agora) fica fechada para o
 * resto até entrar nesta lista: seguro por padrão. Serve ao PC e ao celular usado como microfone.
 */
export function privatePermissions(room: Room, lp: LocalParticipant, to: string) {
  const mic = lp.getTrackPublication(Track.Source.Microphone)?.trackSid;
  const rest = [...lp.trackPublications.values()].map((p) => p.trackSid).filter((sid) => sid !== mic).sort();
  const others = [...room.remoteParticipants.keys()].filter((id) => id !== to).sort();
  return {
    sig: JSON.stringify([to, rest, others]),
    list: [{ participantIdentity: to, allowAll: true }, ...others.map((id) => ({ participantIdentity: id, allowedTrackSids: rest }))],
  };
}

/** Quanto esperar, depois de alguém sair de um 1o1, para conferir se a voz dele voltou a chegar. */
const VERIFY_MS = 4000;

/** Bytes de som que já chegaram por esta faixa (null = sem leitura). */
async function bytesIn(pub: RemoteTrackPublication): Promise<number | null> {
  const rep = await pub.track?.getRTCStatsReport().catch(() => undefined);
  if (rep === undefined) return null;
  let bytes = 0;
  rep.forEach((s: { type?: string; bytesReceived?: number }) => {
    if (s.type === 'inbound-rtp') bytes += s.bytesReceived ?? 0;
  });
  return bytes;
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
  /** O atributo já enviado (pode ser o "saí" de wire()). */
  private appliedWire = '';
  /** Já tem um converge() na fila para levar o atributo até wire(). */
  private kicked = false;
  /**
   * A conexão caiu e voltou: não dá para confiar no que o servidor sabe. Numa retomada ele guardou
   * o atributo; numa reconexão completa perdeu, e o LiveKit reenvia sozinho as últimas permissões.
   * Enquanto true, o próximo passo reenvia o atributo e as permissões mesmo que pareçam iguais.
   */
  private stale = false;
  private permsSig = 'all';
  /**
   * O que as permissões devem dizer agora. Muda junto com o envio (antes de esperar o servidor
   * confirmar o atributo): antes o sync() usava `applied`, que só muda depois dessa espera, e nesse
   * meio-tempo reabria o microfone para a sala inteira (medido: "restrito, TODOS, restrito" em cada
   * começo de 1o1).
   */
  private permsFor: DirectAim | null = null;
  /** Pessoas cuja voz o servidor não me manda porque estão num 1o1 com outra pessoa. */
  private shutOut = new Set<string>();
  /** Quantas vezes cada pessoa entrou num 1o1 com outra (a conferência do fim vale só para o último). */
  private readonly rounds = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  /** Quem está tentando me puxar para um 1o1 enquanto estou noutro (já avisado ou ignorado). */
  private knockers = new Set<string>();
  /** Quando cada pessoa fez o "toc toc" tocar pela última vez. */
  private readonly knockedAt = new Map<string, number>();
  private lastKnock = -Infinity;

  constructor(
    private readonly room: Room,
    private readonly hooks: {
      changed: () => void;
      /** Toca o som de entrar ou sair do 1o1. */
      cue: (c: DirectCue) => void;
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
    // Reconectando: a conversa continua de pé (o servidor também a mantém). Antes ela era zerada
    // aqui só do nosso lado: o servidor continuava com o atributo e as permissões fechadas e, na
    // volta, ninguém mais ouvia a pessoa nem via a conversa acabar (uma conversa "fantasma").
    if (this.room.state === ConnectionState.Disconnected) {
      if (this.aim !== null || this.applied !== null || this.appliedWire !== '') {
        this.aim = null;
        this.applied = null;
        this.appliedWire = '';
        this.declined = null;
        this.paired = false;
        this.micOpenedForTalk = false;
        this.permsSig = 'all';
        this.permsFor = null;
      }
      this.shutOut.clear();
      return;
    }
    if (this.room.state !== ConnectionState.Connected) return;
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
      else if (this.paired || outOf(this.room.remoteParticipants.get(a.to)?.attributes) === me) {
        // Era a dois e a outra pessoa voltou para todos: volto também. O "saí" (|out) cobre o caso
        // em que nunca cheguei a ver a outra pessoa entrar: as duas mudanças do atributo dela
        // chegaram juntas (aba em segundo plano, rede engasgando), e antes eu ficava preso sozinho
        // no 1o1, sem ouvir a sala e com a sala sem me ouvir, esperando alguém que já tinha saído.
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
    this.knock(pointsAtMe);
    // Entrou gente ou publiquei outra faixa: refaz a lista de quem pode receber o quê.
    this.applyPermissions(this.permsFor);
    // O "saí" já não precisa ficar (a outra pessoa parou de apontar para mim): limpa o atributo.
    if (this.wire() !== this.appliedWire) this.kick();
    this.reclaim();
  }

  /**
   * Estou num 1o1 travado e alguém tenta me puxar para outro: a pessoa fica esperando (não entro
   * sozinho no dela), e eu ouço um "toc toc" discreto, só aqui (som local, não passa pelo microfone
   * nem pelo servidor). Toca uma vez por tentativa nova, no máximo uma vez a cada KNOCK_EACH_MS por
   * pessoa e KNOCK_ANY_MS no geral; uma tentativa barrada pelo limite não toca depois.
   */
  private knock(pointsAtMe: (id: string) => boolean) {
    const busyWith = this.aim?.mode === 'lock' ? this.aim.to : null;
    const now = new Set<string>();
    if (busyWith !== null) {
      for (const p of this.room.remoteParticipants.values()) {
        if (p.identity !== busyWith && p.identity !== this.declined && pointsAtMe(p.identity)) now.add(p.identity);
      }
    }
    const t = performance.now();
    for (const id of now) {
      if (this.knockers.has(id)) continue;
      if (t - (this.knockedAt.get(id) ?? -Infinity) < KNOCK_EACH_MS || t - this.lastKnock < KNOCK_ANY_MS) continue;
      this.knockedAt.set(id, t);
      this.lastKnock = t;
      this.hooks.cue('knock');
    }
    this.knockers = now;
  }

  /**
   * Alguém saiu de um 1o1 (com outra pessoa): pede a voz dela de volta ao servidor na hora.
   *
   * Quando a pessoa libera o microfone de novo, o LiveKit (v1.13.11) devolve a voz na hora só para
   * parte da sala: o aviso de "permissão mudou" se perde para alguns (ao cortar a voz ele tira o
   * observador numa goroutine, que às vezes roda depois de o observador novo entrar, e apaga o novo).
   * Esses só voltavam na ronda de 3 s do servidor. Medido com 3 ouvintes, 6 vezes: uns em ~80 ms,
   * outros em 0,8 a 2,9 s, sorteado a cada vez. Pedir a inscrição de novo (setSubscribed(true), que
   * no servidor sempre refaz a inscrição desta faixa na hora) não depende desse aviso.
   * A pessoa manda a permissão antes do atributo, pelo mesmo canal: quando o atributo chega aqui, o
   * servidor já sabe que pode mandar. É uma mensagem por pessoa a cada 1o1 que acaba.
   */
  private reclaim() {
    const me = this.room.localParticipant.identity;
    const now = new Set<string>();
    for (const p of this.room.remoteParticipants.values()) {
      const a = parseDirect(p.attributes);
      if (a !== null && a.to !== me) now.add(p.identity);
    }
    for (const id of now) if (!this.shutOut.has(id)) this.rounds.set(id, (this.rounds.get(id) ?? 0) + 1);
    for (const id of this.shutOut) {
      if (now.has(id)) continue;
      for (const pub of this.voicesOf(id)) if (pub.isDesired && !pub.isSubscribed) pub.setSubscribed(true);
      const round = this.rounds.get(id) ?? 0;
      window.setTimeout(() => void this.verify(id, round), VERIFY_MS);
    }
    this.shutOut = now;
  }

  /** O microfone de uma pessoa: o do PC e o do celular ligado como microfone. */
  private voicesOf(id: string): RemoteTrackPublication[] {
    const out: RemoteTrackPublication[] = [];
    for (const x of this.room.remoteParticipants.values()) {
      if (x.identity !== id && x.attributes?.['phoneOf'] !== id) continue;
      const pub = x.getTrackPublication(Track.Source.Microphone);
      if (pub instanceof RemoteTrackPublication) out.push(pub);
    }
    return out;
  }

  /**
   * Uma conferência só, uns segundos depois de alguém sair de um 1o1: a voz dessa pessoa voltou a
   * chegar de verdade? Se não (inscrição que não voltou, faixa que chegou e se perdeu, nenhum byte
   * entrando), refaz a inscrição do zero: desinscreve e inscreve de novo, o que cria uma inscrição
   * nova no servidor e uma faixa nova aqui, sem depender de nada do estado antigo. Se a faixa chega
   * mas o elemento de áudio parou, manda tocar de novo. Não é um vigia: roda uma vez por 1o1 que acaba.
   */
  private async verify(id: string, round: number) {
    // Entrou noutro 1o1 depois (mesmo que já tenha saído de novo): a conferência daquele vale.
    const moved = () => this.room.state !== ConnectionState.Connected || this.shutOut.has(id) || (this.rounds.get(id) ?? 0) !== round;
    if (moved()) return;
    for (const pub of this.voicesOf(id)) {
      if (!pub.isDesired || pub.isMuted) continue;
      if (!pub.isSubscribed || pub.track === undefined) {
        this.resubscribe(pub, `${id}: sem faixa`);
        continue;
      }
      const a = await bytesIn(pub);
      await new Promise((r) => setTimeout(r, 1500));
      if (moved()) return;
      if (pub.isMuted || pub.track === undefined) continue;
      const b = await bytesIn(pub);
      if (a !== null && b !== null && b <= a) {
        this.resubscribe(pub, `${id}: sem bytes`);
        continue;
      }
      for (const el of pub.track.attachedElements) if (el.paused) void el.play().catch(() => undefined);
    }
  }

  private resubscribe(pub: RemoteTrackPublication, why: string) {
    this.resubscribes++;
    this.resubscribeLog.push(`${new Date().toISOString().slice(11, 23)} ${why}`);
    pub.setSubscribed(false);
    window.setTimeout(() => {
      if (!pub.isDesired) pub.setSubscribed(true);
    }, 250);
  }

  /** Quantas vezes a conferência teve de refazer uma inscrição (para os testes). */
  resubscribes = 0;
  readonly resubscribeLog: string[] = [];

  /** A sala voltou de uma queda: leva o servidor de novo até o estado atual. */
  reconnected() {
    this.stale = true;
    this.permsSig = '';
    this.kick();
  }

  /** O atributo que os outros devem ver agora. */
  private wire() {
    if (this.aim !== null) return encode(this.aim);
    return this.declined !== null ? `${this.declined}|out` : '';
  }

  private kick() {
    if (this.kicked) return;
    this.kicked = true;
    this.queue = this.queue
      .then(() => {
        this.kicked = false;
        return this.converge();
      })
      .catch(() => undefined);
  }

  private set(next: Aim | null) {
    const before = this.aim;
    this.aim = next;
    // Som: puxei alguém (ou fui puxado) para um 1o1, ou saí dele. Segurar não toca nada (é como
    // apertar para falar: tocaria a cada aperto).
    const wasLock = before?.mode === 'lock';
    const isLock = next?.mode === 'lock';
    if (isLock && (!wasLock || before?.to !== next.to)) this.hooks.cue(next.mine ? 'pull' : 'pulled');
    else if (wasLock && !isLock) this.hooks.cue('leave');
    if (next === null || before?.to !== next.to) this.paired = next !== null && !next.mine;
    this.kick();
  }

  /** Leva o servidor até o estado atual, um passo de cada vez (apertar e soltar rápido não embaralha). */
  private async converge() {
    if (this.room.state !== ConnectionState.Connected) return;
    const want = this.aim === null ? null : { to: this.aim.to, mode: this.aim.mode };
    const wire = this.wire();
    if (!this.stale && wire === this.appliedWire && encode(want) === encode(this.applied) && (want === null || this.micLiveOrOpened())) return;
    this.stale = false;
    const lp = this.room.localParticipant;
    if (want !== null) {
      // Fecha o microfone para os outros ANTES de soltar o som: segura a voz (silêncio) até o
      // servidor confirmar, para o começo da frase não vazar para a sala.
      const wasOpen = this.applied === null;
      const track = lp.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
      const gate = wasOpen && track !== undefined && !track.isMuted ? track.mediaStreamTrack : undefined;
      if (gate !== undefined) gate.enabled = false;
      this.applyPermissions(want);
      await this.publish(wire);
      this.appliedWire = wire;
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
      this.appliedWire = wire;
      await this.publish(wire);
    }
    this.hooks.changed();
  }

  private micLiveOrOpened() {
    return this.micOpenedForTalk || this.hooks.micLive() || this.aim?.mine !== true;
  }

  private async publish(wire: string) {
    const done = this.room.localParticipant.setAttributes({ [DIRECT_ATTR]: wire }).catch(() => undefined);
    await Promise.race([done, new Promise((r) => setTimeout(r, ACK_MS))]);
  }

  /**
   * Quem pode receber cada faixa minha. Falando com todos: todo mundo, tudo. Num 1o1: veja
   * privatePermissions.
   */
  private applyPermissions(a: DirectAim | null) {
    const lp = this.room.localParticipant;
    this.permsFor = a;
    if (a === null) {
      if (this.permsSig === 'all') return;
      this.permsSig = 'all';
      lp.setTrackSubscriptionPermissions(true);
      return;
    }
    const { sig, list } = privatePermissions(this.room, lp, a.to);
    if (sig === this.permsSig) return;
    this.permsSig = sig;
    lp.setTrackSubscriptionPermissions(false, list);
  }
}
