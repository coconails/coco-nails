import { useState } from 'react';
import {
  ActionIcon, Box, Button, Fieldset, Group, Image, MultiSelect, NumberInput, Paper, Select, Stack, Switch, Text, Textarea, TextInput, Tooltip,
} from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconPhoto, IconPlus, IconTrash, IconX } from '@tabler/icons-react';
import type { Champ, MediaConfig } from '../types';
import { MediaPicker } from './MediaPicker';

export interface MediaContext {
  siteId: string;
  media: MediaConfig | null;
  dossierPublie: string;
}

/** Adresse publique (« /images/a.webp ») → chemin dans le dépôt (« public/images/a.webp »), pour afficher la vignette. */
export function repoPathOf(url: string, ctx: MediaContext): string | null {
  if (!url || /^[a-z]+:/i.test(url)) return null;
  const clean = url.split(/[?#]/)[0];
  if (ctx.media?.output && clean.startsWith(ctx.media.output + '/')) return `${ctx.media.input}${clean.slice(ctx.media.output.length)}`;
  const prefix = ctx.dossierPublie === '.' ? '' : `${ctx.dossierPublie}/`;
  return `${prefix}${clean.replace(/^\/+/, '')}`;
}

export function defaultValue(f: Champ): unknown {
  if (f.default !== undefined) return f.default;
  if (f.list) return [];
  switch (f.type) {
    case 'boolean':
      return false;
    case 'object':
      return defaultObject(f.fields ?? []);
    case 'number':
      return undefined;
    case 'select':
      return f.options?.multiple ? [] : '';
    default:
      return '';
  }
}

export function defaultObject(fields: Champ[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const f of fields) {
    const v = defaultValue(f);
    if (v !== undefined) o[f.name] = v;
  }
  return o;
}

/** Contrôle côté navigateur (le serveur refait les mêmes vérifications). */
export function fieldError(f: Champ, v: unknown): string | null {
  const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  if (empty) return f.required ? 'Obligatoire' : null;
  if (typeof v === 'string') {
    if (f.pattern) {
      try {
        if (!new RegExp(f.pattern.regex).test(v)) return f.pattern.message ?? 'Format inattendu';
      } catch {
        /* motif invalide : ignoré */
      }
    }
    if (f.maxlength !== undefined && v.length > f.maxlength) return `${f.maxlength} caractères maximum`;
    if (f.minlength !== undefined && v.length < f.minlength) return `${f.minlength} caractères minimum`;
  }
  if (typeof v === 'number') {
    if (f.min !== undefined && v < f.min) return `Minimum ${f.min}`;
    if (f.max !== undefined && v > f.max) return `Maximum ${f.max}`;
  }
  return null;
}

function ImageField({ f, value, onChange, mctx, readOnly }: { f: Champ; value: string; onChange: (v: string) => void; mctx: MediaContext; readOnly: boolean }) {
  const [open, setOpen] = useState(false);
  const rp = value ? repoPathOf(value, mctx) : null;
  return (
    <Box>
      <Text size="sm" fw={500}>
        {f.label}
        {f.required && <Text span c="red"> *</Text>}
      </Text>
      {f.description && (
        <Text size="xs" c="dimmed" mb={4}>
          {f.description}
        </Text>
      )}
      <Group align="flex-end" gap="sm" wrap="nowrap">
        <Box w={140} miw={140}>
          {rp && f.type === 'image' ? (
            <Image src={`/api/sites/${mctx.siteId}/brut?chemin=${encodeURIComponent(rp)}`} className="pg-vignette" alt={`Aperçu : ${f.label}`} fallbackSrc="/icone-192.png" />
          ) : (
            <Paper className="pg-vignette" withBorder style={{ display: 'grid', placeItems: 'center' }}>
              <IconPhoto size={28} opacity={0.4} />
            </Paper>
          )}
        </Box>
        <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
          <Text size="xs" c="dimmed" truncate>
            {value || 'Aucun fichier choisi'}
          </Text>
          {!readOnly && (
            <Group gap="xs">
              <Button size="xs" variant="light" onClick={() => setOpen(true)}>
                {value ? 'Changer' : 'Choisir'}
              </Button>
              {value && (
                <Button size="xs" variant="subtle" color="gray" onClick={() => onChange('')} leftSection={<IconX size={14} />}>
                  Retirer
                </Button>
              )}
            </Group>
          )}
        </Stack>
      </Group>
      <MediaPicker
        opened={open}
        onClose={() => setOpen(false)}
        siteId={mctx.siteId}
        images={f.type === 'image'}
        onPick={(url) => {
          onChange(url);
          setOpen(false);
        }}
      />
    </Box>
  );
}

function Scalar({ f, value, onChange, mctx, label = true }: { f: Champ; value: unknown; onChange: (v: unknown) => void; mctx: MediaContext; label?: boolean }) {
  const err = fieldError(f, value);
  const common = {
    label: label ? f.label : undefined,
    description: label ? f.description : undefined,
    withAsterisk: f.required,
    error: err && value !== undefined && value !== '' ? err : f.required && err ? err : undefined,
    readOnly: f.readonly,
    'aria-label': f.label,
  };
  switch (f.type) {
    case 'text':
      return <Textarea {...common} autosize minRows={3} maxRows={14} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.currentTarget.value)} />;
    case 'number':
      return (
        <NumberInput
          {...common}
          value={typeof value === 'number' ? value : ''}
          min={f.min}
          max={f.max}
          decimalSeparator=","
          allowDecimal
          onChange={(v) => onChange(v === '' ? undefined : typeof v === 'number' ? v : Number(String(v).replace(',', '.')))}
        />
      );
    case 'boolean':
      return <Switch label={f.label} description={f.description} checked={value === true} onChange={(e) => onChange(e.currentTarget.checked)} disabled={f.readonly} mt={4} />;
    case 'date':
      return <TextInput {...common} type="date" value={typeof value === 'string' ? value.slice(0, 10) : ''} onChange={(e) => onChange(e.currentTarget.value)} />;
    case 'select': {
      const data = (f.options?.values ?? []).map((o) => ({ value: o.value, label: o.label }));
      if (f.options?.multiple) return <MultiSelect {...common} data={data} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} searchable clearable />;
      return <Select {...common} data={data} value={typeof value === 'string' && value ? value : null} onChange={(v) => onChange(v ?? '')} searchable clearable={!f.required} />;
    }
    case 'image':
    case 'file':
      return <ImageField f={f} value={typeof value === 'string' ? value : ''} onChange={onChange} mctx={mctx} readOnly={!!f.readonly} />;
    case 'object':
      return (
        <Fieldset legend={label ? f.label : undefined} variant="filled" radius="md">
          {f.description && (
            <Text size="xs" c="dimmed" mb="xs">
              {f.description}
            </Text>
          )}
          <FieldsEditor fields={f.fields ?? []} value={(value as Record<string, unknown>) ?? {}} onChange={onChange} mctx={mctx} />
        </Fieldset>
      );
    default:
      return <TextInput {...common} value={typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(e.currentTarget.value)} />;
  }
}

