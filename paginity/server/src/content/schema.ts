import YAML from 'yaml';
import { humanizeKey } from '../lib/util.js';

/**
 * Schémas de contenu : description des champs modifiables d'un site.
 * Source 1 : le fichier `.pages.yml` (format Pages CMS, lu avec adaptations).
 * Source 2 : déduction automatique à partir des fichiers JSON du site.
 */

export type FieldType = 'string' | 'text' | 'number' | 'boolean' | 'date' | 'select' | 'image' | 'file' | 'object';

export interface Field {
  name: string;
  label: string;
  description?: string;
  type: FieldType;
  required: boolean;
  list: null | { min?: number; max?: number };
  fields?: Field[];
  options?: { values: { label: string; value: string }[]; multiple?: boolean };
  pattern?: { regex: string; message?: string };
  min?: number;
  max?: number;
  minlength?: number;
  maxlength?: number;
  readonly?: boolean;
  hidden?: boolean;
  default?: unknown;
}

export interface Entry {
  name: string;
  label: string;
  description?: string;
  type: 'file' | 'collection';
  path: string;
  format: 'json' | 'yaml';
  /** Le fichier entier est une liste (Pages CMS : `list: true` sur l'entrée). */
  list: boolean;
  fields: Field[];
}

export interface Schema {
  source: '.pages.yml' | 'automatique';
  media: { input: string; output: string } | null;
  entries: Entry[];
  warnings: string[];
}

const TYPE_MAP: Record<string, FieldType> = {
  string: 'string',
  text: 'text',
  'rich-text': 'text',
  code: 'text',
  number: 'number',
  boolean: 'boolean',
  date: 'date',
  select: 'select',
  image: 'image',
  file: 'file',
  object: 'object',
  reference: 'string',
  uuid: 'string',
};

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function parseField(raw: any, warnings: string[], where: string): Field | null {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') {
    warnings.push(`Champ ignoré dans ${where} : nom manquant.`);
    return null;
  }
  const rawType = typeof raw.type === 'string' ? raw.type : 'string';
  let type = TYPE_MAP[rawType];
  if (!type) {
    warnings.push(`Le type « ${rawType} » du champ « ${raw.name} » n'est pas pris en charge : il est affiché comme un texte simple.`);
    type = 'string';
  }
  const opts = raw.options && typeof raw.options === 'object' ? raw.options : {};
  const f: Field = {
    name: raw.name,
    label: typeof raw.label === 'string' ? raw.label : humanizeKey(raw.name),
    description: typeof raw.description === 'string' ? raw.description : undefined,
    type,
    required: raw.required === true,
    list: null,
    readonly: raw.readonly === true || rawType === 'uuid',
    hidden: raw.hidden === true,
    default: raw.default,
  };
  if (raw.list === true) f.list = {};
  else if (raw.list && typeof raw.list === 'object') f.list = { min: asNumber(raw.list.min), max: asNumber(raw.list.max) };
  const pattern = raw.pattern ?? opts.pattern;
  if (typeof pattern === 'string') f.pattern = { regex: pattern };
  else if (pattern && typeof pattern.regex === 'string') f.pattern = { regex: pattern.regex, message: pattern.message };
  if (f.pattern) {
    try {
      new RegExp(f.pattern.regex);
    } catch {
      warnings.push(`Le motif du champ « ${f.name} » est invalide : il est ignoré.`);
      f.pattern = undefined;
    }
  }
  f.min = asNumber(opts.min ?? raw.min);
  f.max = asNumber(opts.max ?? raw.max);
  f.minlength = asNumber(opts.minlength);
  f.maxlength = asNumber(opts.maxlength);
  if (type === 'select') {
    const values = Array.isArray(opts.values) ? opts.values : [];
    f.options = {
      values: values.map((v: any) =>
        typeof v === 'object' && v !== null ? { label: String(v.label ?? v.value), value: String(v.value) } : { label: String(v), value: String(v) },
      ),
      multiple: opts.multiple === true,
    };
  }
  if ((type === 'image' || type === 'file') && opts.multiple === true && !f.list) f.list = {};
  if (type === 'object') {
    f.fields = (Array.isArray(raw.fields) ? raw.fields : []).map((x: any) => parseField(x, warnings, `${where} › ${f.label}`)).filter(Boolean) as Field[];
  }
  return f;
}

