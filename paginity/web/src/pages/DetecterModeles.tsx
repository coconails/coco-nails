import { useState } from 'react';
import { Badge, Button, Card, Checkbox, Group, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconSearch } from '@tabler/icons-react';
import { errorMessage, post } from '../api';

interface Modele {
  id: string;
  nom: string;
  deja: boolean;
}

/** Kit de démarrage : trouve les modèles installés avec Ollama et les ajoute en un clic. */
export function DetecterModeles({ onAjoute }: { onAjoute: () => void }) {
  const [url, setUrl] = useState('http://127.0.0.1:11434');
  const [liste, setListe] = useState<Modele[] | null>(null);
  const [choix, setChoix] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const detecter = async () => {
    setBusy('detecter');
    try {
      const r = await post<{ modeles: Modele[] }>('/api/reglages/ia/detecter', { url });
      setListe(r.modeles);
      setChoix(r.modeles.filter((m) => !m.deja).map((m) => m.id));
    } catch (e) {
      setListe(null);
      notifications.show({ color: 'red', message: errorMessage(e), autoClose: 10_000 });
    } finally {
      setBusy(null);
    }
  };
  const ajouter = async () => {
    setBusy('ajouter');
    try {
      await post('/api/reglages/ia/ajouter-detectes', { url, ids: choix });
      notifications.show({ color: 'green', message: `${choix.length} modèle(s) ajouté(s) et autorisé(s). Lancez le banc d’essai pour les noter.` });
      setListe(null);
      onAjoute();
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card withBorder radius="md" padding="md" data-section="detecter">
      <Stack gap="xs">
        <Text fw={600} size="sm">
          Démarrage rapide : modèles installés sur cette machine
        </Text>
        <Group align="flex-end" gap="xs">
          <TextInput style={{ flex: 1, minWidth: 220 }} label="Adresse d’Ollama" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
          <Button variant="default" leftSection={<IconSearch size={16} />} loading={busy === 'detecter'} onClick={() => void detecter()}>
            Détecter les modèles installés
          </Button>
        </Group>
        {liste && liste.length === 0 && (
          <Text size="sm" c="dimmed">
            Ollama répond, mais aucun modèle n’est installé. Dans un terminal : « ollama pull qwen3:8b » (par exemple).
          </Text>
        )}
        {liste && liste.length > 0 && (
          <>
            {liste.map((m) => (
              <Checkbox
                key={m.id}
                disabled={m.deja}
                checked={m.deja || choix.includes(m.id)}
                onChange={(e) => setChoix(e.currentTarget.checked ? [...choix, m.id] : choix.filter((x) => x !== m.id))}
                label={
                  <>
                    {m.nom} <Text span size="xs" c="dimmed">({m.id})</Text> {m.deja && <Badge size="xs" variant="light">déjà ajouté</Badge>}
                  </>
                }
              />
            ))}
            <Group>
              <Button loading={busy === 'ajouter'} disabled={!choix.length} onClick={() => void ajouter()}>
                Ajouter les modèles choisis
              </Button>
              <Text size="xs" c="dimmed">
                Ils sont enregistrés tout de suite (les modifications non enregistrées plus bas seraient perdues).
              </Text>
            </Group>
          </>
        )}
      </Stack>
    </Card>
  );
}
