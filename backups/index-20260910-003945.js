require("dotenv").config();

const fs = require("fs");
const path = require("path");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} = require("discord.js");

const { PlayerManager } = require("ziplayer");

const {
  YouTubePlugin,
  SoundCloudPlugin,
  SpotifyPlugin,
  AttachmentsPlugin,
} = require("@ziplayer/plugin");

class StableYouTubePlugin extends YouTubePlugin {
  buildTrack(raw, requestedBy, extra) {
    const track = super.buildTrack(raw, requestedBy, extra);
    const id = [
      raw?.id,
      raw?.video_id,
      raw?.videoId,
      raw?.basic_info?.id,
      track.id,
    ].find(
      (value) =>
        value !== undefined &&
        value !== null &&
        value !== "" &&
        value !== "undefined",
    );

    if (track.url === "undefined" || !track.url) {
      track.url = id ? `https://www.youtube.com/watch?v=${id}` : null;
    }

    if (!Number.isFinite(track.duration)) {
      const durationValue =
        raw?.length_seconds ??
        raw?.duration?.seconds ??
        raw?.duration?.text ??
        raw?.duration ??
        raw?.basic_info?.duration;
      const durationSeconds =
        typeof durationValue === "string" && durationValue.includes(":")
          ? durationValue.split(":").reduce((total, part) => total * 60 + Number(part), 0)
          : Number(durationValue);

      track.duration = Number.isFinite(durationSeconds)
        ? durationSeconds * 1000
        : 0;
    }

    if (!track.title || track.title === "undefined" || track.title === "Unknown title") {
      track.title =
        raw?.metadata?.title?.text ||
        raw?.title?.text ||
        raw?.title ||
        (id ? `YouTube video ${id}` : "Không rõ tên");
    }

    return track;
  }

  async getStream(track, signal) {
    const id = track?.id || this.extractVideoId(track?.url);
    let lastError;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this.downloadWithYoutubei(track, id, signal);
      } catch (error) {
        lastError = error;

        if (signal?.aborted || attempt === 2) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    throw lastError;
  }
}

/* =========================================================
   CONFIG
========================================================= */

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;

if (!TOKEN) {
  console.error("❌ Thiếu TOKEN trong .env");
  process.exit(1);
}

if (!CLIENT_ID) {
  console.error("❌ Thiếu CLIENT_ID trong .env");
  process.exit(1);
}

/* =========================================================
   AUTO VOICE CONFIG
========================================================= */

const AUTO_VOICE_CONFIG_FILE = path.join(__dirname, "voice-config.json");

const autoVoiceRooms = new Map();

function loadAutoVoiceConfig() {
  try {
    if (!fs.existsSync(AUTO_VOICE_CONFIG_FILE)) {
      return;
    }

    const data = JSON.parse(fs.readFileSync(AUTO_VOICE_CONFIG_FILE, "utf8"));

    if (data && typeof data === "object") {
      for (const [guildId, channelId] of Object.entries(data)) {
        if (typeof guildId === "string" && typeof channelId === "string") {
          autoVoiceRooms.set(guildId, channelId);
        }
      }
    }

    console.log(`✅ Đã load ${autoVoiceRooms.size} auto voice room.`);
  } catch (error) {
    console.error("❌ Không thể đọc voice-config.json:", error);
  }
}

function saveAutoVoiceConfig() {
  try {
    const data = Object.fromEntries(autoVoiceRooms);

    fs.writeFileSync(
      AUTO_VOICE_CONFIG_FILE,
      JSON.stringify(data, null, 4),
      "utf8",
    );
  } catch (error) {
    console.error("❌ Không thể lưu voice-config.json:", error);
  }
}

loadAutoVoiceConfig();

/* =========================================================
   CLIENT
========================================================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/* =========================================================
   ZIPLAYER
========================================================= */

const manager = new PlayerManager({
  plugins: [
    new StableYouTubePlugin(),
    new SoundCloudPlugin(),
    new SpotifyPlugin(),
    new AttachmentsPlugin({
      maxFileSize: 25 * 1024 * 1024,
    }),
  ],

  extractorTimeout: 30000,
  autoCleanup: true,
  cleanupInterval: 120000,
  enableSearchCache: true,
});

/* =========================================================
   STATE
========================================================= */

const uiMessages = new Map();
const uiTimers = new Map();

const currentTrackState = new Map();
const trackDurationHydration = new Map();

const playerState = new Map();
const loopState = new Map();
const shuffleState = new Map();
const autoplayState = new Map();
const filterState = new Map();
const volumeState = new Map();

const searchCache = new Map();
const searchSessions = new Map();
const ephemeralReplies = new Map();

const guildLocks = new Map();

/* =========================================================
   FILTERS
========================================================= */

const FILTERS = {
  none: "Không filter",
  bassboost: "Bass Boost",
  trebleboost: "Treble Boost",
  nightcore: "Nightcore",
  lofi: "Lo-Fi",
  vaporwave: "Vaporwave",
  echo: "Echo",
  reverb: "Reverb",
  chorus: "Chorus",
  karaoke: "Karaoke",
  normalize: "Normalize",
  compressor: "Compressor",
  limiter: "Limiter",
};

const UI_COLORS = {
  default: 0x5865f2,
  success: 0x57f287,
  warning: 0xfaa61a,
  danger: 0xed4245,
  info: 0x1abc9c,
};

function buildEphemeralReply(content, extra = {}) {
  if (
    typeof MessageFlags !== "undefined" &&
    typeof MessageFlags.Ephemeral !== "undefined"
  ) {
    return {
      ...extra,
      content,
      flags: MessageFlags.Ephemeral,
    };
  }

  return {
    ...extra,
    content,
    ephemeral: true,
  };
}

async function safeReplyEphemeral(interaction, content, extra = {}) {
  try {
    if (interaction?.deferred || interaction?.replied) {
      return await interaction.editReply({
        ...extra,
        content,
      });
    }

    return await interaction.reply(buildEphemeralReply(content, extra));
  } catch {
    return null;
  }
}

async function safeReplyMessage(message, content, extra = {}) {
  try {
    return await message.reply({
      ...extra,
      content,
    });
  } catch {
    return null;
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function parseDurationToMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 10000) {
      return Math.max(0, value);
    }

    return Math.max(0, value * 1000);
  }

  if (typeof value === "string") {
    const raw = value.trim();

    if (!raw) {
      return 0;
    }

    const clockMs = parseClockStringToMs(raw);
    if (clockMs > 0) {
      return clockMs;
    }

    const numberValue = Number(raw);

    if (Number.isFinite(numberValue)) {
      return Math.max(0, numberValue * 1000);
    }
  }

  if (value && typeof value === "object") {
    if (typeof value.formatted === "string") {
      return parseDurationToMs(value.formatted);
    }

    if (typeof value.ms === "number") {
      return Math.max(0, value.ms);
    }

    if (typeof value.milliseconds === "number") {
      return Math.max(0, value.milliseconds);
    }

    if (typeof value.seconds === "number") {
      return Math.max(0, value.seconds * 1000);
    }

    if (typeof value.value === "number") {
      return Math.max(0, value.value * 1000);
    }
  }

  return 0;
}

function normalizePlaybackMs(value, totalHint = 0) {
  if (typeof value === "string") {
    const asMs = parseClockStringToMs(value);
    if (asMs > 0) {
      return asMs;
    }

    const asNum = Number(value);
    if (Number.isFinite(asNum)) {
      return Math.max(0, asNum * 1000);
    }

    return 0;
  }

  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }

  if (totalHint > 0 && totalHint > 10000 && value <= 10000) {
    return value * 1000;
  }

  return value;
}

function buildProgressBar(currentMs, totalMs, length = 18) {
  const safeCurrent = Number.isFinite(currentMs) ? Math.max(0, currentMs) : 0;
  const safeTotal = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 0;

  if (!safeTotal) {
    return `${"░".repeat(length)} 0%`;
  }

  const percent = clamp((safeCurrent / safeTotal) * 100, 0, 100);
  const filled = Math.round((length * percent) / 100);

  return `${"█".repeat(filled)}${"░".repeat(length - filled)} ${Math.round(percent)}%`;
}