export function parsePagesYml(text: string): Schema {
  const warnings: string[] = [];
  let doc: any;
  try {
    doc = YAML.parse(text) ?? {};
  } catch (e) {
    return { source: '.pages.yml', media: null, entries: [], warnings: [`Le fichier .pages.yml contient une erreur : ${(e as Error).message}`] };
  }
  let media: Schema['media'] = null;
  if (typeof doc.media === 'string') media = { input: doc.media.replace(/\/+$/, ''), output: '/' + doc.media.replace(/^\/+|\/+$/g, '') };
  else if (doc.media && typeof doc.media.input === 'string') {
    media = { input: doc.media.input.replace(/^\/+|\/+$/g, ''), output: typeof doc.media.output === 'string' ? doc.media.output.replace(/\/+$/, '') : '' };
  } else if (Array.isArray(doc.media) && doc.media[0]?.input) {
    media = { input: String(doc.media[0].input).replace(/^\/+|\/+$/g, ''), output: String(doc.media[0].output ?? '').replace(/\/+$/, '') };
  }
  const entries: Entry[] = [];
  for (const raw of Array.isArray(doc.content) ? doc.content : []) {
    if (!raw || typeof raw.name !== 'string' || typeof raw.path !== 'string') {
      warnings.push('Une entrée de « content » a été ignorée (nom ou chemin manquant).');
      continue;
    }
    const type = raw.type === 'collection' ? 'collection' : 'file';
    const fmt = String(raw.format ?? (raw.path.endsWith('.json') ? 'json' : raw.path.match(/\.ya?ml$/) ? 'yaml' : 'json'));
    if (!['json', 'yaml', 'yml'].includes(fmt)) {
      warnings.push(`« ${raw.label ?? raw.name} » utilise le format ${fmt}, pas encore pris en charge par l'éditeur de contenus (utilisez le mode code).`);
      continue;
    }
    entries.push({
      name: raw.name,
      label: typeof raw.label === 'string' ? raw.label : humanizeKey(raw.name),
      description: typeof raw.description === 'string' ? raw.description : undefined,
      type,
      path: String(raw.path).replace(/^\/+|\/+$/g, ''),
      format: fmt === 'json' ? 'json' : 'yaml',
      list: raw.list === true,
      fields: (Array.isArray(raw.fields) ? raw.fields : []).map((x: any) => parseField(x, warnings, raw.label ?? raw.name)).filter(Boolean) as Field[],
    });
  }
  return { source: '.pages.yml', media, entries, warnings };
}

// ---------------------------------------------------------------------------
// Déduction automatique
// ---------------------------------------------------------------------------

const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|svg)$/i;

function inferField(name: string, value: unknown, depth: number): Field {
  const base: Field = { name, label: humanizeKey(name), type: 'string', required: false, list: null };
  if (typeof value === 'boolean') return { ...base, type: 'boolean' };
  if (typeof value === 'number') return { ...base, type: 'number' };
  if (typeof value === 'string') {
    if (IMAGE_RE.test(value) && !/\s/.test(value)) return { ...base, type: 'image' };
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ...base, type: 'date' };
    return { ...base, type: value.length > 80 || value.includes('\n') ? 'text' : 'string' };
  }
  if (Array.isArray(value)) {
    const sample = value.find((v) => v !== null && v !== undefined);
    if (sample && typeof sample === 'object' && !Array.isArray(sample) && depth < 4) {
      // Union des clés de tous les éléments.
      const merged: Record<string, unknown> = {};
      for (const item of value) if (item && typeof item === 'object') for (const [k, v] of Object.entries(item)) if (!(k in merged) || merged[k] === null) merged[k] = v;
      return { ...base, type: 'object', list: {}, fields: Object.entries(merged).map(([k, v]) => inferField(k, v, depth + 1)) };
    }
    const inner = inferField(name, sample ?? '', depth + 1);
    return { ...inner, list: {} };
  }
  if (value && typeof value === 'object' && depth < 4) {
    return { ...base, type: 'object', fields: Object.entries(value).map(([k, v]) => inferField(k, v, depth + 1)) };
  }
  return base;
}

