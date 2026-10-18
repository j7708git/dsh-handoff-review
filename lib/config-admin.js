// dsh-handoff-review — M2 config administration.
//
// Pure merge/validation of the eleven config fields plus a best-effort catalog
// loader for the settings page (`llm` providers/models, model reasoning efforts
// via `sessionController.modelCatalog`, and `agentPresets`). The composition
// config stays schemastery-validated; this module only defines the runtime
// semantics of persisted partial overrides.
//
// Plain ESM, no build step, no imports.

/** Documented config defaults (DEVELOPMENT.md §12). */
export const CONFIG_DEFAULTS = {
  reviewerProvider: '',
  reviewerModel: '',
  // Reasoning effort id for the reviewer model; empty = the model default.
  reviewerReasoningEffort: '',
  reviewerPreset: '',
  maxRounds: 3,
  maxHandoffChars: 30000,
  diffPerFileChars: 6000,
  autoSummarize: false,
  readOnlyReviewer: true,
  autoContinue: false,
  maxDeliveriesPerMinute: 6,
};

/**
 * UI/validation descriptors for every config field, in §12 order.
 * `kind` is `string`, `natural` (non-negative integer) or `boolean`; `min` /
 * `max` carry the accepted range (`max` is the character budget for strings).
 */
export const CONFIG_FIELDS = [
  { key: 'reviewerProvider', kind: 'string', max: 200 },
  { key: 'reviewerModel', kind: 'string', max: 200 },
  { key: 'reviewerReasoningEffort', kind: 'string', max: 50 },
  { key: 'reviewerPreset', kind: 'string', max: 200 },
  { key: 'maxRounds', kind: 'natural', min: 1, max: 20 },
  { key: 'maxHandoffChars', kind: 'natural', min: 1000, max: 200000 },
  { key: 'diffPerFileChars', kind: 'natural', min: 100, max: 50000 },
  { key: 'autoSummarize', kind: 'boolean' },
  { key: 'readOnlyReviewer', kind: 'boolean' },
  { key: 'autoContinue', kind: 'boolean' },
  { key: 'maxDeliveriesPerMinute', kind: 'natural', min: 1, max: 60 },
];

/** Default string field length cap used when a descriptor omits `max`. */
const DEFAULT_STRING_MAX = 200;

/** Lookup of field descriptors by config key. */
const FIELDS_BY_KEY = new Map(CONFIG_FIELDS.map((field) => [field.key, field]));

/**
 * Error raised by config administration: `code: 'BAD_BODY'` for a malformed or
 * out-of-range patch.
 */
export class ConfigAdminError extends Error {
  /**
   * @param {string} code stable error code (`BAD_BODY`).
   * @param {string} message human-readable diagnostic detail.
   * @param {ErrorOptions} [options] standard `cause` carrier.
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ConfigAdminError';
    /** @type {string} */
    this.code = code;
  }
}

/**
 * Merge a partial override over a base config with normalize semantics: a
 * valid override wins (strings are trimmed), an invalid or absent override
 * falls back to the base value, and an invalid base value falls back to
 * `CONFIG_DEFAULTS`. Unknown keys are ignored.
 *
 * @param {object | undefined} base base (composition or effective) config.
 * @param {object | undefined} overrides partial override.
 * @returns {object} the normalized effective config with exactly ten keys.
 */
export function mergeConfig(base, overrides) {
  const baseConfig = isPlainObject(base) ? base : {};
  const overrideConfig = isPlainObject(overrides) ? overrides : {};
  const merged = {};
  for (const field of CONFIG_FIELDS) {
    const overrideValue = normalizeField(field, overrideConfig[field.key]);
    const baseValue = normalizeField(field, baseConfig[field.key]);
    merged[field.key] = overrideValue !== undefined
      ? overrideValue
      : baseValue !== undefined
        ? baseValue
        : CONFIG_DEFAULTS[field.key];
  }
  return merged;
}

