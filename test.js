// Smoke test for the pure helpers in shared.js. Run: node test.js
const fs = require('fs');
const assert = require('assert');

function run() {
  global.chrome = { storage: {} }; // never touched by the pure helpers
  global.crypto = require('crypto').webcrypto;
  // pf-config first so PF_* consts share the eval scope the helpers close over.
  eval(
    fs.readFileSync(__dirname + '/pf-config.js', 'utf8') +
    '\n' +
    fs.readFileSync(__dirname + '/shared.js', 'utf8')
  );

  // extractDelta — SSE payload parsing per provider
  assert.strictEqual(extractDelta('openrouter', { choices: [{ delta: { content: 'hi' } }] }), 'hi');
  assert.strictEqual(extractDelta('openrouter', { choices: [{ delta: {} }] }), '');
  assert.strictEqual(extractDelta('anthropic', { type: 'content_block_delta', delta: { text: 'ho' } }), 'ho');
  assert.strictEqual(extractDelta('anthropic', { type: 'message_start' }), '');

  // cleanResponse — fence stripping
  assert.strictEqual(cleanResponse('```\nhello\n```'), 'hello');
  assert.strictEqual(cleanResponse('```markdown\nhello\n```'), 'hello');
  assert.strictEqual(cleanResponse('  plain  '), 'plain');

  // uniqueName — suffixing
  assert.strictEqual(uniqueName('a', []), 'a');
  assert.strictEqual(uniqueName('a', ['a']), 'a (2)');
  assert.strictEqual(uniqueName('a', ['a', 'a (2)']), 'a (3)');

  // buildSystem — placeholder substitution incl. EXTRAS join
  const sys = buildSystem({ role: 'Teacher', format: 'Essay', length: 'None', tone: 'None', audience: 'None', extras: ['avoid jargon', 'include examples'] });
  assert.ok(sys.includes('Role the AI should adopt: Teacher'));
  assert.ok(sys.includes('avoid jargon, include examples'));
  const sysNone = buildSystem({ role: 'None', format: 'None', length: 'None', tone: 'None', audience: 'None', extras: [] });
  assert.ok(sysNone.includes('Extra requirements: None'));

  // getHostname
  assert.strictEqual(getHostname('https://mail.google.com/x'), 'mail.google.com');
  assert.strictEqual(getHostname('not a url'), null);

  // defaultParams — merge over None baseline
  const p = defaultParams({ role: 'Lawyer' });
  assert.strictEqual(p.role, 'Lawyer');
  assert.strictEqual(p.format, 'None');
  assert.strictEqual(p.provider, 'openrouter');

  // Promptify Free (MVP4) pure helpers
  assert.strictEqual(
    pfInviteLink('abc123'),
    'https://r129rashid.github.io/prompt-refiner-extension/?ref=abc123'
  );
  assert.strictEqual(pfTokenExpired(null), true);
  assert.strictEqual(pfTokenExpired({}), true);
  assert.strictEqual(pfTokenExpired({ expires_at: Math.floor(Date.now() / 1000) + 3600 }), false);
  assert.strictEqual(pfTokenExpired({ expires_at: Math.floor(Date.now() / 1000) + 10 }), true); // within skew

  console.log('all smoke tests passed');
}

run();
