import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

test('autostart tray pushes update checkbox and page write disables duplicate clicks', async () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('$("#autoStart").addEventListener');
  const end = source.indexOf('$("#checkUpdate").addEventListener', start);
  let change, push, resolve;
  const field = { checked: false, disabled: false, addEventListener: (_, handler) => { change = handler; } };
  vm.runInNewContext(source.slice(start, end), {
    $: () => field, safely: handler => handler,
    window: { chrome: { webview: { addEventListener: (_, handler) => { push = handler; } } },
      oliviaDesktop: { setAutoStart: () => new Promise(done => { resolve = done; }) } }
  });
  push({ data: { type: 'auto-start-settings', autoStart: true } });
  assert.equal(field.checked, true);
  push({ data: { type: 'auto-start-settings', autoStart: false } });
  assert.equal(field.checked, false);
  field.checked = true;
  const pending = change({ target: field });
  assert.equal(field.disabled, true);
  resolve({ autoStart: true }); await pending;
  assert.equal(field.disabled, false); assert.equal(field.checked, true);
});
