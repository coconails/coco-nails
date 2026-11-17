import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Group, NumberInput, PasswordInput, Stack, Switch, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconCloudUpload, IconShieldCheck } from '@tabler/icons-react';
import { errorMessage, get, post, put } from '../api';

interface Resume {
  reglages: { active: boolean; dossier: string; heure: number; garder: number };
  phrase: boolean;
  dossierOk: boolean;
  enCours: null | 'sauvegarde' | 'essai';
  derniere: null | { le: number; fichier: string; octets: number; ok: boolean; message: string; duree: number };
  dernierEssai: null | { le: number; fichier: string; ok: boolean; message: string };
  fichiers: { nom: string; octets: number; le: number }[];
}
const date = (t: number) => new Date(t).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const taille = (o: number) => (o > 1e6 ? `${(o / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo` : `${Math.max(1, Math.round(o / 1e3))} Ko`);

/** Sauvegarde automatique chiffrée hors de la machine, avec essai de restauration mensuel. */
export function ReglagesSauvegarde() {
  const q = useQuery({ queryKey: ['sauvegarde'], queryFn: () => get<Resume>('/api/reglages/sauvegarde') });
  const [r, setR] = useState<Resume['reglages'] | null>(null);
  const [phrase, setPhrase] = useState({ a: '', b: '' });
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
      await q.refetch();
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e), autoClose: 12_000 });
      await q.refetch();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card withBorder radius="lg" padding="lg" data-section="sauvegarde">
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <IconCloudUpload size={20} color="var(--mantine-color-or-5)" />
            <Title order={3} size="h4">
              Sauvegarde automatique (hors de la machine)
            </Title>
          </Group>
          {s.reglages.active ? <Badge color="green">Active</Badge> : <Badge color="gray">Désactivée</Badge>}
        </Group>
        <Text size="sm" c="dimmed">
          Chaque nuit, PAGINITY sauvegarde tout (sites, historiques, messages, comptes), chiffre le fichier avec votre phrase de sauvegarde et le dépose dans
          un dossier de votre choix : dossier synchronisé avec Google Drive ou OneDrive, disque USB, partage réseau. Sans la phrase, le fichier est illisible,
          même pour Google. Une fois par mois, PAGINITY essaie de restaurer la dernière sauvegarde pour vérifier qu’elle est bonne.
        </Text>

        <Text fw={600} size="sm">
          1. Phrase de sauvegarde {s.phrase && <Badge ml={6} size="sm" color="green" variant="light">choisie</Badge>}
        </Text>
        <Alert color="yellow" variant="light">
          Notez-la sur papier et rangez-la hors de la maison. Elle n’est enregistrée nulle part en clair : <b>sans elle, les sauvegardes ne peuvent pas être
          ouvertes</b>. Changer de phrase ne concerne que les sauvegardes suivantes.
        </Alert>
        <Group align="flex-end" gap="xs">
          <PasswordInput style={{ flex: 1, minWidth: 200 }} label={s.phrase ? 'Nouvelle phrase' : 'Phrase'} description="Au moins 16 caractères, par exemple quatre mots sans rapport" value={phrase.a} onChange={(e) => setPhrase({ ...phrase, a: e.currentTarget.value })} />
          <PasswordInput style={{ flex: 1, minWidth: 200 }} label="Retapez-la" value={phrase.b} onChange={(e) => setPhrase({ ...phrase, b: e.currentTarget.value })} />
          <Button
            variant="default"
            loading={busy === 'phrase'}
            disabled={!phrase.a || phrase.a !== phrase.b}
            onClick={() =>
              void agir('phrase', async () => {
                await post('/api/reglages/sauvegarde/phrase', { phrase: phrase.a });
                setPhrase({ a: '', b: '' });
              }, 'Phrase de sauvegarde enregistrée.')
            }
          >
            Enregistrer la phrase
          </Button>
        </Group>
        {phrase.b && phrase.a !== phrase.b && (
          <Text size="xs" c="red">
            Les deux saisies sont différentes.
          </Text>
        )}

        <Text fw={600} size="sm">
          2. Où et quand
        </Text>
        <TextInput
          label="Dossier de destination (chemin complet)"
          description="Exemples : /media/disque-usb/sauvegardes · /home/paginity/Google Drive/Sauvegardes · D:\Sauvegardes"
          value={r.dossier}
          onChange={(e) => setR({ ...r, dossier: e.currentTarget.value })}
          error={s.reglages.dossier && s.reglages.dossier === r.dossier && !s.dossierOk ? 'Dossier introuvable ou impossible d’y écrire.' : undefined}
        />
        <Group grow>
          <NumberInput label="Heure de la sauvegarde" description="Heure du serveur, 0 à 23" min={0} max={23} value={r.heure} onChange={(v) => setR({ ...r, heure: Number(v) || 0 })} />
          <NumberInput label="Sauvegardes gardées" description="Les plus anciennes sont effacées" min={1} max={90} value={r.garder} onChange={(v) => setR({ ...r, garder: Number(v) || 1 })} />
        </Group>
        <Group>
          <Switch label="Sauvegarde automatique active" checked={r.active} onChange={(e) => setR({ ...r, active: e.currentTarget.checked })} />
          <Button loading={busy === 'reglages'} onClick={() => void agir('reglages', () => put('/api/reglages/sauvegarde', r), 'Réglages de sauvegarde enregistrés.')}>
            Enregistrer
          </Button>
        </Group>

        <Text fw={600} size="sm">
          3. État
        </Text>
        <Stack gap={4}>
          <Text size="sm">
            Dernière sauvegarde :{' '}
            {s.derniere ? (
              <>
                <Badge size="sm" color={s.derniere.ok ? 'green' : 'red'} variant="light">
                  {s.derniere.ok ? 'réussie' : 'échec'}
                </Badge>{' '}
                {date(s.derniere.le)} {s.derniere.ok ? `— ${taille(s.derniere.octets)}` : `— ${s.derniere.message}`}
              </>
            ) : (
              'aucune pour l’instant'
            )}
          </Text>
          <Text size="sm">
            Dernier essai de restauration :{' '}
            {s.dernierEssai ? (
              <>
                <Badge size="sm" color={s.dernierEssai.ok ? 'green' : 'red'} variant="light">
                  {s.dernierEssai.ok ? 'réussi' : 'échec'}
                </Badge>{' '}
                {date(s.dernierEssai.le)} — {s.dernierEssai.message}
              </>
            ) : (
              'aucun pour l’instant'
            )}
          </Text>
        </Stack>
        <Group>
          <Button variant="default" leftSection={<IconCloudUpload size={16} />} loading={busy === 'maintenant' || s.enCours === 'sauvegarde'} disabled={!s.phrase || !s.dossierOk} onClick={() => void agir('maintenant', () => post('/api/reglages/sauvegarde/maintenant'), 'Sauvegarde terminée.')}>
            Sauvegarder maintenant
          </Button>
          <Button variant="default" leftSection={<IconShieldCheck size={16} />} loading={busy === 'essai' || s.enCours === 'essai'} disabled={!s.fichiers.length} onClick={() => void agir('essai', () => post('/api/reglages/sauvegarde/essai'))}>
            Essayer de restaurer la dernière
          </Button>
        </Group>
        {s.fichiers.length > 0 && (
          <Table.ScrollContainer minWidth={420}>
            <Table withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Fichier dans le dossier</Table.Th>
                  <Table.Th>Date</Table.Th>
                  <Table.Th>Taille</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {s.fichiers.map((f) => (
                  <Table.Tr key={f.nom}>
                    <Table.Td style={{ fontFamily: 'monospace', fontSize: 12 }}>{f.nom}</Table.Td>
                    <Table.Td>{date(f.le)}</Table.Td>
                    <Table.Td>{taille(f.octets)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        <Text size="xs" c="dimmed">
          En cas de panne totale : sur la nouvelle machine, « paginity-admin ouvrir-sauvegarde &lt;fichier&gt; &lt;dossier&gt; » (la phrase est demandée), puis
          « paginity-admin restaurer ». Le manuel explique chaque étape.
        </Text>
      </Stack>
    </Card>
  );
}
