import assert from 'node:assert/strict';
import test from 'node:test';
import { createTabNotices } from '../public/tab-notices.js';

function fixture(storage = new Map()) {
  const views = new Map();
  const notices = createTabNotices({ storage: {
    getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value),
  }, render: (tab, view) => views.set(tab, view) });
  return { notices, views, storage };
}
test('a seen release stays read after polling and restart, but a new release is unread', () => {
  const f = fixture();
  const event = { kind: 'info', id: 'v5', message: '发现新版本' };
  f.notices.set('update', 'release', event);
  assert.equal(f.views.get('update').kind, 'info');
  f.notices.visit('update');
  assert.equal(f.views.get('update').kind, null);
  f.notices.visit('ai'); f.notices.set('update', 'release', event);
  assert.equal(f.views.get('update').kind, null);
  const reopened = fixture(f.storage);
  reopened.notices.set('update', 'release', event);
  assert.equal(reopened.views.get('update').kind, null);
  reopened.notices.set('update', 'release', { ...event, id: 'v6' });
  assert.equal(reopened.views.get('update').kind, 'info');
});
test('faults survive viewing, clear when resolved and coexist with independent notices', () => {
  const f = fixture();
  f.notices.set('desktop', 'patch', { kind: 'info', id: 'v32', message: '更新补丁' });
  f.notices.set('desktop', 'health', { kind: 'fault', id: 'failed', message: '状态异常' });
  f.notices.visit('desktop');
  assert.equal(f.views.get('desktop').kind, 'fault');
  assert.deepEqual(f.views.get('desktop').messages, ['状态异常']);
  f.notices.set('desktop', 'health', null);
  assert.equal(f.views.get('desktop').kind, null);
});
test('events arriving on the open page are read and blocked browser storage is harmless', () => {
  let view;
  const f = createTabNotices({ storage: { getItem() { throw Error(); }, setItem() { throw Error(); } }, render: (_, v) => { view = v; } });
  f.visit('memory'); f.set('memory', 'task', { kind: 'info', id: 'job1', message: '完成' });
  assert.equal(view.kind, null);
  f.visit('ai'); f.set('memory', 'task', { kind: 'info', id: 'job2', message: '完成' });
  assert.equal(view.kind, 'info');
});
