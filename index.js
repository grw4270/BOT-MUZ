require('dotenv').config({ path: '../.env' });
// Zmieniamy import fs na asynchroniczną wersję promises
const fs = require('fs/promises'); 
const fsSync = require('fs'); // Pozostawiamy synchroniczną wersję dla operacji, które muszą działać przed inicjalizacją

const { Partials, Events, InteractionType, MessageFlags } = require('discord.js');
// Wymuszenie IPv4 i WebSocket dla stabilności połączeń głosowych
process.env.DISCORDJS_VOICE_FORCE_WS = "true";
process.env.FORCE_IPV4 = "true";


const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const path = require('path');
const readline = require('readline');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection } = require('@discordjs/voice');

const TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.OWNER_ID; // ID użytkownika, który może używać komend

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

// ===== HELPERY I NARZĘDZIA SYNC =====
// Używamy wersji synchronicznej, bo często jest wywoływana na wczesnym etapie ładowania.
function ensureDir(dir) { if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true }); }

function log(msg) {
  const ts = new Date().toISOString().replace('T',' ').split('.')[0];
  console.log(`[${ts}] ${msg}`);
}

// Używamy wersji synchronicznej, bo to ma być szybka, niezależna funkcja
function pickRandomAudioFromDir(dir) {
  if (!fsSync.existsSync(dir)) return null;
  const files = fsSync.readdirSync(dir).filter(f => ['mp3','wav','m4a','ogg'].includes(f.split('.').pop().toLowerCase()));
  if (!files.length) return null;
  return path.join(dir, files[Math.floor(Math.random()*files.length)]);
}


// ===== AKTUALIZACJA KOMEND (SLASH COMMANDS) - ASYNCHRONICZNIE =====
async function updateSlashCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    
    // ASYNCHRONICZNY odczyt plików, by nie blokować wątku
    let servers = [];
    if (fsSync.existsSync(SERVERS_FILE)) {
      servers = (await fs.readFile(SERVERS_FILE, 'utf8')).split('\n').filter(Boolean);
    }

    let files = [];
    if (fsSync.existsSync(COM_DIR)) {
      files = (await fs.readdir(COM_DIR)).filter(f => /\.(mp3|wav|m4a|ogg|flac)$/i.test(f));
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
    log(`✅ Zaktualizowano komendy globalne.`);
  } catch (err) {
    console.error('❌ Błąd podczas aktualizacji komend:', err);
  }
}


// ===== SYNC SERWERÓW (ASYNCHRONICZNIE) =====
async function syncServers() {
  ensureDir(MUSIC_DIR); 
  ensureDir(DEFAULT_DIR);
  ensureDir(COM_DIR);
  if (!fsSync.existsSync(SERVERS_FILE)) await fs.writeFile(SERVERS_FILE, '', 'utf8');

  const currentGuilds = new Map(client.guilds.cache.map(g => [g.id, g.name]));
  let servers = (await fs.readFile(SERVERS_FILE, 'utf8')).split('\n').filter(Boolean);
  const knownIds = new Set(servers.map(line => line.split(' - ')[0]?.trim()));

  // --- Dodaj brakujące serwery ---
  for (const [id, name] of currentGuilds.entries()) {
    if (!knownIds.has(id)) {
      const folderName = `${id} - ${name}`;
      const serverDir = path.join(MUSIC_DIR, folderName);
      await fs.mkdir(serverDir, { recursive: true });
      await fs.appendFile(SERVERS_FILE, `${id} - ${name}\n`);
      log(`📁 Dodano brakujący serwer: ${name}`);
    }
  }

  // --- Usuń nieaktualne wpisy ---
  const validIds = new Set(currentGuilds.keys());
  const updated = servers.filter(line => validIds.has(line.split(' - ')[0]?.trim()));
  if (updated.length < servers.length) {
    await fs.writeFile(SERVERS_FILE, updated.join('\n'), 'utf8');
    log(`🧹 Usunięto ${servers.length - updated.length} nieaktualnych wpisów z serwery.txt`);
  }

  // --- Usuń foldery dla nieistniejących serwerów ---
  try {
    const entries = await fs.readdir(MUSIC_DIR, { withFileTypes: true });
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      const [id] = d.name.split(' - ');
      if (!validIds.has(id) && !['com', 'default'].includes(d.name)) {
        await fs.rm(path.join(MUSIC_DIR, d.name), { recursive: true, force: true });
        log(`🗑️ Usunięto folder starego serwera: ${d.name}`);
      }
    }
  } catch (e) {
    console.error('Błąd podczas czyszczenia folderów muzycznych:', e);
  }

  await updateSlashCommands();
}

