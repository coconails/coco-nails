import { useEffect, useState } from 'react';
import { Accordion, Alert, Button, Card, ColorInput, Group, List, SimpleGrid, Stack, Text, TextInput, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconDownload, IconLifebuoy } from '@tabler/icons-react';
import { api, errorMessage, get, put } from '../api';

interface Fiche {
  nom: string;
  message: string;
  telephone: string;
  lien: string;
  lienLibelle: string;
  email: string;
  adresse: string;
  horaires: string;
  couleur: string;
}

/** Page de secours d'un site : une page autonome à déposer chez un hébergeur gratuit, pour les jours de panne. */
export function PageSecours({ siteId, peutModifier }: { siteId: string; peutModifier: boolean }) {
  const q = useQuery({ queryKey: ['secours', siteId], queryFn: () => get<{ fiche: Fiche; enregistree: boolean; page: string }>(`/api/sites/${siteId}/secours`) });
  const [f, setF] = useState<Fiche | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) setF(q.data.fiche);
  }, [q.data]);
  if (!q.data || !f) return null;
  const champ = (k: keyof Fiche) => ({ value: f[k], disabled: !peutModifier, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.currentTarget.value }) });
  const telecharger = async () => {
    const res = await api<Response>('GET', `/api/sites/${siteId}/secours/index.html`, undefined, { raw: true });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = 'index.html';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <Card withBorder radius="lg" padding="lg" data-section="secours">
      <Stack>
        <Group gap="xs">
          <IconLifebuoy size={20} color="var(--mantine-color-or-5)" />
          <Title order={2} fz="lg">
            Page de secours
          </Title>
        </Group>
        <Text size="sm" c="dimmed">
          Si le serveur de la maison s’arrête, cette petite page permet quand même aux clientes de vous joindre. Elle tient en un seul fichier, sans rien
          d’extérieur, et se dépose une fois pour toutes chez un hébergeur gratuit. {q.data.enregistree ? '' : 'Elle est pré-remplie avec ce que PAGINITY a trouvé dans vos contenus : vérifiez.'}
        </Text>
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
          <Stack gap="xs">
            <TextInput label="Nom" {...champ('nom')} />
            <Textarea label="Message" autosize minRows={2} {...champ('message')} />
            <TextInput label="Téléphone" {...champ('telephone')} />
            <Group grow>
              <TextInput label="Lien de contact (facultatif)" placeholder="https://wa.me/33…" {...champ('lien')} />
              <TextInput label="Texte du bouton" {...champ('lienLibelle')} />
            </Group>
            <TextInput label="E-mail" {...champ('email')} />
            <Textarea label="Adresse" autosize minRows={2} {...champ('adresse')} />
            <Textarea label="Horaires" autosize minRows={2} placeholder="Lun, mar, jeu, ven 9 h–19 h · mer, sam 9 h–12 h" {...champ('horaires')} />
            <ColorInput label="Couleur" value={f.couleur} disabled={!peutModifier} onChange={(v) => setF({ ...f, couleur: v })} format="hex" />
            <Group>
              {peutModifier && (
                <Button
                  loading={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await put(`/api/sites/${siteId}/secours`, f);
                      notifications.show({ color: 'green', message: 'Page de secours enregistrée.' });
                      await q.refetch();
                    } catch (e) {
                      notifications.show({ color: 'red', message: errorMessage(e) });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Enregistrer
                </Button>
              )}
              <Button variant="default" leftSection={<IconDownload size={16} />} onClick={() => void telecharger()}>
                Télécharger la page (index.html)
              </Button>
            </Group>
          </Stack>
          <Stack gap={4}>
            <Text size="sm" fw={600}>
              Aperçu (téléphone)
            </Text>
            <iframe
              title="Aperçu de la page de secours"
              sandbox=""
              srcDoc={q.data.page}
              style={{ width: '100%', maxWidth: 360, height: 560, border: '1px solid var(--mantine-color-default-border)', borderRadius: 16, background: '#fff' }}
            />
            <Text size="xs" c="dimmed">
              L’aperçu montre la dernière version enregistrée.
            </Text>
          </Stack>
        </SimpleGrid>
        <Accordion variant="separated">
          <Accordion.Item value="mise-en-place">
            <Accordion.Control>Mettre la page en ligne et basculer en cas de panne</Accordion.Control>
            <Accordion.Panel>
              <List size="sm" type="ordered" spacing={4}>
                <List.Item>Téléchargez la page (bouton ci-dessus).</List.Item>
                <List.Item>Déposez-la chez un hébergeur gratuit de pages simples (par exemple Netlify Drop, Cloudflare Pages ou GitHub Pages) : vous obtenez une adresse de secours.</List.Item>
                <List.Item>Notez cette adresse et, à côté, les réglages DNS actuels de votre domaine.</List.Item>
                <List.Item>En cas de panne longue, chez Squarespace (Domaines › DNS), faites pointer le domaine vers l’hébergeur de secours ; remettez les réglages notés quand le serveur repart.</List.Item>
              </List>
              <Alert mt="sm" variant="light" color="yellow">
                Avec les réglages DNS de Squarespace, la bascule est manuelle : le changement prend effet en quelques minutes à quelques heures. Une bascule
                automatique demande un service DNS avec « surveillance et basculement » (souvent payant). L’alerte de panne des Réglages de la plateforme
                vous prévient dès que le serveur s’arrête.
              </Alert>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </Stack>
    </Card>
  );
}
