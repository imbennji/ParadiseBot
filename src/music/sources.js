const play = require('play-dl');
const { Track } = require('./track');

function parseDurationSeconds(result) {
  if (typeof result?.durationInSec === 'number') {
    return result.durationInSec;
  }
  if (typeof result?.durationInMs === 'number') {
    return Math.floor(result.durationInMs / 1000);
  }
  const raw = result?.durationRaw || result?.duration;
  if (!raw) return null;
  const parts = raw.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some(Number.isNaN)) return null;
  let seconds = 0;
  while (parts.length) {
    seconds = seconds * 60 + (parts.shift() || 0);
  }
  return seconds;
}

async function ensurePlayDlReady() {
  if (typeof play.is_expired === 'function' && play.is_expired()) {
    try {
      await play.refreshToken();
    } catch (_) {
      // Ignore; refreshing is only required for certain providers.
    }
  }
}

async function resolveTrack(query, requester) {
  await ensurePlayDlReady();

  const requesterId = requester?.id ?? null;
  const requesterTag = requester?.tag || requester?.username || 'Unknown User';

  let info = null;
  const validation = typeof play.yt_validate === 'function' ? play.yt_validate(query) : null;

  if (validation === 'video') {
    info = await play.video_info(query);
    const details = info?.video_details;
    if (!details) {
      throw new Error('Could not load information for that video.');
    }
    const durationSec = Number(details.durationInSec || 0);
    return new Track({
      title: details.title,
      url: details.url,
      durationMs: durationSec ? durationSec * 1000 : null,
      requestedById: requesterId,
      requestedByTag: requesterTag,
      thumbnail: Array.isArray(details.thumbnails) ? details.thumbnails[0]?.url : null,
      streamFactory: async () => {
        const stream = await play.stream(details.url);
        return { stream: stream.stream, type: stream.type };
      },
    });
  }

  if (validation === 'playlist') {
    throw new Error('Please provide a specific video URL instead of a playlist.');
  }

  const results = await play.search(query, { limit: 1, source: { youtube: 'video' } });
  if (!results?.length) {
    throw new Error('No matches found for that search.');
  }
  const result = results[0];
  const durationSec = parseDurationSeconds(result);

  return new Track({
    title: result.title,
    url: result.url,
    durationMs: durationSec ? durationSec * 1000 : null,
    requestedById: requesterId,
    requestedByTag: requesterTag,
    thumbnail: Array.isArray(result.thumbnails) ? result.thumbnails[0]?.url : null,
    streamFactory: async () => {
      const stream = await play.stream(result.url);
      return { stream: stream.stream, type: stream.type };
    },
  });
}

module.exports = {
  resolveTrack,
};
