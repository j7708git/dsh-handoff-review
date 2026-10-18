// Continuation route-picker client tests (M3.1): load the browser bundle
// through a fake module loader. The pure selection helpers are exercised
// directly; the dialog gets one scripted-hooks render/confirm smoke test so the
// JSX wiring around those helpers is covered without a browser or real React.

import test from 'node:test'
import assert from 'node:assert/strict'

/** Module definition captured from the bundle's `window.__ModuleLoader__.load`. */
let definition
/** One shared module evaluation per test process. */
let evaluated

/**
 * Evaluate the client bundle once through a fake loader facade.
 * @returns {Promise<void>}
 */
async function ensureBundleEvaluated() {
  if (evaluated !== undefined) return
  globalThis.window = {
    __ModuleLoader__: {
      load(loaded) {
        definition = loaded
      },
    },
  }
  try {
    await import('../client.js?continuation-client-test')
  } finally {
    delete globalThis.window
  }
  assert.ok(definition !== undefined, 'client bundle did not register a module')
  evaluated = true
}

/**
 * Load the client bundle's exports without a browser shell.
 * @param {object} [reactImpl] `react` module implementation for this instance.
 * @returns {Promise<object>} the module exports
 */
async function loadClient(reactImpl = {}) {
  await ensureBundleEvaluated()
  return definition.factory((request) => {
    if (request === 'react') return reactImpl
    throw new Error(`unexpected client module: ${request}`)
  })
}

/**
 * Build a minimal scripted-hooks React stand-in for one render pass. Every
 * `useState` call consumes the next scripted value; effects and setters are
 * no-ops because the dialog is rendered with its loaded state directly.
 * @param {Array<unknown>} scripted State values in hook call order.
 * @returns {object} fake React module
 */
function makeScriptedReact(scripted) {
  let cursor = 0
  /** Setter calls recorded for assertions about state transitions. */
  const setCalls = []
  return {
    setCalls,
    createElement(type, props, ...children) {
      const flat = []
      const push = (child) => {
        if (Array.isArray(child)) {
          for (const nested of child) push(nested)
          return
        }
        if (child === undefined || child === null || child === false) return
        flat.push(child)
      }
      for (const child of children) push(child)
      return { type, props: props || {}, children: flat }
    },
    useState(initial) {
      const index = cursor
      const value = index < scripted.length ? scripted[index] : initial
      cursor += 1
      return [value, (next) => { setCalls.push({ index, value: next }) }]
    },
    useCallback(callback) {
      return callback
    },
    useEffect() {},
    useRef(initial) {
      return { current: initial }
    },
  }
}

/**
 * Visit every element node in a fake-rendered tree.
 * @param {unknown} node Element, array, or primitive child.
 * @param {(element: object) => void} visit Called for every element.
 * @returns {void}
 */
