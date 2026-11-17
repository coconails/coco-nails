import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Card, Group, Stack, Switch, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconShieldSearch } from '@tabler/icons-react';
import { errorMessage, get, post, put } from '../api';

interface Etat {
  hebdo: boolean;
  dernier: null | { le: number; ok: boolean; composants: number; failles: { paquet: string; version: string; titre: string; gravite: string; url: string }[]; erreur: string | null };
}
const GRAVITE: Record<string, { l: string; c: string }> = {
  critical: { l: 'critique', c: 'red' },
  high: { l: 'élevée', c: 'red' },
  moderate: { l: 'moyenne', c: 'orange' },
  low: { l: 'faible', c: 'yellow' },
  info: { l: 'info', c: 'gray' },
};

/** Failles connues dans les composants de PAGINITY (aucune mise à jour automatique : PAGINITY prévient). */
export function ReglagesMisesAJour() {
  const q = useQuery({ queryKey: ['maj'], queryFn: () => get<Etat>('/api/reglages/mises-a-jour') });
  const [busy, setBusy] = useState(false);
  if (!q.data) return null;
  const e = q.data;
  return (
    <Card withBorder radius="lg" padding="lg" data-section="mises-a-jour">
      <Stack gap="sm">
        <Group gap="xs">
          <IconShieldSearch size={20} color="var(--mantine-color-or-5)" />
          <Title order={3} size="h4">
            Failles de sécurité connues
          </Title>
        </Group>
        <Text size="sm" c="dimmed">
          PAGINITY est fait de composants (bibliothèques) publiés sur npm. Il peut demander au registre de npm si une faille est connue dans l’un d’eux :
          seule la liste des composants et de leurs versions est envoyée. Rien n’est mis à jour tout seul ; la mise à jour se fait avec « paginity-maj »
          (sauvegarde, tests et retour arrière automatiques).
        </Text>
        <Group>
          <Button
            variant="default"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await post('/api/reglages/mises-a-jour/verifier');
                await q.refetch();
              } catch (err) {
                notifications.show({ color: 'red', message: errorMessage(err) });
              } finally {
                setBusy(false);
              }
            }}
          >
            Vérifier maintenant
          </Button>
          <Switch
            label="Vérifier chaque semaine"
            checked={e.hebdo}
            onChange={async (ev) => {
              try {
                await put('/api/reglages/mises-a-jour', { hebdo: ev.currentTarget.checked });
                await q.refetch();
              } catch (err) {
                notifications.show({ color: 'red', message: errorMessage(err) });
              }
            }}
          />
        </Group>
        {e.dernier && !e.dernier.ok && <Alert color="gray">{e.dernier.erreur}</Alert>}
        {e.dernier?.ok && e.dernier.failles.length === 0 && (
          <Alert color="green" variant="light">
            Aucune faille connue dans les {e.dernier.composants} composants ({new Date(e.dernier.le).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}).
          </Alert>
        )}
        {e.dernier?.ok &&
          e.dernier.failles.map((f, i) => (
            <Group key={i} gap="xs" wrap="nowrap" align="flex-start">
              <Badge color={GRAVITE[f.gravite]?.c ?? 'gray'} variant="light" style={{ flexShrink: 0 }}>
                {GRAVITE[f.gravite]?.l ?? f.gravite}
              </Badge>
              <Text size="sm">
                <b>{f.paquet}</b> ({f.version}) — {f.titre}{' '}
                {f.url.startsWith('https://') && (
                  <Anchor href={f.url} target="_blank" rel="noopener" size="sm">
                    détails
                  </Anchor>
                )}
              </Text>
            </Group>
          ))}
      </Stack>
    </Card>
  );
}
