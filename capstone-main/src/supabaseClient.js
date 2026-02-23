import { createClient } from '@supabase/supabase-js';

const supabaseUrl = "https://javlnpnawmfpypapauyc.supabase.co";
const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphdmxucG5hd21mcHlwYXBhdXljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEwMTc0NjYsImV4cCI6MjA4NjU5MzQ2Nn0.CRMLyzYeNyoIZFqd1vJrUxuju9fWguQlM0Em6_z5jh8";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

