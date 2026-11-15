import { useState } from 'react';
import { Anchor, Divider, Stack, Text } from '@mantine/core';
import { AuthLayout } from '../components/AuthLayout';
import { PasskeySetup, RecoveryCodes, TotpSetup } from '../components/TwoFactorSetup';
import { useRefreshEtat } from '../App';
import { post } from '../api';

export function Configurer2faPage() {
  const refresh = useRefreshEtat();
  const [codes, setCodes] = useState<string[] | null>(null);

  const done = (c: string[] | null) => {
    if (c) setCodes(c);
    else void refresh();
  };

  if (codes) {
    return (
      <AuthLayout titre="Double authentification activée">
        <RecoveryCodes codes={codes} onDone={() => void refresh()} />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout titre="Protégez votre compte">
      <Stack>
        <Text size="sm">
          La double authentification est obligatoire : en plus du mot de passe, il faudra votre téléphone ou votre appareil pour vous connecter. Ainsi, un mot de passe volé
          ne suffit pas.
        </Text>
        <TotpSetup onDone={done} />
        <Divider label="ou" labelPosition="center" />
        <PasskeySetup onDone={done} label="Utiliser une passkey (empreinte, visage)" />
        <Anchor
          component="button"
          type="button"
          size="sm"
          c="dimmed"
          onClick={async () => {
            await post('/api/deconnexion');
            await refresh();
          }}
        >
          Se déconnecter
        </Anchor>
      </Stack>
    </AuthLayout>
  );
}
