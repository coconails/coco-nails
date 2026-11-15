import { Alert, Card, Group, Progress, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { get } from '../api';
import { ErrorBox, Loading, Page } from '../components/Page';
import { duree, taille } from '../format';

export function SantePage() {
  const q = useQuery({ queryKey: ['sante'], queryFn: () => get<any>('/api/sante'), refetchInterval: 15_000 });
  const d = q.data;
  return (
    <Page titre="Santé du serveur" sousTitre="Actualisé toutes les 15 secondes.">
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {d && (
        <>
          {d.alertes.map((a: any, i: number) => (
            <Alert key={i} color={a.niveau === 'critique' ? 'red' : a.niveau === 'attention' ? 'orange' : 'blue'} variant="light">
              {a.message}
            </Alert>
          ))}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Card withBorder radius="lg" padding="lg">
              <Title order={2} fz="lg" mb="sm">
                Ressources
              </Title>
              <Stack gap="sm">
                {d.disque && (
                  <div>
                    <Group justify="space-between">
                      <Text size="sm">Disque</Text>
                      <Text size="sm">
                        {taille(d.disque.total - d.disque.libre)} / {taille(d.disque.total)}
                      </Text>
                    </Group>
                    <Progress value={d.disque.utilisePct} color={d.disque.utilisePct >= 90 ? 'red' : d.disque.utilisePct >= 80 ? 'orange' : 'green'} />
                  </div>
                )}
                <div>
                  <Group justify="space-between">
                    <Text size="sm">Mémoire</Text>
                    <Text size="sm">
                      {taille(d.memoire.total - d.memoire.libre)} / {taille(d.memoire.total)} (PAGINITY : {taille(d.memoire.paginity)})
                    </Text>
                  </Group>
                  <Progress value={d.memoire.utilisePct} />
                </div>
                <Text size="sm">Charge du processeur (1, 5, 15 min) : {d.charge.join(' · ')} pour {d.processeurs} cœurs</Text>
                <Text size="sm">Température : {d.temperature !== null ? `${d.temperature} °C` : 'capteur non disponible sur cette machine'}</Text>
              </Stack>
            </Card>
            <Card withBorder radius="lg" padding="lg">
              <Title order={2} fz="lg" mb="sm">
                Système
              </Title>
              <Stack gap={4}>
                <Text size="sm">PAGINITY {d.version} — en marche depuis {duree(d.demarreDepuis)}</Text>
                <Text size="sm">Machine : {d.machine}</Text>
                <Text size="sm">Système : {d.systeme}</Text>
                <Text size="sm">Node.js : {d.node}</Text>
                <Text size="sm">Machine démarrée depuis {duree(d.systemeDemarreDepuis)}</Text>
              </Stack>
            </Card>
            <Card withBorder radius="lg" padding="lg">
              <Title order={2} fz="lg" mb="sm">
                Sauvegardes
              </Title>
              <Text size="sm">{d.sauvegardes.message}</Text>
              <Text size="sm" c="dimmed" mt="xs">
                En attendant, chaque site peut être exporté complètement depuis ses Réglages.
              </Text>
            </Card>
            <Card withBorder radius="lg" padding="lg">
              <Title order={2} fz="lg" mb="sm">
                Surveillance externe
              </Title>
              <Text size="sm">Prévue à l’installation définitive : un service extérieur préviendra par e-mail si le serveur ou ses sites deviennent injoignables.</Text>
            </Card>
          </SimpleGrid>
        </>
      )}
    </Page>
  );
}