function walkElements(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walkElements(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  for (const child of node.children) walkElements(child, visit)
}

/**
 * Collect every element matching one predicate.
 * @param {unknown} tree Fake-rendered tree.
 * @param {(element: object) => boolean} predicate Element filter.
 * @returns {Array<object>} matching elements in tree order
 */
function findElements(tree, predicate) {
  const found = []
  walkElements(tree, (element) => {
    if (predicate(element)) found.push(element)
  })
  return found
}

const client = await loadClient()
/** Identity translator: option labels echo their locale key. */
const t = (key) => key

/**
 * Build one wire preview payload with a two-provider catalog.
 * @param {object} [overrides] Top-level payload overrides.
 * @returns {object} preview payload
 */
function makePreview(overrides = {}) {
  return {
    route: { provider: 'p1', model: 'm1' },
    efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
    defaultReasoningEffort: 'low',
    currentReasoningEffort: 'high',
    catalog: {
      groups: [
        {
          id: 'p1',
          name: 'Provider One',
          models: [
            {
              id: 'm1',
              name: 'Model One',
              reasoningEfforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
              defaultReasoningEffort: 'low',
            },
            { id: 'm2', name: 'Model Two', reasoningEfforts: [], defaultReasoningEffort: '' },
          ],
        },
        {
          id: 'p2',
          name: 'Provider Two',
          models: [{
            id: 'm3',
            name: 'Model Three',
            reasoningEfforts: [{ id: 'max', name: 'Max' }],
            defaultReasoningEffort: 'max',
          }],
        },
      ],
      failures: [],
    },
    ...overrides,
  }
}

test('continuation client: the catalog normalizer keeps only selectable identity and efforts', () => {
  const catalog = client.normalizeContinuationCatalog({
    groups: [
      {
        id: 'p1',
        name: 'P1',
        models: [
          {
            id: 'm1',
            name: 'M1',
            description: 'dropped',
            reasoningEfforts: [
              { id: 'low', name: 'Low', description: 'dropped' },
              { id: '', name: 'broken' },
              null,
            ],
            defaultReasoningEffort: 'low',
          },
          { id: 'm2', name: '', reasoningEfforts: [] },
        ],
      },
      { id: '', models: [{ id: 'x', name: 'X' }] },
      { id: 'empty', name: 'Empty', models: [] },
    ],
    failures: [{ id: 'fail', name: 'Fail' }],
  })
  assert.deepEqual(catalog, {
    failures: [{ id: 'fail', name: 'Fail' }],
    groups: [
      {
        id: 'p1',
        name: 'P1',
        models: [
          {
            id: 'm1',
            name: 'M1',
            efforts: [{ id: 'low', name: 'Low' }],
            defaultEffort: 'low',
          },
          { id: 'm2', name: 'm2', efforts: [], defaultEffort: '' },
        ],
      },
    ],
  })
})

test('continuation client: the initial selection keeps the source route and its current effort', () => {
  assert.deepEqual(client.initialContinuationSelection(makePreview()), {
    provider: 'p1',
    model: 'm1',
    effort: 'high',
  })
  // A current effort the catalog no longer advertises falls back to the model default.
  assert.deepEqual(client.initialContinuationSelection(makePreview({ currentReasoningEffort: 'removed' })), {
    provider: 'p1',
    model: 'm1',
    effort: 'low',
  })
  // A model without effort metadata has no selectable level.
  assert.deepEqual(
    client.initialContinuationSelection(makePreview({
      route: { provider: 'p1', model: 'm2' },
      currentReasoningEffort: 'high',
    })),
    { provider: 'p1', model: 'm2', effort: '' },
  )
  // A route the catalog omits is retained unchanged.
  assert.deepEqual(
    client.initialContinuationSelection(makePreview({ route: { provider: 'gone', model: 'gone-model' } })),
    { provider: 'gone', model: 'gone-model', effort: '' },
  )
  // An incomplete source route starts on the no-override option.
  assert.deepEqual(
    client.initialContinuationSelection(makePreview({ route: { provider: 'p1', model: '' } })),
    { provider: '', model: '', effort: '' },
  )
  // Older hosts only send the flat effort fields; they still preselect.
  const legacy = makePreview({ catalog: undefined })
  assert.deepEqual(client.initialContinuationSelection(legacy), {
    provider: 'p1',
    model: 'm1',
    effort: 'high',
  })
})

test('continuation client: provider, model and effort options follow the catalog', () => {
  const controls = client.continuationRouteControls(makePreview(), {
    provider: 'p1',
    model: 'm1',
    effort: 'high',
  }, t)
  assert.equal(controls.catalogAvailable, true)
  assert.deepEqual(controls.provider.options, [
    { value: '', label: 'dialog.providerSameAsSource' },
    { value: 'p1', label: 'Provider One' },
    { value: 'p2', label: 'Provider Two' },
  ])
  assert.equal(controls.provider.disabled, false)
  assert.deepEqual(controls.model.options, [
    { value: 'm1', label: 'Model One' },
    { value: 'm2', label: 'Model Two' },
  ])
  assert.equal(controls.model.disabled, false)
  assert.deepEqual(controls.effort.options, [
    { value: '', label: 'dialog.effortDefault' },
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' },
  ])
  assert.equal(controls.effort.disabled, false)
  assert.equal(controls.effort.showUnavailableHint, false)

  // A model with no advertised levels disables the effort select with the hint.
  const plain = client.continuationRouteControls(makePreview(), {
    provider: 'p1',
    model: 'm2',
    effort: '',
  }, t)
  assert.equal(plain.effort.disabled, true)
  assert.equal(plain.effort.showUnavailableHint, true)
  assert.deepEqual(plain.effort.options, [{ value: '', label: 'dialog.effortDefault' }])

  // Defensive: an empty model value still has a matching rendered option.
  const noModel = client.continuationRouteControls(makePreview(), {
    provider: 'p1',
    model: '',
    effort: '',
  }, t)
  assert.deepEqual(noModel.model.options[noModel.model.options.length - 1], {
    value: '',
    label: 'dialog.modelSource',
  })

  // A retained provider/model the catalog no longer lists stays selectable.
  const retained = client.continuationRouteControls(makePreview(), {
    provider: 'gone',
    model: 'gone-model',
    effort: '',
  }, t)
  assert.deepEqual(retained.provider.options[retained.provider.options.length - 1], {
    value: 'gone',
    label: 'gone',
  })
  assert.deepEqual(retained.model.options, [{ value: 'gone-model', label: 'gone-model' }])
  assert.equal(retained.model.disabled, true)

  // "Same as source" disables the model select and shows the source model placeholder.
  const sameAsSource = client.continuationRouteControls(makePreview(), {
    provider: '',
    model: '',
    effort: '',
  }, t)
  assert.deepEqual(sameAsSource.model.options, [{ value: '', label: 'dialog.modelSource' }])
  assert.equal(sameAsSource.model.disabled, true)
})

test('continuation client: an unavailable catalog disables the picker and offers only the model default', () => {
  const preview = makePreview({ catalog: { groups: [], failures: [] } })
  // The dialog's initial selection clears the effort when no level is advertised.
  const controls = client.continuationRouteControls(preview, {
    provider: 'p1',
    model: 'm1',
    effort: '',
  }, t)
  assert.equal(controls.catalogAvailable, false)
  assert.equal(controls.provider.disabled, true)
  assert.deepEqual(controls.provider.options, [
    { value: '', label: 'dialog.providerSameAsSource' },
    { value: 'p1', label: 'p1' },
  ])
  assert.deepEqual(controls.model.options, [{ value: 'm1', label: 'm1' }])
  assert.equal(controls.model.disabled, true)
  // A current Host always sends catalog.groups (empty here) and efforts: [], so
  // no flat list is invented; only the model default remains.
  assert.deepEqual(controls.effort.options, [{ value: '', label: 'dialog.effortDefault' }])
  assert.equal(controls.effort.disabled, true)
  assert.equal(controls.effort.showUnavailableHint, true)
})

test('continuation client: a legacy payload without a catalog keeps the flat effort list', () => {
  const preview = makePreview({ catalog: undefined })
  const controls = client.continuationRouteControls(preview, {
    provider: 'p1',
    model: 'm1',
    effort: 'high',
  }, t)
  assert.equal(controls.catalogAvailable, false)
  // Only the older wire shape (no catalog field at all) may use flat efforts.
  assert.deepEqual(controls.effort.options, [
    { value: '', label: 'dialog.effortDefault' },
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' },
  ])
  assert.equal(controls.effort.disabled, false)
  assert.equal(controls.effort.showUnavailableHint, false)
})

test('continuation client: changing provider or model re-derives the effort default', () => {
  const preview = makePreview()
  // A provider change re-applies the selected model's advertised default effort.
  assert.deepEqual(
    client.nextContinuationRouteSelection(preview, { provider: 'p1', model: 'm1', effort: 'high' }, { provider: 'p1' }),
    { provider: 'p1', model: 'm1', effort: 'low' },
  )
  const sharedModelCatalog = {
    groups: [
      { id: 'p1', name: 'P1', models: [{ id: 'shared', name: 'Shared' }] },
      { id: 'p2', name: 'P2', models: [{ id: 'shared', name: 'Shared' }, { id: 'other', name: 'Other' }] },
    ],
  }
  assert.deepEqual(
    client.nextContinuationRouteSelection(
      { ...preview, catalog: sharedModelCatalog },
      { provider: 'p1', model: 'shared', effort: '' },
      { provider: 'p2' },
    ),
    { provider: 'p2', model: 'shared', effort: '' },
  )
  // A provider switch without a shared model picks its first model and default effort.
  assert.deepEqual(
    client.nextContinuationRouteSelection(preview, { provider: 'p1', model: 'm1', effort: 'high' }, { provider: 'p2' }),
    { provider: 'p2', model: 'm3', effort: 'max' },
  )
  // A model switch resets the effort to that model's default (or none).
  assert.deepEqual(
    client.nextContinuationRouteSelection(preview, { provider: 'p1', model: 'm1', effort: 'high' }, { model: 'm2' }),
    { provider: 'p1', model: 'm2', effort: '' },
  )
  // "Same as source" clears the model and effort (no override is sent).
  assert.deepEqual(
    client.nextContinuationRouteSelection(preview, { provider: 'p1', model: 'm1', effort: 'high' }, { provider: '' }),
    { provider: '', model: '', effort: '' },
  )
})

test('continuation client: the start payload sends the route pair, effort and supplement only when set', () => {
  assert.deepEqual(client.buildContinuationStartPayload({
    sessionId: 's1',
    draftId: 'd1',
    provider: 'p2',
    model: 'm3',
    effort: 'max',
    supplement: '  keep going  ',
  }), {
    sessionId: 's1',
    draftId: 'd1',
    provider: 'p2',
    model: 'm3',
    reasoningEffort: 'max',
    supplement: 'keep going',
  })
  // A half pair is never sent; the Host then keeps the source route.
  assert.deepEqual(client.buildContinuationStartPayload({
    sessionId: 's1',
    draftId: 'd1',
    provider: 'p2',
    model: '',
    effort: '',
  }), { sessionId: 's1', draftId: 'd1' })
  assert.deepEqual(client.buildContinuationStartPayload({
    sessionId: 's1',
    draftId: 'd1',
  }), { sessionId: 's1', draftId: 'd1' })
})

// ---------------------------------------------------------------------------
// Dialog render/confirm smoke test (scripted hooks, no browser)
// ---------------------------------------------------------------------------

/**
 * Build one preview payload ready for the dialog (prompt + draft identity).
 * @param {object} [overrides] Top-level payload overrides.
 * @returns {object} dialog preview payload
 */
function makeDialogPreview(overrides = {}) {
  const prompt = '# Handoff continuation: source'
  return {
    ...makePreview(overrides),
    draftId: 'draft-1',
    prompt,
    chars: prompt.length,
    sourceTitle: 'source',
    cwd: '/tmp/ws',
    summarySource: 'llm',
    warnings: [],
    ...overrides,
  }
}

/**
 * Scripted hook values for one dialog render: locale tick, open dialog, preview,
 * then no error/loading, then the route picker selection and the form state.
 * @param {object} preview Dialog preview payload.
 * @param {{ provider: string, model: string, effort: string, supplement: string }} selection Current selection.
 * @returns {Array<unknown>} scripted state values in hook call order
 */
function dialogHooks(preview, selection) {
  return [
    0,                        // useLocaleTick
    { open: true },           // continuation dialog state
    preview,                  // preview
    null,                     // previewError
    false,                    // loading
    selection.provider,       // provider
    selection.model,          // model
    selection.effort,         // effort
    selection.supplement,     // supplement
    false,                    // submitting
    null,                     // submitError
    null,                     // navFailure
    null,                     // startedSession
    null,                     // failedSession
  ]
}

test('continuation client dialog: renders the provider/model/effort pickers from the preview', async () => {
  const preview = makeDialogPreview()
  const dialogClient = await loadClient(makeScriptedReact(dialogHooks(preview, {
    provider: 'p1',
    model: 'm1',
    effort: 'high',
    supplement: '',
  })))
  const tree = dialogClient.HandoffContinuationDialog({
    sessionId: 'session-src',
    runtime: { subscribeLocale: () => () => {}, openSession: async () => ({ ok: true }) },
    t,
  })
  assert.ok(tree !== null, 'dialog returned no element while open')

  const selects = findElements(tree, (element) => element.type === 'select')
  assert.equal(selects.length, 3, 'expected provider, model and effort selects')
  const optionsOf = (select) => findElements(select, (element) => element.type === 'option')
    .map((option) => option.props.value)
  assert.equal(selects[0].props.value, 'p1')
  assert.deepEqual(optionsOf(selects[0]), ['', 'p1', 'p2'])
  assert.equal(selects[1].props.value, 'm1')
  assert.deepEqual(optionsOf(selects[1]), ['m1', 'm2'])
  assert.equal(selects[1].props.disabled, false)
  assert.equal(selects[2].props.value, 'high')
  assert.deepEqual(optionsOf(selects[2]), ['', 'low', 'high'])

  const textareas = findElements(tree, (element) => element.type === 'textarea')
  assert.equal(textareas.length, 2, 'expected the read-only preview and the supplement')
  assert.equal(textareas[0].props.readOnly, true)
  assert.equal(textareas[0].props.value, preview.prompt)
  assert.equal(textareas[1].props.value, '')

  const titles = findElements(tree, (element) => element.props.className === 'hrc-title')
  assert.equal(titles.length, 1)
})

test('continuation client dialog: confirm sends the chosen provider/model/effort and closes on navigation', async () => {
  const preview = makeDialogPreview()
  const dialogClient = await loadClient(makeScriptedReact(dialogHooks(preview, {
    provider: 'p2',
    model: 'm3',
    effort: 'max',
    supplement: ' run tests ',
  })))
  const tree = dialogClient.HandoffContinuationDialog({
    sessionId: 'session-src',
    runtime: { subscribeLocale: () => () => {}, openSession: async () => ({ ok: true }) },
    t,
  })
  const confirmButton = findElements(tree, (element) => element.type === 'button' && element.props.key === 'confirm')
  assert.equal(confirmButton.length, 1)
  assert.equal(confirmButton[0].props.disabled, false)

  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) })
    return { ok: true, json: async () => ({ ok: true, sessionId: 'session-new' }) }
  }
  try {
    confirmButton[0].props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/handoff-review/api/continuation/start')
  assert.deepEqual(requests[0].body, {
    sessionId: 'session-src',
    draftId: 'draft-1',
    provider: 'p2',
    model: 'm3',
    reasoningEffort: 'max',
    supplement: 'run tests',
  })
  // A successful navigation consumes the dialog store's open flag.
  assert.equal(dialogClient.continuationDialogStore.of('session-src').open, false)
})

