// ===== LIBSODIUM INIT =====
const sodium = require('libsodium-wrappers');
sodium.ready.then(() => console.log('✅ libsodium ready'));

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Client } = require('discord.js-selfbot-v13');
const { HttpsProxyAgent } = require('https-proxy-agent');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType
} = require('@discordjs/voice');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);
console.log('✅ FFmpeg path:', ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });
const bots = new Map();
let loopEnabled = false;

// ============ ADD TOKEN (with proxy) ============
app.post('/api/token', async (req, res) => {
  const { token, proxy } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  if (bots.has(token)) return res.json({ status: 'ready', tag: bots.get(token).client.user?.tag, total: bots.size });

  const clientOptions = { checkUpdate: false };

  // ✅ Proxy support
  if (proxy && proxy.trim()) {
    try {
      const agent = new HttpsProxyAgent(proxy.trim());
      clientOptions.http = { agent };
      clientOptions.ws = { agent };
      console.log(`🌐 Proxy set: ${proxy}`);
    } catch (e) {
      console.error(`❌ Proxy error: ${e.message}`);
      return res.status(400).json({ status: 'error', error: 'Invalid proxy format' });
    }
  } else {
    console.log(`⚠️ No proxy for token ${token.slice(0, 10)}...`);
  }

  const client = new Client(clientOptions);
  try {
    await client.login(token);
    bots.set(token, { client, connection: null, player: null, channelId: null, proxy });
    console.log(`✅ ${client.user.tag} (Total: ${bots.size})${proxy ? ' [PROXY]' : ''}`);
    res.json({ status: 'ready', tag: client.user.tag, total: bots.size, proxied: !!proxy });
  } catch (err) {
    console.error(`❌ Token error: ${err.message}`);
    res.status(400).json({ status: 'error', error: 'Invalid token or proxy failed' });
  }
});

// ============ JOIN ALL ============
app.post('/api/joinall', async (req, res) => {
  const { guildId, channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'Channel ID required' });
  console.log(`=== JOIN ALL === ${bots.size} bots → ${channelId}`);

  const results = [];

  for (const [token, bot] of bots.entries()) {
    try {
      const channel = await bot.client.channels.fetch(channelId);
      if (!channel) { results.push({ tag: bot.client.user.tag, status: 'not found' }); continue; }

      if (bot.connection) {
        try { bot.connection.destroy(); } catch (e) {}
        bot.connection = null;
        await new Promise(r => setTimeout(r, 500));
      }

      console.log(`→ ${bot.client.user.tag}: joining...`);
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 60000);
      console.log(`✅ ${bot.client.user.tag} VC READY`);

      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5000)
          ]);
        } catch (e) {
          try { connection.destroy(); } catch (e) {}
          bot.connection = null;
        }
      });

      bot.connection = connection;
      bot.channelId = channelId;
      results.push({ tag: bot.client.user.tag, status: 'joined' });
    } catch (err) {
      console.error(`❌ ${bot.client.user?.tag}: ${err.message}`);
      results.push({ tag: bot.client.user?.tag, status: 'failed', error: err.message });
    }
  }

  const joined = results.filter(r => r.status === 'joined').length;
  console.log(`✅ JOIN COMPLETE — ${joined}/${bots.size}`);
  res.json({ results, joined, total: bots.size });
});

// ============ PLAY HELPER ============
function playLoop(bot, audioPath) {
  if (!bot.connection) return false;
  if (bot.player) { try { bot.player.stop(); } catch (e) {} }

  const player = createAudioPlayer({ behaviors: { noSubscriber: 'play', maxMissedFrames: 25000 } });
  const resource = createAudioResource(audioPath, { inputType: StreamType.Arbitrary, inlineVolume: false });

  bot.connection.subscribe(player);
  player.play(resource);

  player.on(AudioPlayerStatus.Idle, () => {
    if (loopEnabled && bot.connection) {
      try {
        const r = createAudioResource(audioPath, { inputType: StreamType.Arbitrary, inlineVolume: false });
        player.play(r);
      } catch (e) {}
    }
  });

  player.on('error', (err) => console.error('Player error:', err.message));
  bot.player = player;
  return true;
}

