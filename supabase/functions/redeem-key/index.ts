// supabase/functions/redeem-key/index.ts
//
// Rôle : reçoit { key, email } depuis le formulaire de connexion du frontend,
// vérifie la clé dans la table access_keys, puis renvoie une VRAIE session
// Supabase Auth (access_token / refresh_token) sans mot de passe ni email à cliquer.
//
// Déploiement : supabase functions deploy redeem-key
// Doit être appelée en POST, sans authentification préalable (public).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  let body: { key?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Corps de requête invalide." }, 400);
  }

  const key = (body.key ?? "").trim().toUpperCase();
  const email = (body.email ?? "").trim().toLowerCase();

  if (!key || !email) {
    return json({ error: "Clé et email sont requis." }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 1. Vérifier la clé
  const { data: keyRow, error: keyErr } = await admin
    .from("access_keys")
    .select("*")
    .eq("key_code", key)
    .eq("email", email)
    .neq("status", "revoked")
    .maybeSingle();

  if (keyErr) return json({ error: "Erreur serveur (clé)." }, 500);
  if (!keyRow) {
    return json({ error: "Clé invalide ou email ne correspondant pas." }, 401);
  }
  if (keyRow.expires_at && new Date(keyRow.expires_at) < new Date()) {
    return json({ error: "Cette clé d'accès a expiré. Contactez Café_digit." }, 401);
  }

  // 2. Trouver ou créer l'utilisateur Supabase Auth correspondant
  let userId: string;
  const { data: existingProfile } = await admin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (existingProfile) {
    userId = existingProfile.id;
  } else {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (createErr || !created.user) {
      return json({ error: "Impossible de créer le compte utilisateur." }, 500);
    }
    userId = created.user.id;
  }

  // 3. Générer un lien magique puis l'échanger immédiatement contre une session
  //    (l'utilisateur n'a pas besoin de cliquer sur un email : on fait l'échange nous-mêmes)
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr || !linkData) {
    return json({ error: "Impossible de générer la session." }, 500);
  }

  const tokenHash =
    (linkData.properties as any)?.hashed_token ?? (linkData as any)?.hashed_token;
  if (!tokenHash) {
    return json({ error: "Session non disponible (hashed_token manquant)." }, 500);
  }

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: verifyData, error: verifyErr } = await anon.auth.verifyOtp({
    token_hash: tokenHash,
    type: "magiclink",
  });
  if (verifyErr || !verifyData.session) {
    return json({ error: "Échec de l'authentification." }, 500);
  }

  // 4. Mettre à jour le tier du profil selon la clé, et marquer la clé comme utilisée
  await admin.from("profiles").upsert({ id: userId, email, tier: keyRow.tier });

  if (keyRow.status === "issued") {
    await admin
      .from("access_keys")
      .update({ status: "redeemed", redeemed_at: new Date().toISOString() })
      .eq("id", keyRow.id);
  }

  return json({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
    user: { id: userId, email, tier: keyRow.tier },
  });
});
