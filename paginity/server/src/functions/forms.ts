import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import Busboy from 'busboy';
import type { Ctx } from '../context.js';
import type { SiteRow } from '../sites/service.js';
import { now, randomId, UserError } from '../lib/util.js';
import { raiseAlert } from '../lib/alerts.js';

/**
 * Module « formulaires » : remplace les formulaires Netlify (attribut data-netlify="true") sans modifier le site.
 * Seuls les formulaires déclarés dans les pages publiées sont acceptés. Le champ piège (honeypot) écarte les robots.
 * Les messages sont chiffrés dans la base (données personnelles) et visibles dans PAGINITY ; e-mail de notification possible.
 */

export interface DeclaredForm {
  nom: string;
  piege: string | null;
  champs: string[];
}

/** Repère les formulaires Netlify dans les pages HTML d'une version. */
export function scanForms(outDir: string): DeclaredForm[] {
  const forms = new Map<string, DeclaredForm>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(p);
      else if (e.isFile() && /\.html?$/i.test(e.name) && fs.statSync(p).size < 3_000_000) {
        const html = fs.readFileSync(p, 'utf8');
        for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
          const attrs = m[1];
          if (!/\b(data-netlify\s*=\s*["']?true|netlify\b(?!-))/i.test(attrs)) continue;
          const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
          if (!name) continue;
          const piege = /\bnetlify-honeypot\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? null;
          const champs = [...m[2].matchAll(/<(?:input|textarea|select)\b[^>]*\bname\s*=\s*["']([^"']+)["']/gi)].map((x) => x[1]).filter((n) => n !== 'form-name' && n !== piege);
          const prev = forms.get(name);
          forms.set(name, { nom: name, piege, champs: [...new Set([...(prev?.champs ?? []), ...champs])] });
        }
      }
    }
  };
  if (fs.existsSync(outDir)) walk(outDir);
  return [...forms.values()];
}

const recent = new Map<string, number[]>();
function rateLimited(key: string): boolean {
  const t = now();
  const list = (recent.get(key) ?? []).filter((x) => t - x < 60_000);
  list.push(t);
  recent.set(key, list);
  if (recent.size > 5000) recent.clear();
  return list.length > 10;
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    let bb: Busboy.Busboy;
    try {
      bb = Busboy({ headers: req.headers, limits: { fieldSize: 20_000, fields: 60, files: 0, fileSize: 0 } });
    } catch {
      return reject(new UserError(400, 'Formulaire illisible.'));
    }
    bb.on('field', (name, val) => {
      if (Object.keys(fields).length < 60) fields[name.slice(0, 100)] = val.slice(0, 20_000);
    });
    bb.on('file', (_n, stream) => stream.resume());
    bb.on('close', () => resolve(fields));
    bb.on('error', () => reject(new UserError(400, 'Formulaire illisible.')));
    req.pipe(bb);
  });
}

export function isFormPost(req: http.IncomingMessage): boolean {
  const ct = String(req.headers['content-type'] ?? '');
  return req.method === 'POST' && (ct.startsWith('application/x-www-form-urlencoded') || ct.startsWith('multipart/form-data'));
}

/** Traite l'envoi d'un formulaire. Renvoie faux si ce n'est pas un formulaire déclaré (la requête suit alors son cours). */
export async function handleFormPost(ctx: Ctx, site: SiteRow, forms: DeclaredForm[], req: http.IncomingMessage, res: http.ServerResponse, ip: string): Promise<void> {
  const fields = await parseBody(req);
  const formName = fields['form-name'];
  const form = forms.find((f) => f.nom === formName);
  const wantsJson = String(req.headers.accept ?? '').includes('application/json');
  const ok = () => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (wantsJson || url.pathname === '/') {
      // Envoi en arrière-plan (JavaScript) ou sans page de remerciement : réponse simple.
      if (wantsJson) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>Merci</title><p>Merci, votre message a bien été envoyé.</p>');
      }
    } else {
      res.writeHead(303, { Location: url.pathname + url.search }).end();
    }
  };
  if (!form) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Formulaire inconnu.');
    return;
  }
  // Robot : on fait comme si tout allait bien, sans rien enregistrer.
  if (form.piege && fields[form.piege]) return ok();
  if (rateLimited(`${site.id}:${ip}`)) {
    res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' }).end('Trop d’envois. Réessayez dans une minute.');
    return;
  }
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) if (k !== 'form-name' && k !== form.piege) data[k] = v;
  const id = randomId('f');
  ctx.db.prepare('INSERT INTO form_submissions (id, site_id, form, at, data_enc) VALUES (?, ?, ?, ?, ?)').run(id, site.id, form.nom, now(), ctx.vault.encrypt(JSON.stringify(data)));
  const to = (site as SiteRow & { notify_email?: string | null }).notify_email;
  if (to && ctx.mailer?.configured()) {
    const text = Object.entries(data)
      .map(([k, v]) => `${k} : ${v}`)
      .join('\n');
    void ctx.mailer.send(to, `${site.name} — nouveau message (${form.nom})`, `${text}\n\n— Reçu par PAGINITY`).catch((e) => {
      raiseAlert(ctx, 'attention', `Notification du formulaire « ${form.nom} » (${site.name}) non envoyée : ${(e as Error).message}`, site.id);
    });
  } else {
    raiseAlert(ctx, 'information', `Nouveau message reçu par le formulaire « ${form.nom} » du site « ${site.name} ».`, site.id);
  }
  ok();
}

export function listSubmissions(ctx: Ctx, siteId: string) {
  const rows = ctx.db.prepare('SELECT id, form, at, data_enc, read_at FROM form_submissions WHERE site_id = ? ORDER BY at DESC LIMIT 500').all(siteId) as {
    id: string;
    form: string;
    at: number;
    data_enc: string;
    read_at: number | null;
  }[];
  return rows.map((r) => ({ id: r.id, formulaire: r.form, le: r.at, lu: !!r.read_at, donnees: JSON.parse(ctx.vault.decrypt(r.data_enc)) as Record<string, string> }));
}

export function pruneSubmissions(ctx: Ctx, retentionDays = 365): void {
  ctx.db.prepare('DELETE FROM form_submissions WHERE at < ?').run(now() - retentionDays * 86_400_000);
}
