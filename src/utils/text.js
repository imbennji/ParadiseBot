/**
 * Renders a simple text progress bar using block emojis. Handy for embedding progress information in
 * Discord messages without relying on images.
 */
function makeProgressBar(current, total, width = 12) {
  if (!total || total <= 0) return 'N/A';
  const ratio = Math.max(0, Math.min(1, current / total));
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return '🟩'.repeat(filled) + '⬜'.repeat(empty);
}

/** Converts a duration in minutes to a friendly `xh ym` format. */
function fmtDuration(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** Converts minutes into a rounded hour string (one decimal place). */
function hours(mins) {
  return (Number(mins || 0) / 60).toFixed(1).replace(/\.0$/, '');
}

module.exports = {
  makeProgressBar,
  fmtDuration,
  hours,
};
