import { supabase } from "./supabaseClient";

export async function fetchConfidence(data) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  const response = await fetch(
    "https://javlnpnawmfpypapauyc.supabase.co/functions/v1/check-confidence",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        script_text: data.script_text,
        document_text: data.document_text,
      }),
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Confidence request failed");
  }

  return result;
}