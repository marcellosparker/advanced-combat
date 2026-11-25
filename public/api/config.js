// Serves the public Supabase settings from Vercel environment variables.
// The anon key is meant to be public; row-level security protects the data.
module.exports = (req, res) => {
  const cfg = {
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
  };
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end('window.AC_CONFIG = ' + JSON.stringify(cfg) + ';');
};
