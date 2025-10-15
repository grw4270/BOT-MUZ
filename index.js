require('dotenv').config();
const { Partials, Events, InteractionType, MessageFlags } = require('discord.js');
process.env.DISCORDJS_VOICE_FORCE_WS = "true";
process.env.FORCE_IPV4 = "true";


const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Client, GatewayIntentBits, ActionRowBuilder, StringSelectMenuBuilder, ComponentType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection } = require('@discordjs/voice');

const TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; // ID użytkownika, który może używać komend

const MUSIC_DIR = path.join(__dirname, 'music');
const DEFAULT_DIR = path.join(MUSIC_DIR, 'default');
const SERVERS_FILE = path.join(__dirname, 'serwery.txt');
const COM_DIR = path.join(MUSIC_DIR, 'com');

if (!TOKEN || !ALLOWED_USER_ID) {
  console.error('❌ Brakuje DISCORD_TOKEN lub ALLOWED_USER_ID w .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates]
});

const connectionMap = new Map();
const initializing = { done: false };

// ===== HELPERY =====
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function log(msg) {
  const ts = new Date().toISOString().replace('T',' ').split('.')[0];
  console.log(`[${ts}] ${msg}`);
}

function pickRandomAudioFromDir(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => ['mp3','wav','m4a','ogg'].includes(f.split('.').pop().toLowerCase()));
  if (!files.length) return null;
  return path.join(dir, files[Math.floor(Math.random()*files.length)]);
}


// ===== AKTUALIZACJA KOMEND /PLAY =====
async function updateSlashCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    const serversFile = path.join(__dirname, 'serwery.txt');
    const comDir = path.join(MUSIC_DIR, 'com');

    // === Czytamy serwery z serwery.txt ===
    let servers = [];
    if (fs.existsSync(serversFile)) {
      servers = fs.readFileSync(serversFile, 'utf8').split('\n').filter(Boolean);
    }

    // === Czytamy pliki audio z /com ===
    let files = [];
    if (fs.existsSync(comDir)) {
      files = fs.readdirSync(comDir).filter(f => /\.(mp3|wav|m4a|ogg|flac)$/i.test(f));
    }

    const commands = [
      new SlashCommandBuilder().setName('ping').setDescription('Sprawdza działanie bota'),
      new SlashCommandBuilder().setName('status').setDescription('Pokazuje status odtwarzania'),
      new SlashCommandBuilder().setName('unmute').setDescription('Odmutowuje bota'),
      new SlashCommandBuilder()
        .setName('play')
        .setDescription('Odtwarza dźwięk na wybranym serwerze')
        .addStringOption(o => {
          o.setName('server_id')
            .setDescription('Wybierz serwer z listy')
            .setRequired(false);
          for (const line of servers.slice(0, 25)) {
            const id = line.split(' - ')[0];
              const name = line.substring(line.indexOf(' - ') + 3) || id;
            o.addChoices({ name, value: id });
          }
          return o;
        })
        .addStringOption(o => {
          o.setName('plik')
            .setDescription('Plik do odtworzenia z folderu /com')
            .setRequired(false);
          for (const f of files.slice(0, 25)) o.addChoices({ name: f, value: f });
          return o;
        }),
    ].map(c => c.toJSON());

    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    log(`✅ Zaktualizowano komendy globalne (/play): ${servers.length} serwerów, ${files.length} plików.`);
  } catch (err) {
    console.error('❌ Błąd podczas aktualizacji komend:', err);
  }
}

// === Obsługa usunięcia bota z serwera ===
client.on('guildDelete', guild => {
  const folderName = `${guild.id} - ${guild.name}`;
  const serverDir = path.join(MUSIC_DIR, folderName);

  if (fs.existsSync(serverDir)) {
    fs.rmSync(serverDir, { recursive: true, force: true });
    log(`🗑️ Usunięto folder serwera: ${guild.name}`);
  }

  if (fs.existsSync(SERVERS_FILE)) {
    let servers = fs.readFileSync(SERVERS_FILE, 'utf8').split('\n').filter(Boolean);
    const before = servers.length;
    servers = servers.filter(line => !line.startsWith(guild.id));
    if (servers.length < before) {
      fs.writeFileSync(SERVERS_FILE, servers.join('\n'), 'utf8');
      log(`🗑️ Usunięto wpis serwera: ${guild.name}`);
    }
  }

  updateSlashCommands();
});

