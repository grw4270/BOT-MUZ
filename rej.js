require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const MUSIC_DIR = path.join(__dirname, 'music');
const COM_DIR = path.join(MUSIC_DIR, 'com');
const SERVERS_FILE = path.join(__dirname, 'serwery.txt');

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ Brakuje DISCORD_TOKEN lub CLIENT_ID w .env');
  process.exit(1);
}

function getCommandsJSON() {
  if (!fs.existsSync(COM_DIR)) fs.mkdirSync(COM_DIR, { recursive: true });
  const files = fs.readdirSync(COM_DIR).filter(f => f.toLowerCase().endsWith('.mp3'));
  const servers = fs.existsSync(SERVERS_FILE)
    ? fs.readFileSync(SERVERS_FILE, 'utf8').split('\n').filter(Boolean)
    : [];

  const commands = [
    new SlashCommandBuilder().setName('ping').setDescription('Sprawdza czy bot działa'),
    new SlashCommandBuilder().setName('status').setDescription('Pokazuje status odtwarzania (tylko właściciel)'),
    new SlashCommandBuilder().setName('unmute').setDescription('Odmutowuje bota na wszystkich serwerach (tylko właściciel)'),
    new SlashCommandBuilder()
      .setName('play')
      .setDescription('Odtwarza wybrany plik na wybranym serwerze')
      .addStringOption(option =>
        option.setName('server_id')
          .setDescription('Wybierz serwer')
          .setRequired(false)
          .addChoices(...servers.map(s => {
            const name = s.split(' - ')[1] || s;
            const id = s.split(' - ')[0];
            return { name, value: id };
          }))
      )
      .addStringOption(option =>
        option.setName('plik')
          .setDescription('Wybierz plik MP3')
          .setRequired(false)
          .addChoices(...files.map(f => ({ name: f, value: f }))))
  ];

  return commands.map(c => c.toJSON());
}

(async () => {
  console.log('⏳ Rejestruję komendy globalnie...');
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: getCommandsJSON() });
    console.log('✅ Komendy zarejestrowane globalnie!');
  } catch (err) {
    console.error('❌ Błąd rejestracji komend:', err);
  }
})();
