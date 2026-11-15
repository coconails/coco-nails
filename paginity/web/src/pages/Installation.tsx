import { useState } from 'react';
import { Alert, Button, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { errorMessage, post } from '../api';
import { AuthLayout } from '../components/AuthLayout';
import { useRefreshEtat } from '../App';

export function InstallationPage() {
  const refresh = useRefreshEtat();
  const [f, setF] = useState({ code: '', nom: '', email: '', motDePasse: '', confirmation: '' });
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.currentTarget.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErreur(null);
    if (f.motDePasse !== f.confirmation) return setErreur('Les deux mots de passe ne sont pas identiques.');
    setBusy(true);
    try {
      await post('/api/installation', f);
      await refresh();
    } catch (err) {
      setErreur(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout titre="Bienvenue ! Créons votre compte">
      <form onSubmit={submit}>
        <Stack>
          <Text size="sm" c="dimmed">
            Ce compte sera le <b>propriétaire</b> de PAGINITY. Le code d’installation s’affiche dans la fenêtre où le serveur a été démarré.
          </Text>
          {erreur && <Alert color="red">{erreur}</Alert>}
          <TextInput label="Code d’installation" value={f.code} onChange={set('code')} required autoComplete="off" />
          <TextInput label="Votre nom" value={f.nom} onChange={set('nom')} required autoComplete="name" />
          <TextInput label="Adresse e-mail" type="email" value={f.email} onChange={set('email')} required autoComplete="email" />
          <PasswordInput
            label="Mot de passe"
            description="Au moins 12 caractères. Une phrase de plusieurs mots est idéale et facile à retenir."
            value={f.motDePasse}
            onChange={set('motDePasse')}
            required
            autoComplete="new-password"
          />
          <PasswordInput label="Confirmez le mot de passe" value={f.confirmation} onChange={set('confirmation')} required autoComplete="new-password" />
          <Button type="submit" loading={busy}>
            Créer mon compte
          </Button>
        </Stack>
      </form>
    </AuthLayout>
  );
}