/**
 * Validate a settings patch against the current effective config.
 *
 * A patch is a partial object: present keys are validated (ranges in
 * `CONFIG_FIELDS`; strings trimmed, single-line, at most 200 chars; booleans
 * exactly boolean) and merged over `current`; unknown keys are ignored with a
 * warning. Invalid types/ranges throw `ConfigAdminError('BAD_BODY', message)`.
 *
 * @param {object | undefined} current current effective config (may be partial).
 * @param {object} patch partial config patch from the settings page.
 * @returns {{ config: object, warnings: string[] }} the merged config and warnings.
 */
export function validateConfigPatch(current, patch) {
  if (!isPlainObject(patch)) {
    throw new ConfigAdminError('BAD_BODY', 'config patch must be a JSON object');
  }

  // Start from the current effective values as-is: the composition config keeps
  // M1 semantics and must NOT be range-clamped just because Settings is saved.
  const source = isPlainObject(current) ? current : {};
  const config = {};
  for (const field of CONFIG_FIELDS) {
    const value = source[field.key];
    config[field.key] = value !== undefined ? value : CONFIG_DEFAULTS[field.key];
  }
  const warnings = [];

  for (const [key, value] of Object.entries(patch)) {
    const field = FIELDS_BY_KEY.get(key);
    if (field === undefined) {
      warnings.push(`Unknown config field "${key}" ignored`);
      continue;
    }
    if (value === undefined) continue;
    // A full-config save from the settings page echoes untouched composition
    // values (which may be outside the Settings ranges); preserve those instead
    // of rejecting or clamping an unrelated save.
    if (source[field.key] !== undefined && value === source[field.key]) continue;
    const normalized = normalizeField(field, value);
    if (normalized === undefined) {
      throw new ConfigAdminError('BAD_BODY', describeField(field));
    }
    config[key] = normalized;
  }

  return { config, warnings };
}

/**
 * Best-effort catalog for the settings page. Every service and call is
 * optional: missing services, throws and rejected promises degrade to empty
 * lists instead of failing the route.
 *
 * @param {{ get?: (name: string) => unknown } | undefined} ctx plugin context.
 * @returns {Promise<{
 *   providers: Array<{ id: string, name: string }>,
 *   models: Array<{ provider: string, model: string, name: string,
 *     reasoningEfforts?: Array<{ id: string, name: string }>,
 *     defaultReasoningEffort?: string }>,
 *   presets: Array<{ id: string, name: string }>,
 * }>} the catalog.
 */
export async function loadCatalog(ctx) {
  const providers = [];
  const models = [];
  const presets = [];

  // Reasoning capabilities per provider/model route come from the session
  // controller's model catalog; adapters that expose none simply have no
  // reasoning selector for that model.
  const reasoningByRoute = new Map();
  const modelCatalogService = getService(ctx, 'sessionController');
  if (modelCatalogService && typeof modelCatalogService.modelCatalog === 'function') {
    try {
      const catalog = await modelCatalogService.modelCatalog();
      const groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : [];
      for (const group of groups) {
        if (group === null || typeof group !== 'object' || !Array.isArray(group.models)) continue;
        for (const model of group.models) {
          if (model === null || typeof model !== 'object') continue;
          const providerId = firstText(group.id);
          const modelId = firstText(model.id);
          if (providerId === undefined || modelId === undefined) continue;
          const reasoning = model.reasoning;
          const efforts = reasoning && Array.isArray(reasoning.efforts)
            ? reasoning.efforts
              .map((effort) => {
                if (effort === null || typeof effort !== 'object') return null;
                const id = firstText(effort.id);
                if (id === undefined) return null;
                return { id, name: firstText(effort.name) ?? id };
              })
              .filter((effort) => effort !== null)
            : [];
          if (efforts.length === 0) continue;
          reasoningByRoute.set(JSON.stringify([providerId, modelId]), {
            reasoningEfforts: efforts,
            ...(firstText(reasoning.defaultEffort) !== undefined
              ? { defaultReasoningEffort: firstText(reasoning.defaultEffort) }
              : {}),
          });
        }
      }
    } catch {
      reasoningByRoute.clear();
    }
  }

  const llm = getService(ctx, 'llm');
  if (llm && typeof llm.listProviders === 'function') {
    for (const provider of safeArray(() => llm.listProviders())) {
      const id = firstText(provider && provider.id, provider && provider.provider);
      if (id === undefined) continue;
      providers.push({ id, name: firstText(provider && provider.name) ?? id });
    }

    if (typeof llm.listModels === 'function') {
      for (const provider of providers) {
        let listed;
        try {
          listed = await llm.listModels(provider.id);
        } catch {
          continue;
        }
        for (const model of Array.isArray(listed) ? listed : []) {
          const providerId = firstText(model && model.provider) ?? provider.id;
          const modelId = firstText(model && model.id, model && model.model);
          if (modelId === undefined) continue;
          const reasoning = reasoningByRoute.get(JSON.stringify([providerId, modelId]));
          models.push({
            provider: providerId,
            model: modelId,
            name: firstText(model && model.name) ?? modelId,
            ...(reasoning !== undefined ? reasoning : {}),
          });
        }
      }
    }
  }

  const presetsService = getService(ctx, 'agentPresets');
  if (presetsService && typeof presetsService.list === 'function') {
    let listed = [];
    try {
      listed = await presetsService.list();
    } catch {
      listed = [];
    }
    for (const preset of Array.isArray(listed) ? listed : []) {
      const id = firstText(preset && preset.id);
      if (id === undefined) continue;
      presets.push({ id, name: firstText(preset && preset.name) ?? id });
    }
  }

  return { providers, models, presets };
}

