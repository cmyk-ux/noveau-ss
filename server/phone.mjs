// Celular como câmera e microfone do PC (no estilo do Iriun Webcam e do WO Mic).
//
// Quem está na sala pelo PC gera um link (e um QR). O celular abre o link, entra na mesma sala do
// LiveKit como um participante "acompanhante" (atributo phoneOf = identidade do PC) e manda a câmera
// e/ou o microfone dele. Os outros navegadores juntam esse acompanhante à pessoa: a câmera do celular
// aparece como a câmera dela, a voz como a voz dela.
//
// Regras:
// - Um link por pessoa por sala, e um aparelho por link: o primeiro celular que abre fica com ele
//   (preso a um id guardado no navegador do celular, então ele pode recarregar a página).
// - "Desconectar" no PC tira o celular da sala e apaga o link; aí dá para gerar outro.
// - Link sem uso vence em 15 min. Em uso, vale enquanto o token do celular valer (12 h).
// - O celular não recebe nada da sala (canSubscribe: false): não gasta a internet dele nem faz eco.
// - O PC liga/desliga a câmera e o microfone do celular pelo atributo "ctl" do celular.
//
// Tudo fica na memória do servidor: reiniciar o servidor apaga os links (o celular que já estava
// na sala continua até sair, e o PC consegue desconectá-lo pelo botão).

import { randomBytes } from 'node:crypto';

export class PhoneError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const UNCLAIMED_TTL_MS = 15 * 60_000;
const CLAIMED_TTL_MS = 12 * 3600_000;
const PHONE_TOKEN_TTL = '12h';

