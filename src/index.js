require('dotenv').config();

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
  UserSelectMenuBuilder,
} = require('discord.js');
const discordTranscripts = require('discord-html-transcripts');
const { createHash } = require('crypto');
const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } = require('fs');
const path = require('path');

const requiredEnv = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`Variáveis ausentes: ${missingEnv.join(', ')}`);
  process.exit(1);
}

function positiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function textEnv(name, fallback, maxLength = 100) {
  const value = process.env[name]?.trim();
  return (value || fallback).slice(0, maxLength);
}

function booleanEnv(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'sim', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'nao', 'não', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function colorEnv(name, fallback) {
  const value = process.env[name]?.trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(value || '') ? Number.parseInt(value, 16) : fallback;
}

const BRAND = {
  botName: textEnv('BOT_NAME', 'Atendimento', 32),
  serverName: textEnv('SERVER_NAME', 'Minha Comunidade', 80),
  color: colorEnv('BRAND_COLOR', 0x5865f2),
  activity: textEnv('BOT_ACTIVITY', 'Atendimentos e suporte', 100),
  transcriptToUser: booleanEnv('SEND_TRANSCRIPT_TO_USER', true),
};

const SECURITY = Object.freeze({
  submitCooldownMs: positiveIntegerEnv('TICKET_SUBMIT_COOLDOWN_SECONDS', 60) * 1000,
  // Uma categoria aceita até 50 canais; acima disso o bot cria categorias extras (ATENDIMENTO 2, 3...).
  maxOpenTickets: Math.min(150, positiveIntegerEnv('MAX_OPEN_TICKETS', 75)),
  maxOpenTicketsPerUser: positiveIntegerEnv('MAX_OPEN_TICKETS_PER_USER', 1),
  maxSubmissionsPerMinute: positiveIntegerEnv('MAX_TICKET_SUBMISSIONS_PER_MINUTE', 10),
  maxTranscriptMessages: positiveIntegerEnv('MAX_TRANSCRIPT_MESSAGES', 1000),
  maxTranscriptImageBytes: positiveIntegerEnv('MAX_TRANSCRIPT_IMAGE_MB', 4) * 1024 * 1024,
  maxTranscriptMediaBytes: positiveIntegerEnv('MAX_TRANSCRIPT_MEDIA_MB', 5) * 1024 * 1024,
  transcriptMediaTimeoutMs: positiveIntegerEnv('TRANSCRIPT_MEDIA_TIMEOUT_SECONDS', 15) * 1000,
});

const TICKET_CLOSER_ROLE_IDS = new Set(
  (process.env.TICKET_CLOSER_ROLE_IDS || '')
    .split(/[\s,]+/)
    .map((roleId) => roleId.trim())
    .filter((roleId) => /^\d{17,20}$/.test(roleId)),
);

const TICKET_STAFF_ROLE_IDS = new Set([
  ...TICKET_CLOSER_ROLE_IDS,
  ...(process.env.TICKET_STAFF_ROLE_IDS || process.env.RESTRICTED_TICKET_ROLE_IDS || '')
    .split(/[\s,]+/)
    .map((roleId) => roleId.trim())
    .filter((roleId) => /^\d{17,20}$/.test(roleId)),
]);

const submissionCooldowns = new Map();
const submissionLocks = new Set();
const ticketClaimLocks = new Set();
const ticketAssignees = new Map();
const ticketRequestIds = new Map();
const closingTicketIds = new Set();

// Dados dos tickets (dono, tipo, registro e atendente) ficam em arquivo, não no tópico do canal.
const TICKET_DATA_DIR = path.join(__dirname, '..', 'data');
const TICKET_DATA_FILE = path.join(TICKET_DATA_DIR, 'tickets.json');
let ticketRecords = {};
try {
  if (existsSync(TICKET_DATA_FILE)) ticketRecords = JSON.parse(readFileSync(TICKET_DATA_FILE, 'utf8')) || {};
} catch (error) {
  console.error('[DADOS] Não foi possível ler data/tickets.json:', error);
}

function saveTicketRecords() {
  try {
    mkdirSync(TICKET_DATA_DIR, { recursive: true });
    const temporary = `${TICKET_DATA_FILE}.tmp`;
    writeFileSync(temporary, JSON.stringify(ticketRecords));
    renameSync(temporary, TICKET_DATA_FILE);
  } catch (error) {
    console.error('[DADOS] Não foi possível salvar data/tickets.json:', error);
  }
}

// Tickets criados antes da versão 1.4.0 guardavam os dados no tópico do canal.
function legacyTopicRecord(topic) {
  if (!topic?.startsWith('ticketOwner:')) return null;
  const read = (name, pattern) => topic.match(new RegExp(`${name}:(${pattern});`))?.[1] || null;
  return {
    ownerId: read('ticketOwner', '\\d+'),
    typeKey: read('type', '[^;]+'),
    requestId: read('request', '\\d+'),
    assigneeId: read('assignee', '\\d+'),
  };
}

function hasTicketRecord(channel) {
  return Boolean(channel && (ticketRecords[channel.id] || legacyTopicRecord(channel.topic)));
}

function ticketRecord(channel) {
  if (!channel) return null;
  if (ticketRecords[channel.id]) return ticketRecords[channel.id];
  const legacy = legacyTopicRecord(channel.topic);
  if (!legacy) return null;
  ticketRecords[channel.id] = legacy;
  saveTicketRecords();
  const label = TICKET_TYPES?.[legacy.typeKey]?.label;
  void channel.setTopic(label ? `Ticket de ${label}` : 'Ticket de atendimento', 'Limpeza do tópico do ticket').catch(() => {});
  return legacy;
}

function updateTicketRecord(channelId, patch) {
  ticketRecords[channelId] = { ...(ticketRecords[channelId] || {}), ...patch };
  saveTicketRecords();
}

function deleteTicketRecord(channelId) {
  if (!ticketRecords[channelId]) return;
  delete ticketRecords[channelId];
  saveTicketRecords();
}
const globalSubmissionTimestamps = [];
const recentAlertContexts = new Map();
const ticketStructureCache = new Map();
let pendingTicketCreations = 0;
let pendingTranscriptJobs = 0;
let transcriptQueue = Promise.resolve();
let alertChannelCache = null;
let maintenanceMode = false;
let maintenanceMessageId = null;
let configurationMessageId = null;
const LEGACY_MAINTENANCE_FOOTER = 'TICKET-SYSTEM-STATE:v1';
const LEGACY_CONFIGURATION_FOOTER = 'TICKET-CONFIGURATION:v1';
const CONFIGURATION_TITLE = 'Preferências do atendimento';
const MAINTENANCE_TITLE = 'Controle de abertura';
const TICKET_STAFF_ACCESS_FIELD = 'Equipe';
const LEGACY_RESTRICTED_TICKET_ACCESS_FIELDS = new Set([
  'Equipe de atendimento — todos os tickets',
  'Acesso restrito — Direção, Transferência e Denúncias',
  'Acesso restrito — Direção e Transferência',
]);
const LOTTIE_MARKER_HOST = 'https://ticket-transcript.invalid/lottie/';
const TRANSCRIPT_TIME_ZONE = (() => {
  const configured = process.env.TRANSCRIPT_TIME_ZONE?.trim() || 'America/Bahia';
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: configured }).format();
    return configured;
  } catch {
    console.warn(`[TRANSCRIPT] Fuso horário inválido: ${configured}. Usando America/Bahia.`);
    return 'America/Bahia';
  }
})();
let cachedLottiePlayerSource = null;

function claimCooldown(userId) {
  const now = Date.now();
  const expiresAt = submissionCooldowns.get(userId) || 0;
  if (expiresAt > now) return expiresAt - now;

  const nextExpiration = now + SECURITY.submitCooldownMs;
  submissionCooldowns.set(userId, nextExpiration);
  const cleanup = setTimeout(() => {
    if ((submissionCooldowns.get(userId) || 0) <= Date.now()) submissionCooldowns.delete(userId);
  }, SECURITY.submitCooldownMs + 1000);
  cleanup.unref?.();
  return 0;
}

function claimGlobalSubmissionSlot() {
  const now = Date.now();
  while (globalSubmissionTimestamps.length && globalSubmissionTimestamps[0] <= now - 60_000) {
    globalSubmissionTimestamps.shift();
  }
  if (globalSubmissionTimestamps.length >= SECURITY.maxSubmissionsPerMinute) {
    return Math.max(1, globalSubmissionTimestamps[0] + 60_000 - now);
  }
  globalSubmissionTimestamps.push(now);
  return 0;
}

function enqueueTranscript(channel, context) {
  pendingTranscriptJobs += 1;
  console.log(`[TRANSCRIPT] ${channel.id} entrou na fila (posição aproximada: ${pendingTranscriptJobs}).`);
  const job = transcriptQueue.then(() => createTranscript(channel, context));
  transcriptQueue = job.then(
    () => { pendingTranscriptJobs -= 1; },
    () => { pendingTranscriptJobs -= 1; },
  );
  return job;
}

function errorReference() {
  const time = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TKT-${time}-${random}`;
}

function logOperationalError(context, error) {
  const reference = errorReference();
  const interactionTimingError = context.startsWith('Interação ')
    && [10062, 40060].includes(Number(error?.code));
  if (interactionTimingError) {
    console.warn(`[${reference}] Interação expirada ou já respondida: ${context}`);
    return reference;
  }
  console.error(`[${reference}] ${context}:`, error);
  notifyErrorAlert(reference, context);
  return reference;
}

function privateMessageFailure(error) {
  if (Number(error?.code) === 50007) {
    return 'o Discord bloqueou a mensagem privada. A pessoa precisa permitir mensagens diretas deste servidor';
  }
  if (Number(error?.code) === 40005) {
    return 'o arquivo ultrapassou o limite de upload permitido pelo Discord';
  }
  if (Number(error?.code) === 50035) {
    return 'o Discord recusou os dados do envio';
  }
  return error?.code
    ? `o Discord recusou o envio (código ${error.code})`
    : 'não foi possível iniciar uma conversa privada com a pessoa';
}

function logPrivateDeliveryFailure(stage, error) {
  console.error(`[MENSAGEM_PRIVADA] Falha ao enviar ${stage}:`, {
    code: error?.code,
    status: error?.status,
    message: error?.message,
    details: error?.rawError?.errors,
  });
}

const FORUM_NAME = '📁・registros';
const LEGACY_FORUM_NAMES = ['📰・tickets'];
const TICKET_CATEGORY_NAME = 'ATENDIMENTO';
const LEGACY_CATEGORY_NAMES = ['TICKETS'];
const STAFF_ROLE_NAME = 'Atendimento';
const BOT_DISPLAY_ROLE_NAME = textEnv('BOT_ROLE_NAME', 'Orbyn', 32);
const PANEL_CHANNEL_NAME = '🎫・abrir-ticket';
const ALERT_CHANNEL_NAME = '🔔・alertas-tickets';
const LEGACY_ALERT_CHANNEL_TOPIC = 'ticket-system:alerts:v1';
const ALERT_CHANNEL_TOPIC = 'Configuração e estado do atendimento.';
const PANEL_CHANNEL_TOPIC = 'Abra um atendimento privado com a equipe.';
const POST_NAMES = {
  tickets: '📰・tickets',
  transcripts: '📰・transcripts',
  feedbacks: '📰・feedbacks',
  system: '📰・sistema',
};
const SYSTEM_POST_INTRO = '**Configuração e estado do sistema de tickets.** Não apague este post.';

const TICKET_MODELS = Object.freeze({
  community: {
    title: 'Central de atendimento',
    intro: 'Selecione um assunto abaixo. Um canal privado será criado para você e nossa equipe.',
    types: {
      suporte: { label: 'Suporte', emoji: '🛟', description: 'Dúvidas, ajuda e orientações sobre o servidor.' },
      denuncia: { label: 'Denúncia', emoji: '🚨', description: 'Relate uma situação que precise ser analisada pela equipe.' },
      parceria: { label: 'Parcerias', emoji: '🤝', description: 'Propostas de parceria e colaboração com a comunidade.' },
      outros: { label: 'Outros assuntos', emoji: '💬', description: 'Solicitações que não se encaixam nas demais opções.' },
    },
  },
  roleplay: {
    title: 'Atendimento do servidor',
    intro: 'Abra um atendimento privado para falar com a equipe sobre assuntos relacionados ao servidor e ao roleplay.',
    types: {
      suporte: { label: 'Suporte geral', emoji: '🛟', description: 'Dúvidas e dificuldades relacionadas ao servidor.' },
      denuncia: { label: 'Denúncia', emoji: '🚨', description: 'Denuncie condutas ou situações ocorridas no servidor.' },
      bug: { label: 'Problemas e bugs', emoji: '🧰', description: 'Relate falhas ou problemas técnicos encontrados.' },
      organizacao: { label: 'Organizações', emoji: '👥', description: 'Atendimento relacionado a facções, corporações ou grupos.' },
      outros: { label: 'Outros assuntos', emoji: '💬', description: 'Solicitações que não se encaixam nas demais opções.' },
    },
  },
  corporation: {
    title: 'Central administrativa',
    intro: 'Encaminhe sua solicitação à equipe responsável. O atendimento será organizado e mantido em um canal privado.',
    types: {
      duvidas: { label: 'Dúvidas', emoji: '❓', description: 'Solicite esclarecimentos administrativos ou operacionais.' },
      ausencia: { label: 'Justificativa de ausência', emoji: '📝', description: 'Apresente uma justificativa de falta ou ausência.' },
      demanda: { label: 'Demanda administrativa', emoji: '📌', description: 'Envie um pedido para análise da administração.' },
      comando: { label: 'Contato com o Comando', emoji: '🏛️', description: 'Encaminhe um assunto diretamente à liderança.' },
      denuncia: { label: 'Denúncia', emoji: '🚨', description: 'Relate uma situação que exija análise reservada.' },
    },
  },
  store: {
    title: 'Central de compras',
    intro: 'Dúvida, problema com pedido ou pagamento? Escolha o assunto e abrimos um canal privado com a equipe.',
    types: {
      compra: { label: 'Dúvida antes da compra', emoji: '🛒', description: 'Produto, estoque, prazo e garantia.' },
      pagamento: { label: 'Pagamento e Pix', emoji: '💠', description: 'Pix, valor ou confirmação do pagamento.' },
      entrega: { label: 'Entrega do pedido', emoji: '📦', description: 'Acompanhar um pedido pelo protocolo.' },
      reembolso: { label: 'Troca ou reembolso', emoji: '↩️', description: 'Pedir troca ou reembolso.' },
      suporte: { label: 'Problema com o produto', emoji: '🛟', description: 'Algo deu errado depois da entrega.' },
    },
  },
});

const configuredTicketModel = process.env.TICKET_MODEL?.trim().toLowerCase() || 'community';
let activeTicketModelKey = TICKET_MODELS[configuredTicketModel] ? configuredTicketModel : 'community';
let ACTIVE_TICKET_MODEL = TICKET_MODELS[activeTicketModelKey];
let TICKET_TYPES = ACTIVE_TICKET_MODEL.types;
if (!TICKET_MODELS[configuredTicketModel]) {
  console.warn(`[CONFIGURAÇÃO] TICKET_MODEL desconhecido: ${configuredTicketModel}. Usando community.`);
}

const adminPermission = PermissionFlagsBits.Administrator.toString();
const commands = [
  { name: 'instalar-tickets', description: 'Cria e configura automaticamente toda a estrutura de tickets.', default_member_permissions: adminPermission },
  { name: 'painel-tickets', description: 'Publica o painel e configura os registros dos atendimentos.', default_member_permissions: adminPermission },
  { name: 'configurar-tickets', description: 'Abre o painel de configuração visual e do modelo.', default_member_permissions: adminPermission },
  { name: 'fechar-ticket', description: 'Fecha o ticket atual.' },
  {
    name: 'adicionar', description: 'Adiciona uma pessoa ao ticket atual.', default_member_permissions: adminPermission,
    options: [{ name: 'usuario', description: 'Pessoa que terá acesso ao ticket.', type: 6, required: true }],
  },
  {
    name: 'remover', description: 'Remove uma pessoa do ticket atual.', default_member_permissions: adminPermission,
    options: [{ name: 'usuario', description: 'Pessoa que perderá o acesso ao ticket.', type: 6, required: true }],
  },
  {
    name: 'autorizar-cargo', description: 'Autoriza um cargo a acessar e atender tickets.', default_member_permissions: adminPermission,
    options: [{ name: 'cargo', description: 'Cargo que terá acesso aos tickets.', type: 8, required: true }],
  },
  {
    name: 'desautorizar-cargo', description: 'Remove o acesso de um cargo aos tickets.', default_member_permissions: adminPermission,
    options: [{ name: 'cargo', description: 'Cargo que perderá o acesso aos tickets.', type: 8, required: true }],
  },
  { name: 'cargos-tickets', description: 'Lista os cargos autorizados a acessar tickets.', default_member_permissions: adminPermission },
  {
    name: 'manutencao-tickets',
    description: 'Ativa ou desativa a abertura de novos tickets.',
    default_member_permissions: adminPermission,
    options: [{
      name: 'estado', description: 'Escolha o estado do sistema.', type: 3, required: true,
      choices: [{ name: 'Ativar manutenção', value: 'ativar' }, { name: 'Desativar manutenção', value: 'desativar' }],
    }],
  },
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

function legacyAlertChannel(guild) {
  return guild.channels.cache.find((item) => item.type === ChannelType.GuildText
    && (item.topic === ALERT_CHANNEL_TOPIC || item.topic === LEGACY_ALERT_CHANNEL_TOPIC
      || normalizedForumPostName(item.name) === normalizedForumPostName(ALERT_CHANNEL_NAME)));
}

// Configuração e alertas ficam no post "sistema" do fórum de registros (antes era um canal separado).
async function getAlertChannel() {
  if (alertChannelCache?.isTextBased() && alertChannelCache.isSendable()) return alertChannelCache;
  const channelId = process.env.ALERT_CHANNEL_ID?.trim();
  if (/^\d{17,20}$/.test(channelId || '')) {
    const configuredChannel = await client.channels.fetch(channelId).catch(() => null);
    if (configuredChannel?.isTextBased() && configuredChannel.isSendable()) {
      alertChannelCache = configuredChannel;
      return configuredChannel;
    }
    console.warn('[CONFIGURAÇÃO] ALERT_CHANNEL_ID não está acessível. Tentando localizar o post do sistema.');
  }

  const guild = client.guilds.cache.get(process.env.GUILD_ID)
    || await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
  if (!guild) return null;
  await guild.channels.fetch().catch(() => null);

  let found = null;
  let forum = null;
  try { forum = ticketForumFor(guild); } catch { forum = null; }
  if (forum) {
    const expected = normalizedForumPostName(POST_NAMES.system);
    const matches = (item) => normalizedForumPostName(item.name) === expected;
    const active = await forum.threads.fetchActive().catch(() => null);
    found = active?.threads.find(matches) || null;
    if (!found) {
      const archived = await forum.threads.fetchArchived({ limit: 100 }).catch(() => null);
      found = archived?.threads.find(matches) || null;
    }
  }
  found ||= legacyAlertChannel(guild);
  if (!found?.isSendable()) return null;
  process.env.ALERT_CHANNEL_ID = found.id;
  alertChannelCache = found;
  return found;
}

// Move configuração e alertas do canal antigo para o fórum e apaga o canal antigo.
async function migrateLegacyAlertChannel(guild) {
  await guild.channels.fetch().catch(() => null);
  const legacy = legacyAlertChannel(guild);
  if (!legacy) return false;
  let forum = null;
  try { forum = ticketForumFor(guild); } catch { forum = null; }
  if (!forum) return false;
  const thread = await ensureForumPost(forum, POST_NAMES.system, SYSTEM_POST_INTRO);
  alertChannelCache = thread;
  process.env.ALERT_CHANNEL_ID = thread.id;
  await persistRuntimeConfiguration();
  await persistMaintenanceState();
  await cleanInstallationMessages(thread);
  await legacy.delete('Canal de alertas substituído pelo post sistema do fórum');
  console.log('[MIGRAÇÃO] Canal de alertas removido. Configuração movida para o fórum de registros.');
  return true;
}

async function sendSystemAlert(title, description, color = 0x3b82f6) {
  const channel = await getAlertChannel();
  if (!channel) return false;
  const embed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)
    .setFooter({ text: internalFooter('Falha') }).setTimestamp();
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  return true;
}

function formattedBrandColor() {
  return `#${BRAND.color.toString(16).padStart(6, '0').toUpperCase()}`;
}

