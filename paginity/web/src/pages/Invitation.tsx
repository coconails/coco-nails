import { useState } from 'react';
import { Alert, Button, Loader, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { errorMessage, get, post } from '../api';
import { AuthLayout } from '../components/AuthLayout';
import { useRefreshEtat } from '../App';

export function InvitationPage() {
  const { token } = useParams();
  const refresh = useRefreshEtat();
  const inv = useQuery({ queryKey: ['invitation', token], queryFn: () => get<{ email: string }>(`/api/invitations/${token}`) });
  const [nom, setNom] = useState('');
  const [mdp, setMdp] = useState('');
  const [mdp2, setMdp2] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mdp !== mdp2) return setErreur('Les deux mots de passe ne sont pas identiques.');
    setBusy(true);
    setErreur(null);
    try {
      await post(`/api/invitations/${token}/accepter`, { nom, motDePasse: mdp });
      await refresh();
    } catch (err) {
      setErreur(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout titre="Vous êtes invité(e) sur PAGINITY">
      {inv.isLoading && <Loader />}
      {inv.error && <Alert color="red">{errorMessage(inv.error)}</Alert>}
      {inv.data && (
        <form onSubmit={submit}>
          <Stack>
            <Text size="sm">
              Création du compte pour <b>{inv.data.email}</b>. Vous configurerez ensuite la double authentification.
            </Text>
            {erreur && <Alert color="red">{erreur}</Alert>}
            <TextInput label="Votre nom" value={nom} onChange={(e) => setNom(e.currentTarget.value)} required autoComplete="name" />
            <PasswordInput label="Mot de passe" description="Au moins 12 caractères." value={mdp} onChange={(e) => setMdp(e.currentTarget.value)} required autoComplete="new-password" />
            <PasswordInput label="Confirmez le mot de passe" value={mdp2} onChange={(e) => setMdp2(e.currentTarget.value)} required autoComplete="new-password" />
            <Button type="submit" loading={busy}>
              Créer mon compte
            </Button>
          </Stack>
        </form>
      )}
    </AuthLayout>
  );
}