// ============ PLAY ALL ============
app.post('/api/playall', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Audio file required' });
  const volume = parseInt(req.body.volume) || 1000;
  const inputPath = req.file.path;
  const outputPath = `uploads/boosted_${Date.now()}.wav`;
  console.log(`💀 ${volume}x | ${bots.size} bots`);

  const filters = [];
  let remaining = volume;
  while (remaining > 256) { filters.push('volume=256'); remaining = remaining / 256; }
  if (remaining > 0.01) filters.push(`volume=${remaining.toFixed(4)}`);
  if (filters.length === 0) filters.push('volume=1');
  filters.push('bass=g=15:f=100:w=0.5');
  filters.push('treble=g=8:f=3000:w=0.5');
  filters.push('alimiter=limit=0.99:attack=1:release=10');

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath).audioFilters(filters.join(','))
        .audioCodec('pcm_s16le').audioBitrate('320k')
        .audioChannels(2).audioFrequency(48000).format('wav')
        .on('end', () => { console.log('✅ FFmpeg done'); resolve(); })
        .on('error', reject)
        .save(outputPath);
    });
  } catch (err) {
    return res.status(500).json({ error: 'FFmpeg failed' });
  }

  fs.unlink(inputPath, () => {});
  loopEnabled = true;

  const results = [];
  let count = 0;
  for (const [token, bot] of bots.entries()) {
    if (!bot.connection) continue;
    if (playLoop(bot, outputPath)) {
      count++;
      results.push({ tag: bot.client.user.tag, status: 'playing' });
      console.log(`▶️ ${bot.client.user.tag} PLAYING`);
    }
  }
  console.log(`✅ PLAY — ${count}/${bots.size}`);
  res.json({ results, playing: count, total: bots.size, volume });
});

// ============ STOP ============
app.post('/api/stop', (req, res) => {
  loopEnabled = false;
  let count = 0;
  for (const bot of bots.values()) {
    if (bot.player) { try { bot.player.stop(); } catch (e) {} bot.player = null; count++; }
  }
  res.json({ status: 'stopped', count });
});

// ============ LEAVE VC ============
app.post('/api/leaveall', (req, res) => {
  loopEnabled = false;
  let count = 0;
  for (const bot of bots.values()) {
    try {
      if (bot.player) { try { bot.player.stop(); } catch (e) {} bot.player = null; }
      if (bot.connection) { try { bot.connection.destroy(); } catch (e) {} bot.connection = null; count++; console.log(`🚪 ${bot.client.user.tag} left`); }
    } catch (e) {}
  }
  console.log(`✅ LEFT ${count}`);
  res.json({ status: 'left', count });
});

// ============ VOICE STATE ============
function updateVoiceState(bot, selfMute, selfDeaf) {
  try {
    if (!bot.connection) return false;
    const cfg = bot.connection.joinConfig;
    bot.client.ws.broadcast({
      op: 4,
      d: { guild_id: cfg.guildId, channel_id: cfg.channelId, self_mute: selfMute, self_deaf: selfDeaf, self_video: false }
    });
    return true;
  } catch (e) { return false; }
}

app.post('/api/muteall', (req, res) => { let c=0; for (const b of bots.values()) if (updateVoiceState(b,true,false)) c++; res.json({status:'muted',count:c}); });
app.post('/api/unmuteall', (req, res) => { let c=0; for (const b of bots.values()) if (updateVoiceState(b,false,false)) c++; res.json({status:'unmuted',count:c}); });
app.post('/api/deafenall', (req, res) => { let c=0; for (const b of bots.values()) if (updateVoiceState(b,true,true)) c++; res.json({status:'deafened',count:c}); });
app.post('/api/undeafenall', (req, res) => { let c=0; for (const b of bots.values()) if (updateVoiceState(b,false,false)) c++; res.json({status:'undeafened',count:c}); });

// ============ VALIDATE ============
app.post('/api/validate', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ status: 'error' });
  if (bots.has(token)) return res.json({ status: 'ready', tag: bots.get(token).client.user?.tag, valid: true });
  res.json({ status: 'unknown', valid: false });
});

app.get('/api/status', (req, res) => {
  const s = [];
  for (const bot of bots.values()) {
    s.push({ tag: bot.client.user?.tag, joined: !!bot.connection, playing: bot.player?.state?.status === 'playing', proxied: !!bot.proxy });
  }
  res.json({ bots: s, count: bots.size });
});

app.listen(PORT, () => {
  console.log(`🚀 http://localhost:${PORT}`);
  console.log(`💀 MULTI-BOT + PROXY`);
});

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
try { fs.readdirSync('uploads').forEach(f => { try { fs.unlinkSync(path.join('uploads', f)); } catch (e) {} }); } catch (e) {}