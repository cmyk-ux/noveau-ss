// Login com Discord e "sala da call": quem está num canal de voz do servidor configurado
// entra numa sala do site junto com as mesmas pessoas da call.
//
// Como funciona:
//  - Login: OAuth2 do Discord só com o escopo "identify" (nome e avatar, nada mais).
//  - Saber em qual call a pessoa está: o bot do app consulta, pela API REST, o estado de voz
//    dela no servidor (GET /guilds/{guild}/voice-states/{user}). O bot não precisa ficar
//    online nem ter permissões especiais, só estar no servidor e poder ver os canais de voz.
//  - A sala do LiveKit é derivada do id do canal de voz, e o token só é emitido para quem
//    o Discord confirma estar naquele canal agora.
//
// Variáveis de ambiente (coloque no arquivo .env na raiz do projeto):
//   DISCORD_CLIENT_ID      id do app (Developer Portal > OAuth2)
//   DISCORD_CLIENT_SECRET  segredo do app (Developer Portal > OAuth2)
//   DISCORD_BOT_TOKEN      token do bot (Developer Portal > Bot)
//   DISCORD_GUILD_ID       id do seu servidor
//   SESSION_SECRET         qualquer texto longo e aleatório, para assinar o cookie de login
//   DISCORD_REDIRECT_URI   opcional; padrão: <endereço do site>/api/discord/callback

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cachedChannelOf, membersOf, pingCall, sendDm, startBot } from './discord-bot.mjs';

const API = process.env.DISCORD_API_URL || 'https://discord.com/api/v10'; // trocável só para testes
const CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? '';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? '';
const GUILD_ID = process.env.DISCORD_GUILD_ID ?? '';
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI ?? '';
const SESSION_SECRET =
  process.env.SESSION_SECRET || createHash('sha256').update(`noveau:${CLIENT_SECRET}:${BOT_TOKEN}`).digest('hex');
const SESSION_COOKIE = 'noveau_session';
const STATE_COOKIE = 'noveau_oauth_state';
const SWITCH_COOKIE = 'noveau_switch_account';
const SESSION_DAYS = 30;

export const discordEnabled = CLIENT_ID !== '' && CLIENT_SECRET !== '' && BOT_TOKEN !== '' && GUILD_ID !== '';

export class DiscordError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- cookies assinados ----------

function sign(value) {
  return createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function seal(data) {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function unseal(raw) {
  if (typeof raw !== 'string') return null;
  const [body, mac] = raw.split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    return typeof data.exp === 'number' && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function siteOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] ?? 'http';
  return `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost'}`;
}

function redirectUri(req) {
  return REDIRECT_URI || `${siteOrigin(req)}/api/discord/callback`;
}

/** Usuário logado (ou null), lido do cookie assinado. */
export function currentUser(req) {
  return unseal(cookies(req)[SESSION_COOKIE]);
}

// ---------- rotas que respondem com redirecionamento ----------

function redirect(res, location, setCookies = []) {
  res.writeHead(302, { location, 'set-cookie': setCookies, 'cache-control': 'no-store' });
  res.end();
}

export function login(req, res) {
  if (!discordEnabled) return redirect(res, '/?discord=desligado');
  const state = randomBytes(16).toString('base64url');
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(req),
    scope: 'identify',
    state,
    // Depois de "sair", mostra a tela de autorização de novo, com o "Não é você?" para trocar
    // de conta. Sem isso o Discord reaproveita na hora a conta logada no navegador.
    prompt: cookies(req)[SWITCH_COOKIE] ? 'consent' : 'none',
  }).toString();
  redirect(res, url.toString(), [cookie(STATE_COOKIE, state, 600)]);
}

export async function callback(req, res) {
  const params = new URL(req.url, 'http://x').searchParams;
  const state = cookies(req)[STATE_COOKIE];
  const clearState = cookie(STATE_COOKIE, '', 0);
  if (!discordEnabled || params.get('error') || !params.get('code') || !state || params.get('state') !== state) {
    return redirect(res, '/?discord=falhou', [clearState]);
  }
  try {
    const tokenRes = await fetch(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: params.get('code'),
        redirect_uri: redirectUri(req),
      }),
    });
    if (!tokenRes.ok) throw new Error(`oauth2/token ${tokenRes.status}: ${await tokenRes.text()}`);
    const { access_token } = await tokenRes.json();
    const meRes = await fetch(`${API}/users/@me`, { headers: { authorization: `Bearer ${access_token}` } });
    if (!meRes.ok) throw new Error(`users/@me ${meRes.status}`);
    const me = await meRes.json();
    const session = seal({
      id: me.id,
      name: (me.global_name || me.username || 'alguém').slice(0, 24),
      avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null,
      exp: Date.now() + SESSION_DAYS * 864e5,
    });
    // O token do Discord só serve para ler o nome agora; revogamos para não guardar nada.
    void revoke(access_token);
    redirect(res, '/', [clearState, cookie(SWITCH_COOKIE, '', 0), cookie(SESSION_COOKIE, session, SESSION_DAYS * 86400)]);
  } catch (e) {
    console.error('[discord] login falhou:', e.message);
    redirect(res, '/?discord=falhou', [clearState]);
  }
}