function getPlaybackProgress(player, track) {
  const current = player?.getTime?.();

  const totalHint = parseDurationToMs(
    track?.duration ??
      track?.totalDuration ??
      track?.length ??
      track?.metadata?.duration ??
      track?.metadata?.totalDuration ??
      track?.metadata?.length ??
      track?.metadata?.durationMs ??
      track?.info?.duration ??
      track?.info?.length ??
      track?.info?.durationMs ??
      track?.raw?.duration ??
      track?.raw?.length ??
      track?.raw?.durationMs ??
      current?.total ??
      current?.duration ??
      current?.formatted?.total ??
      0,
  );

  const currentMs =
    current && typeof current === "object"
      ? typeof current.current === "number"
        ? normalizePlaybackMs(current.current, totalHint)
        : typeof current.current === "string"
          ? normalizePlaybackMs(current.current, totalHint)
          : typeof current.ms === "number"
            ? normalizePlaybackMs(current.ms, totalHint)
            : typeof current.ms === "string"
              ? normalizePlaybackMs(current.ms, totalHint)
              : typeof current.milliseconds === "number"
                ? normalizePlaybackMs(current.milliseconds, totalHint)
                : typeof current.milliseconds === "string"
                  ? normalizePlaybackMs(current.milliseconds, totalHint)
                  : 0
      : 0;

  let totalMs = Math.max(
    0,
    totalHint ||
      parseDurationToMs(
        current?.total ?? current?.duration ?? current?.formatted?.total ?? track?.duration ?? 0,
      ),
  );

  return {
    currentMs: Math.max(0, currentMs),
    totalMs: Math.max(0, totalMs),
  };
}

function buildPlayerComponents(guildId) {
  return [
    buildButtons(guildId),
    buildFilterMenu(guildId),
    buildVolumeMenu(guildId),
  ];
}

/* =========================================================
   BASIC HELPERS
========================================================= */

function isValidUrl(text) {
  try {
    const url = new URL(text);

    return !!url.protocol && !!url.host;
  } catch {
    return false;
  }
}

function isVoiceChannel(channel) {
  if (!channel) {
    return false;
  }

  return (
    channel.type === ChannelType.GuildVoice ||
    channel.type === ChannelType.GuildStageVoice
  );
}

function hasManageGuild(member) {
  return Boolean(
    member?.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    member?.permissions?.has(PermissionFlagsBits.Administrator),
  );
}

function hasManageMessages(member) {
  return Boolean(
    member?.permissions?.has(PermissionFlagsBits.ManageMessages) ||
    member?.permissions?.has(PermissionFlagsBits.Administrator),
  );
}

function isAbortLikeError(error) {
  return Boolean(
    error &&
    (error.name === "AbortError" ||
      error.code === "ABORT_ERR" ||
      error.cause?.name === "AbortError" ||
      error.cause?.code === "ABORT_ERR"),
  );
}

/* =========================================================
   GET PLAYER
========================================================= */

function getPlayer(guildId) {
  if (!guildId) {
    return null;
  }

  try {
    return manager.get(guildId) || null;
  } catch {
    return null;
  }
}

async function waitForPlayer(guildId, timeoutMs = 2500) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const player = getPlayer(guildId);

    if (player) {
      return player;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return getPlayer(guildId);
}

/* =========================================================
   TRACK TITLE
========================================================= */

function getTrackTitle(track) {
  return (
    track?.title || track?.name || track?.metadata?.title || "Không rõ tên"
  );
}

/* =========================================================
   TRACK URL
========================================================= */

function getTrackUrl(track) {
  return (
    track?.url || track?.uri || track?.link || track?.metadata?.url || null
  );
}

async function hydrateTrackDuration(track) {
  const url = getTrackUrl(track);

  if (!track || !url || !/youtube\.com|youtu\.be/.test(url)) {
    return 0;
  }

  const cached = trackDurationHydration.get(url);
  if (cached) {
    const durationMs = await cached;
    if (durationMs > 0) {
      track.duration = durationMs;
    }
    return durationMs;
  }

  const request = (async () => {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        return 0;
      }

      const html = await response.text();
      const match =
        html.match(/"lengthSeconds"\s*:\s*"(\d+)"/) ||
        html.match(/\\"lengthSeconds\\"\s*:\s*\\"(\d+)\\"/) ||
        html.match(/"approxDurationMs"\s*:\s*"(\d+)"/) ||
        html.match(/\\"approxDurationMs\\"\s*:\s*\\"(\d+)\\"/);

      if (!match) {
        return 0;
      }

      const durationMs = match[0].includes("approxDurationMs")
        ? Number(match[1])
        : Number(match[1]) * 1000;

      return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
    } catch {
      return 0;
    }
  })();

  trackDurationHydration.set(url, request);

  const durationMs = await request;
  if (durationMs > 0) {
    track.duration = durationMs;
  }

  return durationMs;
}

function logTrackDebug(label, guildId, player, track) {
  const time = player?.getTime?.();

  const rawDuration =
    track?.duration ??
    track?.length ??
    track?.totalDuration ??
    track?.durationMs ??
    track?.metadata?.duration ??
    track?.metadata?.length ??
    track?.metadata?.totalDuration ??
    track?.metadata?.durationMs ??
    track?.info?.duration ??
    track?.raw?.duration ??
    "N/A";

  const rawCurrent =
    (typeof time?.current === "number" ? time.current : null) ??
    (typeof time?.formatted?.current === "string" ? time.formatted.current : null) ??
    "N/A";

  const rawTotal =
    (typeof time?.total === "number" ? time.total : null) ??
    (typeof time?.duration === "number" ? time.duration : null) ??
    (typeof time?.formatted?.total === "string" ? time.formatted.total : null) ??
    "N/A";

  const currentText = getCurrentTime(player);
  const totalText = getTrackDuration(track, player);

  console.log(
    `[${label}] guild=${guildId} title=${getTrackTitle(track)} url=${getTrackUrl(track) || "N/A"} durationRaw=${String(rawDuration)} currentRaw=${String(rawCurrent)} totalRaw=${String(rawTotal)} currentFmt=${currentText} totalFmt=${totalText}`,
  );
}

/* =========================================================
   FORMAT TIME
========================================================= */

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(ms / 1000);

  const hours = Math.floor(totalSeconds / 3600);

  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return (
      `${hours}:` +
      `${String(minutes).padStart(2, "0")}:` +
      `${String(seconds).padStart(2, "0")}`
    );
  }

  return `${minutes}:` + `${String(seconds).padStart(2, "0")}`;
}

/* =========================================================
   SECONDS -> TIME
========================================================= */

function formatSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }

  return formatTime(seconds * 1000);
}

function parseClockStringToMs(value) {
  if (typeof value !== "string") {
    return 0;
  }

  const raw = value.trim();

  if (!raw || raw === "0:00") {
    return 0;
  }

  if (!/^\d+:\d{2}(?::\d{2})?$/.test(raw)) {
    return 0;
  }

  const parts = raw.split(":").map(Number);

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
      return (minutes * 60 + seconds) * 1000;
    }
  }

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    if (Number.isFinite(hours) && Number.isFinite(minutes) && Number.isFinite(seconds)) {
      return (hours * 3600 + minutes * 60 + seconds) * 1000;
    }
  }

  return 0;
}

/* =========================================================
   CURRENT TIME
========================================================= */

function getCurrentTime(player) {
  try {
    const time = player?.getTime?.();

    if (!time) {
      return "0:00";
    }

    if (
      time.formatted &&
      typeof time.formatted === "object" &&
      typeof time.formatted.current === "string"
    ) {
      return time.formatted.current;
    }

    if (typeof time.formatted === "string") {
      return time.formatted;
    }

    const totalHint = parseDurationToMs(
      time?.total ?? time?.formatted?.total ?? 0,
    );

    if (typeof time.current === "number") {
      const normalized = normalizePlaybackMs(time.current, totalHint);

      return formatTime(normalized);
    }

    if (time.current && typeof time.current === "object") {
      if (typeof time.current.formatted === "string") {
        return time.current.formatted;
      }

      if (typeof time.current.ms === "number") {
        return formatTime(normalizePlaybackMs(time.current.ms, totalHint));
      }

      if (typeof time.current.milliseconds === "number") {
        return formatTime(
          normalizePlaybackMs(time.current.milliseconds, totalHint),
        );
      }
    }
  } catch (error) {
    console.error("[TIME ERROR]", error);
  }

  return "0:00";
}