function ticketModelLabel(modelKey = activeTicketModelKey) {
  return ({
    community: 'Comunidade',
    roleplay: 'Roleplay',
    corporation: 'Corporação ou academia',
    store: 'Loja e atendimento ao cliente',
  })[modelKey] || 'Comunidade';
}

function applyTicketModel(modelKey) {
  activeTicketModelKey = TICKET_MODELS[modelKey] ? modelKey : 'community';
  ACTIVE_TICKET_MODEL = TICKET_MODELS[activeTicketModelKey];
  TICKET_TYPES = ACTIVE_TICKET_MODEL.types;
}

function configurationEmbed() {
  return new EmbedBuilder()
    .setColor(BRAND.color)
    .setTitle(CONFIGURATION_TITLE)
    .setDescription('Ajustes usados no painel e nas mensagens do atendimento.')
    .addFields(
      {
        name: 'Identidade',
        value: `**Nome:** ${BRAND.botName}\n**Marca:** ${BRAND.serverName}\n**Cor:** ${formattedBrandColor()}`,
        inline: true,
      },
      {
        name: 'Funcionamento',
        value: `**Modelo:** ${ticketModelLabel()}\n**Atividade:** ${BRAND.activity}`,
        inline: true,
      },
      {
        name: 'Transcript privado',
        value: BRAND.transcriptToUser ? 'Ativado' : 'Desativado',
        inline: true,
      },
    )
    .setFooter({ text: 'Use /configurar-tickets para alterar' });
}

function configurationComponents() {
  const modelSelector = new StringSelectMenuBuilder()
    .setCustomId('config:model')
    .setPlaceholder('Escolha o tipo de servidor')
    .addOptions(
      { label: 'Comunidade', value: 'community', emoji: '💬', description: 'Suporte, denúncias, parcerias e assuntos gerais.', default: activeTicketModelKey === 'community' },
      { label: 'Roleplay', value: 'roleplay', emoji: '🎮', description: 'Suporte, denúncias, bugs e organizações.', default: activeTicketModelKey === 'roleplay' },
      { label: 'Corporação ou academia', value: 'corporation', emoji: '🏛️', description: 'Dúvidas, ausências e demandas administrativas.', default: activeTicketModelKey === 'corporation' },
      { label: 'Loja', value: 'store', emoji: '🛒', description: 'Compras, pagamentos, entregas e reembolsos.', default: activeTicketModelKey === 'store' },
    );
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('config:identity').setLabel('Editar identidade').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('config:toggle-transcript')
      .setLabel(BRAND.transcriptToUser ? 'Desativar transcript privado' : 'Ativar transcript privado')
      .setEmoji('📄').setStyle(ButtonStyle.Secondary),
  );
  return [new ActionRowBuilder().addComponents(modelSelector), controls];
}

function configurationPanelPayload(content = null, includeEphemeral = true) {
  return {
    ...(content ? { content } : {}),
    embeds: [configurationEmbed()],
    components: configurationComponents(),
    ...(includeEphemeral ? { flags: MessageFlags.Ephemeral } : {}),
  };
}

function isConfigurationMessage(message) {
  const embed = message.embeds[0];
  return message.author.id === client.user.id
    && (embed?.title === CONFIGURATION_TITLE
      || embed?.title === 'Configuração'
      || embed?.title === 'Configuração do atendimento'
      || embed?.title === 'Ajustes do atendimento'
      || embed?.footer?.text === LEGACY_CONFIGURATION_FOOTER);
}

async function findConfigurationMessage(channel) {
  let pinned = null;
  if (typeof channel.messages.fetchPins === 'function') {
    const response = await channel.messages.fetchPins().catch(() => null);
    pinned = response?.items?.map((item) => item.message) || response;
  } else if (typeof channel.messages.fetchPinned === 'function') {
    pinned = await channel.messages.fetchPinned().catch(() => null);
  }
  const pinnedMessage = pinned?.find?.(isConfigurationMessage);
  if (pinnedMessage) return pinnedMessage;
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  return recent?.find(isConfigurationMessage) || null;
}

function configurationField(embed, name) {
  return embed?.fields?.find((field) => field.name === name)?.value;
}

function configurationDiscordId(embed, name) {
  return configurationField(embed, name)?.match(/\d{17,20}/)?.[0] || null;
}

function configurationDiscordIdFrom(embed, ...names) {
  return names.map((name) => configurationDiscordId(embed, name)).find(Boolean) || null;
}

function configurationLine(embed, fieldName, label) {
  const value = configurationField(embed, fieldName);
  if (!value) return null;
  const line = value.split('\n')
    .map((entry) => entry.replace(/\*\*/g, ''))
    .find((entry) => entry.startsWith(`${label}:`));
  return line?.slice(label.length + 1).trim() || null;
}

function configurationLineDiscordId(embed, fieldName, label) {
  return configurationLine(embed, fieldName, label)?.match(/\d{17,20}/)?.[0] || null;
}

async function loadRuntimeConfiguration() {
  const channel = await getAlertChannel();
  if (!channel) return false;
  const message = await findConfigurationMessage(channel);
  if (!message?.embeds[0]) {
    await persistRuntimeConfiguration();
    return false;
  }

  configurationMessageId = message.id;
  const embed = message.embeds[0];
  BRAND.botName = (configurationLine(embed, 'Identidade', 'Nome')
    || configurationField(embed, 'Nome exibido') || BRAND.botName).slice(0, 32);
  BRAND.serverName = (configurationLine(embed, 'Identidade', 'Marca')
    || configurationField(embed, 'Servidor ou marca') || BRAND.serverName).slice(0, 80);
  BRAND.activity = (configurationLine(embed, 'Funcionamento', 'Atividade')
    || configurationLine(embed, 'Atendimento', 'Atividade')
    || configurationField(embed, 'Atividade') || BRAND.activity).slice(0, 100);
  const storedColor = (configurationLine(embed, 'Identidade', 'Cor')
    || configurationField(embed, 'Cor'))?.replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(storedColor || '')) BRAND.color = Number.parseInt(storedColor, 16);
  const storedModelLabel = configurationLine(embed, 'Funcionamento', 'Modelo')
    || configurationLine(embed, 'Atendimento', 'Modelo')
    || configurationField(embed, 'Modelo');
  const storedModel = Object.keys(TICKET_MODELS).find((key) => ticketModelLabel(key) === storedModelLabel);
  if (storedModel) applyTicketModel(storedModel);
  const storedTranscript = configurationField(embed, 'Transcript')
    || configurationField(embed, 'Transcript privado');
  BRAND.transcriptToUser = storedTranscript
    ? ['Enviado ao usuário', 'Ativado'].includes(storedTranscript)
    : configurationField(embed, 'Transcript no privado') !== 'Desativado';
  const storedCategoryId = configurationLineDiscordId(embed, 'Canais', 'Categoria')
    || configurationDiscordIdFrom(embed, 'Categoria', 'Categoria de tickets');
  const storedForumId = configurationLineDiscordId(embed, 'Canais', 'Registros')
    || configurationDiscordIdFrom(embed, 'Registros', 'Fórum de registros');
  const storedAlertId = configurationLineDiscordId(embed, 'Canais', 'Avisos')
    || configurationDiscordIdFrom(embed, 'Avisos internos', 'Canal de alertas');
  const storedPanelId = configurationLineDiscordId(embed, 'Canais', 'Painel')
    || configurationDiscordIdFrom(embed, 'Painel', 'Canal do painel');
  const storedRoleId = configurationLineDiscordId(embed, 'Cargos', 'Equipe')
    || configurationDiscordIdFrom(embed, 'Equipe', 'Cargo padrão');
  const storedBotRoleId = configurationLineDiscordId(embed, 'Cargos', 'Bot')
    || configurationDiscordId(embed, 'Bot');
  if (storedCategoryId) process.env.TICKET_CATEGORY_ID = storedCategoryId;
  if (storedForumId) process.env.TICKETS_FORUM_ID = storedForumId;
  if (storedAlertId) process.env.ALERT_CHANNEL_ID = storedAlertId;
  if (storedPanelId) process.env.TICKET_PANEL_ID = storedPanelId;
  if (storedRoleId) {
    process.env.TICKET_DEFAULT_ROLE_ID = storedRoleId;
    TICKET_STAFF_ROLE_IDS.add(storedRoleId);
  }
  if (storedBotRoleId) process.env.TICKET_BOT_ROLE_ID = storedBotRoleId;
  return true;
}

async function persistRuntimeConfiguration() {
  const channel = await getAlertChannel();
  if (!channel) {
    const error = new Error('ALERT_CHANNEL_ID ausente ou inacessível.');
    error.userMessage = 'Execute `/instalar-tickets` antes de alterar o sistema de tickets.';
    throw error;
  }
  let message = configurationMessageId
    ? await channel.messages.fetch(configurationMessageId).catch(() => null)
    : await findConfigurationMessage(channel);
  if (message) await message.edit({ embeds: [configurationEmbed()] });
  else {
    message = await channel.send({ embeds: [configurationEmbed()] });
    await message.pin('Configuração persistente do sistema de tickets').catch(() => {});
  }
  configurationMessageId = message.id;
}

function identityConfigurationModal() {
  const fields = [
    new TextInputBuilder().setCustomId('bot_name').setLabel('Nome exibido nos painéis')
      .setStyle(TextInputStyle.Short).setValue(BRAND.botName).setMinLength(1).setMaxLength(32).setRequired(true),
    new TextInputBuilder().setCustomId('server_name').setLabel('Nome do servidor ou da marca')
      .setStyle(TextInputStyle.Short).setValue(BRAND.serverName).setMinLength(1).setMaxLength(80).setRequired(true),
    new TextInputBuilder().setCustomId('brand_color').setLabel('Cor hexadecimal — exemplo: #5865F2')
      .setStyle(TextInputStyle.Short).setValue(formattedBrandColor()).setMinLength(6).setMaxLength(7).setRequired(true),
    new TextInputBuilder().setCustomId('activity').setLabel('Atividade exibida no perfil do bot')
      .setStyle(TextInputStyle.Short).setValue(BRAND.activity).setMinLength(1).setMaxLength(100).setRequired(true),
  ];
  return new ModalBuilder().setCustomId('config:identity-form').setTitle('Identidade dos tickets')
    .addComponents(fields.map((field) => new ActionRowBuilder().addComponents(field)));
}

function updateBotPresence(user = client.user) {
  user?.setPresence({
    activities: [{ name: BRAND.activity, type: ActivityType.Watching }],
    status: 'online',
  });
}