// ===== INICJALIZACJA =====
// ===== SYNC / SERWERY =====
async function syncServers() {
  ensureDir(MUSIC_DIR);
  if (!fs.existsSync(SERVERS_FILE)) fs.writeFileSync(SERVERS_FILE, '', 'utf8');

  const currentGuilds = new Map(client.guilds.cache.map(g => [g.id, g.name]));
  let servers = fs.readFileSync(SERVERS_FILE, 'utf8').split('\n').filter(Boolean);
  const knownIds = new Set(servers.map(line => line.split(' - ')[0]?.trim()));

  // --- Dodaj brakujące serwery ---
  for (const [id, name] of currentGuilds.entries()) {
    if (!knownIds.has(id)) {
      const folderName = `${id} - ${name}`;
      const serverDir = path.join(MUSIC_DIR, folderName);
      ensureDir(serverDir);
      const prefix = fs.readFileSync(SERVERS_FILE, 'utf8').endsWith('\n') ? '' : '\n';
fs.appendFileSync(SERVERS_FILE, `${prefix}${id} - ${name}\n`);
      log(`📁 Dodano brakujący serwer: ${name}`);
    }
  }

  // --- Usuń nieaktualne wpisy ---
  const validIds = new Set(currentGuilds.keys());
  const updated = servers.filter(line => validIds.has(line.split(' - ')[0]?.trim()));
  if (updated.length < servers.length) {
    fs.writeFileSync(SERVERS_FILE, updated.join('\n'), 'utf8');
    log(`🧹 Usunięto ${servers.length - updated.length} nieaktualnych wpisów z serwery.txt`);
  }

  // --- Usuń foldery dla nieistniejących serwerów ---
  const entries = fs.readdirSync(MUSIC_DIR, { withFileTypes: true });
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const [id] = d.name.split(' - ');
    if (!validIds.has(id) && !['com', 'default'].includes(d.name)) {
      fs.rmSync(path.join(MUSIC_DIR, d.name), { recursive: true, force: true });
      log(`🗑️ Usunięto folder starego serwera: ${d.name}`);
    }
  }

  await updateSlashCommands();
}

// ===== GŁÓWNY START BOTA =====
client.once('ready', async () => {
  log(`✅ Zalogowano jako ${client.user.tag}`);
  ensureDir(MUSIC_DIR);
  ensureDir(DEFAULT_DIR);
  ensureDir(COM_DIR);
  if (!fs.existsSync(SERVERS_FILE)) fs.writeFileSync(SERVERS_FILE, '', 'utf8');

  await syncServers(); // 🔁 automatyczna synchronizacja na starcie
  initializing.done = true;
});

// === Obsługa dołączenia bota do nowego serwera ===
client.on('guildCreate', guild => {
  ensureDir(MUSIC_DIR);
  const folderName = `${guild.id} - ${guild.name}`;
  const serverDir = path.join(MUSIC_DIR, folderName);
  ensureDir(serverDir);

  if (!fs.existsSync(SERVERS_FILE)) fs.writeFileSync(SERVERS_FILE, '', 'utf8');
  const servers = fs.readFileSync(SERVERS_FILE, 'utf8').split('\n').filter(Boolean);

  if (!servers.some(line => line.startsWith(guild.id))) {
    const prefix = fs.readFileSync(SERVERS_FILE, 'utf8').endsWith('\n') ? '' : '\n';
    fs.appendFileSync(SERVERS_FILE, `${prefix}${guild.id} - ${guild.name}\n`);

    log(`📁 Utworzono folder i wpisano nowy serwer: ${guild.name}`);
  }
  updateSlashCommands();
});

// === Obsługa usunięcia bota z serwera ===
client.on('guildDelete', guild => {
  const folderName = `${guild.id} - ${guild.name}`;
  const serverDir = path.join(MUSIC_DIR, folderName);

  if (fs.existsSync(serverDir)) {
    fs.rmSync(serverDir, { recursive: true, force: true });
    log(`🗑️ Usunięto folder serwera: ${guild.name}`);
  }

  if (fs.existsSync(SERVERS_FILE)) {
    let servers = fs.readFileSync(SERVERS_FILE, 'utf8').split('\n').filter(Boolean);
    const before = servers.length;
    servers = servers.filter(line => !line.startsWith(guild.id));
    if (servers.length < before) {
      fs.writeFileSync(SERVERS_FILE, servers.join('\n'), 'utf8');
      log(`🗑️ Usunięto wpis serwera: ${guild.name}`);
    }
  }
  updateSlashCommands();
});




// ===== KONSOLE =====
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', async (input) => {
  const cmd = input.trim().toLowerCase();
  if (cmd === 'reload') {
    log('🔄 Przeładowanie komend globalnych...');
    require('./register-commands.js');
  }
});

