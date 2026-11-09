// Bot do Discord ligado ao gateway: sabe em tempo real quem está em cada call do servidor.
//
// - Lista quem está numa call (a API REST do Discord não tem isso, só o gateway).
// - Quando alguém sai ou troca de call, tira essa pessoa da sala do site correspondente.
// - Marca todo mundo da call no chat do canal de voz com o link do site.
//
// Usa só a intent GUILD_VOICE_STATES (não privilegiada): nada para ligar no Developer Portal.

import { Client, GatewayIntentBits, Events } from 'discord.js';

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
