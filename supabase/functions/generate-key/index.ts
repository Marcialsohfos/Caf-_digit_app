// supabase/functions/generate-key/index.ts
//
// Rôle : usage interne (vous / votre équipe), PAS appelée depuis le site public.
// Crée une nouvelle clé d'accès pour un candidat sélectionné ou ayant payé,
// et (optionnel) lui envoie l'email via Resend si RESEND_API_KEY est configuré.
//
// Protégée par un secret admin passé dans l'en-tête "x-admin-secret".
// Déploiement : supabase functions deploy generate-key
// Appel (exemple) :
//   curl -X POST https://<projet>.supabase.co/functions/v1/generate-key \
//     -H "x-admin-secret: VOTRE_SECRET" -H "Content-Type: application/json" \
//     -d '{"email":"etudiant@example.com","tier":"premium"}'

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY"); // optionnel

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function generateKeyCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans caractères ambigus
  const block = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `CD-${block()}-${block()}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  if (req.headers.get("x-admin-secret") !== ADMIN_SECRET) {
    return json({ error: "Non autorisé." }, 401);
  }

  let body: { email?: string; tier?: string; expires_in_days?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Corps de requête invalide." }, 400);
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const tier = body.tier === "premium" ? "premium" : "standard";
  if (!email) return json({ error: "Email requis." }, 400);

  const expiresAt = body.expires_in_days
    ? new Date(Date.now() + body.expires_in_days * 86400000).toISOString()
    : null;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const keyCode = generateKeyCode();

  const { data, error } = await admin
    .from("access_keys")
    .insert({ key_code: keyCode, email, tier, expires_at: expiresAt })
    .select()
    .single();

  if (error) return json({ error: "Impossible de créer la clé.", details: error.message }, 500);

  // Envoi optionnel de l'email via Resend
  if (RESEND_API_KEY) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Café_digit <onboarding@cafedigit.app>", // à remplacer par votre domaine vérifié
          to: email,
          subject: "Votre clé d'accès Café_digit",
          html: `<p>Bienvenue sur Café_digit !</p>
                 <p>Votre clé d'accès personnelle : <b>${keyCode}</b></p>
                 <p>Connectez-vous avec cette clé et votre adresse email (${email}) sur la plateforme.</p>`,
        }),
      });
    } catch (_e) {
      // On ne bloque pas la création de la clé si l'email échoue ; à surveiller en logs.
    }
  }

  return json({ key_code: keyCode, email, tier, id: data.id });
});
