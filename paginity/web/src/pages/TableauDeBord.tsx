import { Alert, Anchor, Badge, Button, Card, Group, Progress, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconExternalLink, IconFileText, IconInfoCircle, IconPlus, IconRocket } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { get, post } from '../api';
import { useEtat } from '../App';
import { ErrorBox, Loading, Page } from '../components/Page';
import { JobBadge, StatusBadge } from '../components/Status';
import { duree, ilYa, taille } from '../format';
import type { Activite, SiteResume } from '../types';

interface Tableau {
  sites: SiteResume[];
  serveur: any | null;
  alertes: { id?: number; niveau: 'information' | 'attention' | 'critique'; message: string; siteId?: string | null }[];
  activites: Activite[];
}

function lienAlerte(siteId: string, message: string): { to: string; label: string } {
  if (/formulaire/i.test(message)) return { to: `/sites/${siteId}/formulaires`, label: 'Voir les messages' };
  if (/tâche|fonction/i.test(message)) return { to: `/sites/${siteId}/fonctions`, label: 'Voir les tâches' };
  return { to: `/sites/${siteId}/versions`, label: 'Voir les versions' };
}

const pct = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });

export function TableauDeBordPage() {
  const etat = useEtat();
  const q = useQuery({ queryKey: ['tableau'], queryFn: () => get<Tableau>('/api/tableau-de-bord'), refetchInterval: 30_000 });
  const user = etat.utilisateur!;

  return (
    <Page
      titre={`Bonjour ${user.nom.split(' ')[0]}`}
      sousTitre="Vos sites et l’état de PAGINITY en un coup d’œil."
      actions={
        user.proprietaire && (
          <Button component={Link} to="/sites/nouveau" leftSection={<IconPlus size={18} />}>
            Ajouter un site
          </Button>
        )
      }
    >
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <>
          {q.data.alertes.length > 0 && (
            <Stack gap="xs">
              {q.data.alertes.map((a, i) => (
                <Alert
                  key={i}
                  color={a.niveau === 'critique' ? 'red' : a.niveau === 'attention' ? 'orange' : 'blue'}
                  icon={a.niveau === 'information' ? <IconInfoCircle /> : <IconAlertTriangle />}
                  variant="light"
                  withCloseButton={!!a.id}
                  closeButtonLabel="Marquer comme lue"
                  onClose={() => a.id && void post(`/api/alertes/${a.id}/lue`).then(() => q.refetch())}
                >
                  {a.message}
                  {a.siteId && (
                    <>
                      {' '}
                      <Anchor component={Link} to={lienAlerte(a.siteId, a.message).to} size="sm">
                        {lienAlerte(a.siteId, a.message).label}
                      </Anchor>
                    </>
                  )}
                </Alert>
              ))}
            </Stack>
          )}

          <Title order={2} fz="lg">
            Mes sites
          </Title>
          {q.data.sites.length === 0 && (
            <Card withBorder p="xl">
              <Text>Aucun site pour le moment.</Text>
              {user.proprietaire && (
                <Button component={Link} to="/sites/nouveau" mt="md" leftSection={<IconPlus size={18} />}>
                  Créer ou importer mon premier site
                </Button>
              )}
            </Card>
          )}
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
            {q.data.sites.map((s) => (
              <Card key={s.id} withBorder radius="lg" padding="lg">
                <Stack gap="sm">
                  <Group justify="space-between" wrap="nowrap">
                    <Anchor component={Link} to={`/sites/${s.id}`} fw={700} fz="lg" c="var(--mantine-color-text)">
                      {s.nom}
                    </Anchor>
                    <Badge variant="outline" size="sm">
                      {s.roleLibelle}
                    </Badge>
                  </Group>
                  <StatusBadge etat={s.etat} />
                  <Text size="sm" c="dimmed">
                    {s.enLigne ? `Publication n°${s.enLigne.numero} en ligne, ${ilYa(s.enLigne.le)}` : 'Pas encore publié'}
                    {s.modificationsEnAttente > 0 && ` · ${s.modificationsEnAttente} fichier(s) modifié(s)`}
                  </Text>
                  <Anchor href={s.urls.domaines[0] ?? s.urls.test} target="_blank" rel="noopener" size="sm">
                    <Group gap={4}>
                      {(s.urls.domaines[0] ?? s.urls.test).replace(/^https?:\/\//, '')} <IconExternalLink size={14} />
                    </Group>
                  </Anchor>
                  <Group gap="xs">
                    <Button size="xs" variant="light" component={Link} to={`/sites/${s.id}/contenus`} leftSection={<IconFileText size={14} />}>
                      Modifier
                    </Button>
                    {s.role !== 'contributeur' && (
                      <Button size="xs" variant={s.modificationsEnAttente ? 'filled' : 'light'} component={Link} to={`/sites/${s.id}/publier`} leftSection={<IconRocket size={14} />}>
                        Publier
                      </Button>
                    )}
                  </Group>
                </Stack>
              </Card>
            ))}
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, md: q.data.serveur ? 2 : 1 }}>
            {q.data.serveur && (
              <Card withBorder radius="lg" padding="lg">
                <Group justify="space-between" mb="sm">
                  <Title order={2} fz="lg">
                    Serveur
                  </Title>
                  <Anchor component={Link} to="/sante" size="sm">
                    Détails
                  </Anchor>
                </Group>
                <Stack gap="xs">
                  {q.data.serveur.disque && (
                    <div>
                      <Text size="sm">
                        Disque : {pct(q.data.serveur.disque.utilisePct)} % utilisé ({taille(q.data.serveur.disque.libre)} libres)
                      </Text>
                      <Progress value={q.data.serveur.disque.utilisePct} color={q.data.serveur.disque.utilisePct > 80 ? 'red' : 'green'} />
                    </div>
                  )}
                  <div>
                    <Text size="sm">Mémoire : {pct(q.data.serveur.memoire.utilisePct)} % utilisée</Text>
                    <Progress value={q.data.serveur.memoire.utilisePct} color={q.data.serveur.memoire.utilisePct > 90 ? 'red' : 'blue'} />
                  </div>
                  <Text size="sm">Température : {q.data.serveur.temperature !== null ? `${q.data.serveur.temperature} °C` : 'capteur non disponible'}</Text>
                  <Text size="sm">PAGINITY fonctionne depuis {duree(q.data.serveur.demarreDepuis)}.</Text>
                  <Text size="sm" c="dimmed">
                    Sauvegardes : {q.data.serveur.sauvegardes.message}
                  </Text>
                </Stack>
              </Card>
            )}
            <Card withBorder radius="lg" padding="lg">
              <Group justify="space-between" mb="sm">
                <Title order={2} fz="lg">
                  Dernières activités
                </Title>
                <Anchor component={Link} to="/activites" size="sm">
                  Tout voir
                </Anchor>
              </Group>
              <Stack gap="xs">
                {q.data.activites.length === 0 && <Text size="sm" c="dimmed">Aucune activité pour l’instant.</Text>}
                {q.data.activites.map((a) => (
                  <Group key={a.id} justify="space-between" wrap="nowrap">
                    <Text size="sm" lineClamp={1}>
                      {a.libelle}
                    </Text>
                    <Group gap={6} wrap="nowrap">
                      <Text size="xs" c="dimmed">
                        {ilYa(a.creeLe)}
                      </Text>
                      <JobBadge etat={a.etat} />
                    </Group>
                  </Group>
                ))}
              </Stack>
            </Card>
          </SimpleGrid>
        </>
      )}
    </Page>
  );
}
