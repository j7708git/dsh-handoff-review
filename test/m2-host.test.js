// Unit tests for the M2 host modules: round-history/settings store, config
// administration, and panel/diff payload builders (DEVELOPMENT.md M2;
// the M2 implementation contract).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HISTORY_DOMAIN,
  HISTORY_TEXT_LIMIT,
  HistoryStoreError,
  ROUNDS_TABLE,
  SETTINGS_DOMAIN,
  SETTINGS_TABLE,
  applyRoundFeedback,
  createRoundRecord,
  openHistoryStore,
  roundKey,
  roundRecordSchema,
  settingsRecordSchema,
} from '../lib/history-store.js';
import {
  CONFIG_DEFAULTS,
  CONFIG_FIELDS,
  ConfigAdminError,
  loadCatalog,
  mergeConfig,
  reviewerLabel,
  validateConfigPatch,
} from '../lib/config-admin.js';
import {
  buildChangedFileSummaries,
  buildDiffFiles,
  buildDiffPayload,
  buildPanelPayload,
  buildRoundHistory,
} from '../lib/panel-data.js';

/**
 * In-memory storage-domain double: one domain per opened spec name, with a
 * single serialized write chain shared by every table.
 * @returns {{ storageDomain: object, domains: Map<string, object>, opened: object[] }} the fake.
 */
