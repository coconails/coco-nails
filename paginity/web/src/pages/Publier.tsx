import { ApercuTelephone } from './ApercuTelephone';
import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Card, Group, Modal, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowBackUp, IconExternalLink, IconEye, IconGitCompare, IconRocket } from '@tabler/icons-react';
import { Link, useParams } from 'react-router-dom';
import { errorMessage, get, post } from '../api';
import { DiffView } from '../components/DiffView';
import { ErrorBox, Loading, Page } from '../components/Page';
import { JobSteps } from '../components/Status';
import type { Activite } from '../types';
import { useSite } from './Site';

interface Modif {
  chemin: string;
  ancienChemin?: string;
  statut: string;
  auteurs: string[];
  rubrique?: string;
  champs?: { champ: string; avant: unknown; apres: unknown }[];
}

function valeur(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(vide)';
  if (typeof v === 'boolean') return v ? 'oui' : 'non';
  return String(v);
}

export function PublierPage() {
  const { id } = useParams();
  const site = useSite();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['modifications', id], queryFn: () => get<{ reference: number | null; fichiers: Modif[] }>(`/api/sites/${id}/modifications`) });
  const [message, setMessage] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<{ chemin: string; avant: string | null; apres: string | null; binaire?: boolean } | null>(null);
  const job = useQuery({
    queryKey: ['activite', jobId],
    queryFn: () => get<Activite>(`/api/activites/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (qq) => (qq.state.data && ['reussie', 'echouee', 'interrompue'].includes(qq.state.data.etat) ? false : 1500),
  });

  const publier = async () => {
    setBusy(true);
    try {
      const j = await post<Activite>(`/api/sites/${id}/publier`, { message });
      setJobId(j.id);
      qc.setQueryData(['activite', j.id], j);
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const annulerTout = async () => {
    if (!window.confirm('Annuler TOUTES les modifications non publiées ? Le brouillon reviendra exactement à la version en ligne. (Elles restent consultables dans l’historique.)')) return;
    try {
      await post(`/api/sites/${id}/annuler`);
      notifications.show({ color: 'green', message: 'Modifications annulées.' });
      void qc.invalidateQueries({ queryKey: ['modifications', id] });
      void qc.invalidateQueries({ queryKey: ['site', id] });
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e) });
    }
  };

  const annulerFichier = async (chemin: string) => {
    if (!window.confirm(`Annuler les modifications de ${chemin} ?`)) return;
    try {
      await post(`/api/sites/${id}/annuler`, { chemin });
      void qc.invalidateQueries({ queryKey: ['modifications', id] });
      void qc.invalidateQueries({ queryKey: ['site', id] });
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e) });
    }
  };

  const voirDiff = async (chemin: string) => {
    const d = await get<{ avant: string | null; apres: string | null; binaire?: boolean }>(`/api/sites/${id}/diff?chemin=${encodeURIComponent(chemin)}`);
    setDiff({ chemin, avant: d.avant ?? null, apres: d.apres ?? null, binaire: d.binaire });
  };

  const fini = job.data && ['reussie', 'echouee', 'interrompue'].includes(job.data.etat);
  return (
    <Page titre="Publier" sousTitre="Vérifiez les modifications, puis mettez-les en ligne." fil={[{ label: 'Tableau de bord', to: '/' }, { label: site.data?.nom ?? '…', to: `/sites/${id}` }, { label: 'Publier' }]}>
      {job.data && (
        <Card withBorder radius="lg" padding="lg">
          <JobSteps job={job.data} />
          {fini && (
            <Group mt="md">
              {job.data.etat === 'reussie' && site.data && (
                <Button component="a" href={site.data.urls.domaines[0] ?? site.data.urls.test} target="_blank" rel="noopener" rightSection={<IconExternalLink size={16} />}>
                  Voir le site en ligne
                </Button>
              )}
              <Button variant="default" onClick={() => { setJobId(null); void q.refetch(); }}>
                Fermer
              </Button>
            </Group>
          )}
          {job.data.etat === 'reussie' && job.data.resultat?.avertissements?.length > 0 && (
            <Alert color="orange" variant="light" mt="md" title="Publié, avec des points à vérifier">
              {job.data.resultat.avertissements.map((a: string) => (
                <Text size="sm" key={a}>
                  {a}
                </Text>
              ))}
            </Alert>
          )}
        </Card>
      )}
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && !jobId && (
        <>
          {q.data.fichiers.length === 0 ? (
            <Alert color="green" variant="light">
              Aucune modification en attente : le site en ligne est à jour{q.data.reference ? ` (publication n°${q.data.reference})` : ''}.
            </Alert>
          ) : (
            <Card withBorder radius="lg" padding="lg">
              <Group justify="space-between" mb="sm">
                <Title order={2} fz="lg">
                  {q.data.fichiers.length} modification(s) en attente
                </Title>
                {q.data.reference && (
                  <Button size="xs" variant="subtle" color="red" leftSection={<IconArrowBackUp size={14} />} onClick={annulerTout}>
                    Tout annuler
                  </Button>
                )}
              </Group>
              <Stack gap="md">
                {q.data.fichiers.map((f) => (
                  <Card key={f.chemin} withBorder padding="sm" radius="md">
                    <Group justify="space-between" wrap="nowrap" align="flex-start">
                      <div style={{ minWidth: 0 }}>
                        <Group gap={6}>
                          <Badge size="sm" color={f.statut === 'supprimé' ? 'red' : f.statut === 'ajouté' ? 'green' : 'or'}>
                            {f.statut}
                          </Badge>
                          <Text fw={600} size="sm" style={{ wordBreak: 'break-all' }}>
                            {f.rubrique ?? f.chemin}
                          </Text>
                        </Group>
                        {f.rubrique && (
                          <Text size="xs" c="dimmed">
                            {f.chemin}
                          </Text>
                        )}
                        {f.auteurs.length > 0 && (
                          <Text size="xs" c="dimmed">
                            Par {f.auteurs.join(', ')}
                          </Text>
                        )}
                      </div>
                      <Group gap={4} wrap="nowrap">
                        <Button size="xs" variant="subtle" leftSection={<IconGitCompare size={14} />} onClick={() => void voirDiff(f.chemin)}>
                          Détail
                        </Button>
                        {q.data!.reference && (
                          <Button size="xs" variant="subtle" color="gray" onClick={() => void annulerFichier(f.chemin)}>
                            Annuler
                          </Button>
                        )}
                      </Group>
                    </Group>
                    {f.champs && f.champs.length > 0 && (
                      <Table mt="xs" fz="sm" striped withRowBorders={false}>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>Champ</Table.Th>
                            <Table.Th>Avant</Table.Th>
                            <Table.Th>Après</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {f.champs.map((c) => (
                            <Table.Tr key={c.champ}>
                              <Table.Td>{c.champ}</Table.Td>
                              <Table.Td c="red" style={{ wordBreak: 'break-word' }}>{valeur(c.avant)}</Table.Td>
                              <Table.Td c="green" style={{ wordBreak: 'break-word' }}>{valeur(c.apres)}</Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    )}
                  </Card>
                ))}
              </Stack>
            </Card>
          )}
          <Card withBorder radius="lg" padding="lg">
            <Stack>
              <TextInput label="Note pour l’historique (facultatif)" placeholder="Par exemple : nouveaux tarifs de décembre" value={message} onChange={(e) => setMessage(e.currentTarget.value)} />
              <Group>
                <Button size="md" leftSection={<IconRocket size={18} />} onClick={publier} loading={busy} disabled={q.data.fichiers.length === 0 && !!q.data.reference}>
                  Publier maintenant
                </Button>
                <Button size="md" variant="default" component={Link} to={`/sites/${id}/apercu`} leftSection={<IconEye size={18} />}>
                  Voir l’aperçu d’abord
                </Button>
              </Group>
              <Text size="xs" c="dimmed">
                La nouvelle version est préparée entièrement avant de remplacer l’ancienne : le site ne s’interrompt pas. En cas de problème, l’ancienne version reste en ligne. Vous
                pourrez revenir en arrière depuis <Anchor component={Link} to={`/sites/${id}/versions`} size="xs">Versions</Anchor>.
              </Text>
            </Stack>
          </Card>
        </>
      )}
      <Modal opened={!!diff} onClose={() => setDiff(null)} title={diff?.chemin} size="xl">
        {diff && (diff.binaire ? <Text>Fichier non textuel (image, document) : modifié.</Text> : <DiffView avant={diff.avant} apres={diff.apres} />)}
      </Modal>
      <ApercuTelephone siteId={id!} />
    </Page>
  );
}