/* =========================================================
   DURATION
========================================================= */

function getTrackDuration(track, player = null) {
  const values = [
    track?.duration,
    track?.length,
    track?.totalDuration,
    track?.durationMs,
    track?.metadata?.duration,
    track?.metadata?.length,
    track?.metadata?.totalDuration,
    track?.metadata?.durationMs,
    track?.info?.duration,
    track?.info?.length,
    track?.info?.durationMs,
    track?.raw?.duration,
    track?.raw?.length,
    track?.raw?.durationMs,
  ];

  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value <= 0) {
        continue;
      }

      if (value > 10000) {
        return formatTime(value);
      }

      return formatSeconds(value);
    }

    if (typeof value === "string") {
      const v = value.trim();

      if (!v || v === "0:00" || v === "0") {
        continue;
      }

      if (/^\d+:\d{2}(?::\d{2})?$/.test(v)) {
        return v;
      }

      const seconds = Number(v);

      if (Number.isFinite(seconds) && seconds > 0) {
        if (seconds > 100000) {
          return formatTime(seconds);
        }

        return formatSeconds(seconds);
      }
    }

    if (value && typeof value === "object") {
      if (typeof value.formatted === "string" && value.formatted.trim()) {
        const formattedMs = parseDurationToMs(value.formatted);

        if (formattedMs > 0) {
          return formatTime(formattedMs);
        }
      }

      if (typeof value.ms === "number" && value.ms > 0) {
        return formatTime(value.ms);
      }

      if (typeof value.milliseconds === "number" && value.milliseconds > 0) {
        return formatTime(value.milliseconds);
      }

      if (typeof value.seconds === "number" && value.seconds > 0) {
        return formatSeconds(value.seconds);
      }

      if (typeof value.value === "number" && value.value > 0) {
        return formatSeconds(value.value);
      }
    }
  }

  try {
    const time = player?.getTime?.();

    if (time) {
      if (
        time.formatted &&
        typeof time.formatted === "object" &&
        typeof time.formatted.total === "string" &&
        time.formatted.total !== "0:00"
      ) {
        return time.formatted.total;
      }

      if (
        time.formatted &&
        typeof time.formatted === "object" &&
        typeof time.formatted.current === "string" &&
        typeof time.formatted.total === "string" &&
        time.formatted.total !== "0:00"
      ) {
        return time.formatted.total;
      }

      if (typeof time.total === "number" && time.total > 0) {
        return formatTime(time.total);
      }

      if (typeof time.duration === "number" && time.duration > 0) {
        return formatTime(time.duration);
      }
    }
  } catch {}

  const fallbackTrack = currentTrackState.get(player?.guildId || "");
  if (fallbackTrack) {
    const fallbackDuration = getTrackDuration(fallbackTrack, null);
    if (fallbackDuration && fallbackDuration !== "0:00") {
      return fallbackDuration;
    }
  }

  return "0:00";
}

/* =========================================================
   CURRENT TRACK
========================================================= */

function getCurrentTrack(guildId, player) {
  const track =
    player?.queue?.currentTrack ||
    player?.currentTrack ||
    player?.current ||
    null;

  if (track) {
    currentTrackState.set(guildId, track);

    return track;
  }

  return currentTrackState.get(guildId) || null;
}

/* =========================================================
   LOOP
========================================================= */

function getLoopMode(guildId) {
  return loopState.get(guildId) || "off";
}

function getLoopText(guildId) {
  const mode = getLoopMode(guildId);

  if (mode === "track") {
    return "🔂 Bài hiện tại";
  }

  if (mode === "queue") {
    return "🔁 Queue";
  }

  return "➡️ Tắt";
}

/* =========================================================
   STATUS
========================================================= */

function getStatusText(guildId) {
  const state = playerState.get(guildId) || "stopped";

  if (state === "paused") {
    return "⏸️ Tạm dừng";
  }

  if (state === "playing") {
    return "▶️ Đang phát";
  }

  return "⏹️ Đã dừng";
}

/* =========================================================
   FILTER TEXT
========================================================= */

function getFilterText(guildId) {
  return FILTERS[filterState.get(guildId) || "none"] || FILTERS.none;
}

/* =========================================================
   GUILD LOCK
========================================================= */

async function withGuildLock(guildId, fn) {
  const previous = guildLocks.get(guildId) || Promise.resolve();

  let release;

  const current = new Promise((resolve) => {
    release = resolve;
  });

  const chain = previous.then(() => current);

  guildLocks.set(guildId, chain);

  await previous;

  try {
    return await fn();
  } finally {
    release();

    if (guildLocks.get(guildId) === chain) {
      guildLocks.delete(guildId);
    }
  }
}

/* =========================================================
   QUEUE
========================================================= */

function getQueueTracks(player) {
  const result = [];
  const queue = player?.queue;

  if (!queue) {
    return result;
  }

  try {
    if (
      typeof queue.getTrack === "function" &&
      typeof queue.size === "number"
    ) {
      for (let i = 0; i < queue.size; i++) {
        const track = queue.getTrack(i);

        if (track) {
          result.push(track);
        }
      }
    }
  } catch (error) {
    console.error("[QUEUE READ ERROR]", error);
  }

  if (!result.length && Array.isArray(queue.tracks)) {
    result.push(...queue.tracks);
  }

  if (!result.length && Array.isArray(queue.items)) {
    result.push(...queue.items);
  }

  return result;
}

/* =========================================================
   CLEAR QUEUE
========================================================= */

async function clearQueue(player) {
  const queue = player?.queue;

  if (!queue) {
    return;
  }

  if (typeof queue.clear === "function") {
    await queue.clear();
    return;
  }

  if (Array.isArray(queue.tracks)) {
    queue.tracks.length = 0;
  }
}

/* =========================================================
   CREATE / ENSURE PLAYER
========================================================= */

async function ensurePlayer(guild, voiceChannel, textChannel, options = {}) {
  const autoRoom = options.autoRoom === true;

  let player = getPlayer(guild.id);

  if (!player || player.destroyed) {
    player = await manager.create(guild.id, {
      volume: volumeState.get(guild.id) ?? 100,

      quality: "high",

      leaveOnEnd: false,

      leaveOnEmpty: !autoRoom,

      leaveTimeout: 100000,

      selfDeaf: true,
      selfMute: false,

      extractorTimeout: 30000,

      userdata: {
        channel: textChannel || null,
      },
    });
  }

  player.userdata = player.userdata || {};

  if (textChannel) {
    player.userdata.channel = textChannel;
  }

  if (!player.connection) {
    await player.connect(voiceChannel);
  }

  if (!volumeState.has(guild.id)) {
    volumeState.set(guild.id, 100);
  }

  if (!loopState.has(guild.id)) {
    loopState.set(guild.id, "off");
  }

  if (!shuffleState.has(guild.id)) {
    shuffleState.set(guild.id, false);
  }

  if (!autoplayState.has(guild.id)) {
    autoplayState.set(guild.id, false);
  }

  if (!filterState.has(guild.id)) {
    filterState.set(guild.id, "none");
  }

  if (!playerState.has(guild.id)) {
    playerState.set(guild.id, "stopped");
  }

  startUITimer(guild.id);

  return player;
}

/* =========================================================
   AUTO VOICE - GET CONFIGURED CHANNEL
========================================================= */

function getConfiguredVoiceChannel(guild) {
  const channelId = autoVoiceRooms.get(guild.id);

  if (!channelId) {
    return null;
  }

  const channel = guild.channels.cache.get(channelId);

  if (!channel || !isVoiceChannel(channel)) {
    return null;
  }

  return channel;
}

/* =========================================================
   AUTO VOICE - SETUP
========================================================= */