function itemTitle(f: Champ, item: unknown, i: number): string {
  if (item && typeof item === 'object') {
    const first = (f.fields ?? []).find((x) => ['string', 'select'].includes(x.type));
    const v = first ? (item as Record<string, unknown>)[first.name] : undefined;
    if (typeof v === 'string' && v) return `${i + 1}. ${v}`;
  }
  return `Élément n°${i + 1}`;
}

function ListField({ f, value, onChange, mctx }: { f: Champ; value: unknown; onChange: (v: unknown) => void; mctx: MediaContext }) {
  const items = Array.isArray(value) ? value : [];
  const max = f.list?.max;
  const itemField: Champ = { ...f, list: null, required: f.type !== 'object' && f.required };
  const move = (i: number, d: number) => {
    const next = [...items];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    onChange(next);
  };
  const add = () => onChange([...items, f.type === 'object' ? defaultObject(f.fields ?? []) : defaultValue(itemField)]);
  return (
    <Stack gap="xs">
      <Box>
        <Text size="sm" fw={600}>
          {f.label} <Text span c="dimmed" fw={400}>({items.length}{max ? ` / ${max}` : ''})</Text>
        </Text>
        {f.description && (
          <Text size="xs" c="dimmed">
            {f.description}
          </Text>
        )}
      </Box>
      {items.map((item, i) => (
        <Paper key={i} withBorder p="sm" radius="md">
          <Group justify="space-between" mb={f.type === 'object' ? 'xs' : 0} wrap="nowrap" gap="xs">
            {f.type === 'object' ? (
              <Text size="sm" fw={600} truncate>
                {itemTitle(f, item, i)}
              </Text>
            ) : (
              <Box style={{ flex: 1 }}>
                <Scalar f={itemField} value={item} onChange={(v) => onChange(items.map((x, j) => (j === i ? v : x)))} mctx={mctx} label={false} />
              </Box>
            )}
            {!f.readonly && (
              <Group gap={2} wrap="nowrap">
                <Tooltip label="Monter">
                  <ActionIcon variant="subtle" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Monter">
                    <IconArrowUp size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Descendre">
                  <ActionIcon variant="subtle" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Descendre">
                    <IconArrowDown size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Supprimer">
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    onClick={() => {
                      if (window.confirm(`Supprimer « ${itemTitle(f, item, i)} » ?`)) onChange(items.filter((_, j) => j !== i));
                    }}
                    aria-label="Supprimer"
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            )}
          </Group>
          {f.type === 'object' && (
            <FieldsEditor fields={f.fields ?? []} value={(item as Record<string, unknown>) ?? {}} onChange={(v) => onChange(items.map((x, j) => (j === i ? v : x)))} mctx={mctx} />
          )}
        </Paper>
      ))}
      {!f.readonly && (
        <Button variant="light" leftSection={<IconPlus size={16} />} onClick={add} disabled={max !== undefined && items.length >= max} style={{ alignSelf: 'flex-start' }}>
          Ajouter
        </Button>
      )}
    </Stack>
  );
}

