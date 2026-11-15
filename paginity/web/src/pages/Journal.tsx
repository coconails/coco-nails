import { Card, Code, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { get } from '../api';
import { ErrorBox, Loading, Page } from '../components/Page';
import { dateHeure } from '../format';

const LIBELLES: Record<string, string> = {
  installation: 'Installation de PAGINITY',
  connexion: 'Connexion',
  deconnexion: 'Déconnexion',
  deconnexion_partout: 'Déconnexion de tous les appareils',
  totp_active: 'Codes à 6 chiffres activés',
  totp_desactive: 'Codes à 6 chiffres désactivés',
  passkey_ajoutee: 'Passkey ajoutée',
  passkey_supprimee: 'Passkey supprimée',
  code_secours_utilise: 'Code de secours utilisé',
  codes_secours_regeneres: 'Nouveaux codes de secours',
  mot_de_passe_change: 'Mot de passe changé',
  invitation: 'Invitation créée',
  invitation_acceptee: 'Invitation acceptée',
  creation_site: 'Site créé',
  import_site: 'Site importé',
  suppression_site: 'Site supprimé',
  reglages_site: 'Réglages du site modifiés',
  export_site: 'Site exporté',
  publication: 'Publication',
  publication_echouee: 'Publication échouée',
  remise_en_ligne: 'Version remise en ligne',
  brouillon_repris: 'Brouillon repris depuis une publication',
  annulation_modifications: 'Modifications annulées',
  role_modifie: 'Rôle modifié',
  acces_retire: 'Accès retiré',
  utilisateur_desactive: 'Utilisateur désactivé',
  utilisateur_reactive: 'Utilisateur réactivé',
};

export function JournalPage() {
  const q = useQuery({ queryKey: ['journal'], queryFn: () => get<any[]>('/api/journal?limite=300') });
  return (
    <Page titre="Journal" sousTitre="Qui a fait quoi, quand, sur quel site et depuis quelle adresse. Conservé un an.">
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <Card withBorder radius="lg" padding="sm">
          <Table.ScrollContainer minWidth={700}>
            <Table striped fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Date</Table.Th>
                  <Table.Th>Action</Table.Th>
                  <Table.Th>Personne</Table.Th>
                  <Table.Th>Site</Table.Th>
                  <Table.Th>Adresse</Table.Th>
                  <Table.Th>Détails</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {q.data.map((r) => (
                  <Table.Tr key={r.id}>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>{dateHeure(r.le)}</Table.Td>
                    <Table.Td>{LIBELLES[r.action] ?? r.action}</Table.Td>
                    <Table.Td>{r.utilisateur ?? '—'}</Table.Td>
                    <Table.Td>{r.site ?? '—'}</Table.Td>
                    <Table.Td>{r.ip ?? '—'}</Table.Td>
                    <Table.Td>{Object.keys(r.details).length ? <Code fz="xs">{JSON.stringify(r.details)}</Code> : <Text size="xs" c="dimmed">—</Text>}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}
    </Page>
  );
}