function setupAutoVoiceRoom(guildId, channelId) {
  autoVoiceRooms.set(guildId, channelId);

  saveAutoVoiceConfig();
}

/* =========================================================
   AUTO VOICE - CANCEL
========================================================= */

function cancelAutoVoiceRoom(guildId) {
  const existed = autoVoiceRooms.has(guildId);

  autoVoiceRooms.delete(guildId);

  saveAutoVoiceConfig();

  return existed;
}

/* =========================================================
   AUTO VOICE - JOIN
========================================================= */

async function autoJoinConfiguredRoom(guild) {
  const channel = getConfiguredVoiceChannel(guild);

  if (!channel) {
    return;
  }

  const humans = channel.members.filter((member) => !member.user.bot);

  if (!humans.size) {
    return;
  }

  const me = guild.members.me || (await guild.members.fetch(client.user.id));

  if (me.voice.channelId === channel.id) {
    return;
  }

  await withGuildLock(guild.id, async () => {
    const latest = getConfiguredVoiceChannel(guild);

    if (!latest) {
      return;
    }

    const latestHumans = latest.members.filter((member) => !member.user.bot);

    if (!latestHumans.size) {
      return;
    }

    const player = await ensurePlayer(guild, latest, null, {
      autoRoom: true,
    });

    if (player) {
      console.log(`[AUTO VOICE JOIN] ${guild.name} -> ${latest.name}`);
    }
  });
}

/* =========================================================
   AUTO VOICE - LEAVE WHEN EMPTY
========================================================= */

async function autoLeaveIfEmpty(guild) {
  const channel = getConfiguredVoiceChannel(guild);

  if (!channel) {
    return;
  }

  const humans = channel.members.filter((member) => !member.user.bot);

  if (humans.size > 0) {
    return;
  }

  const me =
    guild.members.me ||
    (client.user && guild.members.cache.get(client.user.id));

  if (!me) {
    return;
  }

  if (me.voice.channelId !== channel.id) {
    return;
  }

  const player = getPlayer(guild.id);

  if (player) {
    try {
      await player.stop();
    } catch {}

    try {
      if (
        player.connection &&
        typeof player.connection.disconnect === "function"
      ) {
        player.connection.disconnect();
      }
    } catch (error) {
      console.error("[AUTO VOICE LEAVE ERROR]", error);
    }
  }

  playerState.set(guild.id, "stopped");

  await updateUI(guild.id);

  console.log(`[AUTO VOICE LEAVE] ${guild.name} -> ${channel.name} empty`);
}

/* =========================================================
   FILTER MENU
========================================================= */

function buildFilterMenu(guildId) {
  const current = filterState.get(guildId) || "none";

  const options = Object.entries(FILTERS).map(([value, label]) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(label)
      .setValue(value)
      .setDescription(value === "none" ? "Tắt tất cả hiệu ứng" : `Bật ${label}`)
      .setDefault(value === current),
  );

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("music_filter")
      .setPlaceholder("🎛️ Chọn Filter")
      .addOptions(options),
  );
}

function buildVolumeMenu(guildId) {
  const current = volumeState.get(guildId) ?? 100;

  const values = Array.from({ length: 11 }, (_, index) => index * 10);

  const options = values.map((value) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(`${value}%`)
      .setValue(String(value))
      .setDescription(
        value === 0
          ? "Tắt âm thanh"
          : value === 100
            ? "Âm lượng tối đa"
            : `Chỉnh âm lượng ${value}%`,
      )
      .setDefault(value === current),
  );

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("music_volume")
      .setPlaceholder("🔊 Chọn âm lượng")
      .addOptions(options),
  );
}

/* =========================================================
   PLAYER BUTTONS
========================================================= */