export function FieldEditor({ f, value, onChange, mctx }: { f: Champ; value: unknown; onChange: (v: unknown) => void; mctx: MediaContext }) {
  if (f.hidden) return null;
  if (f.list) return <ListField f={f} value={value} onChange={onChange} mctx={mctx} />;
  return <Scalar f={f} value={value} onChange={onChange} mctx={mctx} />;
}

/** Formulaire complet pour un objet : les clés inconnues du schéma sont conservées telles quelles. */
export function FieldsEditor({ fields, value, onChange, mctx }: { fields: Champ[]; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; mctx: MediaContext }) {
  return (
    <Stack gap="md">
      {fields.map((f) => (
        <FieldEditor
          key={f.name}
          f={f}
          value={value?.[f.name]}
          onChange={(v) => {
            const next = { ...(value ?? {}) };
            if (v === undefined) delete next[f.name];
            else next[f.name] = v;
            onChange(next);
          }}
          mctx={mctx}
        />
      ))}
    </Stack>
  );
}

/** Compte les erreurs bloquantes d'un formulaire (pour désactiver le bouton Enregistrer). */
export function countErrors(fields: Champ[], value: unknown): number {
  let n = 0;
  const obj = (value ?? {}) as Record<string, unknown>;
  for (const f of fields) {
    const v = obj[f.name];
    if (f.list) {
      const arr = Array.isArray(v) ? v : [];
      if (f.required && arr.length === 0) n++;
      if (f.list.max !== undefined && arr.length > f.list.max) n++;
      if (f.type === 'object') for (const it of arr) n += countErrors(f.fields ?? [], it);
      else for (const it of arr) if (fieldError({ ...f, list: null }, it)) n++;
    } else if (f.type === 'object') n += countErrors(f.fields ?? [], v);
    else if (fieldError(f, v)) n++;
  }
  return n;
}
