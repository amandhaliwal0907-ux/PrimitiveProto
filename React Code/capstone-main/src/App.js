import { useState, useEffect, useRef } from "react";
import "./App.css";
import Auth from "./Auth";
import { supabase } from "./supabaseClient";
import { extractFileText } from "./fileUtils";
import ConversationAgent from "./ConversationAgent";
import SyncedPlayer from "./SyncedPlayer";

const SUPABASE_FUNCTIONS_URL = "https://javlnpnawmfpypapauyc.supabase.co/functions/v1";

const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 30;

const VOICE_OPTIONS = [
  { value: "Mark",     label: "Mark — Neutral male" },
  { value: "Maya",     label: "Maya — Warm female" },
  { value: "James",    label: "James — Deep & authoritative" },
  { value: "Eleanor",  label: "Eleanor — Clear & professional" },
  { value: "Lara",     label: "Lara — Soft & calm" },
  { value: "Noah",     label: "Noah — Friendly & upbeat" },
  { value: "Rachel",   label: "Rachel — Conversational female" },
  { value: "Frank",    label: "Frank — Gruff & direct" },
  { value: "Ella",     label: "Ella — Bright & energetic" },
  { value: "Benjamin", label: "Benjamin — Measured & thoughtful" },
];

const getAuthToken = async () => {
  const session = await supabase.auth.getSession();
  return session.data.session?.access_token ?? "";
};

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [activeDraft, setActiveDraft] = useState(null);
  const [approvedScripts, setApprovedScripts] = useState([]);

  const [videoStates, setVideoStates] = useState({});
  const [audioStates, setAudioStates] = useState({});
  const [selectedVoices, setSelectedVoices] = useState({});

  const pollTimers = useRef({});

  // -------------------------------
  // Auth Session
  // -------------------------------
  useEffect(() => {
    const fetchSession = async () => {
      const { data } = await supabase.auth.getSession();
      setUser(data.session?.user || null);
      setLoading(false);
    };
    fetchSession();
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => setUser(session?.user || null)
    );
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    return () => { Object.values(pollTimers.current).forEach(clearInterval); };
  }, []);

  // -------------------------------
  // Fetch Drafts
  // -------------------------------
  const fetchDrafts = async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from("draft_scripts").select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (error) { console.error("Error fetching drafts:", error); return; }
    setDrafts(data || []);
  };

  useEffect(() => { fetchDrafts(); }, [user]);

  // -------------------------------
  // Fetch Approved Scripts
  // -------------------------------
  const fetchApprovedScripts = async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from("approved_scripts").select("*")
      .eq("user_id", user.id)
      .not("approved_script", "is", null)
      .order("created_at", { ascending: false });
    if (error) { console.error("Error fetching approved scripts:", error); return; }
    setApprovedScripts(data || []);
  };

  useEffect(() => { fetchApprovedScripts(); }, [user]);

  // Initialise states from DB on load
  useEffect(() => {
    if (!approvedScripts.length) return;

    setVideoStates((prev) => {
      const next = { ...prev };
      approvedScripts.forEach((a) => {
        if (!next[a.id]) {
          next[a.id] = {
            phase: a.video_status === "generated" ? "done"
              : a.video_status === "processing" ? "polling"
              : a.video_status === "failed" ? "failed"
              : "idle",
            progress: a.video_status === "generated" ? 100 : 0,
            error: null,
          };
        }
      });
      return next;
    });

    setAudioStates((prev) => {
      const next = { ...prev };
      approvedScripts.forEach((a) => {
        if (!next[a.id]) {
          next[a.id] = {
            phase: a.audio_status === "generated" ? "done"
              : a.audio_status === "failed" ? "failed"
              : "idle",
            error: null,
          };
        }
      });
      return next;
    });
  }, [approvedScripts]);

  // Resume polling for in-progress video generations after page refresh
  useEffect(() => {
    approvedScripts.forEach((a) => {
      const vs = videoStates[a.id];
      if (vs?.phase === "polling" && a.runway_task_id && !pollTimers.current[a.id]) {
        startPolling(a.id, a.runway_task_id);
      }
    });
  }, [videoStates, approvedScripts]);

  // -------------------------------
  // Upload file + create checklist
  // -------------------------------
  const uploadFileToBucket = async () => {
    if (!file) { alert("Select a file first"); return null; }
    const filePath = `uploads/${Date.now()}-${file.name}`;
    const { error: storageError } = await supabase.storage
      .from("checklists").upload(filePath, file, { upsert: true });
    if (storageError) { alert(storageError.message); return null; }
    const { data: checklist, error: checklistError } = await supabase
      .from("checklists")
      .insert([{ file_name: file.name, file_url: filePath }])
      .select().single();
    if (checklistError) { alert(checklistError.message); return null; }
    return checklist;
  };

  // -------------------------------
  // Generate Script
  // -------------------------------
  const generateScript = async () => {
    if (!file) { alert("Select checklist first"); return; }
    try {
      const checklist = await uploadFileToBucket();
      if (!checklist?.id) { alert("Checklist creation failed"); return; }
      const text = await extractFileText(file);
      const token = await getAuthToken();
      const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/swift-responder`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) { alert("Script generation failed"); return; }
      const data = await response.json();
      if (!data.script) { alert("No script returned"); return; }
      const { data: newDraftArray, error: draftError } = await supabase
        .from("draft_scripts")
        .insert([{
          user_id: user.id,
          primitive_id: checklist.id,
          script_text: data.script,
          primitive_draft: data.primitiveDraft || {},
          primitive_status: "draft",
          script_status: "draft",
          workflow_state: "primitive_clarification",
        }]).select();
      if (draftError) { alert("Failed to save draft: " + draftError.message); return; }
      const newDraft = newDraftArray?.[0];
      if (!newDraft) { alert("Draft creation failed"); return; }
      await fetchDrafts();
      setActiveDraft(newDraft);
      setFile(null);
      alert("Script generated successfully.");
    } catch (err) {
      console.error("Error generating script:", err);
      alert("Error generating script.");
    }
  };

  // -------------------------------
  // Generate Video
  // -------------------------------
  const generateVideoFromApproved = async (approved) => {
    const scriptId = approved.id;
    setVideoStates((prev) => ({ ...prev, [scriptId]: { phase: "starting", progress: 0, error: null } }));
    try {
      const token = await getAuthToken();
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/generate-video`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ approvedScript: approved.approved_script, approvedScriptId: scriptId }),
      });
      if (!res.ok) throw new Error("Failed to start video generation");
      const { taskId } = await res.json();
      if (!taskId) throw new Error("No task ID returned");
      setVideoStates((prev) => ({ ...prev, [scriptId]: { phase: "polling", progress: 5, error: null } }));
      startPolling(scriptId, taskId);
    } catch (err) {
      console.error("Video generation error:", err);
      setVideoStates((prev) => ({ ...prev, [scriptId]: { phase: "failed", progress: 0, error: err.message } }));
    }
  };

  const startPolling = (scriptId, taskId) => {
    if (pollTimers.current[scriptId]) return;
    let attempts = 0;
    const poll = async () => {
      attempts++;
      if (attempts > MAX_POLL_ATTEMPTS) {
        stopPolling(scriptId);
        setVideoStates((prev) => ({ ...prev, [scriptId]: { phase: "failed", progress: 0, error: "Generation timed out." } }));
        return;
      }
      try {
        const token = await getAuthToken();
        const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/poll-video-status`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ taskId, approvedScriptId: scriptId }),
        });
        if (!res.ok) return;
        const data = await res.json();
        const progress = Math.round((data.progress ?? 0) * 100);
        if (data.status === "SUCCEEDED") {
          stopPolling(scriptId);
          setVideoStates((prev) => ({ ...prev, [scriptId]: { phase: "done", progress: 100, error: null } }));
          await fetchApprovedScripts();
          return;
        }
        if (data.status === "FAILED" || data.status === "CANCELLED") {
          stopPolling(scriptId);
          setVideoStates((prev) => ({ ...prev, [scriptId]: { phase: "failed", progress: 0, error: data.error || "Failed." } }));
          return;
        }
        setVideoStates((prev) => ({ ...prev, [scriptId]: { phase: "polling", progress: Math.max(5, progress), error: null } }));
      } catch (err) { console.error("Polling error:", err); }
    };
    poll();
    pollTimers.current[scriptId] = setInterval(poll, POLL_INTERVAL_MS);
  };

  const stopPolling = (scriptId) => {
    if (pollTimers.current[scriptId]) {
      clearInterval(pollTimers.current[scriptId]);
      delete pollTimers.current[scriptId];
    }
  };

  // -------------------------------
  // Generate Audio (Voiceover)
  // -------------------------------
  const generateAudioFromApproved = async (approved) => {
    const scriptId = approved.id;
    const presetId = selectedVoices[scriptId] || VOICE_OPTIONS[0].value;
    setAudioStates((prev) => ({ ...prev, [scriptId]: { phase: "generating", error: null } }));
    try {
      const token = await getAuthToken();
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/generate-audio`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({
          approvedScript: approved.approved_script,
          approvedScriptId: scriptId,
          presetId,
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error("generate-audio error:", errText);
        throw new Error("Audio generation failed");
      }
      const { audioUrl } = await res.json();
      if (!audioUrl) throw new Error("No audio URL returned");
      setAudioStates((prev) => ({ ...prev, [scriptId]: { phase: "done", error: null } }));
      await fetchApprovedScripts();
    } catch (err) {
      console.error("Audio generation error:", err);
      setAudioStates((prev) => ({ ...prev, [scriptId]: { phase: "failed", error: err.message } }));
    }
  };

  // -------------------------------
  // Toggle Draft
  // -------------------------------
  const toggleDraft = async (draft) => {
    if (activeDraft?.id === draft.id) { setActiveDraft(null); return; }
    const { data: latestDraft, error } = await supabase
      .from("draft_scripts").select("*")
      .eq("id", draft.id).eq("user_id", user.id).single();
    if (error || !latestDraft) { console.error("Draft not found:", error); return; }
    setActiveDraft({ ...latestDraft, enhanced_primitive: latestDraft.enhanced_primitive || null });

    const isPrimitiveEmpty = (obj) =>
      !obj || !Object.values(obj).some((v) => (Array.isArray(v) ? v.length > 0 : !!v));

    if (isPrimitiveEmpty(latestDraft.enhanced_primitive)) {
      try {
        setActiveDraft((prev) => prev ? { ...prev, enhancing: true } : prev);
        const token = await getAuthToken();
        const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/swift-responder`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ primitive: latestDraft.primitive_draft }),
        });
        if (!res.ok) { setActiveDraft((prev) => prev ? { ...prev, enhancing: false } : prev); return; }
        const data = await res.json();
        const enhancedPrimitive = data.primitive || {};
        await supabase.from("draft_scripts").update({ enhanced_primitive: enhancedPrimitive })
          .eq("id", draft.id).eq("user_id", user.id);
        setDrafts((prev) => prev.map((d) => d.id === draft.id ? { ...d, enhanced_primitive: enhancedPrimitive } : d));
        setActiveDraft((prev) => prev ? { ...prev, enhanced_primitive: enhancedPrimitive, enhancing: false } : prev);
      } catch (err) {
        console.error("Error enhancing primitive:", err);
        setActiveDraft((prev) => prev ? { ...prev, enhancing: false } : prev);
      }
    }
  };

  // -------------------------------
  // Render Media Section
  // -------------------------------
  const renderMediaSection = (approved) => {
    const vs = videoStates[approved.id] || { phase: "idle", progress: 0, error: null };
    const as = audioStates[approved.id] || { phase: "idle", error: null };
    const presetId = selectedVoices[approved.id] || VOICE_OPTIONS[0].value;

    const videoReady = vs.phase === "done" && approved.video_url;
    const audioReady = as.phase === "done" && approved.audio_url;
    const isVideoGenerating = vs.phase === "starting" || vs.phase === "polling";
    const isAudioGenerating = as.phase === "generating";

    return (
      <div className="media-section">

        {/* Synced player + download links — shown when both are ready */}
        {videoReady && audioReady && (
          <div className="synced-player-wrapper">
            <h4 className="explainer-title">📽 Explainer Video</h4>
            <SyncedPlayer videoUrl={approved.video_url} audioUrl={approved.audio_url} />
            <div className="download-links">
              <a
                className="download-link-btn"
                href={approved.video_url}
                target="_blank"
                rel="noopener noreferrer"
                download
              >
                ⬇ Download Video
              </a>
              <a
                className="download-link-btn secondary"
                href={approved.audio_url}
                target="_blank"
                rel="noopener noreferrer"
                download
              >
                ⬇ Download Audio
              </a>
            </div>
          </div>
        )}

        {/* Individual controls — shown until both are ready */}
        {!(videoReady && audioReady) && (
          <div className="generation-controls">

            {/* Video block */}
            <div className="gen-block">
              <p className="gen-block-label">🎬 Video</p>

              {videoReady && <p className="gen-ready">✓ Video ready — generate voiceover to combine</p>}

              {isVideoGenerating && (
                <div className="video-progress-wrapper">
                  <div className="video-progress-label">
                    {vs.phase === "starting" ? "Starting…" : `Generating video… ${vs.progress}%`}
                  </div>
                  <div className="video-progress-track">
                    <div className="video-progress-bar" style={{ width: `${vs.progress}%` }} />
                  </div>
                  <p className="video-progress-hint">Runway typically takes 1–3 minutes.</p>
                </div>
              )}

              {vs.phase === "failed" && (
                <div className="video-error">
                  <span>⚠ {vs.error}</span>
                  <button className="secondary-btn retry-btn"
                    onClick={() => setVideoStates((prev) => ({ ...prev, [approved.id]: { phase: "idle", progress: 0, error: null } }))}>
                    Retry
                  </button>
                </div>
              )}

              {!videoReady && !isVideoGenerating && (
                <button
                  className="primary-btn"
                  disabled={isVideoGenerating || !approved.approved_script}
                  onClick={() => generateVideoFromApproved(approved)}
                >
                  {vs.phase === "failed" ? "Retry Video" : "Generate Video"}
                </button>
              )}
            </div>

            {/* Audio block */}
            <div className="gen-block">
              <p className="gen-block-label">🎙 Voiceover</p>

              {audioReady && <p className="gen-ready">✓ Voiceover ready — generate video to combine</p>}

              {isAudioGenerating && (
                <div className="audio-generating">
                  <span className="audio-spinner">⏳</span> Generating voiceover… (~15–30 seconds)
                </div>
              )}

              {as.phase === "failed" && (
                <div className="video-error">
                  <span>⚠ {as.error}</span>
                  <button className="secondary-btn retry-btn"
                    onClick={() => setAudioStates((prev) => ({ ...prev, [approved.id]: { phase: "idle", error: null } }))}>
                    Retry
                  </button>
                </div>
              )}

              {!audioReady && !isAudioGenerating && (
                <div className="audio-controls">
                  <select
                    className="voice-select"
                    value={presetId}
                    disabled={isAudioGenerating}
                    onChange={(e) => setSelectedVoices((prev) => ({ ...prev, [approved.id]: e.target.value }))}
                  >
                    {VOICE_OPTIONS.map((v) => (
                      <option key={v.value} value={v.value}>{v.label}</option>
                    ))}
                  </select>
                  <button
                    className="secondary-btn"
                    disabled={isAudioGenerating || !approved.approved_script}
                    onClick={() => generateAudioFromApproved(approved)}
                  >
                    🎙 Generate Voiceover
                  </button>
                </div>
              )}
            </div>

          </div>
        )}

      </div>
    );
  };

  // -------------------------------
  // Rendering
  // -------------------------------
  if (loading) return <div>Loading...</div>;
  if (!user) return <Auth setUser={setUser} />;

  return (
    <div className="dashboard-container">
      <div className="top-header sticky-header">
        <h3>Welcome, {user.email}</h3>
        <button className="secondary-btn" onClick={() => supabase.auth.signOut()}>Logout</button>
      </div>

      <div className="dashboard">
        <div className="left-panel">
          <div className="card upload-section">
            <h3>Upload Checklist</h3>
            <input type="file" onChange={(e) => setFile(e.target.files[0])} />
            <button className="primary-btn" onClick={generateScript}>Generate Script</button>
          </div>

          <div className="draft-list">
            <h3>Your Drafts</h3>
            {drafts.length === 0 && <p>No drafts yet.</p>}
            {drafts.map((d) => (
              <div key={d.id} className="draft-card">
                <p><strong>Script Status:</strong> {d.script_status}</p>
                <p>{d.script_text}</p>
                <button className="secondary-btn" onClick={() => toggleDraft(d)}>
                  {activeDraft?.id === d.id ? "Close Draft" : "Open Draft"}
                </button>
                {d.workflow_state === "video_ready" && (
                  <span className="video-ready"> Approved primitive for final script</span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="right-panel">
          {activeDraft && (
            <div className="active-draft-panel">
              <div className="card primitive-panel">
                <h3>Original Primitive</h3>
                <pre>{JSON.stringify(activeDraft.primitive_draft, null, 2)}</pre>
              </div>
              <div className="card enhanced-panel">
                <h3>Enhanced Primitive</h3>
                <pre>{JSON.stringify(activeDraft.enhanced_primitive, null, 2)}</pre>
              </div>
              {!activeDraft.chatStarted && (
                <div style={{ display: "flex", gap: "12px", marginTop: "12px" }}>
                  <button className="primary-btn"
                    onClick={() => setActiveDraft((prev) => ({ ...prev, chatStarted: true }))}>
                    Start Chat
                  </button>
                  <button className="secondary-btn" onClick={() => setActiveDraft(null)}>Close Draft</button>
                </div>
              )}
              {activeDraft.chatStarted && (
                <ConversationAgent
                  draft={activeDraft}
                  refresh={async () => {
                    await fetchDrafts();
                    await fetchApprovedScripts();
                    setActiveDraft(null);
                  }}
                />
              )}
            </div>
          )}

          <div className="approved-scripts">
            <h3>Approved Scripts History</h3>
            {approvedScripts.length === 0 && <p>No approved scripts yet.</p>}
            {approvedScripts.map((a, index) => (
              <div key={a.id} className="approved-script-card">
                <h4>
                  Approved Script {approvedScripts.length - index}
                  {a.version_number ? ` (v${a.version_number})` : ""}
                </h4>
                <pre className="script-content">{a.approved_script}</pre>
                {renderMediaSection(a)}
              </div>
            ))}
          </div>

          {!activeDraft && approvedScripts.length === 0 && (
            <p>Select a draft to view details and start conversation.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;