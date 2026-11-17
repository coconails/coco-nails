import { NotificationsTelephone } from './NotificationsTelephone';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Group, Modal, PasswordInput, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconLogout, IconTrash } from '@tabler/icons-react';
import { del, errorMessage, get, patch, post } from '../api';
import { useRefreshEtat } from '../App';
import { Page } from '../components/Page';
import { PasskeySetup, RecoveryCodes, TotpSetup } from '../components/TwoFactorSetup';
import { dateHeure, ilYa } from '../format';
import type { Utilisateur } from '../types';

export function ProfilPage() {
  const qc = useQueryClient();
  const refreshEtat = useRefreshEtat();
  const profil = useQuery({ queryKey: ['profil'], queryFn: () => get<{ utilisateur: Utilisateur; passkeys: { id: string; nom: string; creeLe: number; utiliseeLe: number | null }[] }>('/api/profil') });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => get<{ id: string; courante: boolean; vueLe: number; ip: string; appareil: string }[]>('/api/profil/sessions') });
  const [nom, setNom] = useState('');
  const [mdp, setMdp] = useState({ actuel: '', nouveau: '', confirmation: '' });
  const [codes, setCodes] = useState<string[] | null>(null);
  const [totpOpen, setTotpOpen] = useState(false);
  const [pkOpen, setPkOpen] = useState(false);
  const u = profil.data?.utilisateur;

  useEffect(() => {
    if (u) setNom(u.nom);
  }, [u]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['profil'] });
    void qc.invalidateQueries({ queryKey: ['sessions'] });
    void refreshEtat();
  };
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) notifications.show({ color: 'green', message: ok });
      refresh();
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e) });
    }
  };

  if (!u) return null;
  return (
    <Page titre="Mon profil et sécurité" largeur={900}>
      <Card withBorder radius="lg" padding="lg">
        <Stack>
          <Title order={2} fz="lg">
            Identité
          </Title>
          <TextInput label="Nom affiché" value={nom} onChange={(e) => setNom(e.currentTarget.value)} />
          <Text size="sm" c="dimmed">
            Adresse e-mail : {u.email}
          </Text>
          <Group>
            <Button disabled={nom === u.nom} onClick={() => void act(() => patch('/api/profil', { nom }), 'Nom enregistré.')}>
              Enregistrer
            </Button>
          </Group>
        </Stack>
      </Card>

      <Card withBorder radius="lg" padding="lg">
        <Stack>
          <Title order={2} fz="lg">
            Double authentification
          </Title>
          <Group justify="space-between">
            <div>
              <Text fw={500}>Codes à 6 chiffres (application)</Text>
              <Text size="sm" c="dimmed">
                Google Authenticator, Microsoft Authenticator…
              </Text>
            </div>
            {u.doubleAuthentification.totp ? (
              <Group gap="xs">
                <Badge color="green">Activés</Badge>
                <Button size="xs" variant="subtle" onClick={() => setTotpOpen(true)}>
                  Changer de téléphone
                </Button>
                {u.doubleAuthentification.passkey && (
                  <Button size="xs" variant="subtle" color="red" onClick={() => void act(() => post('/api/profil/2fa/totp/desactiver'), 'Codes à 6 chiffres désactivés.')}>
                    Désactiver
                  </Button>
                )}
              </Group>
            ) : (
              <Button size="xs" variant="light" onClick={() => setTotpOpen(true)}>
                Activer
              </Button>
            )}
          </Group>
          <div>
            <Group justify="space-between">
              <div>
                <Text fw={500}>Passkeys</Text>
                <Text size="sm" c="dimmed">
                  Connexion par empreinte, visage ou code de l’appareil. Résistent à l’hameçonnage.
                </Text>
              </div>
              <Button size="xs" variant="light" onClick={() => setPkOpen(true)}>
                Ajouter
              </Button>
            </Group>
            {profil.data!.passkeys.map((p) => (
              <Group key={p.id} justify="space-between" mt="xs">
                <Text size="sm">
                  {p.nom} — ajoutée le {dateHeure(p.creeLe)}
                  {p.utiliseeLe ? `, utilisée ${ilYa(p.utiliseeLe)}` : ''}
                </Text>
                <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={() => void act(() => del(`/api/profil/passkeys/${encodeURIComponent(p.id)}`), 'Passkey supprimée.')}>
                  Supprimer
                </Button>
              </Group>
            ))}
          </div>
          <Group justify="space-between">
            <div>
              <Text fw={500}>Codes de secours</Text>
              <Text size="sm" c="dimmed">
                {u.doubleAuthentification.codesSecoursRestants} code(s) encore utilisable(s).
              </Text>
            </div>
            <Button
              size="xs"
              variant="light"
              onClick={() =>
                void act(async () => {
                  const r = await post<{ codesSecours: string[] }>('/api/profil/codes-secours');
                  setCodes(r.codesSecours);
                })
              }
            >
              Générer de nouveaux codes
            </Button>
          </Group>
        </Stack>
      </Card>

      <Card withBorder radius="lg" padding="lg">
        <Stack>
          <Title order={2} fz="lg">
            Mot de passe
          </Title>
          <PasswordInput label="Mot de passe actuel" value={mdp.actuel} onChange={(e) => setMdp({ ...mdp, actuel: e.currentTarget.value })} autoComplete="current-password" />
          <PasswordInput label="Nouveau mot de passe" description="Au moins 12 caractères." value={mdp.nouveau} onChange={(e) => setMdp({ ...mdp, nouveau: e.currentTarget.value })} autoComplete="new-password" />
          <PasswordInput label="Confirmation" value={mdp.confirmation} onChange={(e) => setMdp({ ...mdp, confirmation: e.currentTarget.value })} autoComplete="new-password" error={mdp.confirmation && mdp.confirmation !== mdp.nouveau ? 'Différent du nouveau mot de passe' : undefined} />
          <Group>
            <Button
              disabled={!mdp.actuel || !mdp.nouveau || mdp.nouveau !== mdp.confirmation}
              onClick={() =>
                void act(async () => {
                  await post('/api/profil/mot-de-passe', { actuel: mdp.actuel, nouveau: mdp.nouveau });
                  setMdp({ actuel: '', nouveau: '', confirmation: '' });
                }, 'Mot de passe changé. Les autres appareils ont été déconnectés.')
              }
            >
              Changer le mot de passe
            </Button>
          </Group>
        </Stack>
      </Card>

      <Card withBorder radius="lg" padding="lg">
        <Stack>
          <Group justify="space-between">
            <Title order={2} fz="lg">
              Appareils connectés
            </Title>
            <Button
              size="xs"
              color="red"
              variant="light"
              leftSection={<IconLogout size={14} />}
              onClick={async () => {
                await post('/api/deconnexion/partout');
                window.location.href = '/connexion';
              }}
            >
              Se déconnecter partout
            </Button>
          </Group>
          <Table.ScrollContainer minWidth={500}>
            <Table fz="sm">
              <Table.Tbody>
                {sessions.data?.map((s) => (
                  <Table.Tr key={s.id}>
                    <Table.Td>
                      {appareilLisible(s.appareil)} {s.courante && <Badge size="xs">cet appareil</Badge>}
                    </Table.Td>
                    <Table.Td>{s.ip}</Table.Td>
                    <Table.Td>{ilYa(s.vueLe)}</Table.Td>
                    <Table.Td>
                      {!s.courante && (
                        <Button size="xs" variant="subtle" color="red" onClick={() => void act(() => del(`/api/profil/sessions/${s.id}`), 'Appareil déconnecté.')}>
                          Déconnecter
                        </Button>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Stack>
      </Card>

      <Modal opened={totpOpen} onClose={() => setTotpOpen(false)} title="Activer les codes à 6 chiffres">
        <TotpSetup
          onDone={(c) => {
            setTotpOpen(false);
            if (c) setCodes(c);
            refresh();
          }}
        />
      </Modal>
      <Modal opened={pkOpen} onClose={() => setPkOpen(false)} title="Ajouter une passkey">
        <PasskeySetup
          onDone={(c) => {
            setPkOpen(false);
            if (c) setCodes(c);
            notifications.show({ color: 'green', message: 'Passkey ajoutée.' });
            refresh();
          }}
        />
      </Modal>
      <Modal opened={!!codes} onClose={() => setCodes(null)} title="Codes de secours" size="lg">
        {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}
      </Modal>
      <NotificationsTelephone />
    </Page>
  );
}

/** « Mozilla/5.0 (iPhone; …) Safari/… » → « Safari sur iPhone ». */
export function appareilLisible(ua: string | null | undefined): string {
  if (!ua) return 'Appareil inconnu';
  const nav = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /(Chrome|CriOS)\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
  const sys = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'appareil inconnu';
  return `${nav} sur ${sys}`;
}