// ===== ODTWARZANIE =====
function playAndLeave(channel, file) {
  const guildId = channel.guild.id;
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  const resource = createAudioResource(file);
  connection.subscribe(player);
  connectionMap.set(guildId, { connection, player, currentlyPlayingFile: path.basename(file), channelId: channel.id });

  log(`🎵 Odtwarzanie: ${path.basename(file)} na ${channel.guild.name}`);
  player.play(resource);

  player.once(AudioPlayerStatus.Idle, () => {
    log(`🛑 Odtwarzanie zakończone (${channel.guild.name}) — rozłączanie`);
    try { connection.destroy(); } catch {}
    connectionMap.delete(guildId);
  });

  player.on('error', err => { log(`⚠️ AudioPlayer błąd (${channel.guild.name}): ${err.message}`); try { connection.destroy(); } catch {} connectionMap.delete(guildId); });
}

// ===== VOICE STATE UPDATE =====
client.on('voiceStateUpdate', (oldState, newState) => {
  if (!initializing.done) return;
  if (!oldState.channelId && newState.channelId) {
    const channel = newState.channel;
    if (!channel) return;
    const memberCount = channel.members.filter(m => !m.user.bot).size;
    if (memberCount === 1 && !getVoiceConnection(channel.guild.id)) {
      const file = pickRandomAudioFromDir(path.join(MUSIC_DIR, `${channel.guild.id} - ${channel.guild.name}`)) || pickRandomAudioFromDir(DEFAULT_DIR);
      if (file) playAndLeave(channel, file);
    }
  }
});

// ===== KOMENDY SLASH =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.user.id !== ALLOWED_USER_ID) {
    await interaction.reply({ content: '⛔ Nie masz uprawnień.', flags: MessageFlags.Ephemeral });
    return;
  }

  const cmd = interaction.commandName;

  if (cmd === 'ping') await interaction.reply('🏓 Pong! Bot działa.');
  
  else if (cmd === 'status') {
      if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ ephemeral: true });
      }

      let text = '--- STATUS ---\n';
      if (!connectionMap.size) text += 'Brak aktywnych połączeń głosowych.';
      else for (const [guildId,obj] of connectionMap.entries())
        text += `Serwer: ${guildId} | Kanał: ${obj.channelId} | Plik: ${obj.currentlyPlayingFile}\n`;

      try {
          await interaction.user.send(text);
          await interaction.followUp({ content: '✅ Status wysłany w DM.', ephemeral: true });
      } catch {
          await interaction.followUp({ content: '❌ Nie udało się wysłać DM.', ephemeral: true });
      }
  }

  else if (cmd === 'unmute') {
      if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ ephemeral: true });
      }

      for (const guild of client.guilds.cache.values()) {
        try {
          const me = guild.members.me ?? await guild.members.fetch(client.user.id);
          if (me.voice?.channel) await me.voice.setMute(false);
        } catch {}
      }

      await interaction.followUp({
        content: `🔊 Bot odmutowany.`,
        ephemeral: true
      });
  }
  
  else if (cmd === 'play') {
    const serverId = interaction.options.getString('server_id');
    const fileName = interaction.options.getString('plik');

    const serversList = fs.existsSync(SERVERS_FILE) ? fs.readFileSync(SERVERS_FILE,'utf8').split('\n').filter(Boolean) : [];
    const comFiles = fs.existsSync(COM_DIR) ? fs.readdirSync(COM_DIR).filter(f=>f.toLowerCase().endsWith('.mp3')) : [];

    let chosenGuild = serverId ? client.guilds.cache.get(serverId) : null;
    if (!chosenGuild && serversList.length) {
      chosenGuild = client.guilds.cache.get(serversList[0].split(' - ')[0]);
    }

    if (!chosenGuild) {
      await interaction.reply({ content: '❌ Brak dostępnego serwera.', flags: MessageFlags.Ephemeral });
      return;
    }

    const chosenFile = fileName || comFiles[0];
    if (!chosenFile) {
      await interaction.reply({ content: '❌ Brak plików MP3 w Folderze komentarzy', flags: MessageFlags.Ephemeral });
      return;
    }

    // Wybór kanału z największą liczbą użytkowników
    const voiceChannels = chosenGuild.channels.cache.filter(c=>c.type===2);
    let targetChannel = null, maxMembers = 0;
    for (const ch of voiceChannels.values()) {
      const count = ch.members.filter(m=>!m.user.bot).size;
      if (count > maxMembers) { maxMembers = count; targetChannel = ch; }
    }

    if (!targetChannel) {
      await interaction.reply({ content: '❌ Brak aktywnych kanałów głosowych.', flags: MessageFlags.Ephemeral });
      return;
    }

    const trackName = chosenFile;
    const guildName = chosenGuild.name;

    if (!interaction.replied && !interaction.deferred) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    playAndLeave(targetChannel, path.join(COM_DIR, chosenFile));

    await interaction.followUp({
      content: `🎵 Odtworzyłem **${trackName}** na serwerze **${guildName}**`,
      flags: MessageFlags.Ephemeral
    });
  }
});

client.login(TOKEN);
