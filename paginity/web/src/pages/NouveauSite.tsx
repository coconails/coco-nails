import { useState } from 'react';
import { Alert, Button, Card, Group, Radio, SegmentedControl, SimpleGrid, Stack, Stepper, Text, TextInput } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconFileZip, IconUpload } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { errorMessage, get, post } from '../api';
import { Page } from '../components/Page';
import { JobSteps } from '../components/Status';
import type { Activite, SiteResume } from '../types';

/** Assistant de création : nom, modèle ou import, vérification, création. */
export function NouveauSitePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const modeles = useQuery({ queryKey: ['modeles'], queryFn: () => get<{ id: string; nom: string; description: string }[]>('/api/modeles') });
  const [step, setStep] = useState(0);
  const [nom, setNom] = useState('');
  const [source, setSource] = useState<'modele' | 'zip' | 'git'>('modele');
  const [modele, setModele] = useState('vitrine');
  const [zip, setZip] = useState<File | null>(null);
  const [git, setGit] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useQuery({
    queryKey: ['activite', jobId],
    queryFn: () => get<Activite>(`/api/activites/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && ['reussie', 'echouee', 'interrompue'].includes(q.state.data.etat) ? false : 1000),
  });

  const create = async () => {
    setBusy(true);
    setErreur(null);
    try {
      if (source === 'modele') {
        const s = await post<SiteResume>('/api/sites', { nom, modele });
        await qc.invalidateQueries({ queryKey: ['sites'] });
        navigate(`/sites/${s.id}`);
        return;
      }
      if (source === 'zip') {
        const fd = new FormData();
        fd.append('nom', nom);
        fd.append('archive', zip!);
        const j = await post<Activite>('/api/sites/import', fd);
        setJobId(j.id);
      } else {
        const j = await post<Activite>('/api/sites/import', { nom, git });
        setJobId(j.id);
      }
      setStep(3);
    } catch (e) {
      setErreur(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = source === 'modele' ? !!modele : source === 'zip' ? !!zip : /^https:\/\//.test(git);
  const done = job.data?.etat === 'reussie' ? (job.data.resultat as { siteId: string }) : null;

  return (
    <Page titre="Ajouter un site" fil={[{ label: 'Tableau de bord', to: '/' }, { label: 'Ajouter un site' }]} largeur={860}>
      <Stepper active={step} onStepClick={(s) => s < step && step < 3 && setStep(s)} size="sm">
        <Stepper.Step label="Nom" description="Comment s’appelle-t-il ?">
          <Stack mt="md">
            <TextInput label="Nom du site" description="Vous pourrez le changer plus tard." value={nom} onChange={(e) => setNom(e.currentTarget.value)} autoFocus />
            <Group justify="flex-end">
              <Button onClick={() => setStep(1)} disabled={!nom.trim()}>
                Continuer
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Step label="Point de départ" description="Modèle ou import">
          <Stack mt="md">
            <SegmentedControl
              fullWidth
              value={source}
              onChange={(v) => setSource(v as typeof source)}
              data={[
                { value: 'modele', label: 'Partir d’un modèle' },
                { value: 'zip', label: 'Importer une archive' },
                { value: 'git', label: 'Importer un dépôt' },
              ]}
            />
            {source === 'modele' && (
              <Radio.Group value={modele} onChange={setModele}>
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  {(modeles.data ?? []).map((m) => (
                    <Card key={m.id} withBorder padding="md" component="label" style={{ cursor: 'pointer' }}>
                      <Group wrap="nowrap" align="flex-start">
                        <Radio value={m.id} />
                        <div>
                          <Text fw={600}>{m.nom}</Text>
                          <Text size="sm" c="dimmed">
                            {m.description}
                          </Text>
                        </div>
                      </Group>
                    </Card>
                  ))}
                </SimpleGrid>
              </Radio.Group>
            )}
            {source === 'zip' && (
              <Dropzone onDrop={(f) => setZip(f[0] ?? null)} maxFiles={1} accept={{ 'application/zip': ['.zip'], 'application/x-zip-compressed': ['.zip'] }} maxSize={200 * 1024 * 1024}>
                <Stack align="center" gap="xs" py="lg" style={{ pointerEvents: 'none' }}>
                  {zip ? <IconFileZip size={40} /> : <IconUpload size={40} />}
                  <Text>{zip ? zip.name : 'Déposez ici l’archive ZIP du site, ou touchez pour la choisir'}</Text>
                  <Text size="xs" c="dimmed">
                    HTML, CSS, JavaScript, JSON, images… 200 Mo maximum. Les dossiers .git et node_modules sont ignorés.
                  </Text>
                </Stack>
              </Dropzone>
            )}
            {source === 'git' && (
              <TextInput
                label="Adresse du dépôt Git public"
                description="Par exemple https://github.com/moi/mon-site — seulement les dépôts publics, sans mot de passe dans l’adresse."
                placeholder="https://…"
                value={git}
                onChange={(e) => setGit(e.currentTarget.value)}
              />
            )}
            <Group justify="space-between">
              <Button variant="default" onClick={() => setStep(0)}>
                Retour
              </Button>
              <Button onClick={() => setStep(2)} disabled={!ready}>
                Continuer
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Step label="Vérification" description="Tout est correct ?">
          <Stack mt="md">
            <Card withBorder>
              <Text>
                <b>Nom :</b> {nom}
              </Text>
              <Text>
                <b>Départ :</b>{' '}
                {source === 'modele' ? `modèle « ${modeles.data?.find((m) => m.id === modele)?.nom ?? modele} »` : source === 'zip' ? `archive ${zip?.name}` : git}
              </Text>
              <Text size="sm" c="dimmed" mt="xs">
                Le site sera créé en brouillon. Rien ne sera visible du public avant que vous le publiiez.
              </Text>
            </Card>
            {erreur && <Alert color="red">{erreur}</Alert>}
            <Group justify="space-between">
              <Button variant="default" onClick={() => setStep(1)}>
                Retour
              </Button>
              <Button onClick={create} loading={busy}>
                Créer le site
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Completed>
          <Stack mt="md">
            {job.data && <JobSteps job={job.data} />}
            {done && (
              <Group>
                <Button onClick={() => navigate(`/sites/${done.siteId}`)}>Ouvrir le site</Button>
                <Button variant="light" onClick={() => navigate(`/sites/${done.siteId}/apercu`)}>
                  Voir l’aperçu
                </Button>
              </Group>
            )}
            {job.data && ['echouee', 'interrompue'].includes(job.data.etat) && (
              <Button variant="default" onClick={() => setStep(1)}>
                Réessayer
              </Button>
            )}
          </Stack>
        </Stepper.Completed>
      </Stepper>
    </Page>
  );
}