function isAdministrator(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

async function showTicketConfiguration(interaction) {
  if (!isAdministrator(interaction)) {
    return interaction.reply({ content: 'Somente administradores podem alterar a configuração.', flags: MessageFlags.Ephemeral });
  }
  return interaction.reply(configurationPanelPayload());
}

async function updateTicketModel(interaction) {
  if (!isAdministrator(interaction)) {
    return interaction.reply({ content: 'Somente administradores podem alterar a configuração.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferUpdate();
  applyTicketModel(interaction.values[0]);
  await persistRuntimeConfiguration();
  return interaction.editReply(configurationPanelPayload(`Modelo alterado para **${ticketModelLabel()}**. Atualize o painel público com \`/painel-tickets\`.`, false));
}

async function togglePrivateTranscript(interaction) {
  if (!isAdministrator(interaction)) {
    return interaction.reply({ content: 'Somente administradores podem alterar a configuração.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferUpdate();
  BRAND.transcriptToUser = !BRAND.transcriptToUser;
  await persistRuntimeConfiguration();
  return interaction.editReply(configurationPanelPayload(`Transcript no privado **${BRAND.transcriptToUser ? 'ativado' : 'desativado'}**.`, false));
}

async function saveIdentityConfiguration(interaction) {
  if (!isAdministrator(interaction)) {
    return interaction.reply({ content: 'Somente administradores podem alterar a configuração.', flags: MessageFlags.Ephemeral });
  }
  const colorInput = interaction.fields.getTextInputValue('brand_color').trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(colorInput)) {
    return interaction.reply({ content: 'A cor precisa possuir seis caracteres hexadecimais, como `#5865F2`.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  BRAND.botName = interaction.fields.getTextInputValue('bot_name').trim().slice(0, 32);
  BRAND.serverName = interaction.fields.getTextInputValue('server_name').trim().slice(0, 80);
  BRAND.color = Number.parseInt(colorInput, 16);
  BRAND.activity = interaction.fields.getTextInputValue('activity').trim().slice(0, 100);
  await persistRuntimeConfiguration();
  updateBotPresence();
  return interaction.editReply(configurationPanelPayload('Identidade atualizada. Use `/painel-tickets` para atualizar o painel público.', false));
}

function notifyErrorAlert(reference, context) {
  const now = Date.now();
  if ((recentAlertContexts.get(context) || 0) > now - 60_000) return;
  recentAlertContexts.set(context, now);
  const cleanup = setTimeout(() => recentAlertContexts.delete(context), 61_000);
  cleanup.unref?.();
  void sendSystemAlert(
    'Falha registrada',
    `**Código:** \`${reference}\`\nOs detalhes estão no terminal.`,
    0xef4444,
  ).catch(() => {});
}

function maintenanceEmbed() {
  const staffRoles = [...TICKET_STAFF_ROLE_IDS].map((roleId) => `<@&${roleId}>`).join('\n')
    || 'Nenhum cargo definido.';
  return new EmbedBuilder().setColor(maintenanceMode ? 0xf59e0b : 0x22c55e)
    .setTitle(maintenanceMode ? 'Tickets pausados' : 'Tickets liberados')
    .setDescription(maintenanceMode
      ? 'O painel não aceitará novos tickets.'
      : 'Novos tickets podem ser abertos normalmente.')
    .addFields({ name: 'Equipe', value: staffRoles })
    .setFooter({ text: internalFooter('Atualizado automaticamente') }).setTimestamp();
}

function isMaintenanceMessage(message) {
  const embed = message.embeds[0];
  return message.author.id === client.user.id
    && (embed?.title === 'Tickets liberados'
      || embed?.title === 'Tickets pausados'
      || embed?.title === MAINTENANCE_TITLE
      || embed?.title === 'Status do atendimento'
      || embed?.title === 'Abertura de tickets'
      || embed?.footer?.text === LEGACY_MAINTENANCE_FOOTER);
}

async function findMaintenanceMessage(channel) {
  let pinned = null;
  if (typeof channel.messages.fetchPins === 'function') {
    const response = await channel.messages.fetchPins().catch(() => null);
    pinned = response?.items?.map((item) => item.message) || response;
  } else if (typeof channel.messages.fetchPinned === 'function') {
    pinned = await channel.messages.fetchPinned().catch(() => null);
  }
  const pinnedMessage = pinned?.find?.(isMaintenanceMessage);
  if (pinnedMessage) return pinnedMessage;
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  return recent?.find(isMaintenanceMessage) || null;
}

async function loadMaintenanceState() {
  const channel = await getAlertChannel();
  if (!channel) return false;
  const message = await findMaintenanceMessage(channel);
  if (!message) return false;
  maintenanceMessageId = message.id;
  const embed = message.embeds[0];
  const statusField = message.embeds[0]?.fields?.find((field) => (
    field.name === 'Situação' || field.name === 'Status' || field.name === 'Manutenção'
  ));
  const wasMaintenanceEnabled = embed?.title === 'Tickets pausados'
    || statusField?.value?.includes('Pausada')
    || statusField?.value?.includes('Pausado')
    || statusField?.value?.includes('ATIVADA')
    || false;
  maintenanceMode = wasMaintenanceEnabled;
  const staffField = message.embeds[0]?.fields?.find((field) => (
    field.name === 'Equipe responsável'
    || field.name === TICKET_STAFF_ACCESS_FIELD
    || LEGACY_RESTRICTED_TICKET_ACCESS_FIELDS.has(field.name)
  ));
  if (staffField) {
    for (const match of staffField.value.matchAll(/<@&(\d{17,20})>/g)) {
      TICKET_STAFF_ROLE_IDS.add(match[1]);
    }
  }
  return wasMaintenanceEnabled;
}

async function persistMaintenanceState() {
  const channel = await getAlertChannel();
  if (!channel) {
    const error = new Error('ALERT_CHANNEL_ID ausente ou inacessível.');
    error.userMessage = '❌ Execute `/instalar-tickets` antes de alterar configurações persistentes dos tickets.';
    throw error;
  }
  let message = maintenanceMessageId
    ? await channel.messages.fetch(maintenanceMessageId).catch(() => null)
    : await findMaintenanceMessage(channel);
  if (message) await message.edit({ embeds: [maintenanceEmbed()] });
  else {
    message = await channel.send({ embeds: [maintenanceEmbed()] });
    await message.pin('Estado persistente da manutenção do bot de Tickets').catch(() => {});
  }
  maintenanceMessageId = message.id;
}

async function cleanInstallationMessages(channel) {
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return;

  const obsolete = recent.filter((message) => {
    if (message.author.id !== client.user.id) return false;
    const title = message.embeds[0]?.title;
    if (isConfigurationMessage(message)) return message.id !== configurationMessageId;
    if (isMaintenanceMessage(message)) return message.id !== maintenanceMessageId;
    return title === 'Falha importante — Tickets'
      || title === 'Não consegui concluir uma ação'
      || title === 'Erro no atendimento'
      || title === 'Atendimento pausado'
      || title === 'Atendimento liberado'
      || title === '🟢 Bot de Tickets iniciado';
  });

  await Promise.allSettled(
    obsolete.map((message) => message.delete().catch(() => null)),
  );
}

async function setTicketMaintenance(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: '❌ Somente administradores podem controlar a manutenção.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const previousState = maintenanceMode;
  maintenanceMode = interaction.options.getString('estado', true) === 'ativar';
  try {
    await persistMaintenanceState();
  } catch (error) {
    maintenanceMode = previousState;
    throw error;
  }
  return interaction.editReply(maintenanceMode
    ? '✅ Manutenção ativada. Novas solicitações de ticket foram bloqueadas.'
    : '✅ Manutenção desativada. Novas solicitações de ticket foram liberadas.');
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
}

function authorizedTicketRoles(guild, channel) {
  return channel.permissionOverwrites.cache
    .filter((overwrite) => guild.roles.cache.has(overwrite.id)
      && overwrite.id !== guild.roles.everyone.id
      && overwrite.allow.has(PermissionFlagsBits.ViewChannel))
    .map((overwrite) => guild.roles.cache.get(overwrite.id))
    .filter(Boolean);
}

function ticketStaffRoles(guild, forumChannel) {
  const roles = new Map(authorizedTicketRoles(guild, forumChannel).map((role) => [role.id, role]));
  for (const roleId of TICKET_STAFF_ROLE_IDS) {
    const role = guild.roles.cache.get(roleId);
    if (role && role.id !== guild.roles.everyone.id && !role.managed) roles.set(role.id, role);
  }
  return [...roles.values()];
}

async function syncUnifiedTicketAccess(guild, forumChannel) {
  const roles = ticketStaffRoles(guild, forumChannel);
  const openTickets = guild.channels.cache.filter(isTicketChannel);
  await Promise.all([
    ...roles.map((role) => forumChannel.permissionOverwrites.edit(role.id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessagesInThreads: true,
    })),
    ...[...openTickets.values()].flatMap((channel) => roles.map((role) => channel.permissionOverwrites.edit(role.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    }))),
  ]);
  return roles;
}

function cachedTicketStructure(guild, kind) {
  const cached = ticketStructureCache.get(guild.id)?.[kind];
  if (!cached) return null;
  const hasCoreChannels = guild.channels.cache.has(cached.category?.id)
    && guild.channels.cache.has(cached.forumChannel?.id);
  const hasActivePosts = cached.ticketsThread && !cached.ticketsThread.archived
    && cached.transcriptsThread && !cached.transcriptsThread.archived
    && cached.feedbacksThread && !cached.feedbacksThread.archived;
  if (hasCoreChannels && hasActivePosts) return cached;
  const structures = ticketStructureCache.get(guild.id);
  if (structures) structures[kind] = null;
  return null;
}

function cacheTicketStructure(guild, kind, structure) {
  const structures = ticketStructureCache.get(guild.id) || {};
  structures[kind] = structure;
  ticketStructureCache.set(guild.id, structures);
  return structure;
}

function ticketForumFor(guild) {
  const configuredId = process.env.TICKETS_FORUM_ID?.trim();
  if (/^\d{17,20}$/.test(configuredId || '')) {
    const configuredForum = guild.channels.cache.get(configuredId);
    if (configuredForum?.type === ChannelType.GuildForum) return configuredForum;
    console.warn('[CONFIGURAÇÃO] TICKETS_FORUM_ID inválido ou inacessível. Tentando localizar o Fórum instalado.');
  }

  const acceptedNames = [FORUM_NAME, ...LEGACY_FORUM_NAMES].map(normalizedForumPostName);
  const forums = guild.channels.cache.filter((channel) => channel.type === ChannelType.GuildForum
    && acceptedNames.includes(normalizedForumPostName(channel.name)));
  if (forums.size > 1) {
    const error = new Error('Há mais de um Fórum com o mesmo nome.');
    error.userMessage = '❌ Existem dois Fóruns de registros. Exclua a cópia que não será usada e execute `/instalar-tickets` novamente.';
    throw error;
  }
  return forums.first();
}

function ticketCategoryFor(guild) {
  const configuredId = process.env.TICKET_CATEGORY_ID?.trim();
  if (/^\d{17,20}$/.test(configuredId || '')) {
    const configuredCategory = guild.channels.cache.get(configuredId);
    if (configuredCategory?.type === ChannelType.GuildCategory) return configuredCategory;
    console.warn('[CONFIGURAÇÃO] TICKET_CATEGORY_ID inválido ou inacessível. Tentando localizar a categoria instalada.');
  }

  const acceptedNames = [TICKET_CATEGORY_NAME, ...LEGACY_CATEGORY_NAMES].map(normalizedForumPostName);
  const categories = guild.channels.cache.filter(
    (channel) => channel.type === ChannelType.GuildCategory
      && acceptedNames.includes(normalizedForumPostName(channel.name)),
  );
  if (categories.size > 1) {
    const error = new Error('Há mais de uma categoria chamada TICKETS.');
    error.userMessage = '❌ Existem duas categorias de atendimento. Exclua a cópia que não será usada e execute `/instalar-tickets` novamente.';
    throw error;
  }
  return categories.first();
}

function installedTextChannel(guild, name, topic) {
  return guild.channels.cache.find((channel) => channel.type === ChannelType.GuildText
    && (channel.topic === topic
      || normalizedForumPostName(channel.name) === normalizedForumPostName(name)));
}

function installationPermissionError(guild) {
  const botMember = guild.members.me;
  const required = [
    [PermissionFlagsBits.ManageChannels, 'Gerenciar canais'],
    [PermissionFlagsBits.ManageRoles, 'Gerenciar cargos'],
  ];
  const missing = required.filter(([permission]) => !botMember?.permissions.has(permission));
  if (!missing.length) return null;
  const error = new Error(`Permissões ausentes: ${missing.map(([, label]) => label).join(', ')}`);
  error.userMessage = `❌ Antes de instalar, libere para o bot: **${missing.map(([, label]) => label).join('** e **')}**.`;
  return error;
}

async function installTicketSystem(interaction) {
  if (!isAdministrator(interaction)) {
    return interaction.reply({ content: '❌ Somente administradores podem instalar o sistema de tickets.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  await Promise.all([guild.channels.fetch(), guild.roles.fetch(), guild.members.fetchMe()]);

  if (!guild.features.includes('COMMUNITY')) {
    return interaction.editReply([
      '⚠️ **Falta apenas ativar a Comunidade no servidor.**',
      'Abra **Configurações do servidor → Ativar comunidade**, conclua as etapas do Discord e execute `/instalar-tickets` novamente.',
      'O Discord exige a Comunidade ativa para permitir a criação do Fórum de registros.',
    ].join('\n'));
  }

  const permissionError = installationPermissionError(guild);
  if (permissionError) throw permissionError;

  const botMember = guild.members.me;
  const created = [];
  const reused = [];

  const configuredBotRoleId = process.env.TICKET_BOT_ROLE_ID?.trim();
  let botDisplayRole = /^\d{17,20}$/.test(configuredBotRoleId || '')
    ? guild.roles.cache.get(configuredBotRoleId)
    : null;
  if (!botDisplayRole || botDisplayRole.managed) {
    botDisplayRole = guild.roles.cache.find((role) => !role.managed && role.name === BOT_DISPLAY_ROLE_NAME);
  }
  if (!botDisplayRole) {
    botDisplayRole = await guild.roles.create({
      name: BOT_DISPLAY_ROLE_NAME,
      color: BRAND.color,
      hoist: true,
      mentionable: false,
      reason: 'Identificação visual do bot de tickets',
    });
    created.push(`cargo visual ${botDisplayRole}`);
  } else {
    if (botDisplayRole.position >= botMember.roles.highest.position) {
      const error = new Error('O cargo visual do bot está acima do cargo gerenciado da aplicação.');
      error.userMessage = `❌ Mova o cargo **${BOT_DISPLAY_ROLE_NAME}** para baixo do cargo do bot e execute \`/instalar-tickets\` novamente.`;
      throw error;
    }
    await botDisplayRole.edit({
      color: BRAND.color,
      hoist: true,
      mentionable: false,
      reason: 'Atualização da identificação visual do bot de tickets',
    });
    reused.push(`cargo visual ${botDisplayRole}`);
  }
  if (!botMember.roles.cache.has(botDisplayRole.id)) {
    await botMember.roles.add(botDisplayRole, 'Identificação visual do bot de tickets');
  }

  const configuredStaffRoleId = process.env.TICKET_DEFAULT_ROLE_ID?.trim();
  let staffRole = /^\d{17,20}$/.test(configuredStaffRoleId || '')
    ? guild.roles.cache.get(configuredStaffRoleId)
    : null;
  if (!staffRole || staffRole.managed) {
    staffRole = guild.roles.cache.find((role) => !role.managed && role.name === STAFF_ROLE_NAME);
  }
  if (!staffRole) {
    staffRole = await guild.roles.create({
      name: STAFF_ROLE_NAME,
      color: BRAND.color,
      mentionable: false,
      reason: 'Instalação automática do sistema de tickets',
    });
    created.push(`cargo ${staffRole}`);
  } else {
    if (staffRole.position >= botMember.roles.highest.position) {
      const error = new Error('O cargo Atendimento está acima do cargo do bot.');
      error.userMessage = `❌ Mova o cargo do bot para cima de ${staffRole} na lista de cargos e execute \`/instalar-tickets\` novamente.`;
      throw error;
    }
    reused.push(`cargo ${staffRole}`);
  }

  const privateCategoryOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: staffRole.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
    },
    {
      id: botMember.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages],
    },
  ];

  let category = ticketCategoryFor(guild);
  if (!category) {
    category = await guild.channels.create({
      name: TICKET_CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      permissionOverwrites: privateCategoryOverwrites,
      reason: 'Instalação automática do sistema de tickets',
    });
    created.push(`categoria **${TICKET_CATEGORY_NAME}**`);
  } else reused.push(`categoria **${TICKET_CATEGORY_NAME}**`);

  if (category.name !== TICKET_CATEGORY_NAME) {
    await category.setName(TICKET_CATEGORY_NAME, 'Padronização da área de atendimento');
  }

  await Promise.all(privateCategoryOverwrites.map((overwrite) => (
    category.permissionOverwrites.edit(overwrite.id, {
      ViewChannel: overwrite.id === guild.roles.everyone.id ? false : true,
      ...(overwrite.id !== guild.roles.everyone.id ? {
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
      } : {}),
      ...(overwrite.id === botMember.id ? {
        EmbedLinks: true,
        ManageChannels: true,
        ManageMessages: true,
      } : {}),
    })
  )));

  let forumChannel = ticketForumFor(guild);
  if (!forumChannel) {
    forumChannel = await guild.channels.create({
      name: FORUM_NAME,
      type: ChannelType.GuildForum,
      parent: category.id,
      topic: 'Registros, transcripts e avaliações do sistema de tickets.',
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: staffRole.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.AttachFiles],
        },
        {
          id: botMember.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads,
            PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.ManageThreads,
            PermissionFlagsBits.ManageMessages, PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks],
        },
      ],
      reason: 'Fórum privado de registros do sistema de tickets',
    });
    created.push(`${forumChannel}`);
  } else reused.push(`${forumChannel}`);

  if (forumChannel.name !== FORUM_NAME) {
    await forumChannel.setName(FORUM_NAME, 'Padronização da área de atendimento');
  }

  await Promise.all([
    forumChannel.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: false }),
    forumChannel.permissionOverwrites.edit(staffRole.id, {
      ViewChannel: true, ReadMessageHistory: true, SendMessagesInThreads: true, AttachFiles: true,
    }),
    forumChannel.permissionOverwrites.edit(botMember.id, {
      ViewChannel: true, ReadMessageHistory: true, SendMessages: true,
      SendMessagesInThreads: true, CreatePublicThreads: true, ManageThreads: true,
      ManageMessages: true, AttachFiles: true, EmbedLinks: true,
    }),
  ]);

  const configuredPanelId = process.env.TICKET_PANEL_ID?.trim();
  let panelChannel = /^\d{17,20}$/.test(configuredPanelId || '')
    ? guild.channels.cache.get(configuredPanelId)
    : null;
  if (panelChannel?.type !== ChannelType.GuildText) panelChannel = null;
  if (!panelChannel) panelChannel = installedTextChannel(guild, PANEL_CHANNEL_NAME, PANEL_CHANNEL_TOPIC);
  if (!panelChannel) {
    panelChannel = await guild.channels.create({
      name: PANEL_CHANNEL_NAME,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: PANEL_CHANNEL_TOPIC,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.SendMessagesInThreads],
        },
        {
          id: botMember.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels],
        },
      ],
      reason: 'Canal público do painel de abertura de tickets',
    });
    created.push(`${panelChannel}`);
  } else reused.push(`${panelChannel}`);

  await Promise.all([
    panelChannel.permissionOverwrites.edit(guild.roles.everyone.id, {
      ViewChannel: true, ReadMessageHistory: true, SendMessages: false,
      CreatePublicThreads: false, SendMessagesInThreads: false,
    }),
    panelChannel.permissionOverwrites.edit(botMember.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
      EmbedLinks: true, ManageMessages: true, ManageChannels: true,
    }),
  ]);

  await category.setPosition(0, { reason: 'Destacar a área de atendimento' });
  await panelChannel.edit({
    name: PANEL_CHANNEL_NAME,
    parent: category.id,
    lockPermissions: false,
    topic: PANEL_CHANNEL_TOPIC,
    reason: 'Organização da área de atendimento',
  });
  await forumChannel.edit({
    name: FORUM_NAME,
    parent: category.id,
    lockPermissions: false,
    topic: 'Histórico dos atendimentos, conversas encerradas e avaliações.',
    reason: 'Organização da área de atendimento',
  });
  await panelChannel.setPosition(0, { reason: 'Organização do sistema de tickets' });
  await forumChannel.setPosition(1, { reason: 'Organização do sistema de tickets' });

  process.env.TICKET_CATEGORY_ID = category.id;
  process.env.TICKETS_FORUM_ID = forumChannel.id;
  const systemThread = await ensureForumPost(forumChannel, POST_NAMES.system, SYSTEM_POST_INTRO);
  process.env.ALERT_CHANNEL_ID = systemThread.id;
  process.env.TICKET_PANEL_ID = panelChannel.id;
  process.env.TICKET_DEFAULT_ROLE_ID = staffRole.id;
  process.env.TICKET_BOT_ROLE_ID = botDisplayRole.id;
  alertChannelCache = systemThread;
  ticketStructureCache.delete(guild.id);
  TICKET_STAFF_ROLE_IDS.add(staffRole.id);

  await ensureStructure(guild);
  await persistRuntimeConfiguration();
  await persistMaintenanceState();
  await cleanInstallationMessages(systemThread);
  const legacyAlerts = legacyAlertChannel(guild);
  if (legacyAlerts) await legacyAlerts.delete('Canal de alertas substituído pelo post sistema do fórum').catch(() => {});
  await publishTicketPanel(panelChannel);

  const summary = new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle('Atendimento pronto')
    .setDescription(`A área foi organizada na categoria **${TICKET_CATEGORY_NAME}** e o painel já pode ser usado.`)
    .addFields(
      { name: 'Abrir um ticket', value: `${panelChannel}`, inline: true },
      { name: 'Equipe', value: `${staffRole}`, inline: true },
      { name: 'Registros', value: `${forumChannel}`, inline: true },
      {
        name: 'Para finalizar',
        value: `Entregue ${staffRole} aos atendentes e use \`/configurar-tickets\` para ajustar o visual.`,
      },
    )
    .setFooter({ text: `${BRAND.botName} • Instalação concluída` })
    .setTimestamp();
  return interaction.editReply({ embeds: [summary] });
}