function buildButtons(guildId) {
  const shuffle = !!shuffleState.get(guildId);
  const loop = getLoopMode(guildId);
  const paused = playerState.get(guildId) === "paused";

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_pause")
      .setLabel(paused ? "Tiếp tục" : "Tạm dừng")
      .setEmoji(paused ? "▶️" : "⏸️")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("music_skip")
      .setLabel("Bỏ qua")
      .setEmoji("⏭️")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_stop")
      .setLabel("Dừng")
      .setEmoji("⏹️")
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId("music_shuffle")
      .setLabel(shuffle ? "Shuffle ON" : "Shuffle")
      .setEmoji("🔀")
      .setStyle(shuffle ? ButtonStyle.Success : ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_loop")
      .setLabel(loop === "queue" ? "Queue" : loop === "track" ? "Track" : "Loop")
      .setEmoji("🔁")
      .setStyle(loop !== "off" ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
}

/* =========================================================
   PLAYER EMBED
========================================================= */

function buildPlayerEmbed(guildId) {
  const player = getPlayer(guildId);
  const track = getCurrentTrack(guildId, player);
  const status = getStatusText(guildId);

  const embed = new EmbedBuilder()
    .setTitle("🎵 Music Player")
    .setColor(
      playerState.get(guildId) === "playing"
        ? UI_COLORS.success
        : playerState.get(guildId) === "paused"
          ? UI_COLORS.warning
          : UI_COLORS.default,
    )
    .setFooter({
      text: "Dùng /p để phát nhạc • /ui để mở lại giao diện",
    });

  if (!track) {
    return embed
      .setDescription("🎶 Chưa có bài hát nào đang phát.")
      .addFields(
        {
          name: "📡 Trạng thái",
          value: status,
          inline: true,
        },
        {
          name: "🔁 Loop",
          value: getLoopText(guildId),
          inline: true,
        },
        {
          name: "🎛️ Filter",
          value: getFilterText(guildId),
          inline: true,
        },
      );
  }

  const title = getTrackTitle(track);
  const url = getTrackUrl(track);
  const current = getCurrentTime(player);
  const duration = getTrackDuration(track, player);
  const queueSize =
    typeof player?.queue?.size === "number"
      ? player.queue.size
      : getQueueTracks(player).length;
  const progress = getPlaybackProgress(player, track);

  const safeCurrent =
    progress.currentMs > 0
      ? formatTime(progress.currentMs)
      : current && current !== "0:00"
        ? current
        : "0:00";

  const safeDuration =
    duration && duration !== "0:00" ? duration :
    progress.totalMs > 0 ? formatTime(progress.totalMs) : "0:00";

  const progressBar = buildProgressBar(progress.currentMs, progress.totalMs);

  embed
    .setDescription(url ? `[${title}](${url})` : `**${title}**`)
    .addFields(
      {
        name: "⏱️ Tiến độ",
        value: `\`${safeCurrent} / ${safeDuration}\`\n${progressBar}`,
        inline: false,
      },
      {
        name: "📋 Queue",
        value: `\`${queueSize}\` bài`,
        inline: true,
      },
      {
        name: "🔊 Volume",
        value: `\`${volumeState.get(guildId) ?? 100}%\``,
        inline: true,
      },
      {
        name: "📡 Trạng thái",
        value: status,
        inline: true,
      },
      {
        name: "🔁 Loop",
        value: getLoopText(guildId),
        inline: true,
      },
      {
        name: "🎛️ Filter",
        value: getFilterText(guildId),
        inline: true,
      },
      {
        name: "⚙️ Tùy chọn",
        value: `Shuffle: ${shuffleState.get(guildId) ? "ON" : "OFF"} • Autoplay: ${autoplayState.get(guildId) ? "ON" : "OFF"}`,
        inline: false,
      },
    );

  const thumbnail = track.thumbnail || track.artwork || track.image;
  if (thumbnail) {
    embed.setThumbnail(thumbnail);
  }

  return embed;
}

/* =========================================================
   UPDATE UI
========================================================= */

async function updateUI(guildId) {
  const message = uiMessages.get(guildId);

  if (!message) {
    return;
  }

  try {
    await message.edit({
      embeds: [buildPlayerEmbed(guildId)],
      components: buildPlayerComponents(guildId),
    });
  } catch (error) {
    if (error?.code === 10008 || error?.code === 10003) {
      uiMessages.delete(guildId);
    } else {
      console.error("[UI UPDATE ERROR]", error);
    }
  }
}

/* =========================================================
   SEND / UPDATE UI
========================================================= */

async function sendOrUpdateUI(guildId, channel) {
  if (!channel || !guildId) {
    return null;
  }

  const player = getPlayer(guildId);
  const currentTrack = getCurrentTrack(guildId, player);

  if (!player && !currentTrack) {
    return null;
  }

  const data = {
    embeds: [buildPlayerEmbed(guildId)],
    components: buildPlayerComponents(guildId),
  };

  const oldMessage = uiMessages.get(guildId);

  if (oldMessage) {
    try {
      await oldMessage.edit(data);

      return oldMessage;
    } catch {
      uiMessages.delete(guildId);
    }
  }

  const message = await channel.send(data);

  uiMessages.set(guildId, message);

  return message;
}

/* =========================================================
   UI TIMER
========================================================= */

function startUITimer(guildId) {
  if (uiTimers.has(guildId)) {
    return;
  }

  const timer = setInterval(() => {
    const player = getPlayer(guildId);

    if (!player) {
      return;
    }

    if (
      playerState.get(guildId) === "playing" ||
      playerState.get(guildId) === "paused"
    ) {
      updateUI(guildId).catch((error) => {
        console.error("[UI TIMER ERROR]", error);
      });
    }
  }, 5000);

  uiTimers.set(guildId, timer);
}

/* =========================================================
   SEARCH
========================================================= */

async function searchTracks(query, userId) {
  const key = query.trim().toLowerCase();

  const cached = searchCache.get(key);

  if (cached && Date.now() - cached.createdAt < 5 * 60 * 1000) {
    return cached.tracks;
  }

  const results = await manager.search(query, userId);

  const tracks = results?.tracks || results?.items || results || [];

  const valid = tracks
    .filter((track) => track && getTrackUrl(track))
    .slice(0, 10);

  searchCache.set(key, {
    tracks: valid,
    createdAt: Date.now(),
  });

  return valid;
}

/* =========================================================
   PLAY QUERY
========================================================= */

async function playQuery({
  guild,
  voiceChannel,
  textChannel,
  query,
  userId,
  newPlay = false,
}) {
  return withGuildLock(guild.id, async () => {
    const player = await ensurePlayer(guild, voiceChannel, textChannel);

    if (newPlay) {
      try {
        await player.stop();
      } catch {}

      await clearQueue(player);

      currentTrackState.delete(guild.id);

      playerState.set(guild.id, "stopped");
    }

    await player.play(query, userId);

    return player;
  });
}

/* =========================================================
   SLASH COMMANDS
========================================================= */

const slashCommands = [
  /* =====================================================
       /p
    ===================================================== */

  new SlashCommandBuilder()
    .setName("p")
    .setDescription("Phát nhạc hoặc tìm kiếm bài hát")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("Tên bài hát hoặc link")
        .setRequired(true),
    ),

  /* =====================================================
       /pn
    ===================================================== */

  new SlashCommandBuilder()
    .setName("pn")
    .setDescription("Xóa queue và phát link mới")
    .addStringOption((option) =>
      option.setName("link").setDescription("Link bài hát").setRequired(true),
    ),

  /* =====================================================
       /pa
    ===================================================== */

  new SlashCommandBuilder().setName("pa").setDescription("Tạm dừng nhạc"),

  /* =====================================================
       /r
    ===================================================== */

  new SlashCommandBuilder().setName("r").setDescription("Tiếp tục nhạc"),

  /* =====================================================
       /s
    ===================================================== */

  new SlashCommandBuilder().setName("s").setDescription("Bỏ qua bài hiện tại"),

  /* =====================================================
       /st
    ===================================================== */

  new SlashCommandBuilder().setName("st").setDescription("Dừng nhạc"),

  /* =====================================================
       /keep
    ===================================================== */

  new SlashCommandBuilder()
    .setName("keep")
    .setDescription("Giữ bài hiện tại và xóa các bài còn lại trong queue"),

  /* =====================================================
       /q
    ===================================================== */

  new SlashCommandBuilder().setName("q").setDescription("Xem queue"),

  /* =====================================================
       /v
    ===================================================== */

  new SlashCommandBuilder()
    .setName("v")
    .setDescription("Điều chỉnh volume")
    .addIntegerOption((option) =>
      option
        .setName("value")
        .setDescription("0 - 100")
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(true),
    ),

  /* =====================================================
       /np
    ===================================================== */

  new SlashCommandBuilder().setName("np").setDescription("Xem bài đang phát"),

  /* =====================================================
       /ui
    ===================================================== */

  new SlashCommandBuilder()
    .setName("ui")
    .setDescription("Hiển thị lại bảng điều khiển nhạc"),

  /* =====================================================
       /sh
    ===================================================== */

  new SlashCommandBuilder().setName("sh").setDescription("Shuffle queue"),

  /* =====================================================
       /l
    ===================================================== */

  new SlashCommandBuilder().setName("l").setDescription("Bật/tắt Queue Loop"),

  /* =====================================================
       /lm
    ===================================================== */

  new SlashCommandBuilder()
    .setName("lm")
    .setDescription("Chọn loop mode")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("off / track / queue")
        .setRequired(true)
        .addChoices(
          {
            name: "Tắt",
            value: "off",
          },
          {
            name: "Bài hiện tại",
            value: "track",
          },
          {
            name: "Queue",
            value: "queue",
          },
        ),
    ),

  /* =====================================================
       /ap
    ===================================================== */

  new SlashCommandBuilder()
    .setName("ap")
    .setDescription("Bật/tắt autoplay (tự phát bài tương tự khi queue hết)"),

  /* =====================================================
       /clear
    ===================================================== */

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Xóa một đoạn tin nhắn hoặc toàn bộ chat")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("all hoặc số tin nhắn cần xóa")
        .setRequired(false)
        .addChoices(
          {
            name: "Xóa tất cả",
            value: "all",
          },
          {
            name: "Xóa theo số",
            value: "count",
          },
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName("count")
        .setDescription("Số tin nhắn cần xóa (2-100)")
        .setMinValue(2)
        .setMaxValue(100)
        .setRequired(false),
    ),

  /* =====================================================
       /clearh
    ===================================================== */

  new SlashCommandBuilder()
    .setName("clearh")
    .setDescription("Xóa các phản hồi riêng tư của bạn trong phiên hiện tại"),

  /* =====================================================
       /f
    ===================================================== */

  new SlashCommandBuilder().setName("f").setDescription("Chọn audio filter"),

  /* =====================================================
       /setup
       LỆNH SETUP ROOM
    ===================================================== */

  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Setup hoặc hủy voice room tự động")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("Setup room hiện tại hoặc hủy setup")
        .setRequired(false)
        .addChoices(
          {
            name: "Setup room hiện tại",
            value: "setup",
          },
          {
            name: "Hủy setup",
            value: "off",
          },
        ),
    ),
].map((command) => command.toJSON());

/* =========================================================
   REGISTER SLASH COMMANDS
========================================================= */
async function registerSlashCommands() {
  const rest = new REST({
    version: "10",
  }).setToken(TOKEN);

  try {
    console.log("=================================");
    console.log("🔄 Đang đăng ký slash commands...");
    console.log(`CLIENT_ID: ${CLIENT_ID}`);
    console.log(`GUILD_ID: ${GUILD_ID || "GLOBAL"}`);
    console.log(`TOTAL COMMANDS: ${slashCommands.length}`);

    const result = GUILD_ID
      ? await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
          body: slashCommands,
        })
      : await rest.put(Routes.applicationCommands(CLIENT_ID), {
          body: slashCommands,
        });

    console.log("✅ Slash commands đã đăng ký.");

    console.log("📋 Commands:");

    for (const command of result) {
      console.log(`   /${command.name}`);
    }

    console.log("=================================");
  } catch (error) {
    console.error("❌ ĐĂNG KÝ SLASH COMMAND THẤT BẠI");

    console.error(error);
  }
}
/* =========================================================
   INTERACTIONS
========================================================= */

