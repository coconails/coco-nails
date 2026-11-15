import { useState } from 'react';
import { Alert, Badge, Button, Card, Code, Group, Modal, ScrollArea, Stack, Switch, Table, Text, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconPlayerPlay, IconRefresh, IconShieldCheck } from '@tabler/icons-react';
import { Link, useParams } from 'react-router-dom';
import { errorMessage, get, post, put } from '../api';
import { ErrorBox, Loading, Page } from '../components/Page';
import { dateHeure, ilYa } from '../format';
import { useSite } from './Site';

interface Donnees {
  isolation: 'podman' | 'processus';
  fonctions: { nom: string; chemins: string[]; planification: string | null; erreur: string | null }[];
  statistiques: { fonction: string; appels24h: number; erreurs24h: number; dureeMoyenneMs: number; dernierAppel: number }[];
  executeurs: { environnement: string; actif: boolean; depuis: number | null; version: string | null }[];
  planificationActive: boolean;
  peutModifier: boolean;
  taches: {
    fonction: string;
    planification: string;
    prochaineParis: string | null;
    active: boolean;
    rattrapage: boolean;
    erreur: string | null;
    executions: { creneau: number; type: string; etat: string; debut: number; fin: number | null; message: string | null }[];
  }[];
}

const ETAT_TACHE: Record<string, { c: string; l: string }> = {
  reussie: { c: 'green', l: 'Réussie' },
  echouee: { c: 'red', l: 'Échouée' },
  en_cours: { c: 'blue', l: 'En cours' },
  manquee: { c: 'orange', l: 'Manquée' },
  ignoree: { c: 'gray', l: 'Ignorée' },
};
const TYPE: Record<string, string> = { planifiee: 'prévue', rattrapage: 'rattrapage', manuel: 'manuelle' };