async function structureForTicketType(guild, typeKey, baseStructure = null) {
  return baseStructure || ensureStructure(guild);
}

function normalizedForumPostName(value) {
  return value.normalize('NFKC').toLocaleLowerCase('pt-BR').replace(/[^\p{L}\p{N}]/gu, '');
}

async function ensureForumPost(forum, name, introduction) {
  const expectedName = normalizedForumPostName(name);
  const active = await forum.threads.fetchActive();
  let thread = active.threads.find(
    (item) => normalizedForumPostName(item.name) === expectedName,
  );
  if (!thread) {
    const archived = await forum.threads.fetchArchived({ limit: 100 });
    thread = archived.threads.find(
      (item) => normalizedForumPostName(item.name) === expectedName,
    );
  }
  if (thread) {
    if (thread.archived) await thread.setArchived(false, 'Reativação da postagem operacional');
    return thread;
  }
  return forum.threads.create({
    name,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    message: { content: introduction },
    reason: `Estrutura do sistema de tickets de ${BRAND.serverName}`,
  });
}

async function ensureStructure(guild) {
  const cached = cachedTicketStructure(guild, 'normal');
  if (cached) return cached;
  await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
  const forumChannel = ticketForumFor(guild);
  if (!forumChannel) {
    const error = new Error('O Fórum de tickets não foi encontrado.');
    error.userMessage = '❌ O Fórum de registros não foi encontrado. Execute `/instalar-tickets`.';
    throw error;
  }

  const category = ticketCategoryFor(guild);
  if (!category) {
    const error = new Error('A categoria de canais de tickets não foi encontrada.');
    error.userMessage = '❌ A estrutura ainda não foi instalada. Execute `/instalar-tickets`.';
    throw error;
  }

  const ticketsThread = await ensureForumPost(
    forumChannel, POST_NAMES.tickets,
    '**Registro dos atendimentos abertos e encerrados.**',
  );
  const transcriptsThread = await ensureForumPost(
    forumChannel, POST_NAMES.transcripts,
    '**Arquivo de transcripts dos atendimentos encerrados.**',
  );
  const feedbacksThread = await ensureForumPost(
    forumChannel, POST_NAMES.feedbacks,
    '**Avaliações e observações enviadas pelos solicitantes.**',
  );
  const structure = cacheTicketStructure(guild, 'normal', {
    category, forumChannel, ticketsThread, transcriptsThread, feedbacksThread,
  });
  await syncUnifiedTicketAccess(guild, forumChannel);
  return structure;
}

async function warmTicketStructureCache(guild) {
  await ensureStructure(guild);
}

function ticketMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ticket:select')
      .setPlaceholder('Selecione um assunto para começar')
      .addOptions(Object.entries(TICKET_TYPES).filter(([, type]) => !type.hidden).map(([key, type]) => ({
        label: type.label, value: key, emoji: type.emoji, description: type.description,
      }))),
  );
}

function ticketForm(typeKey) {
  const details = new TextInputBuilder()
    .setCustomId('detalhes').setLabel('Descreva sua solicitação')
    .setPlaceholder('Informe todos os detalhes necessários para que possamos ajudar.')
    .setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true);
  return new ModalBuilder()
    .setCustomId(`ticket:form:${typeKey}`).setTitle(TICKET_TYPES[typeKey].label)
    .addComponents(new ActionRowBuilder().addComponents(details));
}

function ticketButtons(assigneeId = null) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:claim')
      .setLabel(assigneeId ? 'Ticket assumido' : 'Assumir ticket')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(Boolean(assigneeId)),
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Fechar ticket')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ticket:manage').setLabel('Gerenciar ticket')
      .setStyle(ButtonStyle.Secondary),
  );
}

function ticketManagementSelector(channelId) {
  const selector = new StringSelectMenuBuilder()
    .setCustomId(`ticket:manage_action:${channelId}`)
    .setPlaceholder('Escolha uma ação')
    .addOptions(
      { label: 'Adicionar pessoa', value: 'add', emoji: '➕', description: 'Libera o acesso de uma pessoa ao ticket.' },
      { label: 'Remover pessoa', value: 'remove', emoji: '➖', description: 'Remove um acesso individual do ticket.' },
      { label: 'Renomear ticket', value: 'rename', emoji: '✏️', description: 'Altera o nome deste canal.' },
    );
  return {
    content: 'O que você quer fazer neste ticket?',
    components: [new ActionRowBuilder().addComponents(selector)],
    flags: MessageFlags.Ephemeral,
  };
}

function ticketParticipantSelector(channelId, action) {
  const isAddition = action === 'add';
  const selector = new UserSelectMenuBuilder()
    .setCustomId(`ticket:manage_member:${action}:${channelId}`)
    .setPlaceholder(isAddition ? 'Selecione a pessoa que receberá acesso' : 'Selecione a pessoa cujo acesso será removido')
    .setMinValues(1)
    .setMaxValues(1);
  return {
    content: isAddition
      ? 'Selecione a pessoa que terá acesso a este ticket.'
      : 'Selecione a pessoa cujo acesso individual será removido.',
    components: [new ActionRowBuilder().addComponents(selector)],
  };
}

function renameTicketForm(channelId, currentName) {
  const name = new TextInputBuilder()
    .setCustomId('name')
    .setLabel('Novo nome do ticket')
    .setPlaceholder('Exemplo: suporte-pedido-pagamento')
    .setStyle(TextInputStyle.Short)
    .setValue(currentName.slice(0, 100))
    .setMinLength(1)
    .setMaxLength(100)
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(`ticket:rename_modal:${channelId}`)
    .setTitle('Renomear ticket')
    .addComponents(new ActionRowBuilder().addComponents(name));
}

function cleanReason(raw) {
  const text = String(raw || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, 300);
  return text.replace(/^[^\p{L}\p{N}]+$/u, '') || 'Não informado';
}

function closeForm(channelId) {
  const reason = new TextInputBuilder()
    .setCustomId('motivo').setLabel('Motivo (opcional)')
    .setPlaceholder('Ex.: problema resolvido')
    .setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false);
  return new ModalBuilder().setCustomId(`ticket:close-form:${channelId}`)
    .setTitle('Fechar ticket').addComponents(new ActionRowBuilder().addComponents(reason));
}

function feedbackButtons(channelId, typeKey, ownerId) {
  const row = new ActionRowBuilder();
  for (let score = 1; score <= 5; score += 1) {
    let style = ButtonStyle.Secondary;
    if (score <= 2) style = ButtonStyle.Danger;
    else if (score >= 4) style = ButtonStyle.Success;
    row.addComponents(
      new ButtonBuilder().setCustomId(`feedback:score:${channelId}:${typeKey}:${ownerId}:${score}`)
        .setLabel(`${score} ⭐`).setStyle(style),
    );
  }
  return [row];
}

function feedbackForm(channelId, typeKey, ownerId, score) {
  const observation = new TextInputBuilder()
    .setCustomId('observacao').setLabel('Observação sobre o atendimento')
    .setPlaceholder('Conte como foi sua experiência com o atendimento')
    .setStyle(TextInputStyle.Paragraph).setMinLength(1).setMaxLength(1000).setRequired(true);
  return new ModalBuilder()
    .setCustomId(`feedback:form:${channelId}:${typeKey}:${ownerId}:${score}`)
    .setTitle(`Avaliação do atendimento — ${score}/5`)
    .addComponents(new ActionRowBuilder().addComponents(observation));
}

const STORE_PANEL_BANNER_NAME = 'banner-orbyn-tickets-v1.jpg';
const STORE_PANEL_BANNER_PATH = path.join(__dirname, '..', 'assets', STORE_PANEL_BANNER_NAME);

function ticketPanel({ includeBanner = false } = {}) {
  const storeModel = activeTicketModelKey === 'store';
  const embed = new EmbedBuilder()
    .setColor(BRAND.color)
    .setTitle(`🎫 ${ACTIVE_TICKET_MODEL.title}`)
    .setDescription(`${ACTIVE_TICKET_MODEL.intro}\n\nSó você e a equipe veem o canal.`);
  if (storeModel) {
    embed.addFields(
      { name: 'Já comprou?', value: 'Deixe o protocolo do pedido à mão (ex.: `ORB-000001`). Fica bem mais rápido de achar.' },
      { name: 'Atenção', value: 'A equipe nunca pede senha, código de verificação ou dados do cartão.' },
    );
    if (existsSync(STORE_PANEL_BANNER_PATH)) embed.setImage(`attachment://${STORE_PANEL_BANNER_NAME}`);
  } else {
    embed.addFields({
      name: 'Antes de abrir',
      value: 'Explique o caso com o máximo de detalhes e mantenha um assunto por ticket.',
    });
  }
  const payload = { embeds: [embed], components: [ticketMenu()] };
  if (storeModel && includeBanner && existsSync(STORE_PANEL_BANNER_PATH)) {
    payload.files = [new AttachmentBuilder(STORE_PANEL_BANNER_PATH).setName(STORE_PANEL_BANNER_NAME)];
  }
  return payload;
}

async function publishTicketPanel(channel) {
  if (!channel?.isTextBased() || !channel.isSendable()) {
    const error = new Error('O canal do painel não aceita mensagens.');
    error.userMessage = '❌ Não foi possível publicar o painel no canal escolhido.';
    throw error;
  }
  const botMember = channel.guild.members.me || await channel.guild.members.fetchMe();
  if (botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await channel.permissionOverwrites.edit(botMember.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      EmbedLinks: true,
      AttachFiles: true,
      ManageMessages: true,
      ManageChannels: true,
    }, { reason: 'Restaurar acesso do Orbyn Tickets ao painel' });
  }
  const recentMessages = await channel.messages.fetch({ limit: 50 });
  const existingPanel = recentMessages.find((message) => message.author.id === client.user.id
    && message.components.some((row) => row.components.some((component) => component.customId === 'ticket:select')));
  if (existingPanel) {
    const storeModel = activeTicketModelKey === 'store';
    const hasBanner = existingPanel.attachments.some((attachment) => attachment.name === STORE_PANEL_BANNER_NAME);
    const payload = ticketPanel({ includeBanner: storeModel && !hasBanner });
    if (!storeModel && hasBanner) payload.attachments = [];
    await existingPanel.edit(payload);
    return { message: existingPanel, created: false };
  }
  const message = await channel.send(ticketPanel({ includeBanner: activeTicketModelKey === 'store' }));
  return { message, created: true };
}

function isTicketChannel(channel) {
  return channel?.type === ChannelType.GuildText && hasTicketRecord(channel);
}

function safeChannelName(name) {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'usuario';
}

function ticketProtocol(channelId) {
  return `TKT-${String(channelId).slice(-8).toUpperCase()}`;
}

function internalFooter(section) {
  return `${client.user?.username || BRAND.botName} • ${section}`;
}

function ticketMetadata(channel) {
  const record = ticketRecord(channel) || {};
  return {
    ownerId: record.ownerId || undefined,
    typeKey: record.typeKey || undefined,
    requestId: record.requestId || ticketRequestIds.get(channel.id),
    assigneeId: record.assigneeId || ticketAssignees.get(channel.id),
  };
}

function transcriptAttachment(attachment, url = attachment.url) {
  return {
    id: attachment.id,
    name: attachment.name,
    description: attachment.description || null,
    url,
    proxyURL: url,
    contentType: attachment.contentType || null,
    size: attachment.size || 0,
    width: attachment.width || null,
    height: attachment.height || null,
    ephemeral: Boolean(attachment.ephemeral),
    duration: attachment.duration || null,
    waveform: attachment.waveform || null,
    spoiler: Boolean(attachment.spoiler),
  };
}

