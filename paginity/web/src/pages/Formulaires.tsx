import { useEffect, useState } from 'react';
import { Accordion, Alert, Badge, Button, Card, Group, Stack, Table, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDownload, IconMail, IconTrash } from '@tabler/icons-react';
import { Link, useParams } from 'react-router-dom';
import { api, del, errorMessage, get, patch, post } from '../api';
import { useEtat } from '../App';
import { ErrorBox, Loading, Page } from '../components/Page';
import { dateHeure } from '../format';
import { useSite } from './Site';

interface Donnees {
  notification: string;
  messagerieConfiguree: boolean;
  messages: { id: string; formulaire: string; le: number; lu: boolean; donnees: Record<string, string> }[];
}

export function FormulairesPage() {
  const { id } = useParams();
  const site = useSite();
  const etat = useEtat();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['formulaires', id], queryFn: () => get<Donnees>(`/api/sites/${id}/formulaires`), refetchInterval: 30_000 });
  const [email, setEmail] = useState('');
  useEffect(() => {
    if (q.data) setEmail(q.data.notification);
  }, [q.data]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['formulaires', id] });

  const exporter = async () => {
    try {
      const res = await api<Response>('GET', `/api/sites/${id}/formulaires.csv`, undefined, { raw: true });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = `${site.data?.slug ?? 'site'}-messages.csv`;
      a.click();
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e) });
    }
  };

  return (
    <Page
      titre="Messages des formulaires"
      sousTitre="Messages envoyés depuis les formulaires du site (contact, demandes de rendez-vous…). Chiffrés sur le serveur, conservés un an."
      fil={[{ label: 'Tableau de bord', to: '/' }, { label: site.data?.nom ?? '…', to: `/sites/${id}` }, { label: 'Formulaires' }]}
      actions={
        <Button variant="default" leftSection={<IconDownload size={16} />} onClick={exporter}>
          Exporter (tableur)
        </Button>
      }
    >
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <>
          {site.data?.droits.reglages && (
            <Card withBorder radius="lg" padding="lg">
              <Group align="flex-end">
                <TextInput
                  label="Être prévenu par e-mail à chaque nouveau message"
                  placeholder="adresse@exemple.fr"
                  value={email}
                  onChange={(e) => setEmail(e.currentTarget.value)}
                  style={{ flex: 1, minWidth: 240 }}
                  leftSection={<IconMail size={16} />}
                />
                <Button
                  onClick={async () => {
                    try {
                      await patch(`/api/sites/${id}/notification`, { email });
                      notifications.show({ color: 'green', message: 'Adresse enregistrée.' });
                    } catch (e) {
                      notifications.show({ color: 'red', message: errorMessage(e) });
                    }
                  }}
                >
                  Enregistrer
                </Button>
              </Group>
              {!q.data.messagerieConfiguree && (
                <Alert color="orange" variant="light" mt="sm">
                  L’envoi d’e-mails n’est pas encore configuré :{' '}
                  {etat.utilisateur?.proprietaire ? <Link to="/reglages">Réglages de la plateforme</Link> : 'demandez au propriétaire de la plateforme'}. En attendant, les messages
                  restent visibles ici.
                </Alert>
              )}
            </Card>
          )}
          {q.data.messages.length === 0 && <Text c="dimmed">Aucun message pour le moment.</Text>}
          <Accordion variant="separated" radius="md">
            {q.data.messages.map((m) => (
              <Accordion.Item key={m.id} value={m.id}>
                <Accordion.Control
                  onClick={() => {
                    if (!m.lu) void post(`/api/sites/${id}/formulaires/${m.id}/lu`).then(refresh);
                  }}
                >
                  <Group justify="space-between" wrap="nowrap" pr="sm">
                    <div style={{ minWidth: 0 }}>
                      <Text fw={m.lu ? 400 : 700} truncate>
                        {m.donnees.nom || m.donnees.name || m.donnees.email || 'Message'}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {dateHeure(m.le)} · formulaire « {m.formulaire} »
                      </Text>
                    </div>
                    {!m.lu && <Badge color="or">Nouveau</Badge>}
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack>
                    <Table fz="sm">
                      <Table.Tbody>
                        {Object.entries(m.donnees).map(([k, v]) => (
                          <Table.Tr key={k}>
                            <Table.Td fw={600} w={160}>
                              {k}
                            </Table.Td>
                            <Table.Td style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{v}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                    <Group>
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        leftSection={<IconTrash size={14} />}
                        onClick={() => window.confirm('Supprimer définitivement ce message ?') && void del(`/api/sites/${id}/formulaires/${m.id}`).then(refresh)}
                      >
                        Supprimer
                      </Button>
                    </Group>
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        </>
      )}
    </Page>
  );
}
