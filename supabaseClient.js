
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.1";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./env.js";

export const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

export function supabaseReady(){
  return !!supabase;
}