/**
 * Human-readable reviewer route label: `provider/model` when both are set,
 * otherwise `(預設)` (the reviewer follows the implementation session route).
 *
 * @param {{ reviewerProvider?: unknown, reviewerModel?: unknown } | undefined} config config object.
 * @returns {string} the reviewer label.
 */
export function reviewerLabel(config) {
  const input = isPlainObject(config) ? config : {};
  const provider = typeof input.reviewerProvider === 'string' ? input.reviewerProvider.trim() : '';
  const model = typeof input.reviewerModel === 'string' ? input.reviewerModel.trim() : '';
  return provider !== '' && model !== '' ? `${provider}/${model}` : '(預設)';
}

/**
 * Normalize one field value; returns `undefined` when the value is absent or
 * invalid for the field kind.
 * @param {{ key: string, kind: string, min?: number, max?: number }} field field descriptor.
 * @param {unknown} value candidate value.
 * @returns {string | number | boolean | undefined} the normalized value.
 */
function normalizeField(field, value) {
  if (value === undefined || value === null) return undefined;
  if (field.kind === 'string') {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (/[\r\n]/.test(trimmed)) return undefined;
    if (trimmed.length > (field.max ?? DEFAULT_STRING_MAX)) return undefined;
    return trimmed;
  }
  if (field.kind === 'natural') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
    if (field.min !== undefined && value < field.min) return undefined;
    if (field.max !== undefined && value > field.max) return undefined;
    return value;
  }
  if (field.kind === 'boolean') {
    return typeof value === 'boolean' ? value : undefined;
  }
  return undefined;
}

/**
 * Describe the validation rule of one field for an error message.
 * @param {{ key: string, kind: string, min?: number, max?: number }} field field descriptor.
 * @returns {string} the message.
 */
function describeField(field) {
  if (field.kind === 'string') {
    return `"${field.key}" must be a single-line string of at most ${field.max ?? DEFAULT_STRING_MAX} characters`;
  }
  if (field.kind === 'natural') {
    return `"${field.key}" must be an integer between ${field.min} and ${field.max}`;
  }
  return `"${field.key}" must be a boolean`;
}

/**
 * Resolve one optional plugin service without throwing.
 * @param {unknown} ctx plugin context.
 * @param {string} name service name.
 * @returns {unknown} the service, when available.
 */
function getService(ctx, name) {
  if (ctx === null || typeof ctx !== 'object') return undefined;
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Call a sync list accessor, degrading a throw to an empty array.
 * @param {() => unknown} accessor list accessor.
 * @returns {unknown[]} the list.
 */
function safeArray(accessor) {
  try {
    const value = accessor();
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/**
 * Return the first non-empty trimmed string among the candidates.
 * @param {...unknown} values candidate values.
 * @returns {string | undefined} the first useful text.
 */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * Object guard that excludes arrays and null.
 * @param {unknown} value candidate.
 * @returns {boolean} whether the value is a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
