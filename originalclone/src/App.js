//Updated App.js, includes confidence checking 
import { useState, useEffect } from "react";
import "./App.css";
import Auth from "./Auth";
import { supabase } from "./supabaseClient";
import { extractFileText } from "./fileUtils";
import ConversationAgent from "./ConversationAgent";
import { fetchConfidence } from "./api"; // helper to call backend confidence API

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [activeDraft, setActiveDraft] = useState(null);
  const [approvedScripts, setApprovedScripts] = useState([]);
  const [showApprovedModal, setShowApprovedModal] = useState(false);

  // Confidence state
  const [confidenceResult, setConfidenceResult] = useState(null);
  const [confidenceLoading, setConfidenceLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [selectedDraft, setSelectedDraft] = useState(null);

  // Per-script generation state
  // phase: "idle" | "generating" | "done" | "failed"
  const [explainerStates, setExplainerStates] = useState({});
  // Per-script voice selection
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
  const fetchDrafts = async (removeDraftId = null) => {
    if (!user) return;
    const { data, error } = await supabase
      .from("draft_scripts").select("*")
      .eq("primitive_status", "draft").eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (error) { console.error("Error fetching drafts:", error); return; }
    let updatedDrafts = data || [];
    if (removeDraftId) updatedDrafts = updatedDrafts.filter((d) => d.id !== removeDraftId);
    setDrafts(updatedDrafts);
  };

  useEffect(() => { fetchDrafts(); }, [user]);

  // -------------------------------
  // Fetch Approved Scripts
  // -------------------------------
  const fetchApprovedScripts = async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from("primitives").select("*")
      .eq("user_id", user.id)
      .not("approved_script", "is", null)
      .neq("approved_script", "")
      .order("created_at", { ascending: false });
    if (error) { console.error("Error fetching approved scripts:", error); return; }
    setApprovedScripts(data || []);
  };

  useEffect(() => { fetchApprovedScripts(); }, [user]);

  // Initialise explainer states from DB on load
  useEffect(() => {
    if (!approvedScripts.length) return;
    setExplainerStates((prev) => {
      const next = { ...prev };
      approvedScripts.forEach((a) => {
        if (!next[a.id]) {
          const videoReady = a.video_status === "generated" && a.video_url;
          const audioReady = a.audio_status === "generated" && a.audio_url;
          const videoProcessing = a.video_status === "processing";
          next[a.id] = {
            phase: videoReady && audioReady ? "done"
              : videoProcessing ? "polling"
              : a.video_status === "failed" ? "failed"
              : "idle",
            videoProgress: videoReady ? 100 : 0,
            videoReady: !!videoReady,
            audioReady: !!audioReady,
            error: null,
          };
        }
      });
      return next;
    });
  }, [approvedScripts]);

  // Resume polling after page refresh
  useEffect(() => {
    approvedScripts.forEach((a) => {
      const es = explainerStates[a.id];
      if (es?.phase === "polling" && a.runway_task_id && !pollTimers.current[a.id]) {
        pollVideo(a.id, a.runway_task_id);
      }
    });
  }, [explainerStates, approvedScripts]);

  // -------------------------------
  // Upload File
  // -------------------------------
  const uploadFileToBucket = async () => {
    if (!file) return alert("Select a file first");
    const filePath = `uploads/${Date.now()}-${file.name}`;
    const { error: storageError } = await supabase.storage
      .from("checklists").upload(filePath, file, { upsert: true });
    if (storageError) return alert(storageError.message);
    const { data: checklist, error: checklistError } = await supabase
      .from("checklists")
      .insert([{ file_name: file.name, file_url: filePath }])
      .select().single();
    if (checklistError) return alert(checklistError.message);
    return checklist;
  };

  // -------------------------------
  // Generate Script
  // -------------------------------
  const generateScript = async () => {
    if (!file) return alert("Select checklist first");
    try {
      const checklist = await uploadFileToBucket();
      if (!checklist?.id) return alert("Checklist creation failed");

      // original extracted file text
      const text = await extractFileText(file);
      const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/swift-responder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) return alert("Script generation failed (server error)");
      const data = await response.json();
      if (!data.script) return alert("Script generation failed (no script returned)");
      const { data: newDraftArray, error: draftError } = await supabase
        .from("draft_scripts")
        .insert([
          {
            user_id: user.id,
            primitive_id: checklist.id,
            script_text: data.script, // AI generated script
            primitive_draft: primitiveDraftToSave,
            document_text: text, // original extracted document text
            primitive_status: "draft",
            script_status: "draft",
            workflow_state: "primitive_clarification",
          },
        ])
        .select();

      if (draftError) return alert("Failed to save draft: " + draftError.message);
      if (!newDraftArray?.[0]) return alert("Draft creation failed");
      await fetchDrafts();
      setFile(null);
      alert("Script and primitive draft generated successfully.");
    } catch (err) {
      console.error("Error generating script:", err);
      alert("Error generating script.");
    }
  };

  // -------------------------------
  // Toggle Draft + Enhance Primitive
  // -------------------------------
  const toggleDraft = async (draft) => {
    if (activeDraft?.id === draft.id) {
      setActiveDraft(null);
      setConfidenceResult(null); // clear previous confidence result when closing
      return;
    }
    const { data: latestDraft, error } = await supabase
      .from("draft_scripts")
      .select("*")
      .eq("id", draft.id)
      .eq("user_id", user.id)
      .single();

    if (error || !latestDraft) {
      console.error("Draft not found or unauthorized:", error);
      return;
    }

    // reset confidence when switching drafts
    setConfidenceResult(null);

    setActiveDraft({ ...latestDraft, enhanced_primitive: null });

    const isPrimitiveEmpty = (obj) =>
      !obj || !Object.values(obj).some((v) => Array.isArray(v) ? v.length > 0 : !!v);

    if (isPrimitiveEmpty(latestDraft.enhanced_primitive)) {
      try {
        setActiveDraft((prev) => prev ? { ...prev, enhancing: true } : prev);
        const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/swift-responder`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ primitive: latestDraft.primitive_draft }),
        });
        if (!res.ok) { setActiveDraft((prev) => prev ? { ...prev, enhancing: false } : prev); return; }
        const data = await res.json();
        const enhancedPrimitive = data.primitive || {};

        const { error: updateError } = await supabase
          .from("draft_scripts")
          .update({ enhanced_primitive: enhancedPrimitive })
          .eq("id", draft.id)
          .eq("user_id", user.id);

        if (updateError) {
          console.error("Error saving enhanced primitive:", updateError);
        }

        setDrafts((prev) =>
          prev.map((d) =>
            d.id === draft.id ? { ...d, enhanced_primitive: enhancedPrimitive } : d
          )
        );

        setActiveDraft((prev) =>
          prev
            ? {
                ...prev,
                enhanced_primitive: enhancedPrimitive,
                enhancing: false,
              }
            : prev
        );
      } catch (err) {
        console.error("Error enhancing primitive:", err);
        setActiveDraft((prev) => prev ? { ...prev, enhancing: false } : prev);
      }
    } else {
      setActiveDraft(latestDraft);
    }
  };

  // Confidence check on generated draft
  const handleCheckConfidence = async () => {
    if (!activeDraft) {
      alert("No active draft selected.");
      return;
    }

    // use enhanced primitive first, fallback to primitive draft
    const primitive =
      activeDraft.enhanced_primitive ||
      activeDraft.primitive_draft ||
      {};

    const primitiveText =
      typeof primitive === "string"
        ? primitive
        : JSON.stringify(primitive, null, 2);

    // try common field names in case structure varies
    const who = primitive.who || primitive.actor || "";
    const what = primitive.what || primitive.action || "";
    const where = primitive.where || primitive.location || "";
    const precondition =
      primitive.precondition || primitive.condition || "";

    const documentText = activeDraft.document_text || "";

    if (!documentText) {
      alert("Document text is missing for this draft.");
      return;
    }

    try {
      setConfidenceLoading(true);
      setConfidenceResult(null);

      const result = await fetchConfidence({
        // primitive_id: activeDraft.id,
  //primitive_text: primitiveText,
  //who,
  //what,
  //where,
 // precondition,
 // document_text: documentText,

 //changes made here based on cluade
        script_text: activeDraft.script_text,
        document_text: documentText,
      });
      setConfidenceResult(result);
      setSelectedDraft(result.recommended);
    } catch (error) {
      console.error("Confidence check failed:", error);
      alert("Confidence check failed.");
    } finally {
      setConfidenceLoading(false);
    }
  };

  // Regenerate Script based on which draft is selected
  const handleRegenerate = async () => {
    if (!activeDraft) return;

    try {
      setRegenerating(true);

      if (selectedDraft === "openai") {
        const response = await fetch(
          "https://javlnpnawmfpypapauyc.supabase.co/functions/v1/swift-responder",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: activeDraft.document_text,
              strict: true,
            }),
          }
        );

        if (!response.ok) return alert("Regeneration failed.");

        const data = await response.json();
        if (!data.script) return alert("Regeneration failed — no script returned.");

        await supabase
          .from("draft_scripts")
          .update({ script_text: data.script })
          .eq("id", activeDraft.id)
          .eq("user_id", user.id);

        setActiveDraft((prev) => ({ ...prev, script_text: data.script }));
        setDrafts((prev) =>
          prev.map((d) =>
            d.id === activeDraft.id ? { ...d, script_text: data.script } : d
          )
        );

      } else if (selectedDraft === "claude") {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;

        const response = await fetch(
          "https://javlnpnawmfpypapauyc.supabase.co/functions/v1/regenerate-claude",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`,
            },
            body: JSON.stringify({
              document_text: activeDraft.document_text,
            }),
          }
        );

        if (!response.ok) return alert("Claude regeneration failed.");

        const data = await response.json();
        const newClaudeScript = data.claude_script || "";
        if (!newClaudeScript) return alert("Claude regeneration failed — no script returned.");

        await supabase
          .from("draft_scripts")
          .update({ claude_script: newClaudeScript })
          .eq("id", activeDraft.id)
          .eq("user_id", user.id);

        setActiveDraft((prev) => ({ ...prev, claude_script: newClaudeScript }));
        setDrafts((prev) =>
          prev.map((d) =>
            d.id === activeDraft.id ? { ...d, claude_script: newClaudeScript } : d
          )
        );
      }

      setConfidenceResult(null);
      setSelectedDraft(null);
      alert("Script regenerated. Please run Check Confidence again.");

    } catch (err) {
      console.error("Regeneration error:", err);
      alert("Regeneration failed.");
    } finally {
      setRegenerating(false);
    }
  };

  // -------------------------------
  // Generate Explainer (video + audio together)
  // -------------------------------
  const generateExplainer = async (approved) => {
    const scriptId = approved.id;
    const presetId = selectedVoices[scriptId] || VOICE_OPTIONS[0].value;

    setExplainerStates((prev) => ({
      ...prev,
      [scriptId]: { phase: "generating", videoProgress: 0, videoReady: false, audioReady: false, error: null },
    }));

    try {
      const token = await getAuthToken();

      // Kick off video and audio in parallel
      const [videoRes, audioRes] = await Promise.all([
        fetch(`${SUPABASE_FUNCTIONS_URL}/generate-video`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ approvedScript: approved.approved_script, approvedScriptId: scriptId }),
        }),
        fetch(`${SUPABASE_FUNCTIONS_URL}/generate-audio`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ approvedScript: approved.approved_script, approvedScriptId: scriptId, presetId }),
        }),
      ]);

      if (!videoRes.ok) throw new Error("Failed to start video generation");
      if (!audioRes.ok) throw new Error("Failed to start audio generation");

      const { taskId } = await videoRes.json();
      const { audioUrl } = await audioRes.json();

      if (!taskId) throw new Error("No video task ID returned");

      // Audio is done (polls server-side), mark it ready
      // Video needs client-side polling
      setExplainerStates((prev) => ({
        ...prev,
        [scriptId]: {
          phase: "polling",
          videoProgress: 5,
          videoReady: false,
          audioReady: !!audioUrl,
          error: null,
        },
      }));

      pollVideo(scriptId, taskId);
    } catch (err) {
      console.error("Explainer generation error:", err);
      setExplainerStates((prev) => ({
        ...prev,
        [scriptId]: { phase: "failed", videoProgress: 0, videoReady: false, audioReady: false, error: err.message },
      }));
    }
  };

  const pollVideo = (scriptId, taskId) => {
    if (pollTimers.current[scriptId]) return;
    let attempts = 0;
    const poll = async () => {
      attempts++;
      if (attempts > MAX_POLL_ATTEMPTS) {
        stopPolling(scriptId);
        setExplainerStates((prev) => ({
          ...prev,
          [scriptId]: { ...prev[scriptId], phase: "failed", error: "Video generation timed out." },
        }));
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
          setExplainerStates((prev) => ({
            ...prev,
            [scriptId]: { ...prev[scriptId], phase: "done", videoProgress: 100, videoReady: true },
          }));
          await fetchApprovedScripts();
          return;
        }
        if (data.status === "FAILED" || data.status === "CANCELLED") {
          stopPolling(scriptId);
          setExplainerStates((prev) => ({
            ...prev,
            [scriptId]: { ...prev[scriptId], phase: "failed", error: data.error || "Video generation failed." },
          }));
          return;
        }
        setExplainerStates((prev) => ({
          ...prev,
          [scriptId]: { ...prev[scriptId], videoProgress: Math.max(5, progress) },
        }));
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
  // Render Media Section
  // -------------------------------
  const renderMediaSection = (approved) => {
    const es = explainerStates[approved.id] || { phase: "idle", videoProgress: 0, videoReady: false, audioReady: false, error: null };
    const presetId = selectedVoices[approved.id] || VOICE_OPTIONS[0].value;
    const isGenerating = es.phase === "generating" || es.phase === "polling";
    const isDone = es.phase === "done" && approved.video_url && approved.audio_url;

    return (
      <div className="media-section">

        {/* Synced player once both are ready */}
        {isDone && (
          <div className="synced-player-wrapper">
            <h4 className="explainer-title">📽 Explainer Video</h4>
            <SyncedPlayer videoUrl={approved.video_url} audioUrl={approved.audio_url} />
            <div className="download-links">
              <a className="download-link-btn" href={approved.video_url} target="_blank" rel="noopener noreferrer" download>⬇ Download Video</a>
              <a className="download-link-btn secondary" href={approved.audio_url} target="_blank" rel="noopener noreferrer" download>⬇ Download Audio</a>
            </div>
          </div>
        )}

        {/* Progress indicator while generating */}
        {isGenerating && (
          <div className="video-progress-wrapper">
            <div className="video-progress-label">
              {es.phase === "generating"
                ? "Starting generation…"
                : `Generating video… ${es.videoProgress}%${es.audioReady ? " · ✓ Audio ready" : " · Generating audio…"}`}
            </div>
            <div className="video-progress-track">
              <div className="video-progress-bar" style={{ width: `${es.videoProgress}%` }} />
            </div>
            <p className="video-progress-hint">Video and audio are being generated. Please wait...</p>
          </div>
        )}

        {/* Error state */}
        {es.phase === "failed" && (
          <div className="video-error">
            <span>⚠ {es.error || "Generation failed."}</span>
            <button className="secondary-btn retry-btn"
              onClick={() => setExplainerStates((prev) => ({
                ...prev,
                [approved.id]: { phase: "idle", videoProgress: 0, videoReady: false, audioReady: false, error: null },
              }))}>
              Retry
            </button>
          </div>
        )}

        {/* Single generate button + voice selector */}
        {!isDone && !isGenerating && (
          <div className="explainer-generate-row">
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
              <span style={{ fontSize: "13px", marginBottom: "2px" }}>Choose a voice:</span>
              <select
                className="voice-select"
                value={presetId}
                onChange={(e) => setSelectedVoices((prev) => ({ ...prev, [approved.id]: e.target.value }))}
              >
                {VOICE_OPTIONS.map((v) => (
                  <option key={v.value} value={v.value}>{v.label}</option>
                ))}
              </select>
            </div>
            <button
              className="primary-btn"
              disabled={!approved.approved_script}
              onClick={() => generateExplainer(approved)}
            >
               Generate Explainer
            </button>
          </div>
        )}

      </div>
    );
  };

  // -------------------------------
  // ApprovedScriptCard Component
  // -------------------------------
  function ApprovedScriptCard({ script, user }) {
    const [showHistory, setShowHistory] = useState(false);
    const [history, setHistory] = useState(null);

    const fetchHistory = async () => {
      if (history) return setShowHistory((prev) => !prev);
      try {
        const { data: draftData } = await supabase
          .from("draft_scripts").select("primitive_draft, enhanced_primitive")
          .eq("user_id", user.id).eq("primitive_id", script.script_id).maybeSingle();
        const { data: primData } = await supabase
          .from("primitives").select("final_script, approved_script")
          .eq("user_id", user.id).eq("script_id", script.script_id).maybeSingle();
        setHistory({ draft: draftData || {}, primitive: primData || {} });
        setShowHistory(true);
      } catch (err) {
        console.error("Error fetching history:", err);
        alert("Failed to fetch history");
      }
    };

    return (
      <div className="approved-script-card">
        <h4>Checklist ID: {script.script_id}</h4>
        <pre className="script-content">{script.approved_script}</pre>

        <button className="primary-btn" onClick={fetchHistory}>
          {showHistory ? "Hide History" : "View History"}
        </button>

        {showHistory && history && (
          <div className="history-panel">
            <h5>Draft Scripts</h5>
            <div className="card">
              <strong>Primitive Draft:</strong>
              <pre>{JSON.stringify(history.draft.primitive_draft, null, 2)}</pre>
              <strong>Enhanced Primitive:</strong>
              <pre>{JSON.stringify(history.draft.enhanced_primitive, null, 2)}</pre>
            </div>
            <h5>Primitives Table</h5>
            <div className="card">
              <strong>Final Script:</strong>
              <pre>{history.primitive.final_script}</pre>
              <strong>Approved Script:</strong>
              <pre>{history.primitive.approved_script}</pre>
            </div>
          </div>
        )}

        {renderMediaSection(script)}
      </div>
    );
  }

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

            <button className="primary-btn" onClick={generateScript}>
              Generate Script
            </button>
          </div>

          <div className="draft-list">
            <h3>Your Drafts</h3>
            {drafts.length === 0 && <p>No drafts yet.</p>}
            {drafts.map((d) => (
              <div key={d.id} className="draft-card">
                <p><strong>Script Status:</strong> {d.script_status}</p>
                <p><strong>Checklist ID:</strong> {d.primitive_id}</p>
                <p>{d.script_text}</p>
                <button
                  className="secondary-btn"
                  onClick={() => toggleDraft(d)}
                >
                  {activeDraft?.id === d.id ? "Close Draft" : "Open Draft"}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="right-panel">
          {activeDraft && (
            <div className="active-draft-panel">
              <h4>Checklist/Primitive ID: {activeDraft.primitive_id}</h4>

              <div className="card primitive-panel">
                <h3>Original Primitive</h3>
                <pre>{JSON.stringify(activeDraft.primitive_draft, null, 2)}</pre>
              </div>

              <div className="card enhanced-panel">
                <h3>Enhanced Primitive</h3>
                <pre>
                  {JSON.stringify(activeDraft.enhanced_primitive,
                    (key, value) => Array.isArray(value) ? value.join("\n - ") : value, 2)}
                </pre>
              </div>

                {/* confidence check button */}
                <button
                  className="primary-btn"
                  onClick={handleCheckConfidence}
                  disabled={confidenceLoading}
                >
                  {confidenceLoading ? "Checking Confidence..." : "Check Confidence"}
                </button>

                {/* confidence result display */}
                {confidenceResult && (
                  <div className="card confidence-panel">
                    <h3>Confidence Result</h3>

                    <p><strong>Score:</strong> {confidenceResult.confidence_score}</p>
                    <p><strong>Decision:</strong> {confidenceResult.decision}</p>
                    <p><strong>Reason:</strong> {confidenceResult.reason}</p>

                    <h4>Matched Evidence</h4>
                    <ul>
                      {confidenceResult.matched_evidence?.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>

                    <h4>Missing Evidence</h4>
                    <ul>
                      {confidenceResult.missing_evidence?.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {!activeDraft.chatStarted && (
                <button
                  className="primary-btn"
                  onClick={() =>
                    setActiveDraft((prev) => ({ ...prev, chatStarted: true }))
                  }
                >
                  Start Chat
                </button>
              )}

              {activeDraft.chatStarted && (
                <ConversationAgent
                  draft={activeDraft}
                  refresh={(removeDraftId, newApprovedScript = null) => {
                    fetchDrafts(removeDraftId);
                    if (newApprovedScript) {
                      setApprovedScripts((prev) => [newApprovedScript, ...prev]);
                    } else {
                      fetchApprovedScripts();
                    }

                    setActiveDraft((prev) =>
                      prev?.id === removeDraftId ? null : prev
                    );
                  }}
                />
              )}
            </div>
          )}

          <button className="view-btn" onClick={() => setShowApprovedModal(true)}>
            View Approved Scripts
          </button>

          {/* Modal / Blanket */}
          {showApprovedModal && (
            <div className="approved-modal">
              <div className="modal-content">
                <div className="modal-header">
                  <h3>Approved Scripts</h3>
                  <button className="close-btn" onClick={() => setShowApprovedModal(false)}>Close</button>
                </div>
                <div className="modal-body">
                  <div className="approved-scripts-list">
                    {approvedScripts.length === 0 && <p>No approved scripts yet.</p>}
                    {approvedScripts.map((d) => (
                      <ApprovedScriptCard key={d.id} script={d} user={user} />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;