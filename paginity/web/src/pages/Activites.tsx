import { Accordion, Group, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { get } from '../api';
import { ErrorBox, Loading, Page } from '../components/Page';
import { JobBadge, JobSteps } from '../components/Status';
import { dateHeure } from '../format';
import type { Activite } from '../types';

export function ActivitesPage() {
  const q = useQuery({ queryKey: ['activites'], queryFn: () => get<Activite[]>('/api/activites') });
  return (
    <Page titre="Activités" sousTitre="Publications, imports et restaurations : elles continuent sur le serveur même si vous fermez cette page.">
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data?.length === 0 && <Text c="dimmed">Aucune activité pour l’instant.</Text>}
      <Accordion variant="separated" radius="md">
        {q.data?.map((a) => (
          <Accordion.Item key={a.id} value={a.id}>
            <Accordion.Control>
              <Group justify="space-between" wrap="nowrap" pr="sm">
                <div style={{ minWidth: 0 }}>
                  <Text fw={500} truncate>
                    {a.libelle}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {dateHeure(a.creeLe)}
                    {a.utilisateur ? ` · ${a.utilisateur}` : ''}
                  </Text>
                </div>
                <JobBadge etat={a.etat} />
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <JobSteps job={a} />
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
    </Page>
  );
}