export function FonctionsPage() {
  const { id } = useParams();
  const site = useSite();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['fonctions', id], queryFn: () => get<Donnees>(`/api/sites/${id}/fonctions`), refetchInterval: 15_000 });
  const [journal, setJournal] = useState<string[] | null>(null);
  const [activer, setActiver] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['fonctions', id] });
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notifications.show({ color: 'green', message: ok });
      refresh();
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e), autoClose: 10_000 });
    }
  };

  const d = q.data;
  return (
    <Page
      titre="Fonctions et tâches"
      sousTitre="Le code serveur du site (réservations, e-mails, factures…) et ses tâches automatiques."
      fil={[{ label: 'Tableau de bord', to: '/' }, { label: site.data?.nom ?? '…', to: `/sites/${id}` }, { label: 'Fonctions' }]}
      actions={
        d?.peutModifier && (
          <>
            <Button variant="default" onClick={async () => setJournal((await get<{ lignes: string[] }>(`/api/sites/${id}/fonctions/journal`)).lignes)}>
              Journal
            </Button>
            <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => void act(() => post(`/api/sites/${id}/fonctions/redemarrer`), 'Exécuteurs arrêtés : ils redémarreront au prochain appel.')}>
              Redémarrer
            </Button>
          </>
        )
      }
    >
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {d && (
        <>
          <Alert variant="light" color={d.isolation === 'podman' ? 'green' : 'orange'} icon={<IconShieldCheck />}>
            {d.isolation === 'podman'
              ? 'Les fonctions tournent dans un conteneur isolé : elles ne voient que le code de ce site et ses propres secrets.'
              : 'Les fonctions tournent dans un processus restreint (Podman n’est pas installé) : accès limité au code du site, sans sous-processus. Isolation plus faible qu’un conteneur.'}
          </Alert>

          {d.fonctions.length === 0 ? (
            <Card withBorder>
              <Text>Aucune fonction serveur dans la version en ligne. Elles apparaissent ici après une publication (dossier « netlify/functions » ou celui indiqué dans la fiche du site).</Text>
            </Card>
          ) : (
            <Card withBorder radius="lg" padding="lg">
              <Title order={2} fz="lg" mb="sm">
                Fonctions de la version en ligne
              </Title>
              <Table.ScrollContainer minWidth={560}>
                <Table fz="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Fonction</Table.Th>
                      <Table.Th>Adresse</Table.Th>
                      <Table.Th>Appels (24 h)</Table.Th>
                      <Table.Th>Erreurs</Table.Th>
                      <Table.Th>Durée moyenne</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {d.fonctions.map((f) => {
                      const st = d.statistiques.find((s) => s.fonction === f.nom);
                      return (
                        <Table.Tr key={f.nom}>
                          <Table.Td>
                            <Text fw={600} size="sm">
                              {f.nom}
                            </Text>
                            {f.erreur && (
                              <Text c="red" size="xs">
                                {f.erreur}
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td>{f.planification ? <Badge variant="light">tâche planifiée</Badge> : f.chemins.map((c) => <Code key={c}>{c}</Code>)}</Table.Td>
                          <Table.Td>{st?.appels24h ?? 0}</Table.Td>
                          <Table.Td>{st?.erreurs24h ? <Badge color="red">{st.erreurs24h}</Badge> : 0}</Table.Td>
                          <Table.Td>{st ? `${st.dureeMoyenneMs} ms` : '—'}</Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
              <Group mt="sm" gap="lg">
                {d.executeurs.map((e) => (
                  <Text key={e.environnement} size="xs" c="dimmed">
                    {e.environnement === 'production' ? 'Production' : 'Aperçu'} : {e.actif ? `actif (${e.version}, démarré ${ilYa(e.depuis)})` : 'arrêté (démarre au premier appel)'}
                  </Text>
                ))}
              </Group>
              <Text size="xs" c="dimmed" mt="xs">
                Les secrets des fonctions se règlent dans <Link to={`/sites/${id}/secrets`}>Secrets</Link>.
              </Text>
            </Card>
          )}

          {d.taches.length > 0 && (
            <Card withBorder radius="lg" padding="lg">
              <Group justify="space-between" mb="sm">
                <Title order={2} fz="lg">
                  Tâches planifiées
                </Title>
                {d.peutModifier && (
                  <Switch
                    checked={d.planificationActive}
                    onChange={(e) => (e.currentTarget.checked ? setActiver(true) : void act(() => post(`/api/sites/${id}/planification`, { active: false }), 'Tâches planifiées désactivées.'))}
                    label={d.planificationActive ? 'Actives sur PAGINITY' : 'Désactivées sur PAGINITY'}
                  />
                )}
              </Group>
              {!d.planificationActive && (
                <Alert color="orange" variant="light" mb="md" icon={<IconAlertTriangle />}>
                  Les tâches de ce site ne s’exécutent pas sur PAGINITY. C’est volontaire tant que l’ancien hébergement (Netlify) les exécute : sinon, les clientes recevraient deux rappels.
                </Alert>
              )}
              <Stack>
                {d.taches.map((t) => (
                  <Card key={t.fonction} withBorder padding="md" radius="md">
                    <Group justify="space-between" align="flex-start">
                      <div>
                        <Text fw={700}>{t.fonction}</Text>
                        <Text size="sm">
                          Horaire : <Code>{t.planification}</Code> (heure UTC)
                        </Text>
                        {t.prochaineParis && (
                          <Text size="sm" c="dimmed">
                            Prochaine exécution : {t.prochaineParis} (heure de Paris)
                          </Text>
                        )}
                        {t.erreur && <Text c="red" size="sm">{t.erreur}</Text>}
                      </div>
                      {d.peutModifier && (
                        <Stack gap={6} align="flex-end">
                          <Switch size="sm" label="Active" checked={t.active} onChange={(e) => void act(() => put(`/api/sites/${id}/taches/${t.fonction}`, { active: e.currentTarget.checked }), 'Réglage enregistré.')} />
                          <Tooltip
                            multiline
                            w={320}
                            label="Si le serveur était éteint à l’heure prévue, la tâche est exécutée dès son retour (dans les 6 heures). Désactivé par défaut : un rappel envoyé en retard peut surprendre."
                          >
                            <Switch size="sm" label="Rattraper si manquée" checked={t.rattrapage} onChange={(e) => void act(() => put(`/api/sites/${id}/taches/${t.fonction}`, { rattrapage: e.currentTarget.checked }), 'Réglage enregistré.')} />
                          </Tooltip>
                          <Button
                            size="xs"
                            variant="light"
                            leftSection={<IconPlayerPlay size={14} />}
                            onClick={() =>
                              window.confirm(`Lancer « ${t.fonction} » maintenant ?\n\nC’est une exécution RÉELLE : elle peut envoyer de vrais SMS ou e-mails.`) &&
                              void act(() => post(`/api/sites/${id}/taches/${t.fonction}/lancer`), 'Tâche exécutée.')
                            }
                          >
                            Lancer maintenant
                          </Button>
                        </Stack>
                      )}
                    </Group>
                    {t.executions.length > 0 && (
                      <Table mt="sm" fz="xs" withRowBorders={false}>
                        <Table.Tbody>
                          {t.executions.map((x) => (
                            <Table.Tr key={`${x.creneau}-${x.type}`}>
                              <Table.Td style={{ whiteSpace: 'nowrap' }}>{dateHeure(x.creneau)}</Table.Td>
                              <Table.Td>{TYPE[x.type] ?? x.type}</Table.Td>
                              <Table.Td>
                                <Badge size="xs" color={ETAT_TACHE[x.etat]?.c ?? 'gray'}>
                                  {ETAT_TACHE[x.etat]?.l ?? x.etat}
                                </Badge>
                              </Table.Td>
                              <Table.Td c="dimmed" style={{ wordBreak: 'break-word' }}>
                                {x.message}
                              </Table.Td>
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
        </>
      )}
      <Modal opened={activer} onClose={() => setActiver(false)} title="Activer les tâches planifiées sur PAGINITY ?" centered>
        <Stack>
          <Alert color="orange" icon={<IconAlertTriangle />}>
            Vérifiez d’abord que l’ancien hébergement (Netlify) n’exécute plus ces tâches. Sinon, les rappels partiront deux fois.
          </Alert>
          <Text size="sm">Les tâches suivront les horaires indiqués (heure UTC). Une tâche en échec n’est jamais relancée automatiquement : une alerte vous prévient.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setActiver(false)}>
              Annuler
            </Button>
            <Button
              color="orange"
              onClick={() => {
                setActiver(false);
                void act(() => post(`/api/sites/${id}/planification`, { active: true }), 'Tâches planifiées activées.');
              }}
            >
              Activer
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal opened={!!journal} onClose={() => setJournal(null)} title="Journal des fonctions (les secrets sont masqués)" size="xl">
        <ScrollArea h={480}>
          <Code block fz="xs">
            {journal?.length ? journal.join('\n') : 'Journal vide.'}
          </Code>
        </ScrollArea>
      </Modal>
    </Page>
  );
}
