/**
 * Builds the public CDN URL for a Steam app icon. Returns `null` when Steam does not provide an icon
 * hash for the app.
 */
function appIconUrl(appid, img_icon_url) {
  if (!img_icon_url) return null;
  return `https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${img_icon_url}.jpg`;
}

module.exports = { appIconUrl };