async function revoke(token) {
  try {
    await fetch(`${API}/oauth2/token/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, token, token_type_hint: 'access_token' }),
    });
  } catch {
    /* não é crítico */
  }
}

export function logout(_req, res) {
  // Apaga a sessão e marca que o próximo login deve deixar escolher a conta.
  redirect(res, '/?ficar=1', [cookie(SESSION_COOKIE, '', 0), cookie(SWITCH_COOKIE, '1', 30 * 86400)]);
}

// ---------- estado de voz ----------

const channelNames = new Map();

async function bot(path) {
  return fetch(`${API}${path}`, { headers: { authorization: `Bot ${BOT_TOKEN}` } });
}

async function channelName(id) {
  if (channelNames.has(id)) return channelNames.get(id);
  let name = 'call';
  try {
    const r = await bot(`/channels/${id}`);
    if (r.ok) name = (await r.json()).name ?? name;
  } catch {
    /* fica "call" */
  }
  channelNames.set(id, name);
  return name;
}

/** Canal de voz do servidor configurado em que o usuário está agora, ou null. */
export async function voiceChannelOf(userId) {
  // Com o bot conectado, a resposta vem do gateway (tempo real, sem gastar API).
  const cached = cachedChannelOf(userId);
  if (cached !== undefined) return cached;
  const r = await bot(`/guilds/${GUILD_ID}/voice-states/${userId}`);
  if (r.status === 404) return null; // não está em nenhuma call do servidor
  if (!r.ok) {
    console.error('[discord] voice-states', r.status, await r.text());
    throw new DiscordError(502, 'O Discord não respondeu. O bot está no servidor?');
  }
  const state = await r.json();
  if (!state.channel_id) return null;
  return { id: state.channel_id, name: await channelName(state.channel_id) };
}

/** Sala do LiveKit de um canal de voz. */
export function roomForChannel(channelId) {
  return 'd_' + createHash('sha256').update(`${GUILD_ID}:${channelId}`).digest('hex').slice(0, 32);
}

/** Para GET /api/me: quem está logado e em qual call. */
export async function me(req) {
  if (!discordEnabled) return { discord: false, user: null, call: null };
  const user = currentUser(req);
  if (user === null) return { discord: true, user: null, call: null };
  const call = await voiceChannelOf(user.id);
  return { discord: true, user: { id: user.id, name: user.name, avatar: user.avatar }, call };
}

/** Usuário logado e a call em que ele está; erro se faltar algum dos dois. */
export async function requireCall(req) {
  if (!discordEnabled) throw new DiscordError(404, 'O login com Discord não está configurado.');
  const user = currentUser(req);
  if (user === null) throw new DiscordError(401, 'Entre com o Discord primeiro.');
  const call = await voiceChannelOf(user.id);
  if (call === null) throw new DiscordError(409, 'Você não está em nenhuma call do servidor agora.');
  return { user, call };
}

/** Liga o bot do gateway (se configurado). */
export function startDiscordBot(onLeave) {
  if (discordEnabled) startBot({ onLeave });
}

/** Para GET /api/discord/members: todo mundo da call em que o usuário logado está. */
export async function callMembers(req) {
  const { call } = await requireCall(req);
  const people = await membersOf(call.id);
  if (people === null) throw new DiscordError(503, 'O bot do Discord ainda está conectando.');
  return { call, people: people.map(({ id, name, avatar }) => ({ id, name, avatar })) };
}

/** Para POST /api/discord/ping: o bot marca a call no chat do canal de voz. */
export async function pingMyCall(req) {
  const { user, call } = await requireCall(req);
  try {
    const count = await pingCall(call.id, user.name, `${siteOrigin(req)}/`);
    return { ok: true, count };
  } catch (e) {
    throw new DiscordError(409, e.message);
  }
}

/**
 * Para POST /api/discord/invite: o bot manda por DM o link de uma sala privada para alguém
 * que está na mesma call de quem convida (assim o bot não vira ferramenta de spam).
 */
export async function inviteToRoom(req, body) {
  const { user, call } = await requireCall(req);
  const people = (await membersOf(call.id)) ?? [];
  if (typeof body.userId !== 'string' || !people.some((p) => p.id === body.userId)) {
    throw new DiscordError(400, 'Essa pessoa não está na sua call.');
  }
  const origin = siteOrigin(req);
  if (typeof body.link !== 'string' || !body.link.startsWith(`${origin}/room/`) || body.link.length > 300) {
    throw new DiscordError(400, 'Link de sala inválido.');
  }
  try {
    await sendDm(body.userId, `**${user.name}** te chamou para uma sala privada no Noveau: ${body.link}`);
  } catch (e) {
    throw new DiscordError(409, e.message);
  }
  return { ok: true };
}