function createFakeStorageDomain() {
  const opened = [];
  const domains = new Map();
  let chain = Promise.resolve();
  /** @param {() => Promise<unknown>} job queued write. @returns {Promise<unknown>} result. */
  const enqueue = (job) => {
    const result = chain.then(job);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const storageDomain = {
    open: async (spec) => {
      opened.push(spec);
      const tables = new Map();
      const domain = {
        name: spec.name,
        closed: false,
        table(name) {
          if (!spec.tables || spec.tables[name] === undefined) throw new Error(`unknown table ${name}`);
          if (!tables.has(name)) {
            const records = new Map();
            tables.set(name, {
              get: (key) => records.get(key),
              entries: () => new Map(records).entries(),
              keys: () => [...records.keys()][Symbol.iterator](),
              get size() {
                return records.size;
              },
              put: (key, value) => enqueue(async () => records.set(key, value)),
              delete: (key) => enqueue(async () => records.delete(key)),
              update: (key, fn) => enqueue(async () => {
                if (!records.has(key)) throw new Error(`missing key ${key}`);
                const next = fn(records.get(key));
                records.set(key, next);
                return next;
              }),
            });
          }
          return tables.get(name);
        },
        close: async () => {
          domain.closed = true;
        },
      };
      domains.set(spec.name, domain);
      return domain;
    },
  };
  return { storageDomain, domains, opened };
}

/**
 * Build one valid round record.
 * @param {object} [overrides] field overrides.
 * @returns {object} the record.
 */
function makeRound(overrides = {}) {
  return {
    version: 1,
    linkId: 'hr_test',
    round: 1,
    implSessionId: 'impl-1',
    reviewSessionId: 'review-1',
    handoff: '# Handoff for review (round 1)',
    report: null,
    status: 'handoff',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// history-store
// ---------------------------------------------------------------------------

test('history constants and round keys match the contract', () => {
  assert.equal(HISTORY_DOMAIN, 'handoff_review_history');
  assert.equal(ROUNDS_TABLE, 'rounds');
  assert.equal(SETTINGS_DOMAIN, 'handoff_review_settings');
  assert.equal(SETTINGS_TABLE, 'settings');
  assert.equal(HISTORY_TEXT_LIMIT, 20000);
  assert.equal(roundKey('hr_abc', 2), 'hr_abc:2');
  assert.equal(roundKey('hr_abc', '3'), 'hr_abc:3');
});

test('round and settings schemas accept the documented shapes', () => {
  assert.equal(roundRecordSchema.parse(makeRound()).round, 1);
  assert.throws(() => roundRecordSchema.parse(makeRound({ round: 0 })));
  assert.throws(() => roundRecordSchema.parse(makeRound({ status: 'bogus' })));
  assert.throws(() => roundRecordSchema.parse(makeRound({ version: 2 })));
  assert.throws(() => roundRecordSchema.parse(makeRound({ report: 5 })));

  const settings = settingsRecordSchema.parse({ version: 1, updatedAt: 5, config: { maxRounds: 5 } });
  assert.equal(settings.config.maxRounds, 5);
  assert.deepEqual(settingsRecordSchema.parse({ version: 1, updatedAt: 5, config: {} }).config, {});
  assert.throws(() => settingsRecordSchema.parse({ version: 1, updatedAt: 5, config: { maxRounds: 999 } }));
  assert.throws(() => settingsRecordSchema.parse({ version: 2, updatedAt: 5, config: {} }));
});

test('createRoundRecord builds plain JSON and caps handoff/report text', () => {
  const record = createRoundRecord({
    linkId: 'hr_abc',
    round: 2,
    implSessionId: 'impl-1',
    reviewSessionId: 'review-1',
    handoff: '# Handoff for review (round 2)',
    now: 777,
  });
  assert.equal(record.version, 1);
  assert.equal(record.linkId, 'hr_abc');
  assert.equal(record.round, 2);
  assert.equal(record.status, 'handoff');
  assert.equal(record.report, null);
  assert.equal(record.createdAt, 777);
  assert.equal(record.updatedAt, 777);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);

  const withReport = createRoundRecord({ linkId: 'hr_abc', round: 2, implSessionId: 'impl-1', report: 'REPORT', now: 1 });
  assert.equal(withReport.status, 'feedback');
  assert.equal(withReport.report, 'REPORT');

  const long = 'x'.repeat(HISTORY_TEXT_LIMIT + 500);
  const capped = createRoundRecord({
    linkId: 'hr_abc',
    round: 1,
    implSessionId: 'impl-1',
    handoff: long,
    report: long,
    now: 1,
  });
  assert.equal(capped.handoff.length, HISTORY_TEXT_LIMIT);
  assert.ok(capped.handoff.includes('已截斷'));
  assert.equal(capped.report.length, HISTORY_TEXT_LIMIT);
  assert.ok(capped.report.includes('已截斷'));
  assert.equal(roundRecordSchema.safeParse(capped).success, true);
});

test('applyRoundFeedback attaches a capped report without mutating the input', () => {
  const before = makeRound();
  const snapshot = JSON.stringify(before);
  const after = applyRoundFeedback(before, 'r'.repeat(HISTORY_TEXT_LIMIT + 10), 1234);
  assert.equal(JSON.stringify(before), snapshot);
  assert.equal(after.status, 'feedback');
  assert.equal(after.updatedAt, 1234);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.report.length, HISTORY_TEXT_LIMIT);
  assert.ok(after.report.includes('已截斷'));
  assert.equal(applyRoundFeedback(before, null, 5).report, '');
  assert.throws(
    () => applyRoundFeedback(null, 'x'),
    (error) => error instanceof HistoryStoreError && error.code === 'invalid-record',
  );
});

test('openHistoryStore persists rounds newest-first and settings overrides', async () => {
  const fake = createFakeStorageDomain();
  const store = await openHistoryStore(fake.storageDomain);
  assert.deepEqual(fake.opened.map((spec) => spec.name), [HISTORY_DOMAIN, SETTINGS_DOMAIN]);
  assert.equal(fake.opened[0].version, 1);
  assert.ok(fake.opened[0].tables[ROUNDS_TABLE].valueSchema);
  assert.ok(fake.opened[1].tables[SETTINGS_TABLE].valueSchema);

  await store.putRound(createRoundRecord({ linkId: 'hr_a', round: 1, implSessionId: 'impl-a', handoff: 'h1', now: 10 }));
  await store.putRound(createRoundRecord({ linkId: 'hr_a', round: 2, implSessionId: 'impl-a', handoff: 'h2', now: 20 }));
  await store.putRound(createRoundRecord({ linkId: 'hr_a', round: 3, implSessionId: 'impl-a', handoff: 'h3', now: 30 }));
  await store.putRound(createRoundRecord({ linkId: 'hr_b', round: 1, implSessionId: 'impl-b', handoff: 'b1', now: 40 }));

  assert.equal(store.getRound('hr_a', 2).handoff, 'h2');
  assert.equal(store.getRound('hr_a', 9), undefined);
  assert.deepEqual(store.listRounds('hr_a').map((record) => record.round), [3, 2, 1]);
  assert.deepEqual(store.listRounds('hr_b').map((record) => record.linkId), ['hr_b']);
  assert.deepEqual(store.listRounds('missing'), []);

  const roundsTable = fake.domains.get(HISTORY_DOMAIN).table(ROUNDS_TABLE);
  assert.equal(roundsTable.get('hr_a:1').handoff, 'h1');
  assert.deepEqual(JSON.parse(JSON.stringify(roundsTable.get('hr_a:3'))), roundsTable.get('hr_a:3'));

  assert.equal(store.getSettings(), undefined);
  const stored = await store.putSettings({ maxRounds: 5, reviewerProvider: 'deepseek', unknownKey: 'dropped' });
  assert.equal(stored.config.maxRounds, 5);
  assert.equal(stored.config.unknownKey, undefined);
  const settings = store.getSettings();
  assert.equal(settings.version, 1);
  assert.ok(Number.isFinite(settings.updatedAt));
  assert.deepEqual(settings.config, { maxRounds: 5, reviewerProvider: 'deepseek' });

  await store.close();
  assert.equal(fake.domains.get(HISTORY_DOMAIN).closed, true);
  assert.equal(fake.domains.get(SETTINGS_DOMAIN).closed, true);
  assert.throws(() => store.getRound('hr_a', 1), (error) => error.code === 'storage-unavailable');
  await assert.rejects(() => store.putSettings({ maxRounds: 4 }), (error) => error.code === 'storage-unavailable');
  await store.close();
});

test('openHistoryStore refuses a missing service and invalid records', async () => {
  await assert.rejects(
    () => openHistoryStore(undefined),
    (error) => error instanceof HistoryStoreError && error.code === 'storage-unavailable',
  );
  await assert.rejects(
    () => openHistoryStore({ open: async () => { throw new Error('backend down'); } }),
    (error) => error.code === 'storage-unavailable' && /backend down/.test(error.message),
  );

  const failingSecond = {
    open: async (spec) => {
      if (spec.name === SETTINGS_DOMAIN) throw new Error('settings medium missing');
      return { name: spec.name, table: () => ({ get: () => undefined, entries: () => [][Symbol.iterator](), put: async () => {} }), close: async () => { failingSecond.closed = true; } };
    },
    closed: false,
  };
  await assert.rejects(
    () => openHistoryStore(failingSecond),
    (error) => error.code === 'storage-unavailable' && /settings medium missing/.test(error.message),
  );
  assert.equal(failingSecond.closed, true);

  const fake = createFakeStorageDomain();
  const store = await openHistoryStore(fake.storageDomain);
  await assert.rejects(
    () => store.putRound(makeRound({ round: 0 })),
    (error) => error instanceof HistoryStoreError && error.code === 'invalid-record',
  );
  await assert.rejects(
    () => store.putSettings({ maxRounds: 999 }),
    (error) => error.code === 'invalid-record',
  );
  await store.close();
});

// ---------------------------------------------------------------------------
// config-admin
// ---------------------------------------------------------------------------

test('config defaults and UI descriptors match the eleven documented fields', () => {
  assert.deepEqual(CONFIG_DEFAULTS, {
    reviewerProvider: '',
    reviewerModel: '',
    reviewerReasoningEffort: '',
    reviewerPreset: '',
    maxRounds: 3,
    maxHandoffChars: 30000,
    diffPerFileChars: 6000,
    autoSummarize: false,
    readOnlyReviewer: true,
    autoContinue: false,
    maxDeliveriesPerMinute: 6,
  });
  assert.deepEqual(CONFIG_FIELDS.map((field) => field.key), Object.keys(CONFIG_DEFAULTS));
  const byKey = new Map(CONFIG_FIELDS.map((field) => [field.key, field]));
  assert.equal(byKey.get('reviewerProvider').kind, 'string');
  assert.equal(byKey.get('reviewerPreset').kind, 'string');
  assert.equal(byKey.get('maxRounds').kind, 'natural');
  assert.deepEqual([byKey.get('maxRounds').min, byKey.get('maxRounds').max], [1, 20]);
  assert.deepEqual([byKey.get('maxHandoffChars').min, byKey.get('maxHandoffChars').max], [1000, 200000]);
  assert.deepEqual([byKey.get('diffPerFileChars').min, byKey.get('diffPerFileChars').max], [100, 50000]);
  assert.deepEqual([byKey.get('maxDeliveriesPerMinute').min, byKey.get('maxDeliveriesPerMinute').max], [1, 60]);
  assert.equal(byKey.get('autoSummarize').kind, 'boolean');
  assert.equal(byKey.get('readOnlyReviewer').kind, 'boolean');
});

test('mergeConfig: valid overrides win, invalid ones fall back', () => {
  assert.deepEqual(mergeConfig(CONFIG_DEFAULTS, {}), CONFIG_DEFAULTS);
  assert.equal(mergeConfig(CONFIG_DEFAULTS, { maxRounds: 7 }).maxRounds, 7);
  assert.equal(mergeConfig(CONFIG_DEFAULTS, { maxRounds: 0 }).maxRounds, 3);
  assert.equal(mergeConfig(CONFIG_DEFAULTS, { maxRounds: '7' }).maxRounds, 3);
  assert.equal(mergeConfig({ maxRounds: 9 }, { maxRounds: 99 }).maxRounds, 9, 'invalid override -> base');
  assert.equal(mergeConfig({ maxRounds: 99 }, { maxRounds: 99 }).maxRounds, 3, 'invalid base -> default');
  assert.equal(mergeConfig(CONFIG_DEFAULTS, { reviewerProvider: '  deepseek  ' }).reviewerProvider, 'deepseek');
  assert.equal(mergeConfig(CONFIG_DEFAULTS, { reviewerModel: 'a\nb' }).reviewerModel, '');
  assert.deepEqual(Object.keys(mergeConfig(CONFIG_DEFAULTS, { unknown: true, maxRounds: 2 })).length, 11);
  assert.deepEqual(mergeConfig(undefined, undefined), CONFIG_DEFAULTS);
});

test('validateConfigPatch merges, warns on unknown keys, and rejects bad values', () => {
  const empty = validateConfigPatch({}, {});
  assert.deepEqual(empty.config, CONFIG_DEFAULTS);
  assert.deepEqual(empty.warnings, []);

  const merged = validateConfigPatch({ maxRounds: 2 }, {
    maxRounds: 5,
    reviewerProvider: '  deepseek  ',
    autoSummarize: true,
  });
  assert.equal(merged.config.maxRounds, 5);
  assert.equal(merged.config.reviewerProvider, 'deepseek');
  assert.equal(merged.config.autoSummarize, true);

  const warned = validateConfigPatch(CONFIG_DEFAULTS, { bogus: 1, maxRounds: 4 });
  assert.equal(warned.warnings.length, 1);
  assert.match(warned.warnings[0], /bogus/);
  assert.equal(warned.config.maxRounds, 4);
  assert.equal(Object.keys(warned.config).length, 11);
  assert.equal(warned.config.bogus, undefined);

  const invalidPatches = [
    { maxRounds: 0 }, { maxRounds: 21 }, { maxRounds: 2.5 }, { maxRounds: '3' },
    { maxHandoffChars: 999 }, { maxHandoffChars: 200001 },
    { diffPerFileChars: 99 }, { diffPerFileChars: 50001 },
    { maxDeliveriesPerMinute: 0 }, { maxDeliveriesPerMinute: 61 },
    { autoSummarize: 'true' }, { readOnlyReviewer: 1 },
    { reviewerProvider: 'a\nb' }, { reviewerModel: 'x'.repeat(201) }, { reviewerPreset: 5 },
  ];
  for (const patch of invalidPatches) {
    const key = Object.keys(patch)[0];
    assert.throws(
      () => validateConfigPatch(CONFIG_DEFAULTS, patch),
      (error) => error instanceof ConfigAdminError && error.code === 'BAD_BODY' && error.message.includes(`"${key}"`),
      `patch accepted: ${JSON.stringify(patch)}`,
    );
  }

  for (const bad of [null, undefined, [], 'x', 5]) {
    assert.throws(
      () => validateConfigPatch(CONFIG_DEFAULTS, bad),
      (error) => error instanceof ConfigAdminError && error.code === 'BAD_BODY',
    );
  }
});

test('loadCatalog maps llm providers/models and presets', async () => {
  const ctx = {
    get: (name) => {
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { provider: 'p2' }],
          listModels: async (provider) => [
            { provider, id: 'deepseek-v4', name: 'DeepSeek V4' },
            { provider, id: 'no-name' },
          ],
        };
      }
      if (name === 'agentPresets') {
        return {
          list: () => [{ id: 'preset-1', name: 'Preset One' }, { id: 'broken', name: '', broken: true }, { name: 'no id' }],
        };
      }
      if (name === 'sessionController') {
        return {
          modelCatalog: async () => ({
            groups: [{
              id: 'deepseek',
              models: [{
                id: 'deepseek-v4',
                reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'max' }], defaultEffort: 'high' },
              }],
            }],
          }),
        };
      }
      return undefined;
    },
  };
  const catalog = await loadCatalog(ctx);
  assert.deepEqual(catalog.providers, [
    { id: 'deepseek', name: 'DeepSeek' },
    { id: 'p2', name: 'p2' },
  ]);
  assert.deepEqual(catalog.models, [
    {
      provider: 'deepseek',
      model: 'deepseek-v4',
      name: 'DeepSeek V4',
      reasoningEfforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'max' }],
      defaultReasoningEffort: 'high',
    },
    { provider: 'deepseek', model: 'no-name', name: 'no-name' },
    { provider: 'p2', model: 'deepseek-v4', name: 'DeepSeek V4' },
    { provider: 'p2', model: 'no-name', name: 'no-name' },
  ]);
  assert.deepEqual(catalog.presets, [
    { id: 'preset-1', name: 'Preset One' },
    { id: 'broken', name: 'broken' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(catalog)), catalog);
});

