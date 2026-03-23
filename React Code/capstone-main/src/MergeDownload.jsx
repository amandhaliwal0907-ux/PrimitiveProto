// src/MergeDownload.jsx
// Calls the merge-media edge function to combine video + audio server-side,
// then downloads the resulting merged .mp4.

import { useState } from "react";
import { supabase } from "./supabaseClient";

const SUPABASE_FUNCTIONS_URL = "https://javlnpnawmfpypapauyc.supabase.co/functions/v1";

const getAuthToken = async () => {
  const session = await supabase.auth.getSession();
  return session.data.session?.access_token ?? "";
};

export default function MergeDownload({ videoUrl, audioUrl, approvedScriptId, fileName = "explainer" }) {
  const [status, setStatus] = useState("idle"); // idle | merging | done | error
  const [errorMsg, setErrorMsg] = useState("");

  const handleMerge = async () => {
    setStatus("merging");
    setErrorMsg("");

    try {
      const token = await getAuthToken();

      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/merge-media`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ videoUrl, audioUrl, approvedScriptId }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("merge-media error:", errText);
        throw new Error("Merge failed on server");
      }

      const { mergedUrl } = await res.json();
      if (!mergedUrl) throw new Error("No merged URL returned");

      // Trigger download
      const a = document.createElement("a");
      a.href = mergedUrl;
      a.download = `${fileName}.mp4`;
      a.target = "_blank";
      a.click();

      setStatus("done");
    } catch (err) {
      console.error("Merge error:", err);
      setErrorMsg(err.message || "Merge failed");
      setStatus("error");
    }
  };

  const label = {
    idle:    "⬇ Download Combined Video",
    merging: "Merging video + audio…",
    done:    "✓ Downloaded",
    error:   "Retry Download",
  }[status];

  const isWorking = status === "merging";

  return (
    <div className="merge-download-wrapper">
      {status === "error" && (
        <p className="merge-error">⚠ {errorMsg}</p>
      )}

      <button
        className="primary-btn merge-download-btn"
        disabled={isWorking || status === "done"}
        onClick={handleMerge}
      >
        {isWorking && <span className="merge-spinner" />}
        {label}
      </button>

      {isWorking && (
        <p className="merge-hint">This takes about 15–30 seconds…</p>
      )}
    </div>
  );
}