async function readResponseWithLimit(response, limit) {
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length <= limit ? buffer : null;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function embeddedMediaUrl(attachment, budget) {
  const source = attachment.url || attachment.proxyURL;
  if (!source || !attachment.contentType?.startsWith('image/')) return null;

  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    return null;
  }

  const allowedHost = parsed.hostname === 'cdn.discordapp.com'
    || parsed.hostname === 'media.discordapp.net';
  if (parsed.protocol !== 'https:' || !allowedHost) return null;

  const remainingBudget = SECURITY.maxTranscriptMediaBytes - budget.used;
  const downloadLimit = Math.min(SECURITY.maxTranscriptImageBytes, remainingBudget);
  if (downloadLimit <= 0 || (attachment.size > 0 && attachment.size > downloadLimit)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SECURITY.transcriptMediaTimeoutMs);
  timeout.unref?.();

  try {
    const response = await fetch(source, { signal: controller.signal });
    if (!response.ok) return null;

    const responseType = response.headers.get('content-type')?.split(';')[0] || attachment.contentType;
    if (!responseType?.startsWith('image/')) return null;

    const declaredLength = Number(response.headers.get('content-length')) || 0;
    if (declaredLength > downloadLimit) {
      await response.body?.cancel().catch(() => {});
      return null;
    }

    const buffer = await readResponseWithLimit(response, downloadLimit);
    if (!buffer) return null;
    budget.used += buffer.length;
    return `data:${responseType};base64,${buffer.toString('base64')}`;
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.warn(`[TRANSCRIPT_MEDIA] Não foi possível incorporar ${attachment.id}: ${error.message}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function embeddedLottieAnimation(sticker, budget) {
  let parsed;
  try {
    parsed = new URL(sticker.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'cdn.discordapp.com') return null;

  const remainingBudget = SECURITY.maxTranscriptMediaBytes - budget.used;
  const downloadLimit = Math.min(SECURITY.maxTranscriptImageBytes, remainingBudget);
  if (downloadLimit <= 0) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SECURITY.transcriptMediaTimeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(sticker.url, { signal: controller.signal });
    if (!response.ok) return null;
    const declaredLength = Number(response.headers.get('content-length')) || 0;
    if (declaredLength > downloadLimit) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const buffer = await readResponseWithLimit(response, downloadLimit);
    if (!buffer) return null;
    const animation = JSON.parse(buffer.toString('utf8'));
    if (!animation || typeof animation !== 'object') return null;
    budget.used += buffer.length;
    return buffer.toString('base64');
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.warn(`[TRANSCRIPT_MEDIA] Não foi possível incorporar a figurinha Lottie ${sticker.id}: ${error.message}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function lottiePlayerSource() {
  if (!cachedLottiePlayerSource) {
    cachedLottiePlayerSource = readFileSync(
      require.resolve('lottie-web/build/player/lottie.min.js'),
      'utf8',
    ).replace(/<\/script/gi, '<\\/script');
  }
  return cachedLottiePlayerSource;
}

function renderLottieStickers(html, animations) {
  if (!animations.size) return html;
  const dataBlocks = [];
  let rendered = html;

  for (const [marker, animation] of animations) {
    const markerUrl = `${LOTTIE_MARKER_HOST}${marker}.png`;
    const attachmentPattern = new RegExp(
      `<discord-attachment(?=[^>]*\\burl="${escapeRegExp(markerUrl)}")[^>]*></discord-attachment>`,
      'g',
    );
    rendered = rendered.replace(
      attachmentPattern,
      `<div class="ticket-lottie-sticker" data-ticket-lottie="${marker}" slot="attachment" role="img" aria-label="${escapeHtml(animation.name)}"><span>🎞️ Figurinha animada: ${escapeHtml(animation.name)}</span></div>`,
    );
    dataBlocks.push(`<script type="application/json" id="ticket-lottie-data-${marker}">${animation.data}</script>`);
  }

  let player;
  try {
    player = lottiePlayerSource();
  } catch (error) {
    console.warn(`[TRANSCRIPT_MEDIA] Player Lottie indisponível: ${error.message}`);
    return rendered;
  }

  const lottieSupport = `
<style>
.ticket-lottie-sticker{width:min(320px,100%);aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:8px;color:#b5bac1;background:#2b2d31}.ticket-lottie-sticker>span{padding:16px;text-align:center}
</style>
${dataBlocks.join('\n')}
<script>${player}</script>
<script>
document.querySelectorAll('[data-ticket-lottie]').forEach(function(container){
  try {
    var source=document.getElementById('ticket-lottie-data-'+container.dataset.ticketLottie);
    var bytes=Uint8Array.from(atob(source.textContent),function(value){return value.charCodeAt(0);});
    var animationData=JSON.parse(new TextDecoder().decode(bytes));
    container.textContent='';
    window.lottie.loadAnimation({container:container,renderer:'svg',loop:true,autoplay:true,animationData:animationData});
  } catch (error) {
    console.warn('Não foi possível exibir uma figurinha animada no transcript.',error);
  }
});
</script>`;
  return rendered.replace('</body>', `${lottieSupport}\n</body>`);
}

function classicTranscriptHtml(html, channel, messages, context = {}) {
  const openedAt = context.openedAt || channel.createdTimestamp || messages[0]?.createdTimestamp;
  const closedAt = context.closedAt || messages.at(-1)?.createdTimestamp || Date.now();
  const requester = transcriptUserLabel(channel, messages, context.ownerId);
  const assignee = context.assigneeId
    ? transcriptUserLabel(channel, messages, context.assigneeId)
    : 'Não assumido';
  const closedBy = transcriptUserLabel(channel, messages, context.closedById);
  const styles = `
<style id="ticket-classic-transcript-styles">
html,body{max-width:100%;overflow-x:hidden}body{background:#2b2d31!important}
discord-messages{display:block;box-sizing:border-box;width:100%;min-height:100vh;margin:0;overflow-x:hidden;background:#313338}
.ticket-classic-status{box-sizing:border-box;padding:10px 20px;border-bottom:1px solid #3f4147;border-left:4px solid #23a55a;background:#2b2d31;color:#b5bac1;font-size:13px;font-weight:600}
.ticket-classic-summary{box-sizing:border-box;max-width:820px;margin:14px 20px 18px;padding:14px 16px;border-left:4px solid #23a55a;border-radius:4px;background:#2b2d31;color:#dbdee1}
.ticket-classic-summary h2{margin:0 0 12px;color:#f2f3f5;font-size:16px}.ticket-classic-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 22px}
.ticket-classic-field{min-width:0}.ticket-classic-field span{display:block;margin-bottom:3px;color:#b5bac1;font-size:11px;font-weight:700;text-transform:uppercase}.ticket-classic-field strong{display:block;overflow-wrap:anywhere;color:#f2f3f5;font-size:13px;font-weight:600}
.ticket-classic-field-wide{grid-column:1/-1;padding-top:2px;border-top:1px solid #3f4147}.ticket-classic-field-wide strong{white-space:pre-wrap}
@media(max-width:650px){.ticket-classic-summary{margin:12px 10px 16px}.ticket-classic-grid{grid-template-columns:1fr}.ticket-classic-field-wide{grid-column:auto}}
@media print{body,discord-messages{background:#fff!important}.ticket-classic-status,.ticket-classic-summary{border:1px solid #bbb;background:#f4f4f4!important;color:#222!important}.ticket-classic-summary h2,.ticket-classic-field strong{color:#111!important}}
</style>`;
  const status = '<div class="ticket-classic-status">Ticket fechado. Este registro é somente para consulta.</div>';
  const summary = `
<section class="ticket-classic-summary">
  <h2>Resumo do ticket</h2>
  <div class="ticket-classic-grid">
    <div class="ticket-classic-field"><span>Data de abertura</span><strong>${escapeHtml(formatAdministrativeDate(openedAt))}</strong></div>
    <div class="ticket-classic-field"><span>Data de fechamento</span><strong>${escapeHtml(formatAdministrativeDate(closedAt))}</strong></div>
    <div class="ticket-classic-field"><span>Solicitante</span><strong>${escapeHtml(requester)}</strong></div>
    <div class="ticket-classic-field"><span>Atendente</span><strong>${escapeHtml(assignee)}</strong></div>
    <div class="ticket-classic-field"><span>Duração total</span><strong>${escapeHtml(formatAdministrativeDuration(closedAt - openedAt))}</strong></div>
    <div class="ticket-classic-field"><span>Fechado por</span><strong>${escapeHtml(closedBy)}</strong></div>
    <div class="ticket-classic-field ticket-classic-field-wide"><span>Motivo do fechamento</span><strong>${escapeHtml(context.reason || 'Não informado')}</strong></div>
  </div>
</section>`;
  const timeLocalization = `
<script>
(function(){
  function localizeTimes(){
    document.querySelectorAll('discord-message').forEach(function(element){
      var raw=element.getAttribute('timestamp');
      if(!raw)return;
      var date=new Date(raw);if(Number.isNaN(date.getTime()))return;
      var formatted=new Intl.DateTimeFormat('pt-BR',{timeZone:${JSON.stringify(TRANSCRIPT_TIME_ZONE)},day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date).replace(',', ' às');
      var root=element.shadowRoot||element;
      root.querySelectorAll('.discord-message-timestamp').forEach(function(node){node.textContent=formatted;});
      root.querySelectorAll('.discord-message-edited').forEach(function(node){node.textContent='(editado)';});
    });
    document.querySelectorAll('discord-time').forEach(function(element){
      var raw=element.getAttribute('timestamp')||element.getAttribute('datetime');
      if(!raw)return;
      var numeric=Number(raw);var date=Number.isFinite(numeric)?new Date(numeric>1e12?numeric:numeric*1000):new Date(raw);
      if(Number.isNaN(date.getTime()))return;
      var formatted=new Intl.DateTimeFormat('pt-BR',{timeZone:${JSON.stringify(TRANSCRIPT_TIME_ZONE)},day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date).replace(',', ' às');
      element.setAttribute('aria-label',formatted);
      if(!element.shadowRoot)element.textContent=formatted;
      else element.shadowRoot.querySelectorAll('time,span').forEach(function(node){node.textContent=formatted;});
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',localizeTimes);else localizeTimes();
  setTimeout(localizeTimes,250);setTimeout(localizeTimes,1000);setTimeout(localizeTimes,2500);
})();
</script>`;

  let rendered = html
    .replace(/<discord-action-row\b[\s\S]*?<\/discord-action-row>/gi, '')
    .replace(/<discord-button\b[\s\S]*?<\/discord-button>/gi, '');
  if (channel.topic) {
    rendered = rendered.split(channel.topic).join('').split(escapeHtml(channel.topic)).join('');
  }
  rendered = rendered.includes('</head>') ? rendered.replace('</head>', `${styles}\n</head>`) : `${styles}${rendered}`;
  if (/<\/discord-header>/i.test(rendered)) {
    rendered = rendered.replace(/<\/discord-header>/i, `</discord-header>${status}${summary}`);
  } else if (/<body\b[^>]*>/i.test(rendered)) {
    rendered = rendered.replace(/<body\b[^>]*>/i, (bodyTag) => `${bodyTag}${status}${summary}`);
  } else {
    rendered = `${status}${summary}${rendered}`;
  }
  return rendered.includes('</body>')
    ? rendered.replace('</body>', `${timeLocalization}\n</body>`)
    : `${rendered}${timeLocalization}`;
}

function formatAdministrativeDate(timestamp) {
  if (!timestamp) return 'Não identificado';
  try {
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: TRANSCRIPT_TIME_ZONE,
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(timestamp));
    const value = (type) => parts.find((part) => part.type === type)?.value || '';
    return `${value('day')}/${value('month')}/${value('year')} às ${value('hour')}:${value('minute')}`;
  } catch {
    return new Date(timestamp).toISOString().replace('T', ' ').slice(0, 16);
  }
}

function formatAdministrativeDuration(milliseconds) {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (totalMinutes < 1) return 'Menos de 1 minuto';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days} dia${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} hora${hours === 1 ? '' : 's'}`);
  if (minutes) parts.push(`${minutes} minuto${minutes === 1 ? '' : 's'}`);
  return parts.join(' e ');
}

function transcriptUserLabel(channel, messages, userId) {
  if (!userId) return 'Não identificado';
  const member = channel.guild?.members?.cache?.get(userId);
  const author = messages.find((message) => message.author?.id === userId)?.author;
  const name = member?.displayName || author?.globalName || author?.username;
  return name || 'Usuário não identificado';
}

function transcriptCode(channel, messages) {
  const hash = createHash('sha256').update(channel.id);
  for (const message of messages) {
    hash.update(`\n${message.id}:${message.createdTimestamp}:${message.editedTimestamp || 0}:${message.author?.id || ''}`);
    hash.update(`:${message.content || ''}`);
    for (const attachmentId of message.attachments.keys()) hash.update(`:${attachmentId}`);
  }
  return hash.digest('hex').slice(0, 24).toUpperCase().match(/.{1,4}/g).join('-');
}

function administrativeTranscriptHtml(html, channel, messages, context, truncated, attachmentCount) {
  const openedAt = context.openedAt || channel.createdTimestamp || messages[0]?.createdTimestamp;
  const closedAt = context.closedAt || messages.at(-1)?.createdTimestamp || Date.now();
  const protocol = `TKT-${context.requestId || channel.id}`;
  const code = transcriptCode(channel, messages);
  const humanParticipants = new Set(messages.filter((message) => !message.author?.bot)
    .map((message) => message.author?.id).filter(Boolean)).size;
  const claimMessage = messages.find((message) => message.author?.bot
    && message.content?.startsWith('🙋 Atendimento assumido por'));
  const summaryItems = [
    ['Protocolo', protocol],
    ['Status', 'Encerrado'],
    ['Solicitante', transcriptUserLabel(channel, messages, context.ownerId)],
    ['Responsável', context.assigneeId
      ? transcriptUserLabel(channel, messages, context.assigneeId) : 'Não assumido'],
    ['Categoria', context.typeLabel || 'Não identificada'],
    ['Aberto em', formatAdministrativeDate(openedAt)],
    ['Encerrado em', formatAdministrativeDate(closedAt)],
    ['Duração', formatAdministrativeDuration(closedAt - openedAt)],
    ['Encerrado por', transcriptUserLabel(channel, messages, context.closedById)],
  ];
  const summaryCards = summaryItems.map(([label, value]) => `
    <div class="ticket-summary-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  const timeline = [
    ['📨', 'Ticket aberto', formatAdministrativeDate(openedAt)],
    ...(context.assigneeId ? [['🙋', 'Atendimento assumido', formatAdministrativeDate(context.assigneeAt || claimMessage?.createdTimestamp || openedAt)]] : []),
    ['🔒', 'Ticket encerrado', formatAdministrativeDate(closedAt)],
  ].map(([icon, label, date]) => `
    <div class="ticket-timeline-event"><b>${icon}</b><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(date)}</small></span></div>`).join('');
  const warning = truncated
    ? '<div class="ticket-transcript-warning">⚠️ O histórico atingiu o limite de segurança e contém somente as mensagens mais recentes.</div>'
    : '';
  const reason = escapeHtml(context.reason || 'Não informado');

  const styles = `
<style id="ticket-administrative-transcript-styles">
:root{color-scheme:dark}body{margin:0;background:#1e1f22;color:#f2f3f5;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
discord-header,discord-action-row,discord-button{display:none!important}
.ticket-transcript-summary{box-sizing:border-box;margin:0;padding:28px clamp(18px,4vw,56px);background:linear-gradient(135deg,#102541 0%,#173b67 58%,#146447 100%);border-bottom:3px solid #e7b52c;box-shadow:0 12px 30px rgba(0,0,0,.25)}
.ticket-summary-kicker{font-size:12px;font-weight:800;letter-spacing:.16em;color:#b9d7f8;text-transform:uppercase}.ticket-transcript-summary h1{margin:7px 0 3px;font-size:clamp(25px,4vw,40px);line-height:1.08}.ticket-summary-subtitle{margin:0 0 24px;color:#d7e7f8;font-size:15px}
.ticket-summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.ticket-summary-item{min-width:0;padding:12px 14px;background:rgba(0,0,0,.2);border:1px solid rgba(255,255,255,.13);border-radius:10px}.ticket-summary-item span{display:block;margin-bottom:4px;color:#a9c8e8;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.ticket-summary-item strong{display:block;overflow-wrap:anywhere;font-size:14px;color:#fff}
.ticket-reason{margin-top:12px;padding:14px 16px;background:rgba(0,0,0,.24);border-left:4px solid #e7b52c;border-radius:8px;white-space:pre-wrap}.ticket-reason span{display:block;margin-bottom:5px;color:#f8d878;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.ticket-reason strong{font-size:14px}
.ticket-timeline{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:16px}.ticket-timeline-event{display:flex;align-items:center;gap:10px;padding:10px 12px;background:rgba(255,255,255,.08);border-radius:9px}.ticket-timeline-event>b{font-size:20px}.ticket-timeline-event span{display:flex;min-width:0;flex-direction:column}.ticket-timeline-event strong{font-size:13px}.ticket-timeline-event small{margin-top:2px;color:#c6d8ea;font-size:11px}
.ticket-transcript-warning{margin:14px clamp(18px,4vw,56px) 0;padding:12px 15px;border:1px solid #b7791f;border-radius:8px;background:#422f13;color:#fde7a7;font-weight:650}.ticket-event-message{margin:8px 18px!important;border-left:4px solid #3ba55d!important;background:rgba(59,165,93,.08)!important}
.ticket-audit-footer{box-sizing:border-box;margin-top:18px;padding:20px clamp(18px,4vw,56px);border-top:1px solid #3f4147;background:#18191c;color:#b5bac1}.ticket-audit-footer strong{color:#f2f3f5}.ticket-audit-stats{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:8px;font-size:12px}.ticket-audit-code{overflow-wrap:anywhere;color:#f8d878;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
@media(max-width:760px){.ticket-transcript-summary{padding:22px 15px}.ticket-summary-grid{grid-template-columns:1fr}.ticket-timeline{grid-template-columns:1fr}.ticket-transcript-warning{margin:12px 15px 0}.ticket-audit-footer{padding:18px 15px}}
@media print{:root{color-scheme:light}body{background:#fff!important;color:#111!important}.ticket-transcript-summary{background:#eef4fa!important;color:#102541!important;box-shadow:none}.ticket-transcript-summary h1,.ticket-summary-item strong{color:#102541!important}.ticket-summary-item,.ticket-timeline-event,.ticket-reason{background:#fff!important;border:1px solid #aab7c4}.ticket-audit-footer{background:#fff!important;color:#333!important}.ticket-audit-footer strong{color:#111!important}}
</style>`;
  const header = `
<section class="ticket-transcript-summary">
  <div class="ticket-summary-kicker">${escapeHtml(BRAND.serverName)}</div>
  <h1>Central de Atendimento</h1>
  <p class="ticket-summary-subtitle">Transcript oficial de atendimento</p>
  <div class="ticket-summary-grid">${summaryCards}</div>
  <div class="ticket-reason"><span>Motivo do encerramento</span><strong>${reason}</strong></div>
  <div class="ticket-timeline">${timeline}</div>
</section>${warning}`;
  const footer = `
<footer class="ticket-audit-footer">
  <strong>Registro administrativo encerrado</strong>
  <div class="ticket-audit-stats">
    <span>💬 ${messages.length} mensagem${messages.length === 1 ? '' : 's'}</span>
    <span>📎 ${attachmentCount} anexo${attachmentCount === 1 ? '' : 's'}</span>
    <span>👥 ${humanParticipants} participante${humanParticipants === 1 ? '' : 's'}</span>
    <span>🕒 Gerado em ${escapeHtml(formatAdministrativeDate(Date.now()))}</span>
    <span class="ticket-audit-code">Código: ${code}</span>
  </div>
</footer>
<script>
(function(){
  function cleanTranscript(){
    document.querySelectorAll('discord-header,discord-action-row,discord-button').forEach(function(element){element.remove();});
    document.querySelectorAll('discord-message').forEach(function(message){
      var content=message.textContent||'';
      if(content.includes('Atendimento assumido por')||content.includes('Ticket fechado')) message.classList.add('ticket-event-message');
    });
    document.querySelectorAll('discord-time').forEach(function(element){
      var raw=element.getAttribute('timestamp')||element.getAttribute('datetime');
      if(!raw)return;
      var numeric=Number(raw);var date=Number.isFinite(numeric)?new Date(numeric>1e12?numeric:numeric*1000):new Date(raw);
      if(Number.isNaN(date.getTime()))return;
      var formatted=new Intl.DateTimeFormat('pt-BR',{timeZone:${JSON.stringify(TRANSCRIPT_TIME_ZONE)},day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date).replace(',', ' às');
      element.setAttribute('aria-label',formatted);
      if(!element.shadowRoot)element.textContent=formatted;
      else element.shadowRoot.querySelectorAll('time,span').forEach(function(node){node.textContent=formatted;});
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',cleanTranscript);else cleanTranscript();
  setTimeout(cleanTranscript,250);setTimeout(cleanTranscript,1000);
})();
</script>`;

  let rendered = html
    .replace(/<discord-header\b[\s\S]*?<\/discord-header>/gi, '')
    .replace(/<discord-action-row\b[\s\S]*?<\/discord-action-row>/gi, '');
  if (channel.topic) {
    rendered = rendered.split(channel.topic).join('').split(escapeHtml(channel.topic)).join('');
  }
  rendered = rendered.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(protocol)} — ${escapeHtml(BRAND.serverName)}</title>`);
  rendered = rendered.includes('</head>') ? rendered.replace('</head>', `${styles}\n</head>`) : `${styles}${rendered}`;
  rendered = /<body\b[^>]*>/i.test(rendered)
    ? rendered.replace(/<body\b[^>]*>/i, (bodyTag) => `${bodyTag}${header}`)
    : `${header}${rendered}`;
  return rendered.includes('</body>') ? rendered.replace('</body>', `${footer}\n</body>`) : `${rendered}${footer}`;
}

async function prepareTranscriptMedia(messages) {
  const budget = { used: 0 };
  const lottieAnimations = new Map();

  for (const message of messages) {
    for (const sticker of message.stickers.values()) {
      const format = Number(sticker.format);
      const isGif = format === 4;
      const isLottie = format === 3;
      if (isLottie) {
        const marker = `${message.id}-${sticker.id}`;
        const animationData = await embeddedLottieAnimation(sticker, budget);
        if (animationData) {
          lottieAnimations.set(marker, { name: sticker.name, data: animationData });
          message.attachments.set(`sticker-${sticker.id}`, {
            id: `sticker-${sticker.id}`,
            name: `sticker-${safeChannelName(sticker.name)}.png`,
            description: sticker.description || 'Figurinha animada do Discord',
            url: `${LOTTIE_MARKER_HOST}${marker}.png`,
            proxyURL: `${LOTTIE_MARKER_HOST}${marker}.png`,
            contentType: 'image/png',
            size: 0,
            width: 320,
            height: 320,
            ephemeral: false,
            duration: null,
            waveform: null,
            spoiler: false,
            ticketLottieMarker: marker,
          });
        } else {
          message.attachments.set(`sticker-${sticker.id}`, {
            id: `sticker-${sticker.id}`,
            name: `sticker-${safeChannelName(sticker.name)}.json`,
            description: sticker.description || 'Figurinha Lottie do Discord',
            url: sticker.url,
            proxyURL: sticker.url,
            contentType: 'application/json',
            size: 0,
            width: null,
            height: null,
            ephemeral: false,
            duration: null,
            waveform: null,
            spoiler: false,
          });
        }
        continue;
      }
      const extension = isGif ? 'gif' : 'png';
      const stickerUrl = isGif
        ? `https://media.discordapp.net/stickers/${sticker.id}.gif`
        : sticker.url;

      message.attachments.set(`sticker-${sticker.id}`, {
        id: `sticker-${sticker.id}`,
        name: `sticker-${safeChannelName(sticker.name)}.${extension}`,
        description: sticker.description || 'Figurinha do Discord',
        url: stickerUrl,
        proxyURL: stickerUrl,
        contentType: isGif ? 'image/gif' : 'image/png',
        size: 0,
        width: 320,
        height: 320,
        ephemeral: false,
        duration: null,
        waveform: null,
        spoiler: false,
      });
    }

    for (const [attachmentId, attachment] of message.attachments) {
      if (attachment.ticketLottieMarker) continue;
      if (!attachment.contentType?.startsWith('image/')) continue;
      const embeddedUrl = await embeddedMediaUrl(attachment, budget);
      message.attachments.set(attachmentId, transcriptAttachment(attachment, embeddedUrl || attachment.url));
    }
  }

  return { used: budget.used, lottieAnimations };
}