test('loadCatalog degrades to empty lists on every failure', async () => {
  assert.deepEqual(await loadCatalog(undefined), { providers: [], models: [], presets: [] });
  assert.deepEqual(await loadCatalog({}), { providers: [], models: [], presets: [] });
  assert.deepEqual(
    await loadCatalog({ get: () => { throw new Error('no service'); } }),
    { providers: [], models: [], presets: [] },
  );
  assert.deepEqual(
    await loadCatalog({ get: (name) => (name === 'llm' ? { listProviders: () => { throw new Error('boom'); } } : undefined) }),
    { providers: [], models: [], presets: [] },
  );
  const rejectingModels = await loadCatalog({
    get: (name) => (name === 'llm'
      ? { listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }], listModels: async () => { throw new Error('timeout'); } }
      : undefined),
  });
  assert.deepEqual(rejectingModels, { providers: [{ id: 'deepseek', name: 'DeepSeek' }], models: [], presets: [] });
  assert.deepEqual(
    await loadCatalog({ get: (name) => (name === 'llm' ? { listProviders: 'nope' } : { list: 'nope' }) }),
    { providers: [], models: [], presets: [] },
  );
});

test('reviewerLabel renders provider/model or the default marker', () => {
  assert.equal(reviewerLabel({ reviewerProvider: 'deepseek', reviewerModel: 'deepseek-v4' }), 'deepseek/deepseek-v4');
  assert.equal(reviewerLabel({ reviewerProvider: '  deepseek ', reviewerModel: ' deepseek-v4 ' }), 'deepseek/deepseek-v4');
  assert.equal(reviewerLabel(CONFIG_DEFAULTS), '(預設)');
  assert.equal(reviewerLabel({ reviewerProvider: 'deepseek', reviewerModel: '' }), '(預設)');
  assert.equal(reviewerLabel(undefined), '(預設)');
  assert.equal(reviewerLabel({ reviewerProvider: 5, reviewerModel: 6 }), '(預設)');
});

