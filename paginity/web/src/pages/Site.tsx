import { Alert, Anchor, Badge, Button, Card, Group, List, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconCode, IconExternalLink, IconEye, IconFileText, IconHistory, IconInfoCircle, IconPhoto, IconRocket, IconSettings } from '@tabler/icons-react';
import { Link, useParams } from 'react-router-dom';
import { get } from '../api';
import { ErrorBox, Loading, Page } from '../components/Page';
import { StatusBadge } from '../components/Status';
import { dateHeure, ilYa } from '../format';
import type { SiteDetail } from '../types';

export function useSite() {
  const { id } = useParams();
  return useQuery({ queryKey: ['site', id], queryFn: () => get<SiteDetail>(`/api/sites/${id}`) });
}

export function SitePage() {
  const q = useSite();
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const s = q.data;
  const tuile = (to: string, titre: string, texte: string, icon: React.ReactNode, mis = false) => (
    <Card component={Link} to={to} withBorder radius="lg" padding="lg" style={mis ? { borderColor: 'var(--mantine-color-or-6)' } : undefined}>
      <Group wrap="nowrap" align="flex-start">
        {icon}
        <div>
          <Text fw={700}>{titre}</Text>
          <Text size="sm" c="dimmed">
            {texte}
          </Text>
        </div>
      </Group>
    </Card>
  );
  return (
    <Page
      titre={s.nom}
      fil={[{ label: 'Tableau de bord', to: '/' }, { label: s.nom }]}
      actions={
        <Button component="a" href={s.urls.domaines[0] ?? s.urls.test} target="_blank" rel="noopener" variant="default" rightSection={<IconExternalLink size={16} />}>
          Voir le site
        </Button>
      }
    >
      <Card withBorder radius="lg" padding="lg">
        <Stack gap="xs">
          <Group gap="sm">
            <StatusBadge etat={s.etat} />
            <Badge variant="outline">{s.roleLibelle}</Badge>
          </Group>
          <Text>
            {s.enLigne ? (
              <>
                Publication <b>n°{s.enLigne.numero}</b> en ligne depuis le {dateHeure(s.enLigne.le)} ({ilYa(s.enLigne.le)}).
              </>
            ) : (
              'Ce site n’a pas encore été publié : il n’est pas visible du public.'
            )}
          </Text>
          {s.modificationsEnAttente > 0 && (
            <Text c="or">
              {s.modificationsEnAttente} fichier(s) modifié(s) depuis la dernière publication.{' '}
              {s.droits.publier && (
                <Anchor component={Link} to={`/sites/${s.id}/publier`}>
                  Vérifier et publier
                </Anchor>
              )}
            </Text>
          )}
          <Group gap="lg">
            <Text size="sm">
              Adresse de test :{' '}
              <Anchor href={s.urls.test} target="_blank" rel="noopener">
                {s.urls.test.replace(/^https?:\/\//, '')}
              </Anchor>
            </Text>
            {s.urls.domaines.map((d) => (
              <Text size="sm" key={d}>
                Domaine :{' '}
                <Anchor href={d} target="_blank" rel="noopener">
                  {d.replace(/^https?:\/\//, '')}
                </Anchor>
              </Text>
            ))}
          </Group>
        </Stack>
      </Card>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
        {tuile(`/sites/${s.id}/contenus`, 'Contenus', 'Textes, tarifs, horaires, FAQ… par formulaires.', <IconFileText size={28} />)}
        {tuile(`/sites/${s.id}/medias`, 'Médias', 'Photos et documents du site.', <IconPhoto size={28} />)}
        {tuile(`/sites/${s.id}/apercu`, 'Aperçu', 'Voir le brouillon sur téléphone, tablette, ordinateur.', <IconEye size={28} />)}
        {s.droits.publier && tuile(`/sites/${s.id}/publier`, 'Publier', 'Mettre en ligne les modifications.', <IconRocket size={28} />, s.modificationsEnAttente > 0)}
        {tuile(`/sites/${s.id}/versions`, 'Versions', 'Historique et retour à une version précédente.', <IconHistory size={28} />)}
        {s.droits.code && tuile(`/sites/${s.id}/fichiers`, 'Code', 'Fichiers HTML, CSS, JavaScript, JSON.', <IconCode size={28} />)}
        {s.droits.reglages && tuile(`/sites/${s.id}/reglages`, 'Réglages', 'Nom, domaines, membres, export.', <IconSettings size={28} />)}
      </SimpleGrid>

      {s.fiche.remarques.length > 0 && (
        <Alert icon={<IconInfoCircle />} color="blue" variant="light" title="À savoir sur ce site">
          <List size="sm" spacing={4}>
            {s.fiche.remarques.map((r) => (
              <List.Item key={r}>{r}</List.Item>
            ))}
          </List>
        </Alert>
      )}

      <Card withBorder radius="lg" padding="lg">
        <Title order={2} fz="md" mb="xs">
          Fiche technique
        </Title>
        <Text size="sm">Dossier publié : {s.fiche.dossierPublie}</Text>
        <Text size="sm">Étape de préparation : {s.fiche.preparation ?? 'aucune'}</Text>
        <Text size="sm">Fonctions serveur : {s.fiche.fonctions ?? 'aucune'}</Text>
        <Text size="sm">Schéma des contenus : {s.contenus.source === '.pages.yml' ? 'fichier .pages.yml' : 'déduit automatiquement'} ({s.contenus.nombre} rubriques)</Text>
      </Card>
    </Page>
  );
}