async function createTranscript(channel, context = {}) {
  const messages = [];
  let before;

  while (messages.length < SECURITY.maxTranscriptMessages) {
    const remaining = SECURITY.maxTranscriptMessages - messages.length;
    const limit = Math.min(100, remaining);
    const batch = await channel.messages.fetch({ limit, ...(before ? { before } : {}) });
    if (!batch.size) break;
    messages.push(...batch.values());
    if (batch.size < limit) break;
    before = batch.last().id;
  }

  let truncated = false;
  if (messages.length === SECURITY.maxTranscriptMessages && before) {
    const older = await channel.messages.fetch({ limit: 1, before }).catch(() => null);
    truncated = Boolean(older?.size);
  }

  messages.sort((first, second) => first.createdTimestamp - second.createdTimestamp);
  const preparedMedia = await prepareTranscriptMedia(messages);

  let html = await discordTranscripts.generateFromMessages(messages, channel, {
    returnType: 'string',
    filename: `transcript-${safeChannelName(channel.name)}.html`,
    saveImages: false,
    footerText: `Exportado {number} mensagem{s} • ${BRAND.serverName}`,
    poweredBy: false,
  });
  html = html.replace(/mensagems/g, 'mensagens');
  html = renderLottieStickers(html, preparedMedia.lottieAnimations);
  html = classicTranscriptHtml(html, channel, messages, context);
  const buffer = Buffer.from(html);
  const fileName = `transcript-${safeChannelName(channel.name)}.html`;
  const attachment = new AttachmentBuilder(buffer, { name: fileName });
  console.log(`[TRANSCRIPT] ${channel.id}: ${messages.length} mensagens, ${(preparedMedia.used / 1024 / 1024).toFixed(2)} MB de mídia incorporada${truncated ? ', histórico limitado' : ''}.`);
  return { attachment, buffer, fileName, messageCount: messages.length, truncated };
}

function memberHasAnyRole(interaction, roleIds) {
  return [...roleIds].some((roleId) => memberHasRole(interaction, roleId));
}

function isTicketStaff(interaction) {
  return memberHasAnyRole(interaction, TICKET_STAFF_ROLE_IDS);
}

function canOperateTickets(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (isTicketStaff(interaction)) return true;
  const forumChannel = ticketForumFor(interaction.guild);
  if (!forumChannel) return false;
  const allowedIds = new Set(authorizedTicketRoles(interaction.guild, forumChannel).map((role) => role.id));
  return interaction.member.roles.cache.some((role) => allowedIds.has(role.id));
}

function memberHasRole(interaction, roleId) {
  const memberRoles = interaction.member?.roles;
  if (memberRoles?.cache) return memberRoles.cache.has(roleId);
  if (Array.isArray(memberRoles)) return memberRoles.includes(roleId);
  return false;
}

function canCloseTicket(interaction) {
  return canOperateTickets(interaction);
}

function canClaimTicket(interaction) {
  return canOperateTickets(interaction);
}

function canManageTicket(interaction, channel) {
  return canCloseTicket(interaction, ticketMetadata(channel).typeKey);
}

