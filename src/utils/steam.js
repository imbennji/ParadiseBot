function appIconUrl(appid, img_icon_url) {
  if (!img_icon_url) return null;
  return `https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${img_icon_url}.jpg`;
}

module.exports = { appIconUrl };
