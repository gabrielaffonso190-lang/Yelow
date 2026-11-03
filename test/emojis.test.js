import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emojiComponent,
  emojiText,
  getApplicationEmoji,
  loadApplicationEmojis,
} from '../src/config/emojis.js';

test('application emojis load by configured snowflake IDs and retain name compatibility', async () => {
  const success = {
    id: '1566947592229748756',
    name: 'vanta_success',
    animated: false,
    toString: () => '<:vanta_success:1566947592229748756>',
  };
  const shield = {
    id: '1566947581810974740',
    name: 'vanta_shield',
    animated: true,
    toString: () => '<a:vanta_shield:1566947581810974740>',
  };
  const emojis = new Map([
    [success.id, success],
    [shield.id, shield],
  ]);
  emojis.find = (predicate) => [...emojis.values()].find(predicate);
  const client = {
    application: {
      fetch: async () => {},
      emojis: { fetch: async () => emojis },
    },
  };

  const loaded = await loadApplicationEmojis(client, {
    VANTA_EMOJI_SHIELD: shield.id,
    VANTA_EMOJI_ERROR: 'missing_name',
  });
  assert.equal(loaded, 2);
  assert.equal(getApplicationEmoji('success'), success);
  assert.deepEqual(emojiComponent('shield'), {
    id: shield.id,
    name: shield.name,
    animated: true,
  });
  assert.equal(emojiText('success'), success.toString());
});
