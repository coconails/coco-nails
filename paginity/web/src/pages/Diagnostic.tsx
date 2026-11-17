import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconStethoscope } from '@tabler/icons-react';
import { errorMessage, post } from '../api';

interface Constat {
  niveau: 'ok' | 'attention' | 'probleme';
  titre: string;
  detail: string;
  conseil: string;
}
const COULEUR = { ok: 'green', attention: 'yellow', probleme: 'red' } as const;
const LIBELLE = { ok: 'ça va', attention: 'à surveiller', probleme: 'problème' } as const;

/** Diagnostic du site, en lecture seule : rien n'est modifié. */
export function Diagnostic({ siteId }: { siteId: string }) {
  const [r, setR] = useState<{ le: number; constats: Constat[]; explication: { texte: string; par: string } | null } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card withBorder radius="lg" padding="lg" data-section="diagnostic">
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <IconStethoscope size={20} color="var(--mantine-color-or-5)" />
            <Title order={2} fz="lg">
              Diagnostic du site
            </Title>
          </Group>
          <Button
            variant="light"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setR(await post(`/api/sites/${siteId}/diagnostic`));
              } catch (e) {
                notifications.show({ color: 'red', message: errorMessage(e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            Lancer le diagnostic
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          PAGINITY vérifie les publications, les fonctions serveur, les liens et les alertes, et vous explique ce qu’il trouve. Rien n’est modifié ni
          publié. Si l’assistant est actif, un modèle installé sur votre machine reformule le tout (rien ne sort de chez vous).
        </Text>
        {r?.explication && (
          <Alert color="blue" variant="light" title={`En bref (${r.explication.par})`}>
            <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
              {r.explication.texte}
            </Text>
          </Alert>
        )}
        {r?.constats.map((c, i) => (
          <Card key={i} withBorder radius="md" padding="sm">
            <Group gap="xs" align="flex-start" wrap="nowrap">
              <Badge color={COULEUR[c.niveau]} variant="light" style={{ flexShrink: 0 }}>
                {LIBELLE[c.niveau]}
              </Badge>
              <Stack gap={2}>
                <Text size="sm" fw={600}>
                  {c.titre}
                </Text>
                <Text size="sm">{c.detail}</Text>
                {c.conseil && (
                  <Text size="sm" c="dimmed">
                    Conseil : {c.conseil}
                  </Text>
                )}
              </Stack>
            </Group>
          </Card>
        ))}
      </Stack>
    </Card>
  );
}
