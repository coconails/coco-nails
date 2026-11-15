import { useState } from 'react';
import { Alert, Anchor, Button, Divider, PasswordInput, PinInput, Stack, Text, TextInput } from '@mantine/core';
import { startAuthentication } from '@simplewebauthn/browser';
import { IconFingerprint } from '@tabler/icons-react';
import { errorMessage, post } from '../api';
import { AuthLayout } from '../components/AuthLayout';
import { useRefreshEtat } from '../App';

interface Defi {
  defi: string;
  methodes: { totp: boolean; passkey: boolean; secours: boolean };
}

export function ConnexionPage() {
  const refresh = useRefreshEtat();
  const [email, setEmail] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [defi, setDefi] = useState<Defi | null>(null);
  const [code, setCode] = useState('');
  const [secours, setSecours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErreur(null);
    try {
      await fn();
    } catch (e) {
      setErreur(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const step1 = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await post<{ etape: string } & Partial<Defi>>('/api/connexion', { email, motDePasse });
      if (r.etape === '2fa') setDefi(r as Defi);
      else await refresh();
    });
  };

  const sendCode = (value: string) =>
    run(async () => {
      await post(secours ? '/api/connexion/secours' : '/api/connexion/totp', { defi: defi!.defi, code: value });
      await refresh();
    });

  const passkey = () =>
    run(async () => {
      const options = await post('/api/connexion/passkey/options', { defi: defi!.defi });
      const reponse = await startAuthentication({ optionsJSON: options });
      await post('/api/connexion/passkey', { defi: defi!.defi, reponse });
      await refresh();
    });

  if (defi) {
    return (
      <AuthLayout titre="Double authentification">
        <Stack>
          {erreur && <Alert color="red">{erreur}</Alert>}
          {defi.methodes.passkey && (
            <Button size="md" leftSection={<IconFingerprint size={20} />} onClick={passkey} loading={busy}>
              Utiliser ma passkey (empreinte, visage, code de l’appareil)
            </Button>
          )}
          {defi.methodes.passkey && defi.methodes.totp && <Divider label="ou" labelPosition="center" />}
          {defi.methodes.totp && !secours && (
            <Stack gap={6} align="center">
              <Text size="sm">Saisissez le code à 6 chiffres affiché par votre application d’authentification.</Text>
              <PinInput
                length={6}
                type="number"
                oneTimeCode
                value={code}
                onChange={setCode}
                onComplete={(v) => void sendCode(v)}
                aria-label="Code à 6 chiffres"
                size="md"
                autoFocus
              />
            </Stack>
          )}
          {secours && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendCode(code);
              }}
            >
              <Stack>
                <TextInput label="Code de secours" description="Un des 10 codes imprimés lors de la configuration (utilisable une seule fois)." value={code} onChange={(e) => setCode(e.currentTarget.value)} autoFocus />
                <Button type="submit" loading={busy}>
                  Valider
                </Button>
              </Stack>
            </form>
          )}
          <Anchor
            component="button"
            type="button"
            size="sm"
            onClick={() => {
              setSecours(!secours);
              setCode('');
            }}
          >
            {secours ? 'Revenir au code de l’application' : 'Je n’ai pas accès à mon téléphone : utiliser un code de secours'}
          </Anchor>
          <Anchor component="button" type="button" size="sm" c="dimmed" onClick={() => setDefi(null)}>
            Recommencer
          </Anchor>
        </Stack>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout titre="Connexion">
      <form onSubmit={step1}>
        <Stack>
          {erreur && <Alert color="red">{erreur}</Alert>}
          <TextInput label="Adresse e-mail" type="email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} required autoComplete="username" autoFocus />
          <PasswordInput label="Mot de passe" value={motDePasse} onChange={(e) => setMotDePasse(e.currentTarget.value)} required autoComplete="current-password" />
          <Button type="submit" loading={busy}>
            Continuer
          </Button>
        </Stack>
      </form>
    </AuthLayout>
  );
}
