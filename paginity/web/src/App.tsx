import { createContext, lazy, Suspense, useContext, useEffect, type ReactNode } from 'react';
import { Center, Loader } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { get, onUnauthorized, setCsrf } from './api';
import type { Etat } from './types';
import { Shell } from './components/Shell';
import { ConfirmIdentity } from './components/ConfirmIdentity';
import { InstallationPage } from './pages/Installation';
import { ConnexionPage } from './pages/Connexion';
import { InvitationPage } from './pages/Invitation';
import { Configurer2faPage } from './pages/Configurer2fa';
import { TableauDeBordPage } from './pages/TableauDeBord';

// Pages chargées à la demande : premier affichage plus rapide, surtout sur téléphone.
const NouveauSitePage = lazy(() => import('./pages/NouveauSite').then((m) => ({ default: m.NouveauSitePage })));
const SitePage = lazy(() => import('./pages/Site').then((m) => ({ default: m.SitePage })));
const ContenusPage = lazy(() => import('./pages/Contenus').then((m) => ({ default: m.ContenusPage })));
const MediasPage = lazy(() => import('./pages/Medias').then((m) => ({ default: m.MediasPage })));
const FichiersPage = lazy(() => import('./pages/Fichiers').then((m) => ({ default: m.FichiersPage })));
const ApercuPage = lazy(() => import('./pages/Apercu').then((m) => ({ default: m.ApercuPage })));
const PublierPage = lazy(() => import('./pages/Publier').then((m) => ({ default: m.PublierPage })));
const VersionsPage = lazy(() => import('./pages/Versions').then((m) => ({ default: m.VersionsPage })));
const ReglagesPage = lazy(() => import('./pages/Reglages').then((m) => ({ default: m.ReglagesPage })));
const ActivitesPage = lazy(() => import('./pages/Activites').then((m) => ({ default: m.ActivitesPage })));
const UtilisateursPage = lazy(() => import('./pages/Utilisateurs').then((m) => ({ default: m.UtilisateursPage })));
const SantePage = lazy(() => import('./pages/Sante').then((m) => ({ default: m.SantePage })));
const JournalPage = lazy(() => import('./pages/Journal').then((m) => ({ default: m.JournalPage })));
const ProfilPage = lazy(() => import('./pages/Profil').then((m) => ({ default: m.ProfilPage })));

const FonctionsPage = lazy(() => import('./pages/Fonctions').then((m) => ({ default: m.FonctionsPage })));
const SecretsPage = lazy(() => import('./pages/Secrets').then((m) => ({ default: m.SecretsPage })));
const FormulairesPage = lazy(() => import('./pages/Formulaires').then((m) => ({ default: m.FormulairesPage })));
const ReglagesPlateformePage = lazy(() => import('./pages/ReglagesPlateforme').then((m) => ({ default: m.ReglagesPlateformePage })));
const EtatContext = createContext<Etat | null>(null);
export function useEtat(): Etat {
  const e = useContext(EtatContext);
  if (!e) throw new Error('État indisponible');
  return e;
}

export function useRefreshEtat() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['etat'] });
}

export function App() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { data, isLoading } = useQuery({ queryKey: ['etat'], queryFn: () => get<Etat>('/api/etat'), staleTime: 60_000 });

  useEffect(() => {
    if (data?.csrf) setCsrf(data.csrf);
  }, [data?.csrf]);

  useEffect(() => {
    onUnauthorized(() => {
      qc.invalidateQueries({ queryKey: ['etat'] });
      if (!location.pathname.startsWith('/connexion')) navigate('/connexion', { replace: true });
    });
  }, [qc, navigate, location.pathname]);

  if (isLoading || !data) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  let routes: ReactNode;
  if (data.installation) {
    routes = (
      <Routes>
        <Route path="*" element={<InstallationPage />} />
      </Routes>
    );
  } else if (!data.connecte) {
    routes = (
      <Routes>
        <Route path="/connexion" element={<ConnexionPage />} />
        <Route path="/invitation/:token" element={<InvitationPage />} />
        <Route path="*" element={<Navigate to="/connexion" replace />} />
      </Routes>
    );
  } else if (data.configurer2fa) {
    routes = (
      <Routes>
        <Route path="*" element={<Configurer2faPage />} />
      </Routes>
    );
  } else {
    routes = (
      <Shell>
        <Suspense fallback={<Center py="xl"><Loader /></Center>}>
        <Routes>
          <Route path="/" element={<TableauDeBordPage />} />
          <Route path="/sites/nouveau" element={<NouveauSitePage />} />
          <Route path="/sites/:id" element={<SitePage />} />
          <Route path="/sites/:id/contenus" element={<ContenusPage />} />
          <Route path="/sites/:id/contenus/:rubrique" element={<ContenusPage />} />
          <Route path="/sites/:id/medias" element={<MediasPage />} />
          <Route path="/sites/:id/fichiers" element={<FichiersPage />} />
          <Route path="/sites/:id/apercu" element={<ApercuPage />} />
          <Route path="/sites/:id/publier" element={<PublierPage />} />
          <Route path="/sites/:id/versions" element={<VersionsPage />} />
          <Route path="/sites/:id/reglages" element={<ReglagesPage />} />
          <Route path="/sites/:id/fonctions" element={<FonctionsPage />} />
          <Route path="/sites/:id/secrets" element={<SecretsPage />} />
          <Route path="/sites/:id/formulaires" element={<FormulairesPage />} />
          <Route path="/reglages" element={<ReglagesPlateformePage />} />
          <Route path="/activites" element={<ActivitesPage />} />
          <Route path="/utilisateurs" element={<UtilisateursPage />} />
          <Route path="/sante" element={<SantePage />} />
          <Route path="/journal" element={<JournalPage />} />
          <Route path="/profil" element={<ProfilPage />} />
          <Route path="/connexion" element={<Navigate to="/" replace />} />
          <Route path="/invitation/*" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </Shell>
    );
  }

  return (
    <EtatContext.Provider value={data}>
      {routes}
      {data.connecte && <ConfirmIdentity />}
    </EtatContext.Provider>
  );
}
