import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Divider, Group, Modal, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { startAuthentication } from '@simplewebauthn/browser';
import { IconFingerprint, IconShieldLock } from '@tabler/icons-react';
import { errorMessage, onConfirmationRequired, post } from '../api';
import { useEtat } from '../App';

/** Fenêtre de confirmation d'identité, ouverte automatiquement avant une action sensible. */
export function ConfirmIdentity() {
  const etat = useEtat();
  const [opened, setOpened] = useState(false);
  const [motDePasse, setMotDePasse] = useState('');
  const [code, setCode] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const f = etat.utilisateur?.doubleAuthentification;

  useEffect(() => {
    onConfirmationRequired(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setMotDePasse('');
          setCode('');
          setErreur(null);
          setOpened(true);
        }),
    );
  }, []);

  const finish = (ok: boolean) => {
    setOpened(false);
    resolver.current?.(ok);
    resolver.current = null;
  };

  const viaCode = async () => {
    setBusy(true);
    setErreur(null);
    try {
      await post('/api/confirmation', { motDePasse, code });
      finish(true);
    } catch (e) {
      setErreur(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const viaPasskey = async () => {
    setBusy(true);
    setErreur(null);
    try {
      const options = await post('/api/confirmation/passkey/options');
      const reponse = await startAuthentication({ optionsJSON: options });
      await post('/api/confirmation/passkey', { motDePasse, reponse });
      finish(true);
    } catch (e) {
      setErreur(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal zIndex={400} opened={opened} onClose={() => finish(false)} title={<Group gap="xs"><IconShieldLock size={20} /><Text fw={700}>Confirmez votre identité</Text></Group>} centered>
      <Stack>
        <Text size="sm">Cette action est sensible. Par sécurité, confirmez qu’il s’agit bien de vous (valable quelques minutes).</Text>
        {erreur && <Alert color="red">{erreur}</Alert>}
        <PasswordInput label="Mot de passe" value={motDePasse} onChange={(e) => setMotDePasse(e.currentTarget.value)} autoComplete="current-password" data-autofocus />
        {f?.totp && (
          <TextInput label="Code à 6 chiffres (ou code de secours)" value={code} onChange={(e) => setCode(e.currentTarget.value)} inputMode="numeric" autoComplete="one-time-code" />
        )}
        {f?.totp && (
          <Button onClick={viaCode} loading={busy} disabled={!motDePasse || !code}>
            Confirmer
          </Button>
        )}
        {f?.passkey && (
          <>
            {f.totp && <Divider label="ou" labelPosition="center" />}
            <Button variant="light" leftSection={<IconFingerprint size={18} />} onClick={viaPasskey} loading={busy} disabled={!motDePasse}>
              Confirmer avec ma passkey
            </Button>
          </>
        )}
        {!f?.totp && (
          <TextInput label="Code de secours (si vous n’avez pas votre passkey)" value={code} onChange={(e) => setCode(e.currentTarget.value)} />
        )}
        {!f?.totp && code && (
          <Button variant="subtle" onClick={viaCode} loading={busy}>
            Confirmer avec le code de secours
          </Button>
        )}
      </Stack>
    </Modal>
  );
}
