import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconBellRinging } from '@tabler/icons-react';
import { del, errorMessage, get, post } from '../api';

const versOctets = (b64: string) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

/** Notifications sur cet appareil : alertes (propriétaire) et nouveaux messages des formulaires. */
export function NotificationsTelephone() {
  const q = useQuery({ queryKey: ['push'], queryFn: () => get<{ cle: string; appareils: number }>('/api/push') });
  const [busy, setBusy] = useState<string | null>(null);
  const possible = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const iphoneHorsAppli = /iPhone|iPad/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches;
  const agir = async (cle: string, f: () => Promise<unknown>, ok: string) => {
    setBusy(cle);
    try {
      await f();
      notifications.show({ color: 'green', message: ok });
      await q.refetch();
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e), autoClose: 10_000 });
    } finally {
      setBusy(null);
    }
  };
  const activer = async () => {
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications refusées : autorisez-les dans les réglages du navigateur.');
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const abo = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: versOctets(q.data!.cle) });
    await post('/api/push/abonnement', abo.toJSON());
  };
  const desactiver = async () => {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const abo = await reg?.pushManager.getSubscription();
    if (abo) {
      await del('/api/push/abonnement', { endpoint: abo.endpoint });
      await abo.unsubscribe();
    }
  };
  return (
    <Card withBorder radius="lg" padding="lg" data-section="notifications">
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <IconBellRinging size={20} color="var(--mantine-color-or-5)" />
            <Title order={2} fz="lg">
              Notifications sur le téléphone
            </Title>
          </Group>
          {q.data && <Badge variant="light">{q.data.appareils} appareil(s)</Badge>}
        </Group>
        <Text size="sm" c="dimmed">
          Recevez une notification pour les alertes (serveur arrêté, sauvegarde ratée…) et pour chaque nouveau message d’un formulaire. Le contenu des
          messages n’est jamais dans la notification : il reste dans PAGINITY.
        </Text>
        {!possible && <Alert color="gray">Ce navigateur ne sait pas recevoir de notifications.</Alert>}
        {possible && iphoneHorsAppli && (
          <Alert color="blue" variant="light">
            Sur iPhone : ajoutez d’abord PAGINITY à l’écran d’accueil (bouton Partager › « Sur l’écran d’accueil »), ouvrez-le depuis l’icône, puis revenez ici.
          </Alert>
        )}
        {possible && (
          <Group>
            <Button loading={busy === 'activer'} onClick={() => void agir('activer', activer, 'Notifications activées sur cet appareil.')}>
              Activer sur cet appareil
            </Button>
            <Button variant="default" loading={busy === 'essai'} disabled={!q.data?.appareils} onClick={() => void agir('essai', () => post('/api/push/essai'), 'Notification d’essai envoyée.')}>
              Envoyer un essai
            </Button>
            <Button variant="subtle" color="gray" loading={busy === 'off'} onClick={() => void agir('off', desactiver, 'Notifications désactivées sur cet appareil.')}>
              Désactiver sur cet appareil
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}
