import { useEffect, useState } from 'react';
import { Alert, Button, Card, Group, NumberInput, PasswordInput, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconMail } from '@tabler/icons-react';
import { errorMessage, get, post, put } from '../api';
import { Loading, Page } from '../components/Page';
import { ReglagesIA } from './ReglagesIA';
import { ReglagesSauvegarde } from './ReglagesSauvegarde';
import { ReglagesAlerte } from './ReglagesAlerte';

interface Messagerie {
  hote: string;
  port: number;
  securise: boolean;
  utilisateur: string;
  expediteur: string;
  destinataireAlertes: string;
  motDePasseDefini: boolean;
}

export function ReglagesPlateformePage() {
  const q = useQuery({ queryKey: ['messagerie'], queryFn: () => get<Messagerie>('/api/reglages/messagerie') });
  const [f, setF] = useState<Messagerie | null>(null);
  const [mdp, setMdp] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  if (!f) return <Loading />;
  const set = <K extends keyof Messagerie>(k: K, v: Messagerie[K]) => setF({ ...f, [k]: v });

  return (
    <Page titre="Réglages de la plateforme" largeur={800}>
      <Card withBorder radius="lg" padding="lg">
        <Stack>
          <Group gap="xs">
            <IconMail />
            <Title order={2} fz="lg">
              Envoi d’e-mails (alertes, messages des formulaires)
            </Title>
          </Group>
          <Alert variant="light">
            <Text size="sm">
              Avec Google Workspace : serveur <b>smtp.gmail.com</b>, port <b>465</b>, connexion sécurisée, identifiant = votre adresse, et un <b>mot de passe d’application</b>{' '}
              (Compte Google › Sécurité › Mots de passe des applications). Le mot de passe est chiffré et ne sera plus affiché.
            </Text>
          </Alert>
          <Group grow align="flex-start">
            <TextInput label="Serveur SMTP" placeholder="smtp.gmail.com" value={f.hote} onChange={(e) => set('hote', e.currentTarget.value)} />
            <NumberInput label="Port" value={f.port} onChange={(v) => set('port', Number(v) || 465)} min={1} max={65535} />
          </Group>
          <Switch label="Connexion sécurisée (SSL/TLS)" checked={f.securise} onChange={(e) => set('securise', e.currentTarget.checked)} />
          <TextInput label="Identifiant" value={f.utilisateur} onChange={(e) => set('utilisateur', e.currentTarget.value)} autoComplete="off" />
          <PasswordInput
            label="Mot de passe d’application"
            placeholder={f.motDePasseDefini ? '•••••••• (déjà enregistré — laisser vide pour le garder)' : ''}
            value={mdp}
            onChange={(e) => setMdp(e.currentTarget.value)}
            autoComplete="new-password"
          />
          <TextInput label="Adresse d’expédition" placeholder="alertes@mondomaine.fr" value={f.expediteur} onChange={(e) => set('expediteur', e.currentTarget.value)} />
          <TextInput label="Destinataire des alertes" placeholder="moi@mondomaine.fr" value={f.destinataireAlertes} onChange={(e) => set('destinataireAlertes', e.currentTarget.value)} />
          <Group>
            <Button
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await put('/api/reglages/messagerie', { ...f, motDePasse: mdp || undefined });
                  setMdp('');
                  notifications.show({ color: 'green', message: 'Réglages enregistrés.' });
                  void q.refetch();
                } catch (e) {
                  notifications.show({ color: 'red', message: errorMessage(e) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Enregistrer
            </Button>
            <Button
              variant="light"
              onClick={async () => {
                try {
                  const r = await post<{ destinataire: string }>('/api/reglages/messagerie/test');
                  notifications.show({ color: 'green', message: `E-mail de test envoyé à ${r.destinataire}.` });
                } catch (e) {
                  notifications.show({ color: 'red', message: errorMessage(e), autoClose: 12_000 });
                }
              }}
            >
              Envoyer un e-mail de test
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            Alertes critiques (tâche en échec, etc.) : e-mail immédiat. Points d’attention : un récapitulatif par jour (vers 7 h, heure de Paris en hiver).
          </Text>
        </Stack>
      </Card>
      <ReglagesSauvegarde />
      <ReglagesAlerte />
      <ReglagesIA />
    </Page>
  );
}
