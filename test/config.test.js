const test = require('node:test');
const assert = require('node:assert');

const CONFIG_PATH = require.resolve('../src/config');
const ORIGINAL_ENV = { ...process.env };

function reloadConfig(envUpdates = {}) {
  delete require.cache[CONFIG_PATH];
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV, envUpdates);
  return require('../src/config');
}

test('throws ConfigError with a clear message when required variables are missing', () => {
  assert.throws(() => reloadConfig({
    DISCORD_TOKEN: '',
    DISCORD_CLIENT_ID: '',
    STEAM_API_KEY: '',
  }), (err) => {
    assert.strictEqual(err.name, 'ConfigError');
    assert.deepStrictEqual(err.missingKeys, ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'STEAM_API_KEY']);
    assert.match(err.message, /DISCORD_TOKEN.*DISCORD_CLIENT_ID.*STEAM_API_KEY/);
    return true;
  });
});

test('validateEnv succeeds when required variables are present', () => {
  const cfg = reloadConfig({
    DISCORD_TOKEN: 'token',
    DISCORD_CLIENT_ID: 'client',
    STEAM_API_KEY: 'steam',
  });

  assert.doesNotThrow(() => cfg.validateEnv());
});

