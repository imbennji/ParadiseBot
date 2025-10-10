const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
} = require('@discordjs/voice');
const { EventEmitter } = require('node:events');
const { log } = require('../logger');

const subscriptions = new Map();
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

class MusicSubscription extends EventEmitter {
  constructor(guildId) {
    super();
    this.guildId = guildId;
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
    });
    this.connection = null;
    this.voiceChannelId = null;
    this.queue = [];
    this.current = null;
    this._idleTimer = null;
    this._destroyed = false;

    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.current) {
        this.emit('trackFinish', this.current);
        this.current = null;
      }
      this.playNext().catch((err) => {
        log.tag('MUSIC').error(`Queue advance failed guild=${this.guildId}:`, err?.stack || err);
      });
    });

    this.player.on(AudioPlayerStatus.Playing, () => {
      this.clearIdleTimer();
    });

    this.player.on('error', (err) => {
      log.tag('MUSIC').error(`Playback error guild=${this.guildId}:`, err?.stack || err);
      const failed = this.current;
      if (failed) this.emit('trackError', failed, err);
      this.current = null;
      this.playNext().catch((e) => log.tag('MUSIC').error(`Queue recovery failed guild=${this.guildId}:`, e?.stack || e));
    });
  }

  async connect(voiceChannel) {
    if (this._destroyed) throw new Error('This subscription has been destroyed.');
    if (!voiceChannel) throw new Error('No voice channel provided.');

    const connection = this.connection ?? joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    if (!this.connection) {
      this.connection = connection;
      this.voiceChannelId = voiceChannel.id;
      connection.subscribe(this.player);
      this._registerConnectionEvents(connection);
    } else if (this.voiceChannelId !== voiceChannel.id) {
      connection.rejoin({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        selfDeaf: true,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      });
      this.voiceChannelId = voiceChannel.id;
    }

    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    this.emit('connected', this.voiceChannelId);
    return this;
  }

  _registerConnectionEvents(connection) {
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch (err) {
        log.tag('MUSIC').warn(`Voice disconnected guild=${this.guildId}: ${err?.message || err}`);
        this.destroy('disconnected');
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.destroy('connection');
    });
  }

  async enqueue(track) {
    if (this._destroyed) throw new Error('Music player is no longer available.');
    this.queue.push(track);
    this.emit('queueUpdate', this.getQueue());
    if (!this.current) {
      await this.playNext();
    }
    return track;
  }

  async playNext() {
    if (this._destroyed) return;
    if (!this.connection) return;

    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      this.emit('queueUpdate', this.getQueue());
      this.startIdleTimer();
      return;
    }

    try {
      const resource = await next.createAudioResource();
      this.current = next;
      this.clearIdleTimer();
      this.player.play(resource);
      this.emit('trackStart', next);
      this.emit('queueUpdate', this.getQueue());
    } catch (err) {
      log.tag('MUSIC').error(`Failed to start track guild=${this.guildId}:`, err?.stack || err);
      this.emit('trackError', next, err);
      this.current = null;
      await this.playNext();
    }
  }

  skip() {
    if (this.player.state.status === AudioPlayerStatus.Idle) {
      return false;
    }
    this.player.stop(true);
    return true;
  }

  pause() {
    return this.player.pause();
  }

  resume() {
    return this.player.unpause();
  }

  getQueue() {
    return {
      current: this.current,
      upcoming: [...this.queue],
    };
  }

  startIdleTimer() {
    if (this._idleTimer || this._destroyed) return;
    this._idleTimer = setTimeout(() => this.destroy('idle'), IDLE_TIMEOUT_MS);
    if (typeof this._idleTimer.unref === 'function') this._idleTimer.unref();
  }

  clearIdleTimer() {
    if (!this._idleTimer) return;
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
  }

  destroy(reason = 'manual') {
    if (this._destroyed) return;
    this._destroyed = true;
    this.clearIdleTimer();
    this.queue = [];
    this.current = null;
    try {
      this.player.stop();
    } catch (_) {}
    if (this.connection) {
      try {
        this.connection.destroy();
      } catch (err) {
        log.tag('MUSIC').warn(`Failed to destroy voice connection guild=${this.guildId}:`, err?.stack || err);
      }
    }
    this.connection = null;
    this.voiceChannelId = null;
    this.emit('destroyed', reason);
  }
}

async function ensureGuildSubscription(guild, voiceChannel) {
  let sub = subscriptions.get(guild.id);
  let created = false;
  if (!sub || sub._destroyed) {
    sub = new MusicSubscription(guild.id);
    subscriptions.set(guild.id, sub);
    created = true;
    sub.once('destroyed', () => {
      subscriptions.delete(guild.id);
    });
  }
  await sub.connect(voiceChannel);
  return { subscription: sub, isNew: created };
}

function getSubscription(guildId) {
  return subscriptions.get(guildId) || null;
}

function destroySubscription(guildId) {
  const sub = subscriptions.get(guildId);
  if (!sub) return false;
  subscriptions.delete(guildId);
  sub.destroy('manual');
  return true;
}

module.exports = {
  ensureGuildSubscription,
  getSubscription,
  destroySubscription,
  MusicSubscription,
};
