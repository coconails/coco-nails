import { useState } from 'react';
import { Button, Card, Group, Stack, Text } from '@mantine/core';
import { IconDeviceMobile } from '@tabler/icons-react';
import { errorMessage, post } from '../api';

/** Dernier coup d'œil avant de publier : le brouillon dans un cadre de téléphone. */
export function ApercuTelephone({ siteId }: { siteId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  return (
    <Card withBorder radius="lg" padding="lg" data-section="apercu-telephone">
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600}>Vérifier sur téléphone avant de publier</Text>
          <Button
            variant="light"
            leftSection={<IconDeviceMobile size={16} />}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setErreur(null);
              try {
                setUrl((await post<{ url: string }>(`/api/sites/${siteId}/apercu`)).url);
              } catch (e) {
                setErreur(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {url ? 'Actualiser' : 'Afficher'}
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          La plupart des clientes visitent le site sur leur téléphone : voici le brouillon tel qu’elles le verront.
        </Text>
        {erreur && (
          <Text size="sm" c="red">
            {erreur}
          </Text>
        )}
        {url && (
          <div style={{ alignSelf: 'center', padding: 10, borderRadius: 36, background: '#111', boxShadow: '0 8px 30px rgba(0,0,0,.35)' }}>
            <iframe title="Aperçu sur téléphone" src={url} style={{ width: 390, maxWidth: '78vw', height: 700, border: 0, borderRadius: 26, background: '#fff', display: 'block' }} />
          </div>
        )}
      </Stack>
    </Card>
  );
}