// ---------------------------------------------------------------------------
// panel-data
// ---------------------------------------------------------------------------

test('buildRoundHistory renders bounded, plain-JSON history items', () => {
  const report = `REVIEW-REPORT\n${'r'.repeat(1000)}`;
  const handoff = `# Handoff for review (round 3)\n${'h'.repeat(1000)}`;
  const rounds = [
    makeRound({ round: 3, status: 'feedback', report, handoff, updatedAt: 30 }),
    makeRound({ round: 2, status: 'handoff', report: null, handoff: 'h2', updatedAt: 20 }),
    makeRound({ round: 1, status: 'handoff', report: null, handoff: 'h1', updatedAt: 10 }),
  ];
  const items = buildRoundHistory(rounds, { limit: 2 });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.round), [3, 2]);
  assert.equal(items[0].status, 'feedback');
  assert.equal(items[0].report, report);
  assert.equal(items[0].hasReport, true);
  assert.equal(items[0].hasHandoff, true);
  assert.ok(items[0].reportPreview.length <= 400);
  assert.ok(items[0].handoffPreview.length <= 400);
  assert.ok(items[0].reportPreview.startsWith('REVIEW-REPORT'));
  assert.equal(items[1].hasReport, false);
  assert.equal(items[1].report, null);
  assert.equal(items[1].reportPreview, '');
  assert.deepEqual(JSON.parse(JSON.stringify(items)), items);

  assert.deepEqual(buildRoundHistory(rounds, { limit: 0 }), []);
  assert.deepEqual(buildRoundHistory(null), []);
  assert.equal(buildRoundHistory(rounds).length, 3, 'default limit covers three rounds');
  assert.deepEqual(buildRoundHistory([null, 'x', 5]), []);
});

