/**
 * Lightweight representation of a music track. Instances wrap the metadata required for embeds as
 * well as a factory function that yields audio streams compatible with Discord voice connections.
 */
const { createAudioResource, demuxProbe } = require('@discordjs/voice');

class Track {
  constructor({ title, url, durationMs, requestedById, requestedByTag, thumbnail, streamFactory }) {
    this.title = title;
    this.url = url;
    this.durationMs = typeof durationMs === 'number' ? durationMs : null;
    this.requestedById = requestedById;
    this.requestedByTag = requestedByTag;
    this.thumbnail = thumbnail || null;
    this._streamFactory = streamFactory;
  }

  get isLive() {
    return !this.durationMs || this.durationMs <= 0;
  }

  async createAudioResource() {
    if (typeof this._streamFactory !== 'function') {
      throw new Error('No stream factory available for this track.');
    }

    const playback = await this._streamFactory();
    const probe = await demuxProbe(playback.stream);
    return createAudioResource(probe.stream, {
      inputType: probe.type,
      metadata: this,
    });
  }
}

module.exports = { Track };
