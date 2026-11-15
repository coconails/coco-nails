import { useState } from 'react';
import { Alert, Badge, Button, Card, CopyButton, Group, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconUserPlus } from '@tabler/icons-react';
import { errorMessage, get, patch, post } from '../api';
import { ErrorBox, Loading, Page } from '../components/Page';
import { dateHeure } from '../format';

interface Donnees {
  utilisateurs: { id: string; email: string; nom: string; proprietaire: boolean; desactive: boolean; creeLe: number; sites: { id: string; nom: string; roleLibelle: string }[] }[];
  invitations: { email: string; created_at: number; expires_at: number }[];
}

export function UtilisateursPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['utilisateurs'], queryFn: () => get<Donnees>('/api/utilisateurs') });
  const [email, setEmail] = useState('');
  const [lien, setLien] = useState<string | null>(null);

  return (
    <Page titre="Utilisateurs" sousTitre="Les comptes sont créés uniquement sur invitation. Les droits se donnent site par site (Réglages de chaque site).">
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <Card withBorder radius="lg" padding="lg">
          <Table.ScrollContainer minWidth={600}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Personne</Table.Th>
                  <Table.Th>Accès</Table.Th>
                  <Table.Th>Créé le</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {q.data.utilisateurs.map((u) => (
                  <Table.Tr key={u.id} opacity={u.desactive ? 0.5 : 1}>
                    <Table.Td>
                      <Text fw={500} size="sm">
                        {u.nom} {u.proprietaire && <Badge size="xs">Propriétaire</Badge>} {u.desactive && <Badge size="xs" color="gray">Désactivé</Badge>}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {u.email}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {u.proprietaire ? (
                        <Text size="sm">Tous les sites</Text>
                      ) : u.sites.length ? (
                        u.sites.map((s) => (
                          <Text size="sm" key={s.id}>
                            {s.nom} — {s.roleLibelle}
                          </Text>
                        ))
                      ) : (
                        <Text size="sm" c="dimmed">
                          Aucun site
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{dateHeure(u.creeLe)}</Text>
                    </Table.Td>
                    <Table.Td>
                      {!u.proprietaire && (
                        <Button
                          size="xs"
                          variant="subtle"
                          color={u.desactive ? 'green' : 'red'}
                          onClick={async () => {
                            try {
                              await patch(`/api/utilisateurs/${u.id}`, { desactive: !u.desactive });
                              void qc.invalidateQueries({ queryKey: ['utilisateurs'] });
                            } catch (e) {
                              notifications.show({ color: 'red', message: errorMessage(e) });
                            }
                          }}
                        >
                          {u.desactive ? 'Réactiver' : 'Désactiver'}
                        </Button>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}
      <Card withBorder radius="lg" padding="lg">
        <Stack>
          <Title order={2} fz="lg">
            Inviter une personne (sans site pour l’instant)
          </Title>
          <Text size="sm" c="dimmed">
            Pour donner directement l’accès à un site, passez plutôt par les Réglages du site.
          </Text>
          <Group align="flex-end">
            <TextInput label="Adresse e-mail" value={email} onChange={(e) => setEmail(e.currentTarget.value)} style={{ flex: 1, minWidth: 220 }} />
            <Button
              leftSection={<IconUserPlus size={16} />}
              onClick={async () => {
                try {
                  const r = await post<{ lien: string }>('/api/invitations', { email, roles: [] });
                  setLien(r.lien);
                  setEmail('');
                  void qc.invalidateQueries({ queryKey: ['utilisateurs'] });
                } catch (e) {
                  notifications.show({ color: 'red', message: errorMessage(e) });
                }
              }}
            >
              Créer l’invitation
            </Button>
          </Group>
          {lien && (
            <Alert color="green" title="Lien d’invitation (7 jours, usage unique)">
              <Group wrap="nowrap">
                <TextInput value={lien} readOnly style={{ flex: 1 }} />
                <CopyButton value={lien}>{({ copied, copy }) => <Button onClick={copy}>{copied ? 'Copié' : 'Copier'}</Button>}</CopyButton>
              </Group>
            </Alert>
          )}
          {q.data && q.data.invitations.length > 0 && (
            <>
              <Text fw={600} size="sm">
                Invitations en attente
              </Text>
              {q.data.invitations.map((i) => (
                <Text size="sm" key={i.email + i.created_at}>
                  {i.email} — expire le {dateHeure(i.expires_at)}
                </Text>
              ))}
            </>
          )}
        </Stack>
      </Card>
    </Page>
  );
}