test('buildChangedFileSummaries merges files and honours the sinceSeq watermark', () => {
  const entries = [
    { seq: 1, path: 'src/a.js', oldText: 'a', newText: 'b' },
    { seq: 2, path: 'src/b.js', oldText: null, newText: 'one\ntwo' },
    { seq: 5, path: 'src/c.js', oldText: 'x', newText: 'y' },
  ];
  assert.deepEqual(buildChangedFileSummaries(entries), [
    { path: 'src/a.js', added: 1, removed: 1 },
    { path: 'src/b.js', added: 2, removed: 0 },
    { path: 'src/c.js', added: 1, removed: 1 },
  ]);
  assert.deepEqual(buildChangedFileSummaries(entries, { sinceSeq: 2 }), [
    { path: 'src/c.js', added: 1, removed: 1 },
  ]);
  assert.deepEqual(buildChangedFileSummaries(null), []);
});

test('buildDiffFiles renders update and created-file entries', () => {
  const entries = [
    { seq: 1, path: 'src/a.js', oldText: 'a', newText: 'b' },
    { seq: 2, path: 'src/new.js', oldText: null, newText: 'line1\nline2', operation: 'create' },
    { seq: 3, path: 'src/lazy.js', oldText: null, newText: '', operation: 'create', unavailable: true },
  ];
  const files = buildDiffFiles(entries);
  assert.deepEqual(files.map((file) => file.path), ['src/a.js', 'src/new.js', 'src/lazy.js']);
  assert.equal(files[0].added, 1);
  assert.equal(files[0].removed, 1);
  assert.match(files[0].diff, /```diff/);
  assert.match(files[0].diff, /--- a\/src\/a\.js/);
  assert.match(files[0].diff, /-a/);
  assert.match(files[0].diff, /\+b/);
  assert.equal(files[1].added, 2);
  assert.match(files[1].diff, /\+line1/);
  assert.match(files[1].diff, /\+line2/);
  assert.equal(files[2].diff, '（新檔內容未載入）');
  assert.deepEqual(JSON.parse(JSON.stringify(files)), files);

  const since = buildDiffFiles(entries, { sinceSeq: 1 });
  assert.deepEqual(since.map((file) => file.path), ['src/new.js', 'src/lazy.js']);
  const capped = buildDiffFiles([
    { seq: 1, path: 'big.js', oldText: null, newText: Array.from({ length: 200 }, (_, index) => `line-${index}-${'x'.repeat(40)}`).join('\n') },
  ], { perFileChars: 200 });
  assert.match(capped[0].diff, /（diff 已截斷）/);
  assert.deepEqual(buildDiffFiles(null), []);
});

test('buildPanelPayload returns bounded, plain-JSON panel data', () => {
  const payload = buildPanelPayload({
    link: { id: 'hr_1', status: 'reviewing', round: 2 },
    links: [{ id: 'hr_1' }, null, 'x'],
    role: 'impl',
    rounds: [{ round: 2 }, null],
    handoff: `# Handoff for review (round 2)\n${'h'.repeat(5000)}`,
    report: `REVIEW-REPORT\n${'r'.repeat(5000)}`,
    changedFiles: [{ path: 'src/a.js', added: 1, removed: 1 }],
    reviewer: { provider: 'deepseek', model: 'deepseek-v4', preset: 'default' },
    maxRounds: 5,
  });
  assert.equal(payload.link.id, 'hr_1');
  assert.deepEqual(payload.links, [{ id: 'hr_1' }]);
  assert.equal(payload.role, 'impl');
  assert.deepEqual(payload.rounds, [{ round: 2 }]);
  assert.ok(payload.handoff.length <= 4000);
  assert.ok(payload.handoff.includes('已截斷'));
  assert.ok(payload.report.length <= 4000);
  assert.ok(payload.report.includes('已截斷'));
  assert.deepEqual(payload.changedFiles, [{ path: 'src/a.js', added: 1, removed: 1 }]);
  assert.deepEqual(payload.reviewer, { provider: 'deepseek', model: 'deepseek-v4', preset: 'default' });
  assert.equal(payload.maxRounds, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);

  const empty = buildPanelPayload();
  assert.equal(empty.link, null);
  assert.deepEqual(empty.links, []);
  assert.equal(empty.role, null);
  assert.deepEqual(empty.rounds, []);
  assert.equal(empty.handoff, '');
  assert.equal(empty.report, '');
  assert.deepEqual(empty.changedFiles, []);
  assert.deepEqual(empty.reviewer, { provider: '', model: '', preset: '' });
  assert.equal(empty.maxRounds, 3);

  assert.equal(buildPanelPayload({ role: 'admin' }).role, null);
  assert.deepEqual(
    buildPanelPayload({ reviewer: { reviewerProvider: 'p', reviewerModel: 'm', reviewerPreset: 'x' } }).reviewer,
    { provider: 'p', model: 'm', preset: 'x' },
  );
  assert.equal(buildPanelPayload(null).link, null);
});

test('buildDiffPayload returns the diff drawer contract shape', () => {
  const files = [
    { path: 'src/a.js', added: 1, removed: 1, diff: '```diff\n...\n```' },
    { path: 'src/b.js', added: 2, removed: 0, diff: '（新檔內容未載入）' },
    null,
    { path: 5, added: 'x', removed: 'y', diff: 7 },
  ];
  const payload = buildDiffPayload({ round: 2, files });
  assert.equal(payload.round, 2);
  assert.deepEqual(payload.files.slice(0, 2), [
    { path: 'src/a.js', added: 1, removed: 1, diff: '```diff\n...\n```' },
    { path: 'src/b.js', added: 2, removed: 0, diff: '（新檔內容未載入）' },
  ]);
  assert.deepEqual(payload.files[2], { path: '', added: 0, removed: 0, diff: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);

  assert.deepEqual(buildDiffPayload(), { round: 1, files: [] });
  assert.deepEqual(buildDiffPayload({ round: 0, files: [] }), { round: 1, files: [] });
  assert.deepEqual(buildDiffPayload(null), { round: 1, files: [] });
});
