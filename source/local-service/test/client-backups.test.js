import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink, open, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

// Literal archive content; ZIP storage records are built independently of the resolver.
function zip(main = 'original()', asset = 'version-one', entries = [['assets/main-build.js', main], ['assets/style.css', asset]]) {
  const locals = [], central = []; let offset = 0;
  for (const [name, content] of entries) {
    const n = Buffer.from(name), b = Buffer.from(content);
    let crc = 0xffffffff;
    for (const byte of b) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc, 14); l.writeUInt32LE(b.length, 18); l.writeUInt32LE(b.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(b.length, 20); c.writeUInt32LE(b.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(l, n, b); central.push(c, n); offset += l.length + n.length + b.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
function nativeDllBytes() {
  const patch = Buffer.from([0x33, 0xc0, 0x90, 0x90, 0x90, 0x90]);
  const studioPatterns = [
    'cbe8d2370800eb1eff15b2ec0800488d8fa8', 'cbe872340800eb1eff1552e90800488d8fa8',
    'cbe8b21f0800eb2bff1592d4080084c07514', 'cbe8ff1d0800eb1cff15dfd20800488d4f38',
  ].map(value => Buffer.from(value, 'hex'));
  const studioOriginal = Buffer.concat(studioPatterns), studioPatched = Buffer.from(studioOriginal);
  for (const pattern of studioPatterns) patch.copy(studioPatched, studioOriginal.indexOf(pattern) + 8);
  const containerPattern = Buffer.from('488bda488bf9ff1561a4040084c00f85', 'hex');
  const containerOriginal = Buffer.concat([Buffer.from('before'), containerPattern, Buffer.from('after')]);
  const containerPatched = Buffer.from(containerOriginal);
  patch.copy(containerPatched, containerOriginal.indexOf(containerPattern) + 6);
  return { studioOriginal, studioPatched, containerOriginal, containerPatched };
}
async function resolver(args) {
  try { return await (await import('../desktop/client-backups.js')).resolveClientBackups(args); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    const { DesktopController } = await import('../desktop/controller.js');
    const c = new DesktopController(args); c.readFeappStatus = args.readFeappStatus; c.readWebplayerStatus = args.readWebplayerStatus;
    return { feapp: await c.originalFeapp(args.layout, args.createOnMount), webplayer: await c.originalWebplayer(args.layout, args.createOnMount) };
  }
}
async function fixture() {
  const tempRoot = resolve(tmpdir());
  const root = await mkdtemp(join(tempRoot, 'client-backups-'));
  after(async () => {
    const target = resolve(root);
    if (dirname(target) !== tempRoot || !/^client-backups-[A-Za-z0-9]+$/u.test(basename(target))) throw new Error('Unsafe fixture cleanup target');
    await rm(target, { recursive: true, force: true });
  });
  const dataDir = join(root, 'data'), appData = join(root, 'app'), roamingAppData = join(root, 'roaming');
  const layout = { gameRoot: join(root, 'game'), version: '1.0', feappPath: join(root, 'fe.dat'), webplayerPath: join(root, 'wp.dat') };
  const key = createHash('md5').update(`${layout.gameRoot.toLowerCase()}\n1.0`).digest('hex');
  const managed = join(dataDir, 'client-backups'), legacy = join(roamingAppData, 'OliviaSoul', 'client-backups');
  await mkdir(managed, { recursive: true }); await mkdir(legacy, { recursive: true });
  await writeFile(layout.feappPath, zip('/*OliviaSoulPatch:current*/fe()'));
  await writeFile(layout.webplayerPath, zip('/*OliviaSoulPatch:current*/wp()'));
  await writeFile(join(legacy, `${key}.feapp.dat`), zip());
  await writeFile(join(legacy, 'usersettings.dat'), 'never copy');
  await writeFile(join(managed, `${'a'.repeat(32)}.feapp.dat`), zip());
  await writeFile(join(managed, `${'a'.repeat(32)}.webplayer.dat`), zip('player()'));
  const status = async path => ({ clientFound: true, mounted: [layout.feappPath, layout.webplayerPath].includes(path), managed: false });
  return { layout, dataDir, appData, roamingAppData, readFeappStatus: status, readWebplayerStatus: status, key, managed, legacy };
}

async function stagedFixture() {
  const f = await fixture(), staged = join(f.managed, 'resources-only', f.key);
  const pair = { feapp: join(staged, `${f.key}.feapp.dat`), webplayer: join(staged, `${f.key}.webplayer.dat`) };
  await mkdir(staged, { recursive: true });
  await writeFile(pair.feapp, zip());
  await writeFile(pair.webplayer, zip('player()'));
  return { ...f, staged, pair };
}

for (const [name, outsideFe, outsideWp] of [
  ['patched external originals', zip('/*OliviaSoulPatch:old*/external()'), zip('/*OliviaSoulPatch:old*/externalPlayer()')],
  ['different clean external originals', zip('differentOriginal()'), zip('differentPlayer()')],
]) test(`registered staged pair is not vetoed by ${name}`, async () => {
  const f = await stagedFixture();
  const legacyFe = join(f.legacy, `${f.key}.feapp.dat`), legacyWp = join(f.legacy, `${f.key}.webplayer.dat`);
  await writeFile(legacyFe, outsideFe); await writeFile(legacyWp, outsideWp);
  assert.deepEqual(await resolver(f), f.pair);
  assert.deepEqual(await readFile(f.pair.feapp), zip());
  assert.deepEqual(await readFile(f.pair.webplayer), zip('player()'));
  assert.deepEqual(await readFile(legacyFe), outsideFe);
  assert.deepEqual(await readFile(legacyWp), outsideWp);
  assert.deepEqual((await readdir(f.staged)).sort(), [`${f.key}.feapp.dat`, `${f.key}.webplayer.dat`]);
});

for (const mode of ['patched cache', 'wrong cached WP identity', 'full cache sidecar', 'clean current conflict']) {
  test(`registered staged pair still rejects ${mode}`, async () => {
    const f = await stagedFixture();
    if (mode === 'patched cache') await writeFile(f.pair.feapp, zip('/*OliviaSoulPatch:bad*/fe()'));
    if (mode === 'wrong cached WP identity') await writeFile(f.pair.webplayer, zip('player()', 'wrong-version'));
    if (mode === 'full cache sidecar') await writeFile(join(f.staged, 'usersettings.dat'), 'do not restore');
    if (mode === 'clean current conflict') {
      await writeFile(f.layout.feappPath, zip('differentCleanOriginal()'));
      f.readFeappStatus = async () => ({ clientFound: true, mounted: false, managed: false, updateAvailable: false, revision: null });
    }
    const before = await Promise.all(Object.values(f.pair).map(path => readFile(path)));
    const expectedError = { 'patched cache': /original.*patched/u, 'wrong cached WP identity': /identity/u, 'full cache sidecar': /sidecar/u, 'clean current conflict': /clean current original conflict/u }[mode];
    await assert.rejects(resolver({ ...f, createOnMount: mode === 'clean current conflict' }), expectedError);
    assert.deepEqual(await Promise.all(Object.values(f.pair).map(path => readFile(path))), before);
    if (mode === 'full cache sidecar') assert.equal(await readFile(join(f.staged, 'usersettings.dat'), 'utf8'), 'do not restore');
  });
}

test('registered staged pair rejects partial cache without filling from external originals', async () => {
  const f = await stagedFixture();
  await unlink(f.pair.webplayer);
  await assert.rejects(resolver(f), /incomplete|partial|pair.*conflict/u);
  assert.deepEqual(await readdir(f.staged), [`${f.key}.feapp.dat`]);
  assert.deepEqual(await readFile(f.pair.feapp), zip());
});

test('registered staged pair never bypasses a linked staging directory', async () => {
  const f = await stagedFixture(), originalLstat = fsPromises.lstat;
  // I-drive fixtures are exFAT; simulate only the unavailable reparse attribute,
  // retaining real archive reads, identity checks, and all other filesystem I/O.
  fsPromises.lstat = async (path, ...args) => {
    const info = await originalLstat(path, ...args);
    return resolve(String(path)) === resolve(f.staged)
      ? Object.assign(Object.create(info), { isSymbolicLink: () => true }) : info;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(resolver(f), /staging directory is unsafe/u); }
  finally { fsPromises.lstat = originalLstat; syncBuiltinESMExports(); }
  assert.deepEqual(await readFile(f.pair.feapp), zip());
  assert.deepEqual(await readFile(f.pair.webplayer), zip('player()'));
});
test('optional legacy staging plan rejects a reparse-resolved staged directory before writes', async () => {
  const f = await stagedFixture(), originalRealpath = fsPromises.realpath;
  fsPromises.realpath = async path => resolve(String(path)) === resolve(f.staged)
    ? join(f.managed, 'escaped')
    : originalRealpath(path);
  syncBuiltinESMExports();
  try {
    const { planVerifiedOptionalClientBackups } = await import('../desktop/client-backups.js');
    await assert.rejects(planVerifiedOptionalClientBackups({
      layout: f.layout, dataDir: f.dataDir, appData: f.appData, roamingAppData: f.roamingAppData,
    }), /reparse|unsafe|escapes/u);
    assert.deepEqual((await readdir(f.staged)).sort(), [`${f.key}.feapp.dat`, `${f.key}.webplayer.dat`]);
  } finally {
    fsPromises.realpath = originalRealpath;
    syncBuiltinESMExports();
  }
});
test('recovers verified legacy FE and associated WP into sidecar-free exact staged names', async () => {
  const f = await fixture(), result = await resolver(f);
  const dir = join(f.managed, 'resources-only', f.key);
  assert.equal(result.feapp, join(dir, `${f.key}.feapp.dat`));
  assert.equal(result.webplayer, join(dir, `${f.key}.webplayer.dat`));
  assert.deepEqual((await readdir(dir)).sort(), [`${f.key}.feapp.dat`, `${f.key}.webplayer.dat`]);
  assert.deepEqual(await readFile(result.webplayer), zip('player()'));
  assert.equal(await readFile(join(f.legacy, 'usersettings.dat'), 'utf8'), 'never copy');
  assert.deepEqual(await resolver(f), result);
});
test('differing associated WP candidates reject without staging FE', async () => {
  const f = await fixture();
  await writeFile(join(f.managed, `${'b'.repeat(32)}.feapp.dat`), zip());
  await writeFile(join(f.managed, `${'b'.repeat(32)}.webplayer.dat`), zip('otherPlayer()'));
  await assert.rejects(resolver(f), /ambiguous/i);
  await assert.rejects(readdir(join(f.managed, 'resources-only')), { code: 'ENOENT' });
});

test('clean rejection diagnostic bounds marker entry names and redacts unsafe ZIP names', async t => {
  const f = await fixture(), longName = `assets/${'a'.repeat(4096)}.js`;
  await writeFile(join(f.legacy, `${f.key}.feapp.dat`), zip('', '', [
    ['assets/main-build.js', 'original()'],
    ['assets/style.css', 'version-one'],
    [longName, '/*OliviaSoulPatch:unknown*/'],
    ['../private-token.js', '/*OliviaSoulPatch:unknown*/'],
  ]));
  f.readFeappStatus = async () => ({ clientFound: true, mounted: false, managed: false, updateAvailable: false, revision: null });
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  await assert.rejects(resolver(f), /archiveMarker=true/u);
  assert.equal(logs.length, 1);
  const diagnostic = JSON.parse(logs[0].slice('[client-backup] '.length));
  assert.deepEqual(diagnostic.markerEntries, ['[redacted]', '[redacted]']);
  assert.ok(logs[0].length <= 1200, 'diagnostic line must remain bounded for oversized ZIP entry names');
  assert.ok(!logs[0].includes(longName));
  assert.ok(!logs[0].includes('private-token'));
  await assert.rejects(readdir(join(f.managed, 'resources-only')), { code: 'ENOENT' });
});
for (const [name, bytes] of [['asset mismatch', zip('player()', 'other-version')], ['unknown marker', zip('/*OliviaSoulPatch:unknown*/player()')], ['invalid zip', Buffer.from('not zip')]]) {
  test(`rejects ${name} without staging`, async () => {
    const f = await fixture(); await writeFile(join(f.managed, `${'a'.repeat(32)}.webplayer.dat`), bytes);
    await assert.rejects(resolver(f), /backup|original|archive|identity/i);
    await assert.rejects(readdir(join(f.managed, 'resources-only')), { code: 'ENOENT' });
  });
}
test('refuses existing resource sidecars without changing backups', async () => {
  const f = await fixture(), dir = join(f.managed, 'resources-only', f.key);
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'usersettings.dat'), 'old');
  await assert.rejects(resolver(f), /sidecar|unexpected/i);
  assert.deepEqual(await readdir(dir), ['usersettings.dat']);
});
test('permits only exact supported versioned native backup sidecar names in an established staged pair', async () => {
  const f = await stagedFixture();
  const bytes = nativeDllBytes(), name = `NutStudioUI-${f.layout.version}.dll`;
  const target = join(f.layout.gameRoot, f.layout.version, 'plugins', 'Studio', 'NutStudioUI.dll');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes.studioPatched);
  await writeFile(join(f.staged, name), bytes.studioOriginal);
  assert.deepEqual(await resolver(f), f.pair);
  assert.deepEqual((await readdir(f.staged)).sort(), [`${f.key}.feapp.dat`, `${f.key}.webplayer.dat`, name].sort());
});
test('copies an exact verified legacy native sidecar into trusted staging and rejects conflicting approved sources', async () => {
  const f = await stagedFixture(), bytes = nativeDllBytes(), name = `NutContainerPlugin-${f.layout.version}.dll`;
  const target = join(f.layout.gameRoot, f.layout.version, 'plugins', 'Container', 'NutContainerPlugin.dll');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes.containerPatched);
  await writeFile(join(f.legacy, name), bytes.containerOriginal);
  assert.deepEqual(await resolver(f), f.pair);
  assert.equal((await readFile(join(f.staged, name))).equals(bytes.containerOriginal), true);

  const appBackups = join(f.appData, 'client-backups');
  await mkdir(appBackups, { recursive: true });
  await writeFile(join(appBackups, name), Buffer.concat([bytes.containerOriginal, Buffer.from('conflict')]));
  await assert.rejects(resolver(f), /ambiguous|conflict|native/u);
});
test('clean current files may establish new originals only for mount', async () => {
  const f = await fixture();
  await unlink(join(f.legacy, `${f.key}.feapp.dat`));
  await unlink(join(f.managed, `${'a'.repeat(32)}.feapp.dat`));
  await writeFile(f.layout.feappPath, zip()); await writeFile(f.layout.webplayerPath, zip('player()'));
  f.readFeappStatus = f.readWebplayerStatus = async () => ({ clientFound: true, mounted: false, managed: false });
  await assert.rejects(resolver(f), /missing/i);
  const result = await resolver({ ...f, createOnMount: true });
  assert.deepEqual(await readFile(result.feapp), zip());
});
test('root-only FE needs complete non-main archive identity', async () => {
  const f = await fixture();
  await unlink(join(f.legacy, `${f.key}.feapp.dat`));
  const oldKey = createHash('md5').update(f.layout.gameRoot.toLowerCase()).digest('hex');
  await writeFile(join(f.legacy, `${oldKey}.feapp.dat`), zip('original()', 'wrong-version'));
  await assert.rejects(resolver(f), /identity/i);
  await assert.rejects(readdir(join(f.managed, 'resources-only')), { code: 'ENOENT' });
});
for (const [name, entries] of [
  ['duplicate names', [['assets/main-build.js', 'original()'], ['assets/style.css', 'version-one'], ['assets/style.css', 'version-one']]],
  ['main-only identity', [['assets/main-build.js', 'original()']]],
]) test(`rejects ${name} as recovery identity`, async () => {
  const f = await fixture();
  await writeFile(f.layout.webplayerPath, zip('', '', entries));
  await writeFile(join(f.managed, `${'a'.repeat(32)}.webplayer.dat`), zip('', '', entries));
  await assert.rejects(resolver(f), /archive|identity/i);
  await assert.rejects(readdir(join(f.managed, 'resources-only')), { code: 'ENOENT' });
});
test('staged differing existing original is never overwritten', async () => {
  const f = await fixture(), dir = join(f.managed, 'resources-only', f.key);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${f.key}.feapp.dat`); await writeFile(path, zip('different()'));
  await assert.rejects(resolver(f), /ambiguous|conflict/i);
  assert.deepEqual(await readFile(path), zip('different()'));
  assert.deepEqual(await readdir(dir), [`${f.key}.feapp.dat`]);
});
test('same WP filename alone never links an unrelated managed FE pair', async () => {
  const f = await fixture(); await writeFile(join(f.managed, `${'a'.repeat(32)}.feapp.dat`), zip('unrelated()'));
  await assert.rejects(resolver(f), /missing|unknown/i);
  await assert.rejects(readdir(join(f.managed, 'resources-only')), { code: 'ENOENT' });
});
test('exact version key still rejects a different archive asset identity', async () => {
  const f = await fixture();
  await writeFile(join(f.legacy, `${f.key}.feapp.dat`), zip('original()', 'wrong-version'));
  await writeFile(join(f.legacy, `${f.key}.webplayer.dat`), zip('player()'));
  await assert.rejects(resolver(f), /identity/i);
  await assert.rejects(readdir(join(f.managed, 'resources-only')), { code: 'ENOENT' });
});
test('mount refuses clean live bytes conflicting with an existing original', async () => {
  const f = await fixture();
  await writeFile(f.layout.feappPath, zip('differentCleanMain()'));
  f.readFeappStatus = async () => ({ clientFound: true, mounted: false, managed: false });
  await assert.rejects(resolver({ ...f, createOnMount: true }), /clean.*conflict|conflict.*clean/i);
  await assert.rejects(readdir(join(f.managed, 'resources-only')), { code: 'ENOENT' });
});
test('oversized archive is rejected before archive subprocess or whole-file read', async () => {
  const f = await fixture();
  const file = await open(f.layout.feappPath, 'r+');
  try { await file.truncate(268435457); } finally { await file.close(); }
  await assert.rejects(resolver(f), /archive size limit/i);
});

// Independent literal before/after fixtures for the eleven inline locale edits
// in patch-feapp-local.ps1. Do not derive expected bytes from resolver logic.
const originalInlineLocale = `n="开始定制你的演奏吧～";c="仅支持 .mid 格式文件，大小<1MB，时长<10 分钟。仅含钢琴单一乐器，不得出现人声或其他乐器。";r="由音频文件直接转出的 .mid 可能演奏准确度较低；如有钢琴踏板延音，需以竖线标识体现。";st="可以通过上传指定格式的音乐文件或使用分享码，开启你的个性化创作体验。";Ft="为了获得最佳效果，请上传钢琴独奏的单轨 MIDI，避免包含人声或其他乐器。详见";Gt="《MIDI 定制演奏上传攻略》";Tt="• 仅支持 .mid 格式的 MIDI 文件，包含 1–2 条轨道，文件大小 < 1MB，乐曲时长 < 10 分钟。";Vt="• 不建议直接由音频转 MIDI，可能会影响演奏准确性。请确保上传的音乐不侵犯第三方版权。";Wt="• MIDI 中只能使用钢琴单一乐器，不得包含人声或其他乐器；如有踏板延音，需在 MIDI 中用竖线标注。";Un="文件大小必须小于5MB";Cn="文件格式必须为.mid"`;
const patchedInlineLocale = `n="上传 .mid/.midi，或在本地服务导入已下载曲库。";c="支持 .mid/.midi，单文件最大 64 MiB，不限次数。只有 MIDI 时，本地服务会按音符生成可播放 MP4。";r="已下载的分享码曲目可在本地服务中导入；生成文件保存在 MIDI 数据目录，播放缓存跟随曲目存储路径。";st="上传 .mid/.midi 即可生成本地演奏；已下载的分享码曲目可通过本地曲库导入恢复。";Ft="上传 .mid 或 .midi 后会按音符生成本地演奏视频；生成期间可以关闭弹窗。详见";Gt="《本地 MIDI 使用说明》";Tt="• 支持 .mid/.midi，单文件最大 64 MiB，不限次数；建议包含完整的速度、音符和踏板事件。";Vt="• 只有 MIDI 也可以上传，本地服务会自动生成钢琴音频和演奏视频，完成后进入“我的上传”。";Wt="• 生成文件保存在本地服务显示的 MIDI 数据目录；播放缓存会跟随设置中的曲目存储路径自动加载。";Un="MIDI 文件不能超过 64 MiB";Cn="请选择 .mid 或 .midi 文件"`;
const localeZip = (main, locale, style = 'version-one') => zip('', '', [
  ['assets/main-build.js', main], ['assets/style.css', style], ['assets/zh-cn-bd81633d.js', locale],
]);
async function inlineLocaleFixture({ managed = true, revision = 'v29', markerRevision = revision, tamper = '', style = 'version-one', locale = patchedInlineLocale, originalExtra = '' } = {}) {
  const f = await fixture();
  const original = localeZip('original()', originalInlineLocale + originalExtra);
  await writeFile(join(f.legacy, `${f.key}.feapp.dat`), original);
  await writeFile(join(f.managed, `${'a'.repeat(32)}.feapp.dat`), original);
  await writeFile(f.layout.feappPath, localeZip(`/*OliviaSoulPatch:mail-music-${markerRevision}*/fe()`, locale + tamper, style));
  f.readFeappStatus = async path => path === f.layout.feappPath
    ? { clientFound: true, mounted: managed && revision === 'v29', managed, updateAvailable: managed && revision !== 'v29', revision: managed ? revision : null, port: managed ? 27149 : null }
    : { clientFound: true, mounted: false, managed: false, updateAvailable: false, revision: null, port: null };
  return { ...f, original };
}
test('inline locale identity permits exactly the known eleven FE edits', async () => {
  const f = await inlineLocaleFixture(), result = await resolver(f);
  assert.deepEqual(await readFile(result.feapp), f.original);
  assert.deepEqual(await readFile(result.webplayer), zip('player()'));
});
test('inline locale identity permits the current v32 FE after mount registration', async () => {
  const f = await inlineLocaleFixture({ revision: 'v32', markerRevision: 'v32' });
  f.readFeappStatus = async path => path === f.layout.feappPath
    ? { clientFound: true, mounted: true, managed: true, updateAvailable: false, revision: 'v32', port: 27149 }
    : { clientFound: true, mounted: false, managed: false, updateAvailable: false, revision: null, port: null };
  const result = await resolver(f);
  assert.deepEqual(await readFile(result.feapp), f.original);
  assert.deepEqual(await readFile(result.webplayer), zip('player()'));
});
test('inline locale identity permits a managed v30 FE that is explicitly awaiting v31 upgrade', async () => {
  const f = await inlineLocaleFixture({ revision: 'v30', markerRevision: 'v30' });
  const result = await resolver(f);
  assert.deepEqual(await readFile(result.feapp), f.original);
  assert.deepEqual(await readFile(result.webplayer), zip('player()'));
});
for (const [name, options] of [
  ['extra byte tamper', { tamper: 'x' }],
  ['unmanaged current FE', { managed: false }],
  ['unrecognized FE revision', { revision: 'v999' }],
  ['unknown marker despite v29 status', { markerRevision: 'v999' }],
  ['only ten of eleven edits', { locale: patchedInlineLocale.replace('Cn="请选择 .mid 或 .midi 文件"', 'Cn="文件格式必须为.mid"') }],
  ['duplicate original occurrence', { originalExtra: ';Cn="文件格式必须为.mid"', tamper: ';Cn="请选择 .mid 或 .midi 文件"' }],
  ['other non-main asset change', { style: 'other-version' }],
]) test(`inline locale identity rejects ${name}`, async () => {
  const f = await inlineLocaleFixture(options);
  await assert.rejects(resolver(f), /identity|original|archive/i);
  await assert.rejects(readdir(join(f.managed, 'resources-only')), { code: 'ENOENT' });
});
test('inline locale identity never permits WP locale edits', async () => {
  const f = await fixture();
  await writeFile(f.layout.webplayerPath, localeZip('/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v13*/wp()', patchedInlineLocale));
  await writeFile(join(f.managed, `${'a'.repeat(32)}.webplayer.dat`), localeZip('player()', originalInlineLocale));
  f.readWebplayerStatus = async path => ({ clientFound: true, mounted: path === f.layout.webplayerPath, managed: path === f.layout.webplayerPath, updateAvailable: false, revision: path === f.layout.webplayerPath ? 'v13' : null });
  await assert.rejects(resolver(f), /identity/i);
  await assert.rejects(readdir(join(f.managed, 'resources-only')), { code: 'ENOENT' });
});

// Removing a rejecting field or leaking the full status/path must fail these
// boundary assertions; the archive inspector and no-staging behavior stay real.
for (const [name, clientFound, bytes, reason, source] of [
  ['clientFound false', false, zip(), 'clientFound=false:boolean', 'managed'],
  ['archive marker', true, zip('/*OliviaSoulPatch:unknown*/original()'), 'archiveMarker=true', 'roaming'],
]) test(`clean rejection diagnostic identifies ${name} without leaking paths or extra status`, async t => {
  const f = await fixture(), filename = `${f.key}.feapp.dat`;
  const originalPath = join(source === 'managed' ? f.managed : f.legacy, filename);
  await writeFile(originalPath, bytes);
  f.readFeappStatus = async () => ({
    clientFound, mounted: false, managed: false, updateAvailable: false, revision: null,
    response: 'private-response-must-not-be-logged', apiUrl: 'https://private.invalid/token',
  });
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  await assert.rejects(resolver(f), error => {
    assert.ok(error.message.includes(filename), 'UI error must identify the failing backup basename');
    assert.ok(error.message.includes(reason), 'UI error must identify the rejecting guard');
    assert.ok(error.message.length < 220, 'UI error must fit the existing truncation boundary');
    return true;
  });
  assert.equal(logs.length, 1);
  assert.ok(logs[0].startsWith('[client-backup] '));
  const diagnostic = JSON.parse(logs[0].slice('[client-backup] '.length));
  assert.deepEqual(diagnostic, {
    filename, hash: createHash('sha256').update(bytes).digest('hex'),
    source, fileBytes: bytes.length,
    markerEntries: clientFound ? ['assets/main-build.js'] : [],
    currentFeHash: createHash('sha256').update(zip('/*OliviaSoulPatch:current*/fe()')).digest('hex'),
    currentWebplayerHash: createHash('sha256').update(zip('/*OliviaSoulPatch:current*/wp()')).digest('hex'),
    clientFound: { value: clientFound, type: 'boolean' },
    mounted: { value: false, type: 'boolean' },
    managed: { value: false, type: 'boolean' },
    updateAvailable: { value: false, type: 'boolean' },
    revision: { value: null, type: 'object' },
    archiveMarker: !clientFound ? false : true,
  });
  assert.ok(!logs[0].includes(dirname(originalPath)));
  assert.ok(!logs[0].includes('private'));
  assert.ok(!logs[0].includes('\n'));
  await assert.rejects(readdir(join(f.managed, 'resources-only')), { code: 'ENOENT' });
});
