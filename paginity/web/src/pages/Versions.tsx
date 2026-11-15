import { useState } from 'react';
import { Badge, Button, Card, Group, Menu, Modal, Stack, Table, Tabs, Text, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconArrowBackUp, IconDots, IconPencilShare } from '@tabler/icons-react';
import { useParams } from 'react-router-dom';
import { errorMessage, get, post } from '../api';
import { ErrorBox, Loading, Page } from '../components/Page';
import { JobSteps } from '../components/Status';
import { dateHeure } from '../format';
import type { Activite } from '../types';
import { useSite } from './Site';

interface Publication {
  numero: number;
  commit: string;
  message: string;
  le: number;
  etat: string;
  dureeMs: number | null;
  avertissements: string[];
  auteur: string | null;
  enLigne: boolean;
  disponible: boolean;
}

export function VersionsPage() {
  const { id } = useParams();
  const site = useSite();
  const qc = useQueryClient();
  const mobile = useMediaQuery('(max-width: 48em)');
  const pubs = useQuery({ queryKey: ['publications', id], queryFn: () => get<Publication[]>(`/api/sites/${id}/publications`) });
  const hist = useQuery({ queryKey: ['historique', id], queryFn: () => get<{ id: string; le: number; auteur: string; message: string }[]>(`/api/sites/${id}/historique`) });
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useQuery({
    queryKey: ['activite', jobId],
    queryFn: () => get<Activite>(`/api/activites/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && ['reussie', 'echouee', 'interrompue'].includes(q.state.data.etat) ? false : 1500),
  });
  const peut = site.data?.droits.publier;

  const remettre = async (n: number) => {
    if (!window.confirm(`Remettre en ligne la publication n°${n} ?\n\nLe site public reviendra à cette version. Votre brouillon et les données (réservations, comptabilité…) ne sont pas modifiés.`)) return;
    try {
      const j = await post<Activite>(`/api/sites/${id}/publications/${n}/remettre`);
      setJobId(j.id);
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e) });
    }
  };

  const reprendre = async (n: number) => {
    if (!window.confirm(`Repartir de la publication n°${n} pour le brouillon ?\n\nLe brouillon redeviendra identique à cette version. Les modifications plus récentes restent dans l’historique.`)) return;
    try {
      await post(`/api/sites/${id}/publications/${n}/reprendre`);
      notifications.show({ color: 'green', message: `Le brouillon reprend la publication n°${n}.` });
      for (const k of ['site', 'historique', 'modifications']) void qc.invalidateQueries({ queryKey: [k, id] });
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e) });
    }
  };

  const actions = (p: Publication) =>
    peut && p.etat === 'reussie' ? (
      <Menu position="bottom-end">
        <Menu.Target>
          <Button size="xs" variant="light" rightSection={<IconDots size={14} />}>
            Actions
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<IconArrowBackUp size={14} />} disabled={p.enLigne} onClick={() => void remettre(p.numero)}>
            Remettre cette version en ligne
          </Menu.Item>
          <Menu.Item leftSection={<IconPencilShare size={14} />} onClick={() => void reprendre(p.numero)}>
            Repartir de cette version (brouillon)
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    ) : null;

  const etatBadge = (p: Publication) =>
    p.enLigne ? (
      <Badge color="green">En ligne</Badge>
    ) : p.etat === 'reussie' ? (
      <Badge variant="light" color="gray">Publiée</Badge>
    ) : p.etat === 'echouee' ? (
      <Badge color="red">Échouée</Badge>
    ) : (
      <Badge color="blue">{p.etat}</Badge>
    );

  return (
    <Page titre="Versions" sousTitre="Chaque publication est conservée. Vous pouvez revenir en arrière à tout moment." fil={[{ label: 'Tableau de bord', to: '/' }, { label: site.data?.nom ?? '…', to: `/sites/${id}` }, { label: 'Versions' }]}>
      <Modal opened={!!job.data} onClose={() => setJobId(null)} title="Remise en ligne" size="lg">
        {job.data && <JobSteps job={job.data} />}
      </Modal>
      <Tabs defaultValue="publications">
        <Tabs.List>
          <Tabs.Tab value="publications">Publications</Tabs.Tab>
          <Tabs.Tab value="historique">Historique du brouillon</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="publications" pt="md">
          {pubs.isLoading && <Loading />}
          {pubs.error && <ErrorBox error={pubs.error} />}
          {pubs.data?.length === 0 && <Text c="dimmed">Aucune publication pour l’instant.</Text>}
          {mobile ? (
            <Stack>
              {pubs.data?.map((p) => (
                <Card key={p.numero} withBorder padding="sm">
                  <Group justify="space-between">
                    <Text fw={700}>n°{p.numero}</Text>
                    {etatBadge(p)}
                  </Group>
                  <Text size="sm">{dateHeure(p.le)} — {p.auteur ?? '?'}</Text>
                  {p.message && <Text size="sm" c="dimmed">{p.message}</Text>}
                  <Group justify="flex-end" mt="xs">{actions(p)}</Group>
                </Card>
              ))}
            </Stack>
          ) : (
            pubs.data && pubs.data.length > 0 && (
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>N°</Table.Th>
                    <Table.Th>Date</Table.Th>
                    <Table.Th>Par</Table.Th>
                    <Table.Th>Note</Table.Th>
                    <Table.Th>État</Table.Th>
                    <Table.Th>Durée</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {pubs.data.map((p) => (
                    <Table.Tr key={p.numero}>
                      <Table.Td fw={700}>{p.numero}</Table.Td>
                      <Table.Td>{dateHeure(p.le)}</Table.Td>
                      <Table.Td>{p.auteur ?? '?'}</Table.Td>
                      <Table.Td>
                        {p.message}
                        {p.avertissements.length > 0 && (
                          <Tooltip label={p.avertissements.join(' · ')} multiline w={360}>
                            <Badge ml={6} size="xs" color="orange" leftSection={<IconAlertTriangle size={10} />}>
                              {p.avertissements.length}
                            </Badge>
                          </Tooltip>
                        )}
                      </Table.Td>
                      <Table.Td>{etatBadge(p)}</Table.Td>
                      <Table.Td>{p.dureeMs !== null ? `${(p.dureeMs / 1000).toFixed(1)} s` : '—'}</Table.Td>
                      <Table.Td>{actions(p)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )
          )}
        </Tabs.Panel>
        <Tabs.Panel value="historique" pt="md">
          {hist.isLoading && <Loading />}
          <Stack gap={6}>
            {hist.data?.map((h) => (
              <Group key={h.id} gap="xs" wrap="nowrap" align="flex-start">
                <Text size="sm" c="dimmed" miw={150}>
                  {dateHeure(h.le)}
                </Text>
                <Text size="sm">
                  <b>{h.auteur}</b> — {h.message}
                </Text>
              </Group>
            ))}
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Page>
  );
}