client.on("interactionCreate", async (interaction) => {
  try {
    /* =================================================
               AUTOCOMPLETE
            ================================================= */

    if (interaction.isAutocomplete()) {
      if (interaction.commandName !== "p") {
        return;
      }

      const query = interaction.options.getString("query")?.trim();

      if (!query) {
        return interaction.respond([]);
      }

      try {
        const tracks = await searchTracks(query, interaction.user.id);

        await interaction.respond(
          tracks.slice(0, 10).map((track, index) => ({
            name: `${index + 1}. ${getTrackTitle(track)}`.slice(0, 100),

            value: getTrackUrl(track)?.slice(0, 100) || query,
          })),
        );
      } catch {
        await interaction.respond([]).catch(() => {});
      }

      return;
    }

    /* =================================================
               BUTTON
            ================================================= */

    if (interaction.isButton()) {
      const guildId = interaction.guildId;

      const player = getPlayer(guildId);

      if (!player) {
        return interaction.reply({
          content: "❌ Chưa có player.",
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferUpdate();

      await withGuildLock(guildId, async () => {
        switch (interaction.customId) {
          case "music_pause":
            if (playerState.get(guildId) === "paused") {
              await player.resume();

              playerState.set(guildId, "playing");
            } else {
              await player.pause();

              playerState.set(guildId, "paused");
            }

            break;

          case "music_skip":
            await player.skip();

            break;

          case "music_stop":
            await player.stop();

            playerState.set(guildId, "stopped");

            break;

          case "music_shuffle":
            await player.shuffle();

            shuffleState.set(guildId, !shuffleState.get(guildId));

            break;

          case "music_loop": {
            const current = getLoopMode(guildId);

            let next;

            if (current === "off") {
              next = "queue";
            } else if (current === "queue") {
              next = "track";
            } else {
              next = "off";
            }

            await player.loop(next);

            loopState.set(guildId, next);

            break;
          }
        }
      });

      await updateUI(guildId);

      return;
    }

    /* =================================================
               FILTER MENU
            ================================================= */

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "music_filter"
    ) {
      const guildId = interaction.guildId;

      const player = getPlayer(guildId);

      if (!player) {
        return safeReplyEphemeral(interaction, "❌ Chưa có player.");
      }

      const selected = interaction.values[0];

      await interaction.deferUpdate();

      await withGuildLock(guildId, async () => {
        if (selected === "none") {
          await player.filter.clearAll();
        } else {
          await player.filter.applyFilters([selected]);
        }

        filterState.set(guildId, selected);
      });

      await updateUI(guildId);

      return;
    }

    /* =================================================
               VOLUME MENU
            ================================================= */

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "music_volume"
    ) {
      const guildId = interaction.guildId;

      const player = getPlayer(guildId);

      if (!player) {
        return safeReplyEphemeral(interaction, "❌ Chưa có player.");
      }

      const selected = Number(interaction.values[0]);

      if (!Number.isInteger(selected) || selected < 0 || selected > 100) {
        return interaction.reply({
          content: "❌ Âm lượng không hợp lệ.",
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferUpdate();

      await player.setVolume(selected);

      volumeState.set(guildId, selected);

      await updateUI(guildId);

      return;
    }

    /* =================================================
               SEARCH RESULT MENU
            ================================================= */

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId.startsWith("search_result:")
    ) {
      const searchId = interaction.customId.slice("search_result:".length);

      const data = searchSessions.get(searchId);

      if (!data) {
        return safeReplyEphemeral(
          interaction,
          "❌ Kết quả tìm kiếm đã hết hạn.",
        );
      }

      if (interaction.user.id !== data.userId) {
        return safeReplyEphemeral(
          interaction,
          "❌ Menu này không phải của bạn.",
        );
      }

      const index = Number(interaction.values[0]);

      const track = data.tracks[index];

      if (!track) {
        return interaction.reply({
          content: "❌ Không tìm thấy bài đã chọn.",
          flags: MessageFlags.Ephemeral,
        });
      }

      const voiceChannel = interaction.member?.voice?.channel;

      if (!voiceChannel) {
        return safeReplyEphemeral(
          interaction,
          "❌ Bạn phải vào voice channel trước.",
        );
      }

      await interaction.deferUpdate();

      await playQuery({
        guild: interaction.guild,

        voiceChannel,

        textChannel: interaction.channel,

        query: track,

        userId: interaction.user.id,
      });

      searchSessions.delete(searchId);

      await interaction.editReply({
        content: `▶️ Đang phát/thêm: **${getTrackTitle(track)}**`,

        embeds: [],

        components: [],
      });

      return;
    }

    /* =================================================
               SLASH
            ================================================= */

    if (!interaction.isChatInputCommand()) {
      return;
    }

    const command = interaction.commandName;

    if (command !== "clearh") {
      const key = `${interaction.guildId}:${interaction.user.id}`;
      const replies = ephemeralReplies.get(key) || [];

      replies.push(interaction);
      ephemeralReplies.set(key, replies.slice(-25));
    }

    /* =================================================
               /clearh
            ================================================= */

    if (command === "clearh") {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      const key = `${interaction.guildId}:${interaction.user.id}`;
      const replies = ephemeralReplies.get(key) || [];
      let deleted = 0;

      for (const reply of replies) {
        try {
          await reply.deleteReply();
          deleted++;
        } catch {}
      }

      ephemeralReplies.delete(key);

      await interaction.editReply({
        content:
          deleted > 0
            ? `🧹 Đã xóa ${deleted} thông báo riêng tư của bạn.`
            : "ℹ️ Không có thông báo riêng tư nào còn có thể xóa.",
      });

      setTimeout(() => {
        interaction.deleteReply().catch(() => {});
      }, 2000);

      return;
    }

    /* =================================================
               /setup
            ================================================= */

    if (command === "setup") {
      if (!hasManageGuild(interaction.member)) {
        return interaction.reply({
          content:
            "❌ Bạn cần quyền **Manage Server** hoặc **Administrator** để setup room.",
          flags: MessageFlags.Ephemeral,
        });
      }

      const action = interaction.options.getString("action") || "setup";

      /* =============================================
                   /setup action:off
                ============================================= */

      if (action === "off") {
        const existed = cancelAutoVoiceRoom(interaction.guildId);

        return interaction.reply({
          content: existed
            ? "🗑️ Đã hủy setup auto voice room."
            : "ℹ️ Guild này chưa setup auto voice room.",
          flags: MessageFlags.Ephemeral,
        });
      }

      /* =============================================
                   /setup
                ============================================= */

      const voiceChannel = interaction.member?.voice?.channel;

      if (!voiceChannel || !isVoiceChannel(voiceChannel)) {
        return interaction.reply({
          content: "❌ Bạn phải vào một voice channel trước khi setup.",
          flags: MessageFlags.Ephemeral,
        });
      }

      setupAutoVoiceRoom(interaction.guildId, voiceChannel.id);

      /*
                   Nếu hiện tại room đã có người,
                   bot vào ngay sau khi setup.
                */

      await autoJoinConfiguredRoom(interaction.guild);

      return interaction.reply({
        content:
          `✅ Đã setup auto voice room: <#${voiceChannel.id}>\n\n` +
          `👤 Có người vào room → bot tự vào.\n` +
          `🚪 Không còn người → bot tự rời.\n` +
          `⚠️ Nếu Discord đá/move bot ra khỏi room khi vẫn còn người, bot **không tự vào lại**.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    /* =================================================
               /ui
            ================================================= */

    if (command === "ui") {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      const player = getPlayer(interaction.guildId);
      const hasTrack = !!getCurrentTrack(interaction.guildId, player);

      if (!player && !hasTrack) {
        return interaction.editReply(
          "ℹ️ Chưa có player nào. Dùng /p để phát nhạc trước.",
        );
      }

      const message = await sendOrUpdateUI(
        interaction.guildId,
        interaction.channel,
      );

      if (!message) {
        return interaction.editReply(
          "ℹ️ Không thể hiển thị UI ở kênh này lúc này.",
        );
      }

      return interaction.editReply(
        "✅ Đã hiển thị lại bảng điều khiển nhạc.",
      );
    }

    /* =================================================
               /p
            ================================================= */

    if (command === "p") {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      const query = interaction.options.getString("query", true).trim();

      const voiceChannel = interaction.member?.voice?.channel;

      if (!voiceChannel) {
        return interaction.editReply("❌ Bạn phải vào voice channel trước.");
      }

      if (isValidUrl(query)) {
        await playQuery({
          guild: interaction.guild,

          voiceChannel,

          textChannel: interaction.channel,

          query,

          userId: interaction.user.id,
        });

        return interaction.editReply(`▶️ Đã thêm vào queue:\n${query}`);
      }

      const tracks = await searchTracks(query, interaction.user.id);

      if (!tracks.length) {
        return interaction.editReply("❌ Không tìm thấy bài hát.");
      }

      const searchId = interaction.id;

      searchSessions.set(searchId, {
        tracks,
        userId: interaction.user.id,
        guildId: interaction.guildId,
        createdAt: Date.now(),
      });

      const menu = new StringSelectMenuBuilder()
        .setCustomId(`search_result:${searchId}`)
        .setPlaceholder("🎵 Chọn bài hát...")
        .addOptions(
          tracks.map((track, index) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(`${index + 1}. ${getTrackTitle(track)}`.slice(0, 100))
              .setValue(String(index)),
          ),
        );

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🎵 Kết quả tìm kiếm")
            .setDescription(
              `Tìm thấy kết quả cho: **${query}**\n\n` +
                "Chọn bài hát muốn phát:",
            ),
        ],
        components: [new ActionRowBuilder().addComponents(menu)],
      });
    }

    /* =================================================
               /pn
            ================================================= */

    if (command === "pn") {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      const link = interaction.options.getString("link", true).trim();

      const voiceChannel = interaction.member?.voice?.channel;

      if (!isValidUrl(link)) {
        return interaction.editReply("❌ Link không hợp lệ.");
      }

      if (!voiceChannel) {
        return interaction.editReply("❌ Bạn phải vào voice channel trước.");
      }

      await playQuery({
        guild: interaction.guild,

        voiceChannel,

        textChannel: interaction.channel,

        query: link,

        userId: interaction.user.id,

        newPlay: true,
      });

      return interaction.editReply(
        `🗑️ Đã xóa queue cũ.\n` + `▶️ Đang phát bài mới:\n` + link,
      );
    }

    /* =================================================
               /clear
            ================================================= */

    if (command === "clear") {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      if (!hasManageMessages(interaction.member)) {
        return interaction.editReply(
          "❌ Bạn cần quyền **Manage Messages** để xóa đoạn chat.",
        );
      }

      const mode = interaction.options.getString("mode") || "count";
      const channel = interaction.channel;

      if (!channel || !channel.bulkDelete) {
        return interaction.editReply("❌ Không thể xóa tin nhắn ở kênh này.");
      }

      if (mode === "all") {
        await channel.bulkDelete(100, true).catch(() => {});

        const fetched = await channel.messages.fetch({ limit: 100 });

        if (fetched.size > 0) {
          await channel.bulkDelete(fetched, true).catch(() => {});
        }

        return interaction.editReply(
          "🧹 Đã xóa toàn bộ tin nhắn hiện có trong kênh này.",
        );
      }

      const count = interaction.options.getInteger("count") ?? 25;

      if (count < 2 || count > 100) {
        return interaction.editReply(
          "❌ Số tin nhắn cần xóa phải từ **2 đến 100**.",
        );
      }

      const deleted = await channel.bulkDelete(count, true);

      return interaction.editReply(
        `🧹 Đã xóa **${deleted.size}** tin nhắn trong đoạn chat.`,
      );
    }

    /* =================================================
               PLAYER REQUIRED
            ================================================= */

    let player = await waitForPlayer(interaction.guildId, 2500);

    if (!player) {
      return safeReplyEphemeral(
        interaction,
        "❌ Chưa có player. Dùng /p hoặc /pn trước.",
      );
    }

    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    /* =================================================
               /pa
            ================================================= */

    if (command === "pa") {
      await player.pause();

      playerState.set(interaction.guildId, "paused");

      await updateUI(interaction.guildId);

      return interaction.editReply("⏸️ Đã tạm dừng.");
    }

    /* =================================================
               /r
            ================================================= */

    if (command === "r") {
      await player.resume();

      playerState.set(interaction.guildId, "playing");

      await updateUI(interaction.guildId);

      return interaction.editReply("▶️ Đã tiếp tục.");
    }

    /* =================================================
               /s
            ================================================= */

    if (command === "s") {
      await player.skip();

      await updateUI(interaction.guildId);

      return interaction.editReply("⏭️ Đã bỏ qua bài hiện tại.");
    }

    /* =================================================
               /st
            ================================================= */

    if (command === "st") {
      await player.stop();

      playerState.set(interaction.guildId, "stopped");

      await updateUI(interaction.guildId);

      return interaction.editReply("⏹️ Đã dừng nhạc.");
    }

    /* =================================================
               /keep
            ================================================= */

    if (command === "keep") {
      await withGuildLock(interaction.guildId, async () => {
        await clearQueue(player);
      });

      await updateUI(interaction.guildId);

      return interaction.editReply(
        "✅ Đã giữ bài hiện tại và xóa các bài còn lại trong queue.",
      );
    }

    /* =================================================
               /q
            ================================================= */

    if (command === "q") {
      const tracks = getQueueTracks(player);

      if (!tracks.length) {
        return interaction.editReply("📭 Queue hiện đang trống.");
      }

      let description = tracks
        .slice(0, 20)
        .map((track, index) => `**${index + 1}.** ${getTrackTitle(track)}`)
        .join("\n");

      if (tracks.length > 20) {
        description += `\n\n... và còn **${tracks.length - 20}** bài khác.`;
      }

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("📋 Queue")
            .setDescription(description)
            .setFooter({
              text: `Tổng: ${tracks.length} bài`,
            }),
        ],
      });
    }

    /* =================================================
               /v
            ================================================= */

    if (command === "v") {
      const volume = interaction.options.getInteger("value", true);

      await player.setVolume(volume);

      volumeState.set(interaction.guildId, volume);

      await updateUI(interaction.guildId);

      return interaction.editReply(`🔊 Volume: **${volume}%**`);
    }

    /* =================================================
               /np
            ================================================= */

    if (command === "np") {
      return interaction.editReply({
        embeds: [buildPlayerEmbed(interaction.guildId)],
      });
    }

    /* =================================================
               /sh
            ================================================= */

    if (command === "sh") {
      await player.shuffle();

      shuffleState.set(
        interaction.guildId,
        !shuffleState.get(interaction.guildId),
      );

      await updateUI(interaction.guildId);

      return interaction.editReply("🔀 Đã shuffle queue.");
    }

    /* =================================================
               /l
            ================================================= */

    if (command === "l") {
      const next =
        getLoopMode(interaction.guildId) === "queue" ? "off" : "queue";

      await player.loop(next);

      loopState.set(interaction.guildId, next);

      await updateUI(interaction.guildId);

      return interaction.editReply(
        next === "queue" ? "🔁 Queue Loop: **Bật**" : "➡️ Queue Loop: **Tắt**",
      );
    }

    /* =================================================
               /lm
            ================================================= */

    if (command === "lm") {
      const mode = interaction.options.getString("mode", true);

      await player.loop(mode);

      loopState.set(interaction.guildId, mode);

      await updateUI(interaction.guildId);

      return interaction.editReply(`🔁 Loop: **${mode}**`);
    }

    /* =================================================
               /ap
            ================================================= */

    if (command === "ap") {
      const next = !autoplayState.get(interaction.guildId);

      if (typeof player.queue?.autoPlay === "function") {
        await player.queue.autoPlay(next);
      }

      autoplayState.set(interaction.guildId, next);

      await updateUI(interaction.guildId);

      return interaction.editReply(
        next ? "🤖 Autoplay: **Bật**" : "🤖 Autoplay: **Tắt**",
      );
    }

    /* =================================================
               /f
            ================================================= */

    if (command === "f") {
      return interaction.editReply({
        content: "🎛️ Chọn filter bên dưới:",

        components: [buildFilterMenu(interaction.guildId)],
      });
    }
  } catch (error) {
    if (isAbortLikeError(error)) {
      return;
    }

    console.error("[INTERACTION ERROR]", error);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: `❌ ${error?.message || "Có lỗi xảy ra."}`,
          embeds: [],
          components: [],
        });
      } else {
        await interaction.reply({
          content: `❌ ${error?.message || "Có lỗi xảy ra."}`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {}
  }
});

/* =========================================================
   PREFIX COMMANDS
========================================================= */

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) {
    return;
  }

  if (!message.content.startsWith("!")) {
    return;
  }

  return message.reply(
    "⚠️ Lệnh cũ đã bị tắt. Vui lòng dùng các slash command của bot.",
  ).catch(() => {});
});

/* =========================================================
   VOICE STATE UPDATE
========================================================= */

/*
   QUAN TRỌNG:

   - Người vào room setup -> bot vào
   - Người cuối cùng rời -> bot rời
   - Bot bị kick/move -> KHÔNG auto rejoin
   - Không có watchdog
========================================================= */

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    /* ===============================================
               BỎ QUA BOT
            =============================================== */

    if (oldState.id === client.user?.id || newState.id === client.user?.id) {
      return;
    }

    const guild = newState.guild || oldState.guild;

    if (!guild) {
      return;
    }

    const configuredId = autoVoiceRooms.get(guild.id);

    if (!configuredId) {
      return;
    }

    /* ===============================================
               NGƯỜI VÀO ROOM
            =============================================== */

    if (
      newState.channelId === configuredId &&
      oldState.channelId !== configuredId
    ) {
      setTimeout(() => {
        autoJoinConfiguredRoom(guild).catch((error) => {
          console.error("[AUTO JOIN ERROR]", error);
        });
      }, 500);

      return;
    }

    /* ===============================================
               NGƯỜI RỜI ROOM
            =============================================== */

    if (
      oldState.channelId === configuredId &&
      newState.channelId !== configuredId
    ) {
      setTimeout(() => {
        autoLeaveIfEmpty(guild).catch((error) => {
          console.error("[AUTO LEAVE ERROR]", error);
        });
      }, 700);
    }
  } catch (error) {
    if (isAbortLikeError(error)) {
      return;
    }

    console.error("[VOICE STATE ERROR]", error);
  }
});

/* =========================================================
   TRACK START
========================================================= */

manager.on("trackStart", async (player, track) => {
  const guildId = player?.guildId || player?.guildID;

  if (!guildId) {
    return;
  }

  if (track) {
    currentTrackState.set(guildId, track);
  }

  playerState.set(guildId, "playing");

  const channel = player.userdata?.channel;

  if (channel) {
    await sendOrUpdateUI(guildId, channel);
  } else {
    await updateUI(guildId);
  }

  hydrateTrackDuration(track).then((durationMs) => {
    if (durationMs > 0) {
      updateUI(guildId).catch((error) => {
        console.error("[DURATION UI UPDATE ERROR]", error);
      });
    }
  });

  logTrackDebug("TRACK START", guildId, player, track);
});

/* =========================================================
   TRACK END
========================================================= */

manager.on("trackEnd", async (player) => {
  const guildId = player?.guildId || player?.guildID;

  if (!guildId) {
    return;
  }

  await updateUI(guildId);
});

/* =========================================================
   QUEUE ADD
========================================================= */

manager.on("queueAdd", async (player) => {
  const guildId = player?.guildId || player?.guildID;

  if (!guildId) {
    return;
  }

  const channel = player.userdata?.channel;

  if (channel && !uiMessages.has(guildId)) {
    await sendOrUpdateUI(guildId, channel);
  } else {
    await updateUI(guildId);
  }
});

/* =========================================================
   QUEUE ADD LIST
========================================================= */

manager.on("queueAddList", async (player) => {
  const guildId = player?.guildId || player?.guildID;

  if (!guildId) {
    return;
  }

  const channel = player.userdata?.channel;

  if (channel && !uiMessages.has(guildId)) {
    await sendOrUpdateUI(guildId, channel);
  } else {
    await updateUI(guildId);
  }
});

/* =========================================================
   PAUSE
========================================================= */

manager.on("playerPause", async (player) => {
  const guildId = player?.guildId || player?.guildID;

  if (!guildId) {
    return;
  }

  playerState.set(guildId, "paused");

  await updateUI(guildId);
});

/* =========================================================
   RESUME
========================================================= */

manager.on("playerResume", async (player) => {
  const guildId = player?.guildId || player?.guildID;

  if (!guildId) {
    return;
  }

  playerState.set(guildId, "playing");

  await updateUI(guildId);
});

/* =========================================================
   VOLUME
========================================================= */

manager.on("volumeChange", async (player, oldVolume, newVolume) => {
  const guildId = player?.guildId || player?.guildID;

  if (!guildId) {
    return;
  }

  if (typeof newVolume === "number") {
    volumeState.set(guildId, newVolume);
  }

  await updateUI(guildId);
});

/* =========================================================
   QUEUE END
========================================================= */

manager.on("queueEnd", async (player) => {
  const guildId = player?.guildId || player?.guildID;

  if (!guildId) {
    return;
  }

  playerState.set(guildId, "stopped");

  await updateUI(guildId);
});

/* =========================================================
   PLAYER ERROR
========================================================= */

manager.on("playerError", async (player, error, track) => {
  const guildId = player?.guildId || player?.guildID;

  console.error("========== PLAYER ERROR ==========");

  console.error("Guild:", guildId);

  console.error("Track:", getTrackTitle(track));

  console.error("URL:", getTrackUrl(track));
  console.error("Error:", error);

  console.error("==================================");

  if (guildId) {
    await updateUI(guildId);
  }
});

/* =========================================================
   PLAYER DESTROY
========================================================= */

manager.on("playerDestroy", async (player) => {
  const guildId = player?.guildId || player?.guildID;

  if (!guildId) {
    return;
  }

  const timer = uiTimers.get(guildId);

  if (timer) {
    clearInterval(timer);
  }

  uiTimers.delete(guildId);

  uiMessages.delete(guildId);

  currentTrackState.delete(guildId);

  playerState.delete(guildId);

  loopState.delete(guildId);

  shuffleState.delete(guildId);

  autoplayState.delete(guildId);

  filterState.delete(guildId);

  volumeState.delete(guildId);
});

/* =========================================================
   CACHE CLEANUP
========================================================= */

setInterval(() => {
  const now = Date.now();

  for (const [key, data] of searchCache) {
    if (now - data.createdAt > 5 * 60 * 1000) {
      searchCache.delete(key);
    }
  }

  for (const [key, data] of searchSessions) {
    if (now - data.createdAt > 5 * 60 * 1000) {
      searchSessions.delete(key);
    }
  }
}, 60 * 1000);

/* =========================================================
   READY
========================================================= */

let readyHandled = false;

async function onClientReady() {
  if (readyHandled) {
    return;
  }

  readyHandled = true;

  console.log("\n================================");

  console.log(`🤖 Bot: ${client.user.tag}`);

  console.log(`🆔 ID: ${client.user.id}`);

  console.log("🎵 Music engine: ZiPlayer");

  console.log("🎛️ Custom UI: ON");

  console.log("🏠 Auto Voice Setup: ON");

  console.log("📌 Slash command: /setup");

  console.log(
    "🧹 Slash clear command: /clear (sẽ hiển thị sau khi bot restart)",
  );

  console.log("🔄 Auto Rejoin after bot kick: OFF");

  console.log("================================\n");

  try {
    await registerSlashCommands();
  } catch (error) {
    console.error("❌ Lỗi đăng ký slash commands:", error);
  }
}

client.once("ready", onClientReady);
client.once("clientReady", onClientReady);

/* =========================================================
   GLOBAL ERROR
========================================================= */

process.on("unhandledRejection", (error) => {
  console.error("[UNHANDLED REJECTION]", error);
});

process.on("uncaughtException", (error) => {
  console.error("[UNCAUGHT EXCEPTION]", error);
});

/* =========================================================
   LOGIN
========================================================= */

client.login(TOKEN);
