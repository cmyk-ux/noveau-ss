// Bot do Discord ligado ao gateway: sabe em tempo real quem está em cada call do servidor.
//
// - Lista quem está numa call (a API REST do Discord não tem isso, só o gateway).
// - Quando alguém sai ou troca de call, tira essa pessoa da sala do site correspondente.
// - Marca todo mundo da call no chat do canal de voz com o link do site.
// - Escreve no status do canal de voz quem está ao vivo no Noveau (e devolve o status de antes).
//
// Usa só a intent GUILD_VOICE_STATES (não privilegiada): nada para ligar no Developer Portal.

import { Client, GatewayIntentBits, Events, Routes } from 'discord.js';

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? '';
const GUILD_ID = process.env.DISCORD_GUILD_ID ?? '';
const PING_COOLDOWN_MS = 60_000;

let client = null;
let ready = false;
const lastPing = new Map();

/** Liga o bot. onLeave(userId, channelId) é chamado quando alguém sai de uma call. */
export function startBot({ onLeave }) {
  if (BOT_TOKEN === '' || GUILD_ID === '' || client !== null) return;
  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  client.once(Events.ClientReady, (c) => {
    ready = true;
    const guild = c.guilds.cache.get(GUILD_ID);
    console.log(
      guild
        ? `[discord] bot ${c.user.tag} online no servidor "${guild.name}"`
        : `[discord] bot ${c.user.tag} online, mas NÃO está no servidor ${GUILD_ID}. Convide o bot.`,
    );
  });
  client.on(Events.VoiceStateUpdate, (before, after) => {
    if (after.guild.id !== GUILD_ID) return;
    if (before.channelId && before.channelId !== after.channelId) {
      onLeave(after.id, before.channelId);
    }
  });
  // Status dos canais de voz: o discord.js não guarda, então lemos direto do gateway.
  client.on('raw', (packet) => {
    if (packet?.t === 'VOICE_CHANNEL_STATUS_UPDATE' && packet.d?.guild_id === GUILD_ID) {
      voiceStatus.set(packet.d.id, packet.d.status ?? '');
    } else if (packet?.t === 'GUILD_CREATE' && packet.d?.id === GUILD_ID) {
      for (const ch of packet.d.channels ?? []) if (typeof ch.status === 'string') voiceStatus.set(ch.id, ch.status);
    }
  });
  client.on(Events.Error, (e) => console.error('[discord] erro no bot:', e.message));
  client.login(BOT_TOKEN).catch((e) => {
    console.error('[discord] o bot não conseguiu entrar (token errado?):', e.message);
    client = null;
  });
}

function guild() {
  return ready ? client?.guilds.cache.get(GUILD_ID) ?? null : null;
}

/** true quando o bot está conectado e enxerga o servidor. */
export function botReady() {
  return guild() !== null;
}

/** Canal de voz em que o usuário está agora (pelo cache do gateway), ou undefined se o bot não sabe. */
export function cachedChannelOf(userId) {
  const g = guild();
  if (g === null) return undefined;
  const state = g.voiceStates.cache.get(userId);
  if (!state?.channelId) return null;
  return { id: state.channelId, name: state.channel?.name ?? 'call' };
}

async function memberInfo(g, userId) {
  let member = g.members.cache.get(userId);
  if (!member) {
    try {
      member = await g.members.fetch(userId);
    } catch {
      return { id: userId, name: 'alguém', avatar: null, bot: false };
    }
  }
  return {
    id: userId,
    name: (member.displayName || member.user.username).slice(0, 32),
    avatar: member.displayAvatarURL({ size: 64, extension: 'png' }),
    bot: member.user.bot,
  };
}

/** Pessoas (não bots) que estão no canal de voz agora. */
export async function membersOf(channelId) {
  const g = guild();
  if (g === null) return null;
  const ids = [...g.voiceStates.cache.values()].filter((s) => s.channelId === channelId).map((s) => s.id);
  const people = await Promise.all(ids.map((id) => memberInfo(g, id)));
  return people.filter((p) => !p.bot);
}

/**
 * Marca todo mundo da call no chat do canal de voz com o link do site.
 * Retorna quantas pessoas foram marcadas. Lança erro com mensagem amigável se não der.
 */