test('continuation client dialog: start warnings stay in the modal until acknowledged', async () => {
  const preview = makeDialogPreview()
  const fakeReact = makeScriptedReact(dialogHooks(preview, {
    provider: 'p2',
    model: 'm3',
    effort: 'max',
    supplement: '',
  }))
  const dialogClient = await loadClient(fakeReact)
  dialogClient.continuationDialogStore.open('session-src')
  let opened = 0
  const tree = dialogClient.HandoffContinuationDialog({
    sessionId: 'session-src',
    runtime: {
      subscribeLocale: () => () => {},
      openSession: async () => {
        opened += 1
        return { ok: true }
      },
    },
    t,
  })
  const confirmButton = findElements(tree, (element) => element.type === 'button' && element.props.key === 'confirm')
  assert.equal(confirmButton.length, 1)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      sessionId: 'session-new',
      warnings: ['無法套用 p2/m3：boom', '思考強度「max」無法套用，已改用模型預設。'],
    }),
  })
  try {
    confirmButton[0].props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    globalThis.fetch = originalFetch
  }

  // Hook index 12 is the startedSession state: the Host warnings are kept and
  // navigation waits for the user to acknowledge them.
  const started = fakeReact.setCalls.find((call) => call.index === 12)
  assert.deepEqual(started && started.value, {
    sessionId: 'session-new',
    warnings: ['無法套用 p2/m3：boom', '思考強度「max」無法套用，已改用模型預設。'],
  })
  assert.equal(opened, 0, 'navigation must wait for the warning acknowledgement')
  assert.equal(dialogClient.continuationDialogStore.of('session-src').open, true)
})

