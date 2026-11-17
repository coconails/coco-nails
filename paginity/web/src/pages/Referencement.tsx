import { useState } from 'react';
import { Accordion, Alert, Badge, Button, Card, Group, List, SegmentedControl, Stack, Switch, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconCircleCheck, IconSearch } from '@tabler/icons-react';
import { useParams } from 'react-router-dom';
import { errorMessage, get, post, put } from '../api';
import { Loading, Page } from '../components/Page';
import { useSite } from './Site';
import { SearchConsoleSite } from './SearchConsoleSite';

type Niveau = 'probleme' | 'attention' | 'info';
interface Constat {
  regle: string;
  niveau: Niveau;
  page: string | null;
  message: string;
  conseil: string;
  nouveau?: boolean;
}
interface Audit {
  id: string;
  le: number;
  automatique: boolean;
  pages: number;
  pagesIndexables: number;
  constats: Constat[];
  verifie: string[];
  corriges: Constat[];
  comparaison: number | null;
}
interface Etat {
  reglages: { hebdo: boolean };
  enCours: boolean;
  publie: boolean;
  brouillon: Audit | null;
  enLigne: Audit | null;
  historique: { id: string; le: number; cible: string; automatique: boolean; problemes: number; attention: number; info: number }[];
}
const NIVEAU: Record<Niveau, { libelle: string; couleur: string; titre: string }> = {
  probleme: { libelle: 'problème', couleur: 'red', titre: 'Problèmes' },
  attention: { libelle: 'à améliorer', couleur: 'yellow', titre: 'À améliorer' },
  info: { libelle: 'à savoir', couleur: 'gray', titre: 'À savoir' },
};
const date = (t: number) => new Date(t).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/** M1 — audit de référencement local : lecture seule, aucun compte extérieur, aucune IA. */
export function ReferencementPage() {
  const { id } = useParams();
  const site = useSite();
  const q = useQuery({ queryKey: ['referencement', id], queryFn: () => get<Etat>(`/api/sites/${id}/referencement`) });
  const [cible, setCible] = useState<'brouillon' | 'en-ligne'>('brouillon');
  const [busy, setBusy] = useState(false);
  if (!q.data || !site.data) return <Loading />;
  const e = q.data;
  const a = cible === 'brouillon' ? e.brouillon : e.enLigne;
  const lancer = async () => {
    setBusy(true);
    try {
      await post(`/api/sites/${id}/referencement/audit`, { cible });
      await q.refetch();
    } catch (err) {
      notifications.show({ color: 'red', message: errorMessage(err), autoClose: 10_000 });
    } finally {
      setBusy(false);
    }
  };
  const compte = (n: Niveau) => a?.constats.filter((c) => c.niveau === n).length ?? 0;

  return (
    <Page
      titre="Référencement"
      sousTitre="Ce que les moteurs de recherche trouvent sur le site : titres, descriptions, plan du site, données pour Google, liens, images. Lecture seule : rien n’est modifié."
      fil={[{ label: 'Tableau de bord', to: '/' }, { label: site.data.nom, to: `/sites/${id}` }, { label: 'Référencement' }]}
      largeur={1000}
    >
      <Card withBorder radius="lg" padding="lg" data-section="audit">
        <Stack gap="sm">
          <Group justify="space-between" align="flex-end">
            <SegmentedControl
              value={cible}
              onChange={(v) => setCible(v as typeof cible)}
              data={[
                { value: 'brouillon', label: 'Brouillon (avant publication)' },
                { value: 'en-ligne', label: 'Site en ligne', disabled: !e.publie },
              ]}
            />
            <Button leftSection={<IconSearch size={16} />} loading={busy || e.enCours} onClick={() => void lancer()}>
              Lancer l’audit
            </Button>
          </Group>
          <Text size="sm" c="dimmed">
            L’audit lit le site tel que les moteurs le reçoivent (avant que le JavaScript ne s’exécute). Les repères de longueur sont des usages courants,
            pas des règles de Google. Il n’y a pas de « note » : seulement des constats vérifiables.
          </Text>
          {e.reglages && site.data.droits.reglages && (
            <Switch
              label="Refaire l’audit chaque semaine (site en ligne) et m’alerter s’il y a un nouveau problème"
              checked={e.reglages.hebdo}
              onChange={async (ev) => {
                try {
                  await put(`/api/sites/${id}/referencement/reglages`, { hebdo: ev.currentTarget.checked });
                  await q.refetch();
                } catch (err) {
                  notifications.show({ color: 'red', message: errorMessage(err) });
                }
              }}
            />
          )}
        </Stack>
      </Card>

      {!a ? (
        <Alert color="blue" variant="light">
          Aucun audit {cible === 'brouillon' ? 'du brouillon' : 'du site en ligne'} pour l’instant : « Lancer l’audit ».
        </Alert>
      ) : (
        <>
          <Card withBorder radius="lg" padding="lg" data-section="resume">
            <Stack gap="xs">
              <Group justify="space-between">
                <Title order={2} fz="lg">
                  Résultat du {date(a.le)}
                  {a.automatique ? ' (automatique)' : ''}
                </Title>
                <Text size="sm" c="dimmed">
                  {a.pages} page(s) lue(s), dont {a.pagesIndexables} destinée(s) aux moteurs
                </Text>
              </Group>
              <Group gap="xs">
                {(['probleme', 'attention', 'info'] as Niveau[]).map((n) => (
                  <Badge key={n} size="lg" variant="light" color={compte(n) ? NIVEAU[n].couleur : 'gray'}>
                    {compte(n)} {n === 'probleme' ? (compte(n) > 1 ? 'problèmes' : 'problème') : NIVEAU[n].titre.toLowerCase()}
                  </Badge>
                ))}
              </Group>
              {a.comparaison && (
                <Text size="sm">
                  Par rapport à l’audit du {date(a.comparaison)} : {a.constats.filter((c) => c.nouveau).length} nouveau(x) constat(s), {a.corriges.length} corrigé(s).
                </Text>
              )}
            </Stack>
          </Card>

          {(['probleme', 'attention', 'info'] as Niveau[]).map((n) => {
            const liste = a.constats.filter((c) => c.niveau === n);
            if (!liste.length) return null;
            return (
              <Card key={n} withBorder radius="lg" padding="lg" data-niveau={n}>
                <Stack gap="sm">
                  <Title order={3} fz="md">
                    {NIVEAU[n].titre} ({liste.length})
                  </Title>
                  {liste.map((c, i) => (
                    <Card key={i} withBorder radius="md" padding="sm">
                      <Group gap="xs" align="flex-start" wrap="nowrap">
                        <Badge color={NIVEAU[n].couleur} variant="light" style={{ flexShrink: 0 }}>
                          {NIVEAU[n].libelle}
                        </Badge>
                        <Stack gap={2} style={{ minWidth: 0 }}>
                          <Text size="sm" fw={600} style={{ wordBreak: 'break-word' }}>
                            {c.message}{' '}
                            {c.nouveau && (
                              <Badge size="xs" color="orange">
                                nouveau
                              </Badge>
                            )}
                          </Text>
                          {c.page && (
                            <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
                              Page : {c.page}
                            </Text>
                          )}
                          <Text size="sm" c="dimmed">
                            {c.conseil}
                          </Text>
                        </Stack>
                      </Group>
                    </Card>
                  ))}
                </Stack>
              </Card>
            );
          })}

          {a.verifie.length > 0 && (
            <Card withBorder radius="lg" padding="lg" data-section="verifie">
              <Title order={3} fz="md" mb="xs">
                Vérifié et correct
              </Title>
              <List spacing={4} size="sm" icon={<IconCircleCheck size={16} color="var(--mantine-color-green-6)" />}>
                {a.verifie.map((v) => (
                  <List.Item key={v}>{v}</List.Item>
                ))}
              </List>
            </Card>
          )}
          {a.corriges.length > 0 && (
            <Alert color="green" variant="light" title="Corrigé depuis l’audit précédent">
              <List size="sm">
                {a.corriges.map((c, i) => (
                  <List.Item key={i}>{c.message}</List.Item>
                ))}
              </List>
            </Alert>
          )}
        </>
      )}

      <SearchConsoleSite siteId={id!} peutRegler={!!site.data.droits.reglages} />

      {e.historique.length > 0 && (
        <Accordion variant="separated">
          <Accordion.Item value="historique">
            <Accordion.Control>Historique des audits ({e.historique.length})</Accordion.Control>
            <Accordion.Panel>
              <Table.ScrollContainer minWidth={480}>
                <Table fz="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Date</Table.Th>
                      <Table.Th>Version</Table.Th>
                      <Table.Th>Problèmes</Table.Th>
                      <Table.Th>À améliorer</Table.Th>
                      <Table.Th>À savoir</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {e.historique.map((h) => (
                      <Table.Tr key={h.id}>
                        <Table.Td>
                          {date(h.le)}
                          {h.automatique ? ' (auto)' : ''}
                        </Table.Td>
                        <Table.Td>{h.cible === 'brouillon' ? 'brouillon' : 'en ligne'}</Table.Td>
                        <Table.Td>{h.problemes}</Table.Td>
                        <Table.Td>{h.attention}</Table.Td>
                        <Table.Td>{h.info}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}
    </Page>
  );
}