export async function pingCall(channelId, byName, link) {
  const g = guild();
  if (g === null) throw new Error('O bot do Discord não está conectado.');
  const since = Date.now() - (lastPing.get(channelId) ?? 0);
  if (since < PING_COOLDOWN_MS) {
    throw new Error(`A call foi avisada agora há pouco. Espere ${Math.ceil((PING_COOLDOWN_MS - since) / 1000)} s.`);
  }
  const channel = g.channels.cache.get(channelId);
  if (!channel?.isTextBased()) throw new Error('Não achei o chat deste canal de voz.');
  const people = (await membersOf(channelId)) ?? [];
  const mentions = people.map((p) => `<@${p.id}>`).join(' ');
  try {
    await channel.send({
      content: `${mentions}\n**${byName}** está na sala do Noveau desta call: ${link}`.trim(),
      allowedMentions: { users: people.map((p) => p.id).slice(0, 100) },
    });
  } catch (e) {
    console.error('[discord] não consegui mandar no chat da call:', e.message);
    throw new Error('O bot não pode escrever no chat dessa call. Dê a ele "Enviar mensagens" no canal.');
  }
  lastPing.set(channelId, Date.now());
  return people.length;
}

/** Canais para olhar: os que têm alguém dentro e os que estão com o status do bot. */
export function channelsToWatch() {
  const g = guild();
  if (g === null) return [];
  return [...new Set([...[...g.voiceStates.cache.values()].map((s) => s.channelId).filter(Boolean), ...mine.keys()])];
}

// ---------- status do canal de voz ("🔴 ao vivo no Noveau: Pedro")
// Só um status por canal. Antes de escrever, guarda o que alguém tinha posto à mão e devolve
// quando a transmissão acaba. Se alguém trocar o status no meio, o bot não mexe nele até a
// transmissão acabar.
const voiceStatus = new Map(); // canal -> status atual (pelo gateway)
const mine = new Map(); // canal -> { wrote: status que o bot escreveu, before: status de antes, yielded: alguém trocou }
const lastWrite = new Map();
let warnedPermission = false;
const MIN_WRITE_MS = 3000;

async function putStatus(channelId, status) {
  await client.rest.put(Routes.channelVoiceStatus(channelId), { body: { status } });
  voiceStatus.set(channelId, status);
  lastWrite.set(channelId, Date.now());
}

/**
 * Deixa o status do canal dizendo quem está ao vivo (lista vazia = devolve o status de antes).
 * Chamado de tempos em tempos; só fala com o Discord quando algo muda.
 */
export async function setLiveStatus(channelId, names) {
  if (guild() === null) return;
  const want = names.length === 0 ? null : liveText(names);
  const held = mine.get(channelId);
  const current = voiceStatus.get(channelId) ?? '';
  // Alguém mudou o status depois do bot: respeita até essa transmissão acabar.
  if (held !== undefined && !held.yielded && current !== held.wrote) {
    mine.set(channelId, { ...held, yielded: true });
    return;
  }
  if (held?.yielded) {
    if (want === null) mine.delete(channelId);
    return;
  }
  if (want === null) {
    if (held === undefined) return;
    mine.delete(channelId);
    try {
      await putStatus(channelId, held.before);
    } catch (e) {
      logStatusError(e);
    }
    return;
  }
  if (held?.wrote === want) return;
  if (Date.now() - (lastWrite.get(channelId) ?? 0) < MIN_WRITE_MS) return;
  try {
    await putStatus(channelId, want);
    mine.set(channelId, { wrote: want, before: held?.before ?? current });
  } catch (e) {
    // Sem permissão: tenta de novo só daqui a 1 min, para não insistir a cada volta.
    lastWrite.set(channelId, Date.now() + (e?.status === 403 ? 60_000 : 0));
    logStatusError(e);
  }
}

function liveText(names) {
  const list = names.slice(0, 6).join(', ') + (names.length > 6 ? ` e mais ${names.length - 6}` : '');
  return `🔴 ao vivo no Noveau: ${list}`.slice(0, 500);
}

function logStatusError(e) {
  if (e?.status === 403 || e?.code === 50013) {
    if (warnedPermission) return;
    warnedPermission = true;
    console.error(
      '[discord] o bot não pode mudar o status da call. Dê a ele "Definir status do canal de voz" e "Gerenciar canais" (veja o README).',
    );
    return;
  }
  console.error('[discord] status da call:', e?.message ?? e);
}

/** Manda uma mensagem privada (DM) do bot para alguém. */
export async function sendDm(userId, content) {
  if (guild() === null) throw new Error('O bot do Discord não está conectado.');
  try {
    const user = await client.users.fetch(userId);
    await user.send({ content, allowedMentions: { parse: [] } });
  } catch (e) {
    console.error('[discord] DM falhou:', e.message);
    throw new Error('Não consegui mandar mensagem privada para essa pessoa (ela pode ter DMs fechadas). Copie o link e mande você.');
  }
}