export function createPhone({ AccessToken, TrackSource, apiKey, apiSecret, rooms, verifyRoomToken, publicUrl }) {
  /** ownerKey -> { code, room, ownerKey, ownerIdentity, ownerName, discordId, holder, phoneIdentity, expiresAt, ctl } */
  const links = new Map();
  /** code -> ownerKey */
  const codes = new Map();

  function prune() {
    const now = Date.now();
    for (const [key, l] of links) {
      if (l.expiresAt < now) {
        links.delete(key);
        codes.delete(l.code);
      }
    }
  }

  /** Quem pede precisa estar na sala: prova com o próprio token do LiveKit. */
  async function owner(req) {
    const auth = String(req.headers.authorization ?? '');
    const claims = await Promise.resolve(auth.startsWith('Bearer ') ? verifyRoomToken(auth.slice(7)) : null).catch(() => null);
    const room = claims?.video?.room;
    if (typeof room !== 'string' || room === '') throw new PhoneError(401, 'Entre numa sala para usar o celular.');
    if (claims.attributes?.phoneOf) throw new PhoneError(403, 'O celular não gera link de celular.');
    const identity = String(claims.sub ?? '');
    const name = String(claims.name ?? identity.split('#')[0] ?? '');
    const discordId = claims.attributes?.discordId ?? '';
    // Mesma pessoa depois de recarregar a página (a identidade muda a cada entrada): conta do
    // Discord quando tem, senão o apelido.
    const ownerKey = `${room}|${discordId !== '' ? 'd:' + discordId : 'n:' + name}`;
    return { room, identity, name, discordId, ownerKey };
  }

  function status(l) {
    if (l === undefined) return { state: 'none' };
    return {
      state: l.holder === null ? 'waiting' : 'claimed',
      code: l.code,
      expiresAt: l.expiresAt,
      phoneIdentity: l.phoneIdentity,
    };
  }

  /** O PC recarregou (identidade nova): o celular passa a apontar para a identidade nova. */
  async function rebind(l, who) {
    if (l.ownerIdentity === who.identity) return;
    l.ownerIdentity = who.identity;
    if (l.phoneIdentity === null) return;
    await rooms
      .updateParticipant(l.room, l.phoneIdentity, { attributes: { phoneOf: who.identity } })
      .catch((e) => console.error('[celular] religar ao PC:', e.message));
  }

  async function getLink(req) {
    prune();
    const who = await owner(req);
    const l = links.get(who.ownerKey);
    if (l !== undefined) await rebind(l, who);
    return status(l);
  }

  async function createLink(req) {
    prune();
    const who = await owner(req);
    const existing = links.get(who.ownerKey);
    if (existing !== undefined) {
      await rebind(existing, who);
      return status(existing);
    }
    const code = randomBytes(9).toString('base64url');
    const l = {
      code,
      room: who.room,
      ownerKey: who.ownerKey,
      ownerIdentity: who.identity,
      ownerName: who.name,
      discordId: who.discordId,
      holder: null,
      phoneIdentity: null,
      expiresAt: Date.now() + UNCLAIMED_TTL_MS,
      // Começa só com a câmera (estilo Iriun); o microfone liga no celular ou pelo PC.
      ctl: { cam: true, mic: false, n: 0 },
    };
    links.set(who.ownerKey, l);
    codes.set(code, who.ownerKey);
    console.log(`[celular] ${who.name} gerou um link de celular`);
    return status(l);
  }

  async function disconnect(req) {
    prune();
    const who = await owner(req);
    const l = links.get(who.ownerKey);
    // Sem link na memória (servidor reiniciou): tira da sala qualquer celular que aponte para este PC.
    const targets = new Set(l?.phoneIdentity ? [l.phoneIdentity] : []);
    try {
      for (const p of await rooms.listParticipants(who.room)) {
        const of = p.attributes?.phoneOf;
        if (of !== undefined && (of === who.identity || (l !== undefined && of === l.ownerIdentity))) targets.add(p.identity);
      }
    } catch {
      /* sala vazia */
    }
    if (l !== undefined) {
      links.delete(who.ownerKey);
      codes.delete(l.code);
    }
    for (const id of targets) await rooms.removeParticipant(who.room, id).catch(() => undefined);
    if (l !== undefined || targets.size > 0) console.log(`[celular] ${who.name} desconectou o celular`);
    return { ok: true, removed: targets.size };
  }

  /** O PC liga/desliga a câmera ou o microfone do celular. */
  async function control(req, body) {
    prune();
    const who = await owner(req);
    const l = links.get(who.ownerKey);
    if (l === undefined || l.phoneIdentity === null) throw new PhoneError(404, 'Nenhum celular conectado.');
    if (typeof body.cam === 'boolean') l.ctl.cam = body.cam;
    if (typeof body.mic === 'boolean') l.ctl.mic = body.mic;
    l.ctl.n += 1;
    try {
      await rooms.updateParticipant(l.room, l.phoneIdentity, { attributes: { ctl: JSON.stringify(l.ctl) } });
    } catch (e) {
      console.error('[celular] comandar:', e.message);
      throw new PhoneError(502, 'O celular não está na sala agora. Abra a página dele de novo.');
    }
    return { ok: true };
  }

  /** O celular abre o link: o primeiro aparelho fica com ele. */
  async function phoneToken(req, body) {
    prune();
    const key = typeof body.code === 'string' ? codes.get(body.code) : undefined;
    const l = key === undefined ? undefined : links.get(key);
    const holder = typeof body.holder === 'string' && body.holder.length >= 16 && body.holder.length <= 64 ? body.holder : null;
    if (l === undefined || holder === null) {
      throw new PhoneError(410, 'Este link venceu ou foi desconectado no PC. Gere outro no PC (tecla da câmera › Usar o celular).');
    }
    if (l.holder !== null && l.holder !== holder) {
      throw new PhoneError(409, 'Este link já está aberto em outro celular. Para trocar de aparelho, clique em Desconectar no PC e gere outro link.');
    }
    // O mesmo celular recarregou: o participante antigo sai antes de entrar o novo.
    if (l.phoneIdentity !== null) await rooms.removeParticipant(l.room, l.phoneIdentity).catch(() => undefined);
    l.holder = holder;
    l.expiresAt = Date.now() + CLAIMED_TTL_MS;
    const identity = `${l.ownerName}#cel-${randomBytes(3).toString('base64url')}`;
    const attributes = {
      phoneOf: l.ownerIdentity,
      device: 'phone-companion',
      ctl: JSON.stringify(l.ctl),
      ...(l.discordId !== '' ? { phoneOfDiscord: l.discordId } : {}),
    };
    const at = new AccessToken(apiKey, apiSecret, { identity, name: l.ownerName, ttl: PHONE_TOKEN_TTL, attributes });
    at.addGrant({
      roomJoin: true,
      room: l.room,
      canPublish: true,
      canSubscribe: false,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE],
    });
    l.phoneIdentity = identity;
    console.log(`[celular] o celular de ${l.ownerName} entrou`);
    return { token: await at.toJwt(), url: publicUrl(req), name: l.ownerName, identity };
  }

  return {
    routes: {
      'GET /api/phone/link': (req) => getLink(req),
      'POST /api/phone/link': (req) => createLink(req),
      'POST /api/phone/disconnect': (req) => disconnect(req),
      'POST /api/phone/control': (req, body) => control(req, body),
      'POST /api/phone/token': (req, body) => phoneToken(req, body),
    },
  };
}
