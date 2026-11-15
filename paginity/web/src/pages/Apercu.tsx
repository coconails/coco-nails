import { useEffect, useState } from 'react';
import { Alert, Box, Button, Center, Group, Loader, SegmentedControl, Stack, Text } from '@mantine/core';
import { IconDeviceDesktop, IconDeviceMobile, IconDeviceTablet, IconExternalLink, IconRefresh } from '@tabler/icons-react';
import { useParams } from 'react-router-dom';
import { errorMessage, post } from '../api';
import { Page } from '../components/Page';
import { useSite } from './Site';

const LARGEURS: Record<string, number> = { telephone: 390, tablette: 820, ordinateur: 1280 };

/** Aperçu privé du brouillon, dans les formats téléphone, tablette et ordinateur. */
export function ApercuPage() {
  const { id } = useParams();
  const site = useSite();
  const [format, setFormat] = useState('ordinateur');
  const [url, setUrl] = useState<string | null>(null);
  const [avert, setAvert] = useState<string[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cle, setCle] = useState(0);

  const build = async () => {
    setBusy(true);
    setErreur(null);
    try {
      const r = await post<{ url: string; avertissements: string[] }>(`/api/sites/${id}/apercu`);
      setUrl(r.url);
      setAvert(r.avertissements);
      setCle((k) => k + 1);
    } catch (e) {
      setErreur(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void build();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const largeur = LARGEURS[format];
  return (
    <Page
      titre="Aperçu"
      sousTitre="Votre brouillon, tel qu’il apparaîtra une fois publié. Seules les personnes connectées à PAGINITY peuvent le voir."
      fil={[{ label: 'Tableau de bord', to: '/' }, { label: site.data?.nom ?? '…', to: `/sites/${id}` }, { label: 'Aperçu' }]}
      largeur={1400}
      actions={
        <>
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={build} loading={busy}>
            Actualiser
          </Button>
          {url && (
            <Button component="a" href={url} target="_blank" rel="noopener" variant="default" rightSection={<IconExternalLink size={16} />}>
              Nouvel onglet
            </Button>
          )}
        </>
      }
    >
      <Group justify="center">
        <SegmentedControl
          value={format}
          onChange={setFormat}
          data={[
            { value: 'telephone', label: <Group gap={6} wrap="nowrap"><IconDeviceMobile size={16} />Téléphone</Group> },
            { value: 'tablette', label: <Group gap={6} wrap="nowrap"><IconDeviceTablet size={16} />Tablette</Group> },
            { value: 'ordinateur', label: <Group gap={6} wrap="nowrap"><IconDeviceDesktop size={16} />Ordinateur</Group> },
          ]}
        />
      </Group>
      {erreur && <Alert color="red">{erreur}</Alert>}
      {avert.length > 0 && (
        <Alert color="orange" variant="light" title="À vérifier">
          {avert.slice(0, 6).map((a) => (
            <Text size="sm" key={a}>
              {a}
            </Text>
          ))}
        </Alert>
      )}
      <Text size="xs" c="dimmed" ta="center">
        Dans l’aperçu, les formulaires de réservation, paiements, SMS et e-mails ne déclenchent aucune action réelle.
      </Text>
      <Box style={{ overflowX: 'auto' }}>
        {url ? (
          <Stack align="center">
            <iframe
              key={cle}
              src={url}
              title="Aperçu du site"
              className="pg-apercu-cadre"
              style={{ width: `min(100%, ${largeur}px)`, height: format === 'telephone' ? 780 : 820 }}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          </Stack>
        ) : (
          <Center py="xl">{busy ? <Loader /> : null}</Center>
        )}
      </Box>
    </Page>
  );
}
