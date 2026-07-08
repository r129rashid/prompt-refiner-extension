// Promptify Free tier config. Fill these in after deploying the backend
// (see supabase/DEPLOY.md). Until then the free tier stays hidden and the
// extension works exactly as before in bring-your-own-key mode.
//
// The anon key is safe to expose — it only permits operations the row-level
// security policies allow (own-row reads); credits are mutated server-side only.
const PF_SUPABASE_URL = 'https://YOUR_PROJECT_REF.supabase.co';
const PF_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
const PF_LANDING = 'https://r129rashid.github.io/prompt-refiner-extension';

const PF_ENABLED = !PF_SUPABASE_URL.includes('YOUR_PROJECT_REF');