// ===== ZDARZENIA SERWERÓW (ASYNCHRONICZNIE) =====
client.on('guildDelete', async guild => {
  const folderName = `${guild.id} - ${guild.name}`;
  const serverDir = path.join(MUSIC_DIR, folderName);

  if (fsSync.existsSync(serverDir)) {
    try {
      await fs.rm(serverDir, { recursive: true, force: true });
      log(`🗑️ Usunięto folder serwera: ${guild.name}`);
    } catch (err) { console.error('Błąd usuwania folderu:', err); }
  }

  if (fsSync.existsSync(SERVERS_FILE)) {
    try {
      let servers = (await fs.readFile(SERVERS_FILE, 'utf8')).split('\n').filter(Boolean);
      const before = servers.length;
      servers = servers.filter(line => !line.startsWith(guild.id));
      if (servers.length < before) {
        await fs.writeFile(SERVERS_FILE, servers.join('\n'), 'utf8');
        log(`🗑️ Usunięto wpis serwera: ${guild.name}`);
      }
    } catch (err) { console.error('Błąd aktualizacji serwery.txt:', err); }
  }

  updateSlashCommands();
});

client.on('guildCreate', async guild => {
  ensureDir(MUSIC_DIR);
  const folderName = `${guild.id} - ${guild.name}`;
  const serverDir = path.join(MUSIC_DIR, folderName);
  ensureDir(serverDir);

  if (!fsSync.existsSync(SERVERS_FILE)) await fs.writeFile(SERVERS_FILE, '', 'utf8');
  const servers = (await fs.readFile(SERVERS_FILE, 'utf8')).split('\n').filter(Boolean);

  if (!servers.some(line => line.startsWith(guild.id))) {
    await fs.appendFile(SERVERS_FILE, `${guild.id} - ${guild.name}\n`);
    log(`📁 Utworzono folder i wpisano nowy serwer: ${guild.name}`);
  }
  updateSlashCommands();
});


// ===== GŁÓWNY START BOTA =====
client.once('ready', async () => {
  log(`✅ Zalogowano jako ${client.user.tag}`);
  
  // Używamy synchronicznych ensureDir tylko na początkowym etapie
  ensureDir(MUSIC_DIR); 
  ensureDir(DEFAULT_DIR);
  ensureDir(COM_DIR);
  
  await syncServers(); 
  initializing.done = true;
});


// ===== ODTWARZANIE AUDIO (BEZ ZMIAN) =====
function playAndLeave(channel, file) {
  const guildId = channel.guild.id;
  
  const existingConnection = getVoiceConnection(guildId);
  if (existingConnection) {
    existingConnection.destroy();
    connectionMap.delete(guildId);
  }
  
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

  player.on('error', err => { 
    log(`⚠️ AudioPlayer błąd (${channel.guild.name}): ${err.message}`); 
    try { connection.destroy(); } catch {} 
    connectionMap.delete(guildId); 
  });
}

// ===== VOICE STATE UPDATE (Automatyczne odtwarzanie) =====
client.on('voiceStateUpdate', (oldState, newState) => {
  if (!initializing.done) return;
  
  if (!oldState.channelId && newState.channelId) {
    const channel = newState.channel;
    if (!channel) return;
    
    const nonBotMembers = channel.members.filter(m => !m.user.bot);
    if (nonBotMembers.size === 1) {
      const isJoiningUser = nonBotMembers.firstKey() === newState.member.id;
      
      if (isJoiningUser && !getVoiceConnection(channel.guild.id)) {
        const file = pickRandomAudioFromDir(path.join(MUSIC_DIR, `${channel.guild.id} - ${channel.guild.name}`)) || pickRandomAudioFromDir(DEFAULT_DIR);
        if (file) playAndLeave(channel, file);
      }
    }
  }
});