async function submitTicket(interaction, typeKey, formData) {
  const type = TICKET_TYPES[typeKey];
  if (!type) return interaction.reply({ content: '❌ Departamento inválido.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (maintenanceMode) {
    return interaction.editReply('🛠️ O sistema de tickets está temporariamente em manutenção. Tente novamente após a liberação da administração.');
  }
  const cooldownRemaining = claimCooldown(interaction.user.id);
  if (cooldownRemaining > 0) {
    return interaction.editReply(`⏳ Aguarde ${Math.ceil(cooldownRemaining / 1000)} segundos antes de enviar outra solicitação.`);
  }
  if (submissionLocks.has(interaction.user.id)) {
    return interaction.editReply('⏳ Sua solicitação anterior ainda está sendo processada.');
  }

  submissionLocks.add(interaction.user.id);
  try {
    await interaction.editReply('Abrindo seu ticket...');
    const baseStructure = await ensureStructure(interaction.guild);
    const ticketStructure = await structureForTicketType(interaction.guild, typeKey, baseStructure);
    const { category, forumChannel, ticketsThread } = ticketStructure;
    const userTickets = interaction.guild.channels.cache.filter(
      (channel) => isTicketChannel(channel) && ticketRecord(channel)?.ownerId === interaction.user.id,
    );
    if (userTickets.size >= SECURITY.maxOpenTicketsPerUser) {
      const currentChannels = userTickets.map((channel) => `${channel}`).slice(0, 3).join(', ');
      return interaction.editReply(
        SECURITY.maxOpenTicketsPerUser === 1
          ? `ℹ️ Você já possui um atendimento aberto: ${currentChannels}`
          : `ℹ️ Você atingiu o limite de ${SECURITY.maxOpenTicketsPerUser} atendimentos abertos. Canais atuais: ${currentChannels}`,
      );
    }

    const openTicketCount = interaction.guild.channels.cache.filter(isTicketChannel).size;
    if (openTicketCount + pendingTicketCreations >= SECURITY.maxOpenTickets) {
      return interaction.editReply(`⚠️ O limite de ${SECURITY.maxOpenTickets} tickets abertos foi atingido. Tente novamente após a conclusão de um atendimento.`);
    }

    const globalWait = claimGlobalSubmissionSlot();
    if (globalWait > 0) {
      return interaction.editReply(`🛡️ Muitas solicitações foram recebidas ao mesmo tempo. Aguarde ${Math.ceil(globalWait / 1000)} segundos e tente novamente.`);
    }

    const staffRoles = ticketStaffRoles(interaction.guild, forumChannel);
    let channel;
    pendingTicketCreations += 1;
    try {
      const parentCategory = await ticketParentCategory(interaction.guild, category);
      channel = await interaction.guild.channels.create({
        name: `${typeKey}-${safeChannelName(interaction.user.username)}`,
        type: ChannelType.GuildText,
        parent: parentCategory.id,
        topic: `Ticket de ${type.label} • aberto por ${interaction.user.username}`.slice(0, 200),
        permissionOverwrites: [
          { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
          ...staffRoles.map((role) => ({ id: role.id, allow: [PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] })),
          { id: interaction.guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
        ],
        reason: `Ticket aberto por ${interaction.user.tag}`,
      });
      updateTicketRecord(channel.id, { ownerId: interaction.user.id, typeKey, requestId: null, assigneeId: null });
    } finally {
      pendingTicketCreations -= 1;
    }

    try {
      const welcome = new EmbedBuilder()
        .setColor(BRAND.color)
        .setTitle(`${type.emoji} ${type.label}`)
        .setDescription(`${interaction.user}, já avisamos a equipe. É só aguardar aqui que alguém responde.`)
        .addFields(
          { name: 'Solicitação', value: formData.details },
          { name: 'Atendente', value: 'Ninguém assumiu ainda' },
        )
        .setTimestamp();
      await channel.send({
        content: `${interaction.user}`,
        embeds: [welcome],
        components: [ticketButtons()],
        allowedMentions: { users: [interaction.user.id], roles: [] },
      });

      const administrativeLog = new EmbedBuilder()
        .setColor(BRAND.color)
        .setTitle('📨 Atendimento aberto')
        .addFields(
          { name: 'Protocolo', value: `\`${ticketProtocol(channel.id)}\``, inline: true },
          { name: 'Assunto', value: `${type.emoji} ${type.label}`, inline: true },
          { name: 'Canal', value: `${channel}`, inline: true },
          { name: 'Solicitante', value: `${interaction.user}` },
          { name: 'Solicitação', value: formData.details },
          { name: 'Status', value: '🟡 Aguardando atendimento' },
        )
        .setFooter({ text: internalFooter('Registro interno') })
        .setTimestamp();
      const requestMessage = await ticketsThread.send({ embeds: [administrativeLog] });
      ticketRequestIds.set(channel.id, requestMessage.id);
      updateTicketRecord(channel.id, { requestId: requestMessage.id });
    } catch (error) {
      deleteTicketRecord(channel.id);
      await channel.delete('Falha ao concluir a abertura automática do ticket').catch(() => {});
      throw error;
    }

    return interaction.editReply(`Ticket aberto: ${channel}`);
  } finally {
    submissionLocks.delete(interaction.user.id);
  }
}

async function requestTicketClose(interaction) {
  if (!isTicketChannel(interaction.channel)) {
    return interaction.reply({ content: '❌ Este comando só pode ser usado dentro de um ticket.', flags: MessageFlags.Ephemeral });
  }
  if (!canCloseTicket(interaction, ticketMetadata(interaction.channel).typeKey)) {
    return interaction.reply({ content: '❌ Você não possui permissão para fechar este ticket.', flags: MessageFlags.Ephemeral });
  }
  return interaction.showModal(closeForm(interaction.channel.id));
}

async function updateClaimRecord(guild, requestId, user) {
  if (!requestId) return;
  const { ticketsThread } = await ensureStructure(guild);
  const requestMessage = await ticketsThread.messages.fetch(requestId).catch(() => null);
  const source = requestMessage?.embeds?.[0];
  if (!source) return;
  const fields = source.fields
    .filter((field) => !['Status', 'Responsável'].includes(field.name))
    .map((field) => ({ name: field.name, value: field.value, inline: field.inline }));
  fields.push(
    { name: 'Status', value: '🔵 Em atendimento', inline: true },
    { name: 'Responsável', value: `${user}`, inline: true },
  );
  await requestMessage.edit({
    embeds: [EmbedBuilder.from(source).setFields(fields).setTimestamp()],
  });
}

async function claimTicket(interaction) {
  if (!isTicketChannel(interaction.channel)) {
    return interaction.reply({ content: '❌ Este botão só pode ser usado dentro de um ticket.', flags: MessageFlags.Ephemeral });
  }
  if (!canClaimTicket(interaction, ticketMetadata(interaction.channel).typeKey)) {
    return interaction.reply({ content: '❌ Você não possui um cargo autorizado para assumir tickets.', flags: MessageFlags.Ephemeral });
  }

  const channelId = interaction.channel.id;
  await interaction.deferUpdate();
  if (ticketClaimLocks.has(channelId)) {
    return interaction.followUp({ content: '⏳ Este ticket está sendo assumido por outro membro da equipe.', flags: MessageFlags.Ephemeral });
  }

  ticketClaimLocks.add(channelId);
  try {
    const { assigneeId, requestId } = ticketMetadata(interaction.channel);
    if (assigneeId) {
      const message = assigneeId === interaction.user.id
        ? 'ℹ️ Você já é o responsável por este ticket.'
        : `ℹ️ Este ticket já foi assumido por <@${assigneeId}>.`;
      return interaction.followUp({ content: message, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }

    ticketAssignees.set(channelId, interaction.user.id);

    const sourceEmbed = interaction.message.embeds[0];
    if (sourceEmbed) {
      const fields = sourceEmbed.fields
        .filter((field) => field.name !== 'Atendente' && field.name !== 'Responsável pelo atendimento')
        .map((field) => ({ name: field.name, value: field.value, inline: field.inline }));
      fields.push({
        name: 'Atendente',
        value: `${interaction.user}`,
      });
      const updatedEmbed = EmbedBuilder.from(sourceEmbed).setFields(fields);
      await interaction.editReply({ embeds: [updatedEmbed], components: [ticketButtons(interaction.user.id)] });
    } else {
      await interaction.editReply({ components: [ticketButtons(interaction.user.id)] });
    }

    updateTicketRecord(channelId, { assigneeId: interaction.user.id });
    void updateClaimRecord(interaction.guild, requestId, interaction.user).catch((error) => {
      logOperationalError(`Não foi possível atualizar o registro do ticket ${channelId}`, error);
    });

    return interaction.followUp({
      content: '✅ Você assumiu este ticket.',
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    ticketAssignees.delete(channelId);
    throw error;
  } finally {
    ticketClaimLocks.delete(channelId);
  }
}

async function managedTicketChannel(interaction, channelId) {
  const channel = interaction.guild.channels.cache.get(channelId)
    || await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!isTicketChannel(channel)) {
    const error = new Error('Ticket não encontrado para gerenciamento.');
    error.userMessage = '❌ Este ticket não foi encontrado ou já foi encerrado.';
    throw error;
  }
  if (!canManageTicket(interaction, channel)) {
    const error = new Error(`Sem permissão para gerenciar o ticket ${channel.id}.`);
    error.userMessage = '❌ Você não possui permissão para gerenciar participantes ou renomear este ticket.';
    throw error;
  }
  return channel;
}

async function openTicketManagement(interaction) {
  if (!isTicketChannel(interaction.channel)) {
    return interaction.reply({ content: '❌ Este botão só pode ser usado dentro de um ticket.', flags: MessageFlags.Ephemeral });
  }
  if (!canManageTicket(interaction, interaction.channel)) {
    return interaction.reply({ content: '❌ Você não possui permissão para gerenciar este ticket.', flags: MessageFlags.Ephemeral });
  }
  return interaction.reply(ticketManagementSelector(interaction.channel.id));
}

async function selectTicketManagementAction(interaction) {
  const channelId = interaction.customId.split(':')[2];
  const action = interaction.values[0];
  if (action === 'rename') {
    const channel = interaction.guild.channels.cache.get(channelId);
    if (!isTicketChannel(channel)) {
      return interaction.update({ content: '❌ Este ticket não foi encontrado ou já foi encerrado.', components: [] });
    }
    if (!canManageTicket(interaction, channel)) {
      return interaction.update({ content: '❌ Você não possui permissão para renomear este ticket.', components: [] });
    }
    return interaction.showModal(renameTicketForm(channel.id, channel.name));
  }
  await interaction.deferUpdate();
  await managedTicketChannel(interaction, channelId);
  if (!['add', 'remove'].includes(action)) {
    return interaction.editReply({ content: '❌ Ação de gerenciamento inválida.', components: [] });
  }
  return interaction.editReply(ticketParticipantSelector(channelId, action));
}

async function updateTicketParticipant(interaction) {
  await interaction.deferUpdate();
  const [, , action, channelId] = interaction.customId.split(':');
  const channel = await managedTicketChannel(interaction, channelId);
  const userId = interaction.values[0];
  const user = interaction.users.get(userId) || await interaction.client.users.fetch(userId).catch(() => null);
  if (!user || user.bot) {
    return interaction.editReply({ content: '❌ Selecione uma pessoa válida.', components: [] });
  }
  const metadata = ticketMetadata(channel);
  if (userId === metadata.ownerId) {
    return interaction.editReply({ content: 'ℹ️ O solicitante principal não pode ser removido do próprio ticket.', components: [] });
  }

  if (action === 'add') {
    await channel.permissionOverwrites.edit(userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    }, `Participante adicionado por ${interaction.user.tag}`);
    return interaction.editReply({ content: `✅ ${user} foi adicionado ao ticket.`, components: [] });
  }

  if (action === 'remove') {
    if (!channel.permissionOverwrites.cache.has(userId)) {
      return interaction.editReply({ content: `ℹ️ ${user} não possui acesso individual concedido neste ticket.`, components: [] });
    }
    await channel.permissionOverwrites.delete(userId, `Participante removido por ${interaction.user.tag}`);
    return interaction.editReply({ content: `✅ O acesso individual de ${user} foi removido.`, components: [] });
  }

  return interaction.editReply({ content: '❌ Ação de gerenciamento inválida.', components: [] });
}

async function renameTicket(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channelId = interaction.customId.split(':')[2];
  const channel = await managedTicketChannel(interaction, channelId);
  const requestedName = interaction.fields.getTextInputValue('name').trim();
  const nextName = safeChannelName(requestedName);
  if (nextName === channel.name) {
    return interaction.editReply('ℹ️ O ticket já possui este nome.');
  }
  await channel.setName(nextName, `Ticket renomeado por ${interaction.user.tag}`);
  return interaction.editReply(`✅ Ticket renomeado para **${nextName}**.`);
}


// ---- Categorias extras (limite de 50 canais por categoria do Discord) ----
const CATEGORY_SOFT_LIMIT = 47;
let ticketCategoryLock = Promise.resolve();

function isOverflowCategory(channel) {
  return channel?.type === ChannelType.GuildCategory
    && new RegExp(`^${TICKET_CATEGORY_NAME} \\d+$`).test(channel.name);
}

function ticketParentCategory(guild, base) {
  const run = ticketCategoryLock.then(() => pickTicketParent(guild, base));
  ticketCategoryLock = run.catch(() => {});
  return run;
}

async function pickTicketParent(guild, base) {
  const used = (category) => guild.channels.cache.filter((item) => item.parentId === category.id).size;
  if (used(base) < CATEGORY_SOFT_LIMIT) return base;
  for (let number = 2; number <= 9; number += 1) {
    const name = `${TICKET_CATEGORY_NAME} ${number}`;
    const existing = guild.channels.cache.find(
      (item) => item.type === ChannelType.GuildCategory && item.name === name,
    );
    if (existing) {
      if (used(existing) < CATEGORY_SOFT_LIMIT) return existing;
      continue;
    }
    return guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
      position: base.position + 1,
      permissionOverwrites: base.permissionOverwrites.cache.map((overwrite) => ({
        id: overwrite.id, type: overwrite.type, allow: overwrite.allow, deny: overwrite.deny,
      })),
      reason: 'Categoria extra de tickets (a principal está cheia)',
    });
  }
  throw new Error('Não há mais espaço para novos tickets nas categorias de atendimento.');
}

async function cleanupOverflowCategory(guild, categoryId, deletedChannelId) {
  const category = categoryId ? guild.channels.cache.get(categoryId) : null;
  if (!isOverflowCategory(category)) return;
  const stillUsed = guild.channels.cache.some(
    (item) => item.parentId === category.id && item.id !== deletedChannelId,
  );
  if (!stillUsed) await category.delete('Categoria extra de tickets vazia').catch(() => {});
}

// ---- Inatividade: aviso, fechamento automático e lembrete para a equipe ----
const INACTIVITY = Object.freeze({
  warnMs: nonNegativeIntegerEnv('TICKET_INACTIVITY_WARNING_HOURS', 12) * 3_600_000,
  closeMs: nonNegativeIntegerEnv('TICKET_INACTIVITY_CLOSE_HOURS', 12) * 3_600_000,
  reminderMs: nonNegativeIntegerEnv('TICKET_STAFF_REMINDER_HOURS', 2) * 3_600_000,
  checkMs: 10 * 60 * 1000,
});
let activityCheckRunning = false;

function snowflakeTimestamp(id) {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}

function humanDuration(milliseconds) {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} minuto${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hora${hours === 1 ? '' : 's'}`;
  return `${Math.floor(hours / 24)} dias`;
}

async function autoCloseTicket(guild, channel, idleMs) {
  if (closingTicketIds.has(channel.id)) return;
  closingTicketIds.add(channel.id);
  try {
    await runTicketClose({
      guild,
      client,
      channel,
      closer: { id: client.user.id, tag: client.user.tag, label: 'Fechamento automático' },
      reason: `Sem resposta há ${humanDuration(idleMs)}.`,
      closingMessage: '🔒 Ticket fechado por falta de resposta.',
    });
  } catch (error) {
    closingTicketIds.delete(channel.id);
    throw error;
  }
}

async function checkTicketInactivity(guild, channel) {
  if (closingTicketIds.has(channel.id)) return;
  const record = ticketRecord(channel);
  if (!record?.ownerId) return;

  const now = Date.now();
  const lastActivity = channel.lastMessageId ? snowflakeTimestamp(channel.lastMessageId) : channel.createdTimestamp;
  const thresholds = [INACTIVITY.warnMs, INACTIVITY.reminderMs].filter(Boolean);
  const pending = Boolean(record.warnedAt || record.remindedAt);
  if (!pending && now - lastActivity < Math.min(...thresholds)) return;

  const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
  if (!recent) return;
  const lastHuman = [...recent.values()].find((message) => !message.author.bot);
  const lastHumanAt = lastHuman?.createdTimestamp || channel.createdTimestamp;
  const idle = now - lastHumanAt;
  // Quem respondeu por último: se foi alguém da equipe, o ticket aguarda o solicitante.
  const waitingForCustomer = Boolean(lastHuman) && lastHuman.author.id !== record.ownerId;

  // Houve nova mensagem depois do aviso ou do lembrete: a contagem recomeça.
  if (record.warnedAt && lastHumanAt > record.warnedAt) updateTicketRecord(channel.id, { warnedAt: null });
  if (record.remindedAt && lastHumanAt > record.remindedAt) updateTicketRecord(channel.id, { remindedAt: null });

  if (waitingForCustomer) {
    if (!INACTIVITY.warnMs) return;
    if (!record.warnedAt) {
      if (idle < INACTIVITY.warnMs) return;
      const closing = INACTIVITY.closeMs
        ? ` Se não houver resposta em ${humanDuration(INACTIVITY.closeMs)}, o ticket será fechado automaticamente.`
        : '';
      await channel.send({
        content: `<@${record.ownerId}>, este ticket está sem resposta há ${humanDuration(idle)}. Se ainda precisa de ajuda, é só responder aqui.${closing}`,
        allowedMentions: { users: [record.ownerId], roles: [] },
      });
      updateTicketRecord(channel.id, { warnedAt: Date.now() });
      return;
    }
    if (INACTIVITY.closeMs && now - record.warnedAt >= INACTIVITY.closeMs) {
      await autoCloseTicket(guild, channel, idle);
    }
    return;
  }

  // O solicitante falou por último (ou ninguém respondeu ainda): lembra a equipe uma vez.
  if (!INACTIVITY.reminderMs || record.remindedAt || idle < INACTIVITY.reminderMs) return;
  let mention = '';
  let roleIds = [];
  const userIds = [];
  if (record.assigneeId) {
    mention = `<@${record.assigneeId}>`;
    userIds.push(record.assigneeId);
  } else {
    const { forumChannel } = await ensureStructure(guild);
    roleIds = ticketStaffRoles(guild, forumChannel).map((role) => role.id);
    mention = roleIds.map((id) => `<@&${id}>`).join(' ');
  }
  await channel.send({
    content: `${mention} Este ticket está aguardando atendimento há ${humanDuration(idle)}.`.trim(),
    allowedMentions: { users: userIds, roles: roleIds },
  });
  updateTicketRecord(channel.id, { remindedAt: Date.now() });
}

async function checkTicketActivity() {
  if (activityCheckRunning || (!INACTIVITY.warnMs && !INACTIVITY.reminderMs)) return;
  activityCheckRunning = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      const tickets = guild.channels.cache.filter(
        (item) => item.type === ChannelType.GuildText && hasTicketRecord(item),
      );
      for (const channel of tickets.values()) {
        await checkTicketInactivity(guild, channel).catch((error) => {
          logOperationalError(`Não foi possível verificar o ticket ${channel.id}`, error);
        });
      }
    }
  } finally {
    activityCheckRunning = false;
  }
}

async function finalizeTicketClose(interaction) {
  const channelId = interaction.customId.split(':')[2];
  const channel = interaction.guild.channels.cache.get(channelId);
  if (!isTicketChannel(channel)) return interaction.reply({ content: '❌ O ticket não foi encontrado.', flags: MessageFlags.Ephemeral });
  const { typeKey } = ticketMetadata(channel);
  if (!canCloseTicket(interaction, typeKey)) {
    return interaction.reply({ content: '❌ Você não possui permissão para fechar este ticket.', flags: MessageFlags.Ephemeral });
  }
  if (closingTicketIds.has(channelId)) {
    return interaction.reply({ content: '⏳ Este ticket já está sendo encerrado.', flags: MessageFlags.Ephemeral });
  }

  closingTicketIds.add(channelId);
  try {
    await interaction.deferReply();
    await runTicketClose({
      guild: interaction.guild,
      client: interaction.client,
      channel,
      closer: { id: interaction.user.id, tag: interaction.user.tag, label: `${interaction.user}` },
      reason: cleanReason(interaction.fields.getTextInputValue('motivo')),
      closingMessage: '🔒 Ticket fechado.',
      onReady: () => interaction.deleteReply().catch(() => {}),
    });
  } catch (error) {
    closingTicketIds.delete(channelId);
    throw error;
  }
}

// Fluxo de fechamento usado tanto pelo botão quanto pelo fechamento automático.
async function runTicketClose({ guild, client, channel, closer, reason, closingMessage = '🔒 Ticket fechado.', onReady }) {
  const channelId = channel.id;
  const { ownerId, typeKey, requestId, assigneeId } = ticketMetadata(channel);
  const type = TICKET_TYPES[typeKey] || { label: typeKey || 'Não identificado', emoji: '🎫' };
  const baseStructure = await ensureStructure(guild);
  const { ticketsThread, transcriptsThread } = await structureForTicketType(guild, typeKey, baseStructure);
  const closedAt = Date.now();

  const delay = 5000;
  await onReady?.();
  await channel.send({ content: `${closingMessage} Este canal some em ${delay / 1000} segundos.`, allowedMentions: { parse: [] } });

  // O transcript deve ser criado somente depois que a mensagem de encerramento existir no canal.
  const transcriptResult = await enqueueTranscript(channel, {
    ownerId,
    assigneeId,
    requestId,
    closedById: closer.id,
    typeLabel: `${type.emoji} ${type.label}`,
    reason,
    openedAt: channel.createdTimestamp,
    closedAt,
  });

  if (requestId) {
    const requestMessage = await ticketsThread.messages.fetch(requestId).catch(() => null);
    if (requestMessage?.embeds[0]) {
      const previous = requestMessage.embeds[0];
      const requestDetails = previous.fields.find((field) => (
        field.name === 'Solicitação' || field.name === 'Conteúdo'
      ))?.value || 'Não informada.';
      const completed = new EmbedBuilder().setColor(BRAND.color)
        .setTitle('📁 Atendimento encerrado')
        .addFields(
          { name: 'Protocolo', value: `\`${ticketProtocol(channel.id)}\``, inline: true },
          { name: 'Assunto', value: `${type.emoji} ${type.label}`, inline: true },
          { name: 'Canal', value: `\`#${channel.name}\``, inline: true },
          { name: 'Solicitante', value: ownerId ? `<@${ownerId}>` : 'Não identificado' },
          { name: 'Solicitação', value: requestDetails },
          { name: 'Status', value: '🔴 Encerrado', inline: true },
          { name: 'Responsável', value: assigneeId ? `<@${assigneeId}>` : 'Não assumido', inline: true },
          { name: 'Encerrado por', value: `${closer.label}`, inline: true },
          { name: 'Duração', value: formatAdministrativeDuration(closedAt - channel.createdTimestamp), inline: true },
          { name: 'Motivo', value: reason },
        )
        .setFooter({ text: internalFooter('Registro interno') })
        .setTimestamp(closedAt);
      await requestMessage.edit({ embeds: [completed], components: [] }).catch(() => {});
    }
  }

  let transcriptSentByDm = false;
  let feedbackSentByDm = false;
  let transcriptDeliveryError = null;
  let privateDeliveryError = null;
  if (ownerId) {
    const owner = await client.users.fetch(ownerId).catch(() => null);
    if (owner) {
      const deliveryEmbed = (transcriptFailed = false) => new EmbedBuilder()
        .setColor(BRAND.color)
        .setTitle('Como foi o atendimento?')
        .setDescription(BRAND.transcriptToUser
          ? transcriptFailed
            ? 'Seu ticket foi fechado, mas não consegui enviar o transcript. Mesmo assim, você pode avaliar o atendimento abaixo.'
            : 'Seu ticket foi fechado e o transcript está na mensagem anterior. Como foi o atendimento?'
          : 'Seu ticket foi fechado. Como foi o atendimento?')
        .addFields(
          { name: 'Assunto', value: `${type.emoji} ${type.label}`, inline: true },
          { name: 'Motivo', value: reason, inline: true },
        )
        .setTimestamp();

      let transcriptMessage = null;
      if (BRAND.transcriptToUser) {
        transcriptMessage = await owner.send({
          content: 'Aqui está o transcript do seu atendimento. Baixe o arquivo e abra no navegador para ler a conversa.',
          files: [new AttachmentBuilder(transcriptResult.buffer, { name: transcriptResult.fileName })],
          allowedMentions: { parse: [] },
        }).catch((error) => {
          transcriptDeliveryError = error;
          logPrivateDeliveryFailure('o transcript', error);
          return null;
        });
        transcriptSentByDm = Boolean(transcriptMessage);
      }
      const feedbackMessage = await owner.send({
        embeds: [deliveryEmbed(BRAND.transcriptToUser && !transcriptSentByDm)],
        components: feedbackButtons(channel.id, typeKey, ownerId),
        allowedMentions: { parse: [] },
      }).catch((error) => {
        privateDeliveryError = error;
        logPrivateDeliveryFailure('a avaliação', error);
        return null;
      });
      feedbackSentByDm = Boolean(feedbackMessage);
    }
  }

  const privateTranscriptStatus = !BRAND.transcriptToUser
    ? 'Envio privado desativado.'
    : transcriptSentByDm
      ? 'Entregue no privado.'
      : feedbackSentByDm
        ? `Não anexado no privado: ${privateMessageFailure(transcriptDeliveryError)}.`
        : `Não entregue no privado: ${privateMessageFailure(privateDeliveryError || transcriptDeliveryError)}.`;
  const logEmbed = new EmbedBuilder().setColor(BRAND.color).setTitle('📁 Atendimento encerrado')
    .addFields(
      { name: 'Protocolo', value: `\`${ticketProtocol(channel.id)}\``, inline: true },
      { name: 'Assunto', value: `${type.emoji} ${type.label}`, inline: true },
      { name: 'Canal', value: `\`#${channel.name}\``, inline: true },
      { name: 'Solicitante', value: ownerId ? `<@${ownerId}>` : 'Não identificado', inline: true },
      { name: 'Responsável', value: assigneeId ? `<@${assigneeId}>` : 'Não assumido', inline: true },
      { name: 'Encerrado por', value: `${closer.label}`, inline: true },
      { name: 'Duração', value: formatAdministrativeDuration(closedAt - channel.createdTimestamp), inline: true },
      { name: 'Motivo', value: reason },
      {
        name: 'Transcript',
        value: `HTML salvo neste registro.\n${privateTranscriptStatus}`,
      },
      {
        name: 'Avaliação',
        value: feedbackSentByDm
          ? 'Enviada por mensagem privada ao solicitante.'
          : `Não enviada: ${privateMessageFailure(privateDeliveryError || transcriptDeliveryError)}.`,
      },
    ).setFooter({ text: internalFooter('Registro interno') }).setTimestamp();
  await transcriptsThread.send({ embeds: [logEmbed], files: [transcriptResult.attachment] });

  const parentId = channel.parentId;
  const deletion = setTimeout(async () => {
    try {
      await channel.delete(`Ticket fechado por ${closer.tag}`);
    } catch (error) {
      logOperationalError(`Falha ao excluir o ticket ${channelId}`, error);
    } finally {
      ticketAssignees.delete(channelId);
      ticketRequestIds.delete(channelId);
      deleteTicketRecord(channelId);
      closingTicketIds.delete(channelId);
      void cleanupOverflowCategory(guild, parentId, channelId);
    }
  }, delay);
  deletion.unref?.();
}