export function inferEntry(relPath: string, json: unknown): Entry | null {
  const name = relPath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  const base = relPath.split('/').pop()!.replace(/\.json$/i, '');
  if (Array.isArray(json)) {
    const f = inferField('elements', json, 0);
    return { name, label: humanizeKey(base), type: 'file', path: relPath, format: 'json', list: true, fields: f.fields ?? [{ ...f, list: null, name: 'valeur' }] };
  }
  if (json && typeof json === 'object') {
    return {
      name,
      label: humanizeKey(base),
      type: 'file',
      path: relPath,
      format: 'json',
      list: false,
      fields: Object.entries(json).map(([k, v]) => inferField(k, v, 0)),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation (côté serveur ; l'interface fait les mêmes contrôles pour aider à la saisie)
// ---------------------------------------------------------------------------

export interface FieldError {
  chemin: string;
  message: string;
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function validateScalar(f: Field, v: unknown, where: string, errors: FieldError[]): void {
  if (isEmpty(v)) {
    if (f.required) errors.push({ chemin: where, message: `« ${f.label} » est obligatoire.` });
    return;
  }
  switch (f.type) {
    case 'string':
    case 'text':
    case 'image':
    case 'file':
      if (typeof v !== 'string') {
        errors.push({ chemin: where, message: `« ${f.label} » doit être un texte.` });
        return;
      }
      if (f.pattern && !new RegExp(f.pattern.regex).test(v)) errors.push({ chemin: where, message: f.pattern.message ?? `« ${f.label} » n'a pas le format attendu.` });
      if (f.minlength !== undefined && v.length < f.minlength) errors.push({ chemin: where, message: `« ${f.label} » : ${f.minlength} caractères minimum.` });
      if (f.maxlength !== undefined && v.length > f.maxlength) errors.push({ chemin: where, message: `« ${f.label} » : ${f.maxlength} caractères maximum.` });
      return;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        errors.push({ chemin: where, message: `« ${f.label} » doit être un nombre.` });
        return;
      }
      if (f.min !== undefined && v < f.min) errors.push({ chemin: where, message: `« ${f.label} » : minimum ${f.min}.` });
      if (f.max !== undefined && v > f.max) errors.push({ chemin: where, message: `« ${f.label} » : maximum ${f.max}.` });
      return;
    case 'boolean':
      if (typeof v !== 'boolean') errors.push({ chemin: where, message: `« ${f.label} » doit être oui ou non.` });
      return;
    case 'date':
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(Date.parse(v))) errors.push({ chemin: where, message: `« ${f.label} » doit être une date.` });
      return;
    case 'select': {
      const allowed = new Set(f.options?.values.map((o) => o.value) ?? []);
      const vals = Array.isArray(v) ? v : [v];
      for (const x of vals) if (typeof x !== 'string' || (allowed.size && !allowed.has(x))) errors.push({ chemin: where, message: `« ${f.label} » : valeur non autorisée (${String(x)}).` });
      return;
    }
    case 'object':
      if (typeof v !== 'object' || Array.isArray(v)) {
        errors.push({ chemin: where, message: `« ${f.label} » a un format inattendu.` });
        return;
      }
      validateFields(f.fields ?? [], v as Record<string, unknown>, where, errors);
  }
}

export function validateField(f: Field, v: unknown, where: string, errors: FieldError[]): void {
  if (f.list) {
    if (isEmpty(v)) {
      if (f.required || (f.list.min ?? 0) > 0) errors.push({ chemin: where, message: `« ${f.label} » doit contenir au moins ${Math.max(1, f.list.min ?? 1)} élément(s).` });
      return;
    }
    if (!Array.isArray(v)) {
      errors.push({ chemin: where, message: `« ${f.label} » doit être une liste.` });
      return;
    }
    if (f.list.min !== undefined && v.length < f.list.min) errors.push({ chemin: where, message: `« ${f.label} » : au moins ${f.list.min} élément(s).` });
    if (f.list.max !== undefined && v.length > f.list.max) errors.push({ chemin: where, message: `« ${f.label} » : au plus ${f.list.max} élément(s).` });
    v.forEach((item, i) => validateScalar({ ...f, required: f.type !== 'object' && f.required }, item, `${where}[${i}]`, errors));
    return;
  }
  validateScalar(f, v, where, errors);
}

export function validateFields(fields: Field[], obj: Record<string, unknown>, prefix: string, errors: FieldError[]): void {
  for (const f of fields) validateField(f, obj?.[f.name], prefix ? `${prefix}.${f.name}` : f.name, errors);
}

export function validateEntryValue(entry: Entry, value: unknown): FieldError[] {
  const errors: FieldError[] = [];
  if (entry.list) {
    if (!Array.isArray(value)) return [{ chemin: '', message: 'Le contenu doit être une liste.' }];
    value.forEach((item, i) => validateFields(entry.fields, item as Record<string, unknown>, `[${i}]`, errors));
  } else {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ chemin: '', message: 'Le contenu a un format inattendu.' }];
    validateFields(entry.fields, value as Record<string, unknown>, '', errors);
  }
  return errors;
}

/** Garde la mise en forme d'origine (indentation, retour à la ligne final). */
export function serializeLike(original: string | null, value: unknown, format: 'json' | 'yaml'): string {
  if (format === 'yaml') return YAML.stringify(value);
  let indent: string | number = 2;
  const m = original?.match(/^[[{]\r?\n([ \t]+)/);
  if (m) indent = m[1].includes('\t') ? '\t' : m[1].length;
  const trailing = original === null || original.endsWith('\n') ? '\n' : '';
  return JSON.stringify(value, null, indent) + trailing;
}
