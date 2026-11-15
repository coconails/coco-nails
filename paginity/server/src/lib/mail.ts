import nodemailer from 'nodemailer';
import type { Ctx } from '../context.js';
import { getSetting, setSetting } from '../db.js';
import { UserError } from './util.js';

/**
 * Envoi d'e-mails (alertes, formulaires) par un serveur SMTP : par exemple Google Workspace
 * (smtp.gmail.com, port 465, avec un « mot de passe d'application »). Le mot de passe est chiffré dans le coffre.
 */
export interface MailSettings {
  hote: string;
  port: number;
  securise: boolean;
  utilisateur: string;
  expediteur: string;
  destinataireAlertes: string;
  motDePasseDefini: boolean;
}

export class Mailer {
  constructor(private ctx: Ctx) {}

  settings(): MailSettings {
    const raw = getSetting(this.ctx.db, 'smtp');
    const s = raw ? JSON.parse(raw) : {};
    return {
      hote: s.hote ?? '',
      port: s.port ?? 465,
      securise: s.securise ?? true,
      utilisateur: s.utilisateur ?? '',
      expediteur: s.expediteur ?? '',
      destinataireAlertes: s.destinataireAlertes ?? '',
      motDePasseDefini: !!getSetting(this.ctx.db, 'smtp_mdp'),
    };
  }

  save(input: Partial<MailSettings> & { motDePasse?: string }): void {
    const cur = this.settings();
    const next = {
      hote: String(input.hote ?? cur.hote).trim(),
      port: Number(input.port ?? cur.port) || 465,
      securise: input.securise ?? cur.securise,
      utilisateur: String(input.utilisateur ?? cur.utilisateur).trim(),
      expediteur: String(input.expediteur ?? cur.expediteur).trim(),
      destinataireAlertes: String(input.destinataireAlertes ?? cur.destinataireAlertes).trim(),
    };
    for (const e of [next.expediteur, next.destinataireAlertes]) {
      if (e && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e)) throw new UserError(400, `Adresse e-mail invalide : ${e}`);
    }
    if (next.hote && !/^[a-z0-9.-]+$/i.test(next.hote)) throw new UserError(400, 'Nom de serveur invalide.');
    setSetting(this.ctx.db, 'smtp', JSON.stringify(next));
    if (typeof input.motDePasse === 'string' && input.motDePasse) setSetting(this.ctx.db, 'smtp_mdp', this.ctx.vault.encrypt(input.motDePasse));
  }

  configured(): boolean {
    const s = this.settings();
    return !!(s.hote && s.expediteur);
  }

  private transport() {
    const s = this.settings();
    const enc = getSetting(this.ctx.db, 'smtp_mdp');
    return nodemailer.createTransport({
      host: s.hote,
      port: s.port,
      secure: s.securise,
      auth: s.utilisateur ? { user: s.utilisateur, pass: enc ? this.ctx.vault.decrypt(enc) : '' } : undefined,
      connectionTimeout: 15_000,
      tls: process.env.PAGINITY_SMTP_TLS_NON_VERIFIE === 'oui' ? { rejectUnauthorized: false } : undefined,
    });
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    if (!this.configured()) throw new UserError(400, 'L’envoi d’e-mails n’est pas configuré (Réglages de la plateforme).');
    const s = this.settings();
    await this.transport().sendMail({ from: `PAGINITY <${s.expediteur}>`, to, subject, text });
  }

  async sendAlert(subject: string, text: string): Promise<void> {
    const to = this.settings().destinataireAlertes;
    if (!to) return;
    await this.send(to, subject, text);
  }
}
