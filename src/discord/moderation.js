/**
 * Minimal content moderation helper that removes hateful slurs before they linger in chat. The list
 * can be extended via the `MODERATION_BANNED_TERMS` environment variable to support community
 * specific sensitivities without redeploying the bot.
 */
const { log } = require('../logger');

const DEFAULT_BANNED_TERMS = [
  'nigger',
  'nigga',
  'sand nigger',
  'jigaboo',
  'porch monkey',
  'tar baby',
  'uncle tom',
  'mulatto',
  'wetback',
  'spic',
  'beaner',
  'chink',
  'gook',
  'zipperhead',
  'slant eye',
  'jap',
  'kike',
  'heeb',
  'yid',
  'raghead',
  'towelhead',
  'camel jockey',
  'terrorist monkey',
  'paki',
  'abo',
  'spear chucker',
  'coon',
  'jungle bunny',
  'golliwog',
  'darkie',
  'spook',
  'faggot',
  'fag',
  'faggie',
  'dyke',
  'tranny',
  'shemale',
  'homo',
  'poofter',
  'fairy boy',
  'butt pirate',
];

const EXTRA_BANNED_TERMS = (process.env.MODERATION_BANNED_TERMS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/**
 * Normalises configured terms by stripping diacritics and punctuation so we can perform
 * case-insensitive comparisons against user content.
 */
function normalizeTerm(term) {
  return term
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BANNED_TERMS = [...new Set([...DEFAULT_BANNED_TERMS, ...EXTRA_BANNED_TERMS])]
  .map(term => {
    const normalized = normalizeTerm(term);
    return {
      original: term,
      normalized,
      isPhrase: normalized.includes(' '),
    };
  })
  .filter(entry => entry.normalized.length > 0);

/**
 * Extracts all text-like content from a Discord message including embeds and attachment filenames.
 * Moderation decisions are based on the combined text to avoid users bypassing filters via embeds.
 */
function collectMessageText(message) {
  const parts = [];
  if (message.content) parts.push(message.content);
  if (message.cleanContent && message.cleanContent !== message.content) parts.push(message.cleanContent);

  for (const embed of message.embeds || []) {
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    for (const field of embed.fields || []) {
      if (field.name) parts.push(field.name);
      if (field.value) parts.push(field.value);
    }
    if (embed.footer?.text) parts.push(embed.footer.text);
  }

  if (message.attachments?.size) {
    for (const attachment of message.attachments.values()) {
      if (attachment.name) parts.push(attachment.name);
    }
  }

  return parts;
}

/**
 * Normalises user-provided text into a searchable form. The logic mirrors `normalizeTerm` so that our
 * comparisons behave identically for both configuration and runtime content.
 */
function normalizeContent(content) {
  return content
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Scans text for any configured banned term. Phrase matches look for whole words to reduce false
 * positives (e.g. "assistant" should not trigger a ban on "ass").
 */
function findBannedTerm(text) {
  const normalized = normalizeContent(text);
  if (!normalized) return null;

  const padded = ` ${normalized} `;
  const tokens = new Set(normalized.split(' ').filter(Boolean));

  for (const term of BANNED_TERMS) {
    if (term.isPhrase) {
      if (padded.includes(` ${term.normalized} `)) return term.original;
    } else if (tokens.has(term.normalized)) {
      return term.original;
    }
  }

  return null;
}

/**
 * Entry point used by the message handler. When a banned term is detected the offending message is
 * deleted, the author receives a DM explaining the reason, and a log entry is emitted. Returning a
 * boolean allows callers to skip additional processing for removed content.
 */
async function enforceContentModeration(message) {
  const textParts = collectMessageText(message);
  if (!textParts.length) return false;

  const match = findBannedTerm(textParts.join('\n'));
  if (!match) return false;

  try {
    await message.delete().catch(() => {});
    await message.author.send(`Your message in **${message.guild?.name || 'this server'}** was removed because it contained hate speech (detected term: "${match}").`).catch(() => {});
    log.tag('MODERATION').info(`Deleted hate speech from user=${message.author.id} guild=${message.guild?.id || 'DM'} match=${match}`);
  } catch (err) {
    log.tag('MODERATION').error('Failed to enforce content moderation:', err?.stack || err);
  }

  return true;
}

module.exports = {
  enforceContentModeration,
  DEFAULT_BANNED_TERMS,
};