test('continuation client dialog: a warning acknowledgement renders and the open button navigates', async () => {
  const preview = makeDialogPreview()
  const hooks = dialogHooks(preview, {
    provider: 'p2',
    model: 'm3',
    effort: 'max',
    supplement: '',
  })
  // Seed the post-start state: session created + Host warnings.
  hooks[12] = { sessionId: 'session-new', warnings: ['warn-a', 'warn-b'] }
  const dialogClient = await loadClient(makeScriptedReact(hooks))
  let opened = 0
  const tree = dialogClient.HandoffContinuationDialog({
    sessionId: 'session-src',
    runtime: {
      subscribeLocale: () => () => {},
      openSession: async () => {
        opened += 1
        return { ok: true }
      },
    },
    t,
  })
  const warnings = findElements(tree, (element) => element.type === 'li')
    .filter((element) => element.props.className === 'hrc-msg hrc-warning')
    .map((element) => element.children.join(''))
  assert.deepEqual(warnings, ['⚠ warn-a', '⚠ warn-b'])
  const openButton = findElements(tree, (element) => element.type === 'button' && element.props.key === 'openCreated')
  assert.equal(openButton.length, 1)
  // Confirm is disabled and the form is frozen while the acknowledgement is pending.
  const confirmButton = findElements(tree, (element) => element.type === 'button' && element.props.key === 'confirm')
  assert.equal(confirmButton[0].props.disabled, true)
  const selects = findElements(tree, (element) => element.type === 'select')
  assert.ok(selects.every((select) => select.props.disabled === true), 'route selects must be frozen')

  openButton[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(opened, 1)
  assert.equal(dialogClient.continuationDialogStore.of('session-src').open, false)
})

test('continuation client dialog: a preview without the exact prompt keeps the busy state', async () => {
  const preview = makeDialogPreview({ prompt: undefined })
  const dialogClient = await loadClient(makeScriptedReact(dialogHooks(preview, {
    provider: 'p1',
    model: 'm1',
    effort: 'high',
    supplement: '',
  })))
  const tree = dialogClient.HandoffContinuationDialog({
    sessionId: 'session-src',
    runtime: { subscribeLocale: () => () => {}, openSession: async () => ({ ok: true }) },
    t,
  })
  assert.equal(findElements(tree, (element) => element.props.className === 'hrc-loading').length, 1)
  assert.equal(findElements(tree, (element) => element.type === 'select').length, 0)
  const confirmButton = findElements(tree, (element) => element.type === 'button' && element.props.key === 'confirm')
  assert.equal(confirmButton[0].props.disabled, true)
})

test('continuation client dialog: providers that failed to list are surfaced as a hint', async () => {
  const preview = makeDialogPreview()
  preview.catalog = {
    ...preview.catalog,
    failures: [{ id: 'broken', name: 'Broken' }, { id: 'offline', name: 'Offline' }],
  }
  const dialogClient = await loadClient(makeScriptedReact(dialogHooks(preview, {
    provider: 'p1',
    model: 'm1',
    effort: 'high',
    supplement: '',
  })))
  const tInterpolated = (key, params) => (params && params.names ? `${key}:${params.names}` : key)
  const tree = dialogClient.HandoffContinuationDialog({
    sessionId: 'session-src',
    runtime: { subscribeLocale: () => () => {}, openSession: async () => ({ ok: true }) },
    t: tInterpolated,
  })
  const hint = findElements(tree, (element) =>
    Array.isArray(element.children)
    && typeof element.children[0] === 'string'
    && element.children[0].startsWith('dialog.providersUnavailable'))
  assert.equal(hint.length, 1)
  assert.equal(hint[0].children[0], 'dialog.providersUnavailable:Broken, Offline')
})

test('continuation client dialog: a post-create failure offers the created session instead of Retry', async () => {
  const preview = makeDialogPreview()
  const fakeReact = makeScriptedReact(dialogHooks(preview, {
    provider: 'p1',
    model: 'm1',
    effort: 'high',
    supplement: '',
  }))
  const dialogClient = await loadClient(fakeReact)
  dialogClient.continuationDialogStore.open('session-src')
  let opened = 0
  const tree = dialogClient.HandoffContinuationDialog({
    sessionId: 'session-src',
    runtime: {
      subscribeLocale: () => () => {},
      openSession: async () => {
        opened += 1
        return { ok: true }
      },
    },
    t,
  })
  const confirmButton = findElements(tree, (element) => element.type === 'button' && element.props.key === 'confirm')
  assert.equal(confirmButton.length, 1)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: false,
      code: 'CREATE_FAILED',
      message: 'boom after create',
      sessionId: 'session-new',
    }),
  })
  try {
    confirmButton[0].props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    globalThis.fetch = originalFetch
  }

  // Hook index 13 is the failedSession state: the created id + message are kept
  // and Retry is never offered (the one-shot draft is already spent).
  const failed = fakeReact.setCalls.find((call) => call.index === 13)
  assert.deepEqual(failed && failed.value, { sessionId: 'session-new', message: 'boom after create' })
  assert.equal(opened, 0, 'the start failure must not navigate automatically')
  assert.equal(dialogClient.continuationDialogStore.of('session-src').open, true)
})