async function recordFeedback(interaction) {
  const [, , channelId, typeKey, ownerId, score] = interaction.customId.split(':');
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: '❌ Esta avaliação pertence ao solicitante.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferUpdate();
  const observation = interaction.fields.getTextInputValue('observacao');
  const guild = interaction.guild || await interaction.client.guilds.fetch(process.env.GUILD_ID);
  const baseStructure = await ensureStructure(guild);
  const { feedbacksThread } = await structureForTicketType(guild, typeKey, baseStructure);
  const type = TICKET_TYPES[typeKey] || { label: typeKey || 'Não identificado', emoji: '🎫' };
  const numericScore = Number(score);
  const color = numericScore === 5 ? 0x22c55e : numericScore === 4 ? 0x3b82f6 : numericScore === 3 ? 0xf59e0b : 0xef4444;
  const embed = new EmbedBuilder().setColor(color).setTitle('⭐ Avaliação recebida')
    .addFields(
      { name: 'Protocolo', value: `\`${ticketProtocol(channelId)}\``, inline: true },
      { name: 'Assunto', value: `${type.emoji} ${type.label}`, inline: true },
      { name: 'Nota', value: `**${score}/5 ⭐**`, inline: true },
      { name: 'Solicitante', value: `${interaction.user}` },
      { name: 'Observação', value: observation },
    ).setFooter({ text: internalFooter('Avaliação') }).setTimestamp();
  await feedbacksThread.send({ embeds: [embed] });
  const sourceEmbed = interaction.message?.embeds?.[0];
  const visibleFields = (sourceEmbed?.fields || []).filter((field) => field.name !== 'Avaliação' && field.name !== 'Sua avaliação');
  const confirmation = sourceEmbed
    ? EmbedBuilder.from(sourceEmbed)
    : new EmbedBuilder().setTitle('Atendimento encerrado');
  confirmation
    .setColor(color)
    .setDescription('✅ Obrigado! Sua avaliação foi registrada.')
    .setFields(
      ...visibleFields,
      { name: 'Sua avaliação', value: `**${score}/5 ⭐**\n${observation}` },
    );
  return interaction.editReply({ embeds: [confirmation], components: [] });
}

async function updateTicketRoleAccess(interaction, authorize) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: '❌ Somente administradores podem alterar os cargos autorizados.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const role = interaction.options.getRole('cargo', true);
  if (role.id === interaction.guild.roles.everyone.id) {
    return interaction.editReply('❌ O cargo `@everyone` não pode acessar o Fórum privado.');
  }
  const { category, forumChannel } = await ensureStructure(interaction.guild);
  const openTickets = interaction.guild.channels.cache.filter((channel) => isTicketChannel(channel));
  const ticketCategories = [category, ...interaction.guild.channels.cache.filter(isOverflowCategory).values()];
  if (authorize) {
    await Promise.all([
      ...ticketCategories.map((item) => item.permissionOverwrites.edit(role.id, {
        ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true,
      })),
      forumChannel.permissionOverwrites.edit(role.id, {
        ViewChannel: true, ReadMessageHistory: true, SendMessagesInThreads: true,
      }),
    ]);
    await Promise.all(openTickets.map((channel) => channel.permissionOverwrites.edit(role.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true,
    })));
    return interaction.editReply(`✅ O cargo ${role} agora pode acessar o Fórum e atender tickets.`);
  }
  await Promise.all([
    ...ticketCategories.map((item) => item.permissionOverwrites.delete(role.id).catch(() => {})),
    forumChannel.permissionOverwrites.delete(role.id).catch(() => {}),
    ...openTickets.map((channel) => channel.permissionOverwrites.delete(role.id).catch(() => {})),
  ]);
  return interaction.editReply(`✅ O acesso do cargo ${role} foi removido.`);
}

async function listTicketRoles(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: '❌ Somente administradores podem consultar os cargos autorizados.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { forumChannel } = await ensureStructure(interaction.guild);
  const roles = ticketStaffRoles(interaction.guild, forumChannel);
  return interaction.editReply(roles.length
    ? `🎫 **Cargos autorizados:**\n${roles.map((role) => `• ${role}`).join('\n')}`
    : 'ℹ️ Nenhum cargo autorizado. Apenas administradores possuem acesso.');
}

client.once(Events.ClientReady, async (readyClient) => {
  try {
    await loadRuntimeConfiguration();
    updateBotPresence(readyClient.user);
    await loadMaintenanceState();
    await registerCommands();
    const guild = readyClient.guilds.cache.get(process.env.GUILD_ID)
      || await readyClient.guilds.fetch(process.env.GUILD_ID);
    await warmTicketStructureCache(guild).catch((error) => {
      logOperationalError('Não foi possível preparar a estrutura de tickets', error);
    });
    await migrateLegacyAlertChannel(guild).catch((error) => {
      logOperationalError('Não foi possível mover os alertas para o fórum', error);
    });
    const configuredPanel = process.env.TICKET_PANEL_ID
      ? await guild.channels.fetch(process.env.TICKET_PANEL_ID).catch(() => null)
      : null;
    if (configuredPanel?.isSendable()) {
      await publishTicketPanel(configuredPanel).catch((error) => {
        logOperationalError('Não foi possível atualizar automaticamente o painel público', error);
      });
    }
    setTimeout(() => { void checkTicketActivity(); }, 60_000).unref?.();
    setInterval(() => { void checkTicketActivity(); }, INACTIVITY.checkMs).unref?.();
    console.log(`🎫 Orbyn Tickets v1.6.0 online como ${readyClient.user.tag}. Comandos registrados.`);
  } catch (error) {
    logOperationalError('Não foi possível inicializar ou registrar os comandos', error);
  }
});

client.on(Events.Error, (error) => {
  logOperationalError('Erro interno do cliente do Discord', error);
});

client.on(Events.Warn, (warning) => {
  console.warn(`[DISCORD] ${warning}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isStringSelectMenu() && interaction.customId === 'config:model') {
      return await updateTicketModel(interaction);
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket:select') {
      if (maintenanceMode) {
        return interaction.reply({ content: '🛠️ O sistema de tickets está temporariamente em manutenção.', flags: MessageFlags.Ephemeral });
      }
      const typeKey = interaction.values[0];
      if (!TICKET_TYPES[typeKey]) return interaction.reply({ content: '❌ Departamento inválido.', flags: MessageFlags.Ephemeral });
      await interaction.showModal(ticketForm(typeKey));
      void interaction.message.edit(ticketPanel()).catch((error) => {
        console.warn(`[PAINEL] Não foi possível restaurar o menu: ${error.message}`);
      });
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket:form:')) {
      return await submitTicket(interaction, interaction.customId.split(':')[2], {
        details: interaction.fields.getTextInputValue('detalhes'),
      });
    }
    if (interaction.isModalSubmit() && interaction.customId === 'config:identity-form') {
      return await saveIdentityConfiguration(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket:rename_modal:')) return await renameTicket(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket:close-form:')) return await finalizeTicketClose(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith('feedback:form:')) return await recordFeedback(interaction);

    if (interaction.isButton()) {
      if (interaction.customId === 'config:identity') {
        if (!isAdministrator(interaction)) {
          return interaction.reply({ content: 'Somente administradores podem alterar a configuração.', flags: MessageFlags.Ephemeral });
        }
        return await interaction.showModal(identityConfigurationModal());
      }
      if (interaction.customId === 'config:toggle-transcript') return await togglePrivateTranscript(interaction);
      if (interaction.customId === 'ticket:claim') return await claimTicket(interaction);
      if (interaction.customId === 'ticket:manage') return await openTicketManagement(interaction);
      if (interaction.customId.startsWith('feedback:score:')) {
        const [, , channelId, typeKey, ownerId, score] = interaction.customId.split(':');
        if (interaction.user.id !== ownerId) return interaction.reply({ content: '❌ Esta avaliação pertence ao solicitante.', flags: MessageFlags.Ephemeral });
        return await interaction.showModal(feedbackForm(channelId, typeKey, ownerId, score));
      }
      if (interaction.customId === 'ticket:close') return await requestTicketClose(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('ticket:manage_action:')) {
      return await selectTicketManagementAction(interaction);
    }

    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('ticket:manage_member:')) {
      return await updateTicketParticipant(interaction);
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'instalar-tickets') return await installTicketSystem(interaction);
    if (interaction.commandName === 'configurar-tickets') return await showTicketConfiguration(interaction);
    if (interaction.commandName === 'painel-tickets') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Somente administradores podem publicar ou atualizar o painel.', flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await ensureStructure(interaction.guild);
      const configuredPanel = process.env.TICKET_PANEL_ID
        ? await interaction.guild.channels.fetch(process.env.TICKET_PANEL_ID).catch(() => null)
        : null;
      const panelChannel = configuredPanel?.isSendable() ? configuredPanel : interaction.channel;
      if (!panelChannel?.isSendable()) return interaction.editReply('❌ O canal público do painel não foi encontrado. Execute `/instalar-tickets`.');
      await publishTicketPanel(panelChannel);
      return interaction.editReply('✅ Fórum configurado e painel de tickets publicado ou atualizado.');
    }
    if (interaction.commandName === 'manutencao-tickets') return await setTicketMaintenance(interaction);
    if (interaction.commandName === 'autorizar-cargo') return await updateTicketRoleAccess(interaction, true);
    if (interaction.commandName === 'desautorizar-cargo') return await updateTicketRoleAccess(interaction, false);
    if (interaction.commandName === 'cargos-tickets') return await listTicketRoles(interaction);
    if (interaction.commandName === 'fechar-ticket') return await requestTicketClose(interaction);
    if (interaction.commandName === 'adicionar' || interaction.commandName === 'remover') {
      if (!isTicketChannel(interaction.channel)) {
        return interaction.reply({ content: '❌ Este comando só pode ser usado dentro de um ticket.', flags: MessageFlags.Ephemeral });
      }
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Somente administradores podem usar estes comandos diretos.', flags: MessageFlags.Ephemeral });
      }
      const user = interaction.options.getUser('usuario', true);
      if (user.bot || user.id === ticketMetadata(interaction.channel).ownerId) {
        return interaction.reply({ content: '❌ Esta pessoa não pode ser alterada por este comando.', flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (interaction.commandName === 'adicionar') {
        await interaction.channel.permissionOverwrites.edit(user.id, {
          ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true,
        });
        return interaction.editReply(`✅ ${user} foi adicionado ao ticket.`);
      }
      await interaction.channel.permissionOverwrites.delete(user.id);
      return interaction.editReply(`✅ ${user} foi removido do ticket.`);
    }
  } catch (error) {
    const reference = logOperationalError(
      `Interação ${interaction.id || 'sem-id'} de ${interaction.user?.id || 'usuário-desconhecido'}`,
      error,
    );
    const message = [50001, 50013].includes(error.code)
      ? '❌ Falta acesso ao Fórum `📰・tickets`. Libere **Ver canal**, **Ver histórico de mensagens**, **Enviar mensagens em tópicos** e **Gerenciar tópicos** para o bot.'
      : error.userMessage || `❌ Não consegui concluir a operação. Informe o código **${reference}** à administração.`;
    if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {});
    else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

process.on('unhandledRejection', (reason) => {
  logOperationalError('Promise rejeitada sem tratamento', reason);
});

process.on('uncaughtException', (error) => {
  logOperationalError('Erro fatal não capturado; reinício solicitado', error);
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SISTEMA] ${signal} recebido; encerrando conexão com segurança.`);
  client.destroy();
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

client.on('channelDelete', (channel) => deleteTicketRecord(channel.id));

client.login(process.env.DISCORD_TOKEN);
