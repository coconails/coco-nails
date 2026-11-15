import { useState } from 'react';
import { Alert, Button, Code, CopyButton, Group, Image, List, PinInput, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { startRegistration } from '@simplewebauthn/browser';
import { IconCopy, IconDeviceMobile, IconFingerprint, IconPrinter } from '@tabler/icons-react';
import { errorMessage, post } from '../api';

/** Affichage des 10 codes de secours, à imprimer ou recopier. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone?: () => void }) {
  return (
    <Stack>
      <Alert color="or" title="Vos codes de secours">
        Ils permettent de vous connecter si vous perdez votre téléphone. Chaque code ne sert qu’une fois. Imprimez-les ou recopiez-les et rangez-les en lieu sûr :
        ils ne seront plus jamais affichés.
      </Alert>
      <SimpleGrid cols={2} spacing="xs">
        {codes.map((c) => (
          <Code key={c} fz="md" ta="center" p={6}>
            {c}
          </Code>
        ))}
      </SimpleGrid>
      <Group>
        <CopyButton value={codes.join('\n')}>
          {({ copied, copy }) => (
            <Button variant="light" leftSection={<IconCopy size={16} />} onClick={copy}>
              {copied ? 'Copiés' : 'Copier'}
            </Button>
          )}
        </CopyButton>
        <Button variant="light" leftSection={<IconPrinter size={16} />} onClick={() => window.print()}>
          Imprimer
        </Button>
        {onDone && <Button onClick={onDone}>J’ai rangé mes codes</Button>}
      </Group>
    </Stack>
  );
}

/** Mise en place des codes à 6 chiffres (application Google Authenticator, Microsoft Authenticator, etc.). */
export function TotpSetup({ onDone }: { onDone: (codes: string[] | null) => void }) {
  const [data, setData] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setErreur(null);
    try {
      setData(await post('/api/profil/2fa/totp/debut'));
    } catch (e) {
      setErreur(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (value: string) => {
    setBusy(true);
    setErreur(null);
    try {
      const r = await post<{ codesSecours: string[] | null }>('/api/profil/2fa/totp/confirmer', { code: value });
      onDone(r.codesSecours);
    } catch (e) {
      setErreur(errorMessage(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <Stack>
        {erreur && <Alert color="red">{erreur}</Alert>}
        <Button leftSection={<IconDeviceMobile size={18} />} onClick={start} loading={busy}>
          Utiliser une application de codes à 6 chiffres
        </Button>
      </Stack>
    );
  }
  return (
    <Stack>
      <List type="ordered" size="sm" spacing={4}>
        <List.Item>Installez une application d’authentification sur votre téléphone (par exemple Google Authenticator ou Microsoft Authenticator).</List.Item>
        <List.Item>Dans l’application, ajoutez un compte en scannant ce QR code.</List.Item>
        <List.Item>Saisissez le code à 6 chiffres affiché.</List.Item>
      </List>
      <Image src={data.qr} alt="QR code à scanner avec l’application d’authentification" w={220} h={220} mx="auto" radius="md" bg="white" />
      <TextInput label="Si vous ne pouvez pas scanner, saisissez cette clé" value={data.secret} readOnly styles={{ input: { fontFamily: 'monospace' } }} />
      {erreur && <Alert color="red">{erreur}</Alert>}
      <Group justify="center">
        <PinInput length={6} type="number" oneTimeCode value={code} onChange={setCode} onComplete={(v) => void confirm(v)} aria-label="Code à 6 chiffres" />
      </Group>
    </Stack>
  );
}

/** Enregistrement d'une passkey (empreinte, visage ou code de l'appareil). */
export function PasskeySetup({ onDone, label = 'Ajouter une passkey sur cet appareil' }: { onDone: (codes: string[] | null) => void; label?: string }) {
  const [nom, setNom] = useState(() => {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/Mac/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'PC Windows';
    return 'Mon appareil';
  });
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== 'undefined' && 'PublicKeyCredential' in window;

  const go = async () => {
    setBusy(true);
    setErreur(null);
    try {
      const options = await post('/api/profil/passkeys/options');
      const reponse = await startRegistration({ optionsJSON: options });
      const r = await post<{ codesSecours: string[] | null }>('/api/profil/passkeys', { reponse, nom });
      onDone(r.codesSecours);
    } catch (e) {
      setErreur(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!supported) return <Text size="sm" c="dimmed">Ce navigateur ne prend pas en charge les passkeys.</Text>;
  return (
    <Stack>
      {erreur && <Alert color="red">{erreur}</Alert>}
      <TextInput label="Nom de l’appareil" value={nom} onChange={(e) => setNom(e.currentTarget.value)} />
      <Button variant="light" leftSection={<IconFingerprint size={18} />} onClick={go} loading={busy}>
        {label}
      </Button>
    </Stack>
  );
}
