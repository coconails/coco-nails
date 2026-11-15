import { useEffect, useState } from 'react';
import { Alert, Button, Card, CopyButton, Group, Select, Stack, Table, TagsInput, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDownload, IconTrash, IconUserPlus } from '@tabler/icons-react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, del, errorMessage, get, patch, post, put } from '../api';
import { useEtat } from '../App';
import { Page } from '../components/Page';
import { useSite } from './Site';

const ROLES = [
  { value: 'contributeur', label: 'Contributeur — prépare des brouillons' },
  { value: 'editeur', label: 'Éditeur — modifie et publie' },
  { value: 'admin_site', label: 'Administrateur du site — tout, y compris le code' },
];

export function ReglagesPage() {
  const { id } = useParams();
  const site = useSite();
  const etat = useEtat();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [nom, setNom] = useState('');
  const [domaines, setDomaines] = useState<string[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string | null>('editeur');
  const [lien, setLien] = useState<string | null>(null);
  const membres = useQuery({ queryKey: ['membres', id], queryFn: () => get<{ id: string; nom: string; email: string; role: string; roleLibelle: string }[]>(`/api/sites/${id}/membres`) });

  useEffect(() => {
    if (site.data) {
      setNom(site.data.nom);
      setDomaines(site.data.domainesConfigures);
    }
  }, [site.data]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notifications.show({ color: 'green', message: ok });
      void qc.invalidateQueries({ queryKey: ['site', id] });
      void qc.invalidateQueries({ queryKey: ['sites'] });
      void qc.invalidateQueries({ queryKey: ['membres', id] });
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e) });
    }
  };

  const exporter = async () => {
    try {
      const res = await api<Response>('GET', `/api/sites/${id}/export`, undefined, { raw: true });
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${site.data?.slug ?? 'site'}-export.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e) });
    }
  };

  if (!site.data) return null;
  return (
    <Page titre="Réglages" fil={[{ label: 'Tableau de bord', to: '/' }, { label: site.data.nom, to: `/sites/${id}` }, { label: 'Réglages' }]} largeur={900}>
      <Card withBorder radius="lg" padding="lg">
        <Stack>
          <Title order={2} fz="lg">
            Général
          </Title>
          <TextInput label="Nom du site" value={nom} onChange={(e) => setNom(e.currentTarget.value)} />
          <Group>
            <Button onClick={() => void act(() => patch(`/api/sites/${id}`, { nom }), 'Nom enregistré.')} disabled={nom === site.data.nom}>
              Enregistrer
            </Button>
          </Group>
        </Stack>
      </Card>

      <Card withBorder radius="lg" padding="lg">
        <Stack>
          <Title order={2} fz="lg">
            Noms de domaine
          </Title>
          <Text size="sm" c="dimmed">
            Les domaines restent enregistrés chez votre fournisseur (Squarespace…). Il suffira de les faire pointer vers PAGINITY au moment de la mise en ligne définitive (phase 5) : la
            marche à suivre sera affichée ici. Adresse de test actuelle : {site.data.urls.test}
          </Text>
          <TagsInput label="Domaines du site" description="Par exemple : monsite.fr, www.monsite.fr (Entrée après chaque domaine)" value={domaines} onChange={setDomaines} />
          <Group>
            <Button onClick={() => void act(() => patch(`/api/sites/${id}`, { domaines }), 'Domaines enregistrés.')}>Enregistrer les domaines</Button>
          </Group>
        </Stack>
      </Card>

      <Card withBorder radius="lg" padding="lg">
        <Stack>
          <Title order={2} fz="lg">
            Personnes ayant accès
          </Title>
          {membres.data && membres.data.length > 0 ? (
            <Table>
              <Table.Tbody>
                {membres.data.map((m) => (
                  <Table.Tr key={m.id}>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {m.nom}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {m.email}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Select
                        size="xs"
                        data={ROLES.filter((r) => etat.utilisateur?.proprietaire || r.value !== 'admin_site')}
                        value={m.role}
                        onChange={(v) => v && void act(() => put(`/api/sites/${id}/membres/${m.id}`, { role: v }), 'Rôle modifié.')}
                        allowDeselect={false}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Button size="xs" variant="subtle" color="red" onClick={() => window.confirm(`Retirer l’accès de ${m.nom} ?`) && void act(() => del(`/api/sites/${id}/membres/${m.id}`), 'Accès retiré.')}>
                        Retirer
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          ) : (
            <Text size="sm" c="dimmed">
              Personne d’autre que le propriétaire de la plateforme.
            </Text>
          )}
          <Title order={3} fz="md">
            Inviter quelqu’un
          </Title>
          <Group align="flex-end">
            <TextInput label="Adresse e-mail" value={email} onChange={(e) => setEmail(e.currentTarget.value)} style={{ flex: 1, minWidth: 220 }} />
            <Select label="Rôle" data={ROLES.filter((r) => etat.utilisateur?.proprietaire || r.value !== 'admin_site')} value={role} onChange={setRole} w={300} allowDeselect={false} />
            <Button
              leftSection={<IconUserPlus size={16} />}
              onClick={async () => {
                try {
                  const r = await post<{ lien: string }>('/api/invitations', { email, roles: [{ siteId: id, role }] });
                  setLien(r.lien);
                  setEmail('');
                } catch (e) {
                  notifications.show({ color: 'red', message: errorMessage(e) });
                }
              }}
            >
              Créer l’invitation
            </Button>
          </Group>
          {lien && (
            <Alert color="green" title="Invitation créée (valable 7 jours, usage unique)">
              <Text size="sm">Envoyez ce lien à la personne (e-mail, SMS…). L’envoi automatique par e-mail arrivera avec le module e-mail.</Text>
              <Group mt="xs" wrap="nowrap">
                <TextInput value={lien} readOnly style={{ flex: 1 }} />
                <CopyButton value={lien}>{({ copied, copy }) => <Button onClick={copy}>{copied ? 'Copié' : 'Copier'}</Button>}</CopyButton>
              </Group>
            </Alert>
          )}
        </Stack>
      </Card>

      <Card withBorder radius="lg" padding="lg">
        <Stack>
          <Title order={2} fz="lg">
            Exporter
          </Title>
          <Text size="sm" c="dimmed">
            Archive ZIP complète et standard : fichiers du site, données, et tout l’historique (Git). Utilisable ailleurs sans PAGINITY. Les secrets ne sont jamais exportés.
          </Text>
          <Group>
            <Button variant="light" leftSection={<IconDownload size={16} />} onClick={exporter}>
              Télécharger l’export
            </Button>
          </Group>
        </Stack>
      </Card>

      {site.data.droits.supprimer && (
        <Card withBorder radius="lg" padding="lg" style={{ borderColor: 'var(--mantine-color-red-7)' }}>
          <Stack>
            <Title order={2} fz="lg" c="red">
              Supprimer le site
            </Title>
            <Text size="sm">Le site, son historique et ses versions seront définitivement supprimés de ce serveur. Pensez à l’exporter avant.</Text>
            <Group>
              <Button
                color="red"
                variant="light"
                leftSection={<IconTrash size={16} />}
                onClick={() => {
                  const saisie = window.prompt(`Pour confirmer, tapez le nom du site : ${site.data!.nom}`);
                  if (saisie !== site.data!.nom) return;
                  void act(async () => {
                    await del(`/api/sites/${id}`);
                    navigate('/');
                  }, 'Site supprimé.');
                }}
              >
                Supprimer définitivement
              </Button>
            </Group>
          </Stack>
        </Card>
      )}
    </Page>
  );
}