// ===== OBSŁUGA KOMEND SLASH (Z ODPORNOŚCIĄ NA BŁĄD 10062) =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return; 

  const cmd = interaction.commandName;
  
  // 1. Sprawdzenie uprawnień. Jeśli brak, wysyłamy szybką, jednorazową odpowiedź.
  if (interaction.user.id !== ALLOWED_USER_ID) {
    try {
      await interaction.reply({ content: '⛔ Nie masz uprawnień.', ephemeral: true });
    } catch (e) {
      // Jeśli nawet to się nie uda (bo minęło 3s), cicho ignorujemy 10062
      if (e.code === 10062) return; 
      console.error('Błąd przy próbie szybkiej odpowiedzi dla nieuprawnionego użytkownika:', e);
    }
    return;
  }
  
  // 2. Natychmiastowe odroczenie (deferReply) dla uprawnionych komend. 
  // To musi być PIERWSZA rzecz dla uprawnionego użytkownika, aby zapobiec 10062.
  try {
    await interaction.deferReply({ ephemeral: true }); 
  } catch (e) {
    // Jeśli defer nie zadziała (interakcja jest zbyt stara), logujemy i kończymy.
    if (e.code === 10062) {
      console.log(`[TIMEOUT] Interakcja dla /${cmd} jest zbyt stara. Zignorowano błąd 10062.`);
      return; 
    }
    console.error('Błąd przy deferReply:', e);
    return;
  }

  try {
    if (cmd === 'ping') {
      await interaction.editReply('🏓 Pong! Bot działa.');
    }
    else if (cmd === 'status') {
      let text = '--- STATUS AKTYWNYCH POŁĄCZEŃ ---\n';
      if (!connectionMap.size) {
        text += 'Brak aktywnych połączeń głosowych.';
      } else {
        for (const [guildId, obj] of connectionMap.entries()) {
          const guildName = client.guilds.cache.get(guildId)?.name || guildId;
          text += `**Serwer:** ${guildName}\n`;
          text += `**Kanał ID:** ${obj.channelId}\n`;
          text += `**Plik:** ${obj.currentlyPlayingFile}\n\n`;
        }
      }
      await interaction.editReply({ content: text }); 
    }
    else if (cmd === 'unmute') {
      let unmutedCount = 0;
      for (const guild of client.guilds.cache.values()) {
        try {
          const me = guild.members.me ?? await guild.members.fetch(client.user.id);
          if (me.voice?.channel && me.voice.mute) {
            await me.voice.setMute(false);
            unmutedCount++;
          }
        } catch {}
      }
      await interaction.editReply(`🔊 Bot odmutowany na ${unmutedCount} serwerach.`);
    }
    else if (cmd === 'play') {
      const serverId = interaction.options.getString('server_id');
      const fileName = interaction.options.getString('plik');

      // ASYNCHRONICZNY odczyt plików (minimalizujemy blokowanie)
      const serversList = fsSync.existsSync(SERVERS_FILE) ? (await fs.readFile(SERVERS_FILE,'utf8')).split('\n').filter(Boolean) : [];
      const comFiles = fsSync.existsSync(COM_DIR) ? (await fs.readdir(COM_DIR)).filter(f=>f.toLowerCase().endsWith('.mp3')) : [];

      let chosenGuild = serverId ? client.guilds.cache.get(serverId) : null;
      if (!chosenGuild && serversList.length) {
        chosenGuild = client.guilds.cache.get(serversList[0].split(' - ')[0]);
      }

      if (!chosenGuild) {
        await interaction.editReply({ content: '❌ Brak dostępnego serwera do odtworzenia.', ephemeral: true });
        return;
      }

      const chosenFile = fileName || comFiles[0];
      if (!chosenFile) {
        await interaction.editReply({ content: '❌ Brak plików MP3 w music/com lub nie wybrano pliku.', ephemeral: true });
        return;
      }

      // Wybór kanału
      const voiceChannels = chosenGuild.channels.cache.filter(c=>c.type===2);
      let targetChannel = null, maxMembers = 0;
      for (const ch of voiceChannels.values()) {
        const count = ch.members.filter(m=>!m.user.bot).size;
        if (count > maxMembers) { maxMembers = count; targetChannel = ch; }
      }

      if (!targetChannel) {
        await interaction.editReply({ content: `❌ Brak aktywnych kanałów głosowych z użytkownikami na serwerze ${chosenGuild.name}.`, ephemeral: true });
        return;
      }

      playAndLeave(targetChannel, path.join(COM_DIR, chosenFile));
      
      await interaction.editReply({ content: `🎵 Odtwarzam **${chosenFile}** na serwerze **${chosenGuild.name}** (kanał: ${targetChannel.name})`, ephemeral: true });
    }
  } catch (error) {
    console.error(`Błąd w komendzie ${cmd}:`, error);
    // Informujemy użytkownika o błędzie tylko jeśli interakcja została pomyślnie zaakceptowana (deferred/replied)
    if (interaction.deferred || interaction.replied) {
      try {
        await interaction.editReply({ content: `❌ Wystąpił błąd krytyczny podczas wykonywania komendy ${cmd}.`, ephemeral: true });
      } catch { /* ignore if edit fails */ }
    }
  }
});

client.login(TOKEN);