test('continuation client dialog: a failed-after-create state renders the session id, Open session and a frozen form', async () => {
  const preview = makeDialogPreview()
  const hooks = dialogHooks(preview, {
    provider: 'p1',
    model: 'm1',
    effort: 'high',
    supplement: '',
  })
  hooks[13] = { sessionId: 'session-new', message: 'boom after create' }
  const dialogClient = await loadClient(makeScriptedReact(hooks))
  let opened = 0
  const tree = dialogClient.HandoffContinuationDialog({
    sessionId: 'session-src',
    runtime: {
      subscribeLocale: () => () => {},
      openSession: async () => {
        opened += 1
        return { ok: true }
      },
    },
    t,
  })
  // The failed error and the created id are both visible; no Retry control exists.
  const alerts = findElements(tree, (element) => element.props.role === 'alert')
    .map((element) => element.children.join(''))
  assert.deepEqual(alerts, ['dialog.error'])
  const created = findElements(tree, (element) =>
    element.type === 'span' && element.children.length === 1 && element.children[0] === 'dialog.created')
  assert.equal(created.length, 1)
  assert.equal(findElements(tree, (element) =>
    element.type === 'button' && (element.props.key === 'retryStart' || element.props.key === 'retryPreview')).length, 0)
  const openButton = findElements(tree, (element) =>
    element.type === 'button' && element.props.key === 'openFailedCreated')
  assert.equal(openButton.length, 1)
  // The form is frozen once the session exists.
  const selects = findElements(tree, (element) => element.type === 'select')
  assert.ok(selects.every((select) => select.props.disabled === true), 'route selects must be frozen')
  const supplement = findElements(tree, (element) => element.type === 'textarea')
    .filter((element) => element.props.readOnly !== true)
  assert.ok(supplement.every((textarea) => textarea.props.disabled === true), 'supplement must be frozen')
  const confirmButton = findElements(tree, (element) => element.type === 'button' && element.props.key === 'confirm')
  assert.equal(confirmButton[0].props.disabled, true)

  openButton[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(opened, 1)
  assert.equal(dialogClient.continuationDialogStore.of('session-src').open, false)
})
