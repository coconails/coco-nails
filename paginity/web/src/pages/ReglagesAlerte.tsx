import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Group, List, NumberInput, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconHeartbeat } from '@tabler/icons-react';
import { errorMessage, get, post, put } from '../api';

interface Resume {
  reglages: { active: boolean; url: string; minutes: number };
  dernier: null | { le: number; ok: boolean; panne: string | null; reponse: string };
  panne: string | null;
}

/** Alerte si le serveur s'arrête : battement de cœur vers un service de surveillance extérieur. */
export function ReglagesAlerte() {
  const q = useQuery({ queryKey: ['battement'], queryFn: () => get<Resume>('/api/reglages/battement') });
  const [r, setR] = useState<Resume['reglages'] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setR(q.data.reglages);
  }, [q.data]);
  if (!q.data || !r) return null;
  const s = q.data;
  const agir = async (cle: string, f: () => Promise<unknown>, ok?: string) => {
    setBusy(cle);
    try {
      await f();
      if (ok) notifications.show({ color: 'green', message: ok });
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e), autoClose: 12_000 });
    } finally {
      await q.refetch();
      setBusy(null);
    }
  };
  return (
    <Card withBorder radius="lg" padding="lg" data-section="battement">
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <IconHeartbeat size={20} color="var(--mantine-color-or-5)" />
            <Title order={3} size="h4">
              Alerte si le serveur s’arrête
            </Title>
          </Group>
          {s.reglages.active ? <Badge color="green">Surveillé</Badge> : <Badge color="gray">Non surveillé</Badge>}
        </Group>
        <Text size="sm" c="dimmed">
          Un serveur éteint ne peut prévenir personne. PAGINITY envoie donc régulièrement un petit signal « je vais bien » à un service de surveillance
          gratuit. Si les signaux s’arrêtent (coupure de courant, box en panne…), c’est ce service qui vous prévient par e-mail ou SMS. Si PAGINITY tourne
          mais va mal (disque plein, base abîmée, sites arrêtés), il envoie un signal « en panne » : alerte immédiate. Aucune donnée n’est envoyée.
        </Text>
        <Alert variant="light" color="blue" title="Mise en place (5 minutes, gratuit)">
          <List size="sm" type="ordered">
            <List.Item>Créez un compte sur healthchecks.io (ou un service équivalent).</List.Item>
            <List.Item>Ajoutez une vérification : période 5 minutes, délai de grâce 10 minutes ; choisissez comment être prévenu (e-mail, SMS…).</List.Item>
            <List.Item>Copiez l’adresse « ping » qu’il vous donne et collez-la ci-dessous, puis « Envoyer un essai ».</List.Item>
            <List.Item>Conseillé en plus : un service comme UptimeRobot qui vérifie l’adresse publique de chaque site toutes les 5 minutes.</List.Item>
          </List>
        </Alert>
        <TextInput label="Adresse « ping » du service de surveillance" placeholder="https://hc-ping.com/…" value={r.url} onChange={(e) => setR({ ...r, url: e.currentTarget.value })} />
        <Group align="flex-end">
          <NumberInput w={220} label="Un signal toutes les (minutes)" min={1} max={60} value={r.minutes} onChange={(v) => setR({ ...r, minutes: Number(v) || 5 })} />
          <Switch label="Surveillance active" checked={r.active} onChange={(e) => setR({ ...r, active: e.currentTarget.checked })} />
          <Button loading={busy === 'reglages'} onClick={() => void agir('reglages', () => put('/api/reglages/battement', r), 'Surveillance enregistrée.')}>
            Enregistrer
          </Button>
          <Button variant="default" loading={busy === 'essai'} disabled={!s.reglages.url} onClick={() => void agir('essai', () => post('/api/reglages/battement/essai'))}>
            Envoyer un essai
          </Button>
        </Group>
        <Text size="sm">
          État du serveur maintenant : {s.panne ? <Badge color="red" variant="light">{s.panne}</Badge> : <Badge color="green" variant="light">tout va bien</Badge>}
        </Text>
        {s.dernier && (
          <Text size="sm" data-battement-dernier>
            Dernier signal : {new Date(s.dernier.le).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'medium' })} —{' '}
            {s.dernier.panne ? `« en panne » (${s.dernier.panne})` : '« je vais bien »'} —{' '}
            <Badge size="sm" color={s.dernier.ok ? 'green' : 'red'} variant="light">
              {s.dernier.reponse}
            </Badge>
          </Text>
        )}
      </Stack>
    </Card>
  );
}
