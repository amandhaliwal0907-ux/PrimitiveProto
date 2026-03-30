//updated app js with confidence checking on generated draft from openAI and Claude AI

import { useState, useEffect } from "react";
import "./App.css";
import Auth from "./Auth";
import { supabase } from "./supabaseClient";
import { extractFileText } from "./fileUtils";
import ConversationAgent from "./ConversationAgent";
import { fetchConfidence } from "./api";

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [videoLoadingIds, setVideoLoadingIds] = useState([]);
  const [activeDraft, setActiveDraft] = useState(null);
  const [approvedScripts, setApprovedScripts] = useState([]);
  const [showApprovedModal, setShowApprovedModal] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState("");

  // confidence state
  const [confidenceResult, setConfidenceResult] = useState(null);
  const [confidenceLoading, setConfidenceLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [selectedDraft, setSelectedDraft] = useState(null);

  // Auth Session
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

  // Fetch Drafts
  const fetchDrafts = async (removeDraftId = null) => {
    if (!user) return;
    const { data, error } = await supabase
      .from("draft_scripts")
      .select("*")
      .eq("primitive_status", "draft")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching drafts:", error);
    } else {
      let updatedDrafts = data || [];
      if (removeDraftId) {
        updatedDrafts = updatedDrafts.filter((d) => d.id !== removeDraftId);
      }
      setDrafts(updatedDrafts);
    }
  };

  useEffect(() => {
    fetchDrafts();
  }, [user]);

  // Fetch Approved Scripts
  const fetchApprovedScripts = async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from("primitives")
      .select("*")
      .eq("user_id", user.id)
      .not("approved_script", "is", null)
      .neq("approved_script", "")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching approved scripts:", error);
    } else {
      console.log("Approved scripts from DB:", data);
      setApprovedScripts(data || []);
    }
  };

  useEffect(() => {
    fetchApprovedScripts();
  }, [user]);

  // Upload File
  const uploadFileToBucket = async () => {
    if (!file) return alert("Select a file first");

    const filePath = `uploads/${Date.now()}-${file.name}`;
    const { error: storageError } = await supabase.storage
      .from("checklists")
      .upload(filePath, file, { upsert: true });

    if (storageError) return alert(storageError.message);

    const { data: checklist, error: checklistError } = await supabase
      .from("checklists")
      .insert([{ file_name: file.name, file_url: filePath }])
      .select()
      .single();

    if (checklistError) return alert(checklistError.message);

    return checklist;
  };

  // Generate Script + Primitive Draft
  const generateScript = async () => {
    if (!file) return alert("Select checklist first");

    try {
      const checklist = await uploadFileToBucket();
      if (!checklist?.id) return alert("Checklist creation failed");

      const text = await extractFileText(file);

      const response = await fetch(
        "https://javlnpnawmfpypapauyc.supabase.co/functions/v1/swift-responder",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        console.error("Edge function error:", errText);
        return alert("Script generation failed (server error)");
      }

      const data = await response.json();
      if (!data.script) return alert("Script generation failed (no script returned)");

      const primitiveDraftToSave = data.primitive || {};

      const { data: newDraftArray, error: draftError } = await supabase
        .from("draft_scripts")
        .insert([
          {
            user_id: user.id,
            primitive_id: checklist.id,
            script_text: data.script,
            claude_script: data.claude_script,
            primitive_draft: primitiveDraftToSave,
            document_text: text,
            primitive_status: "draft",
            script_status: "draft",
            workflow_state: "primitive_clarification",
            discarded_scripts: null,
          },
        ])
        .select();

      if (draftError) return alert("Failed to save draft: " + draftError.message);

      const newDraft = newDraftArray?.[0];
      if (!newDraft) return alert("Draft creation failed");

      await fetchDrafts();
      setFile(null);
      alert("Script and primitive draft generated successfully.");
    } catch (err) {
      console.error("Error generating script:", err);
      alert("Error generating script. See console for details.");
    }
  };

  // Toggle Draft + Enhance Primitive
  const toggleDraft = async (draft) => {
    if (activeDraft?.id === draft.id) {
      setActiveDraft(null);
      setConfidenceResult(null);
      setSelectedDraft(null);
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

    setConfidenceResult(null);
    setSelectedDraft(null);
    setActiveDraft({ ...latestDraft, enhanced_primitive: null });

    const isPrimitiveEmpty = (primitiveObj) =>
      !primitiveObj ||
      !Object.values(primitiveObj).some((v) =>
        Array.isArray(v) ? v.length > 0 : !!v
      );

    if (isPrimitiveEmpty(latestDraft.enhanced_primitive)) {
      try {
        setActiveDraft((prev) => (prev ? { ...prev, enhancing: true } : prev));

        const res = await fetch(
          "https://javlnpnawmfpypapauyc.supabase.co/functions/v1/swift-responder",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ primitive: latestDraft.primitive_draft }),
          }
        );

        if (!res.ok) {
          const errText = await res.text();
          console.error("Smooth-Action Error:", errText);
          setActiveDraft((prev) => (prev ? { ...prev, enhancing: false } : prev));
          return;
        }

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
            ? { ...prev, enhanced_primitive: enhancedPrimitive, enhancing: false }
            : prev
        );
      } catch (err) {
        console.error("Error calling smooth-action:", err);
        setActiveDraft((prev) => (prev ? { ...prev, enhancing: false } : prev));
      }
    } else {
      setActiveDraft(latestDraft);
    }
  };

  // Confidence check on both OpenAI and Claude drafts
  const handleCheckConfidence = async () => {
    if (!activeDraft) return alert("No active draft selected.");

    const documentText = activeDraft.document_text || "";
    const openaiScript = activeDraft.script_text || "";
    const claudeScript = activeDraft.claude_script || "";

    if (!documentText) return alert("Document text is missing.");
    if (!openaiScript) return alert("OpenAI script is missing.");
    if (!claudeScript) return alert("Claude script is missing.");

    try {
      setConfidenceLoading(true);
      setConfidenceResult(null);
      setSelectedDraft(null);

      const result = await fetchConfidence({
        openai_script: openaiScript,
        claude_script: claudeScript,
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

  // ApprovedScriptCard Component
  function ApprovedScriptCard({ script, user }) {
    const [showHistory, setShowHistory] = useState(false);
    const [history, setHistory] = useState(null);

    const fetchHistory = async () => {
      if (history) return setShowHistory((prev) => !prev);

      try {
        const { data: draftData } = await supabase
          .from("draft_scripts")
          .select("primitive_draft, enhanced_primitive")
          .eq("user_id", user.id)
          .eq("primitive_id", script.script_id)
          .maybeSingle();

        const { data: primData } = await supabase
          .from("primitives")
          .select("final_script, approved_script")
          .eq("user_id", user.id)
          .eq("script_id", script.script_id)
          .maybeSingle();

        setHistory({
          draft: draftData || {},
          primitive: primData || {},
        });
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
      </div>
    );
  }

  // Rendering
  if (loading) return <div>Loading...</div>;
  if (!user) return <Auth setUser={setUser} />;

  return (
    <div className="dashboard-container">
      {/* Sticky Top Header */}
      <div className="top-header sticky-header">
        <h3>Welcome, {user.email}</h3>
        <button
          className="secondary-btn"
          onClick={() => supabase.auth.signOut()}
        >
          Logout
        </button>
      </div>

      {/* Main Dashboard */}
      <div className="dashboard">
        {/* Left Panel */}
        <div className="left-panel">
          {/* Upload Section */}
          <div className="card upload-section">
            <h3>Upload Checklist</h3>
            <input type="file" onChange={(e) => setFile(e.target.files[0])} />
            <button className="primary-btn" onClick={generateScript}>
              Generate Script
            </button>
          </div>

          {/* Draft List */}
          <div className="draft-list">
            <h3>Your Drafts</h3>
            {drafts.length === 0 && <p>No drafts yet.</p>}
            {drafts.map((d) => (
              <div key={d.id} className="draft-card">
                <p><strong>Script Status:</strong> {d.script_status}</p>
                <p><strong>Checklist ID:</strong> {d.primitive_id}</p>

                {/* OpenAI Draft preview — hidden if discarded */}
                {d.script_text && d.discarded_scripts !== "openai" && (
                  <div style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: "8px",
                    padding: "12px",
                    marginBottom: "8px",
                    backgroundColor: "#f9fafb"
                  }}>
                    <p style={{ fontSize: "12px", fontWeight: "600", color: "#6b7280", margin: "0 0 6px 0" }}>
                      OpenAI Draft
                    </p>
                    <p style={{ fontSize: "13px", margin: 0 }}>{d.script_text}</p>
                  </div>
                )}

                {/* Claude Draft preview — hidden if discarded */}
                {d.claude_script && d.discarded_scripts !== "claude" && (
                  <div style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: "8px",
                    padding: "12px",
                    marginBottom: "8px",
                    backgroundColor: "#f0f9ff"
                  }}>
                    <p style={{ fontSize: "12px", fontWeight: "600", color: "#6b7280", margin: "0 0 6px 0" }}>
                      Claude Draft
                    </p>
                    <p style={{ fontSize: "13px", margin: 0 }}>{d.claude_script}</p>
                  </div>
                )}

                <button className="secondary-btn" onClick={() => toggleDraft(d)}>
                  {activeDraft?.id === d.id ? "Close Draft" : "Open Draft"}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Right Panel */}
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
                  {JSON.stringify(
                    activeDraft.enhanced_primitive,
                    (key, value) => {
                      if (Array.isArray(value)) return value.join("\n - ");
                      return value;
                    },
                    2
                  )}
                </pre>
              </div>

              {/* Check Confidence Button — hidden once chat started */}
              {!activeDraft.chatStarted && (
                <button
                  className="primary-btn"
                  onClick={handleCheckConfidence}
                  disabled={confidenceLoading}
                  style={{ marginTop: "16px" }}
                >
                  {confidenceLoading ? "Checking Confidence..." : "Check Confidence"}
                </button>
              )}

              {/* Two Draft Scripts Side by Side — hidden once chat started */}
              {!activeDraft.chatStarted && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginTop: "16px" }}>

                  {/* OpenAI Draft Card — hidden if discarded */}
                  {activeDraft.script_text && activeDraft.discarded_scripts !== "openai" && (
                    <div style={{
                      padding: "16px",
                      border: selectedDraft === "openai" ? "2px solid #22c55e" : "1px solid #e5e7eb",
                      borderRadius: "8px",
                      backgroundColor: "#f9fafb",
                    }}>
                      <h4 style={{ margin: "0 0 8px 0", fontSize: "14px" }}>
                        OpenAI Draft
                        {confidenceResult && selectedDraft === "openai" && (
                          <span style={{ marginLeft: "8px", color: "#22c55e", fontSize: "12px" }}>✅ Selected</span>
                        )}
                      </h4>
                      <p style={{ fontSize: "13px", whiteSpace: "pre-wrap" }}>
                        {activeDraft.script_text}
                      </p>

                      {confidenceResult && (
                        <div style={{ marginTop: "12px", borderTop: "1px solid #e5e7eb", paddingTop: "12px" }}>
                          {[
                            { label: "Accuracy", value: confidenceResult.openai.accuracy },
                            { label: "Completeness", value: confidenceResult.openai.completeness },
                            { label: "Clarity", value: confidenceResult.openai.clarity },
                          ].map((item) => (
                            <div key={item.label} style={{ marginBottom: "8px" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
                                <span style={{ fontSize: "12px", color: "#6b7280" }}>{item.label}</span>
                                <span style={{ fontSize: "12px", fontWeight: "600" }}>{item.value}/100</span>
                              </div>
                              <div style={{ backgroundColor: "#e5e7eb", borderRadius: "999px", height: "6px" }}>
                                <div style={{
                                  width: `${item.value}%`,
                                  backgroundColor: item.value >= 90 ? "#22c55e" : item.value >= 60 ? "#f59e0b" : "#ef4444",
                                  borderRadius: "999px",
                                  height: "6px",
                                }} />
                              </div>
                            </div>
                          ))}
                          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "8px" }}>
                            <span style={{ fontSize: "13px", fontWeight: "600" }}>Total</span>
                            <span style={{
                              fontSize: "13px", fontWeight: "700",
                              color: confidenceResult.openai.total >= 90 ? "#22c55e"
                                : confidenceResult.openai.total >= 60 ? "#f59e0b" : "#ef4444"
                            }}>
                              {confidenceResult.openai.total}/100
                            </span>
                          </div>
                          <p style={{ fontSize: "12px", marginTop: "6px" }}>{confidenceResult.openai.reason}</p>

                          {/* Discard — only when Claude is selected */}
                          {selectedDraft === "claude" && (
                            <button
                              className="secondary-btn"
                              style={{ marginTop: "8px", width: "100%" }}
                              onClick={async () => {
                                const ok = window.confirm("Discard the OpenAI draft?");
                                if (!ok) return;
                                await supabase
                                  .from("draft_scripts")
                                  .update({ script_text: null, discarded_scripts: "openai" })
                                  .eq("id", activeDraft.id);
                                setActiveDraft((prev) => ({ ...prev, script_text: null, discarded_scripts: "openai" }));
                                setDrafts((prev) =>
                                  prev.map((d) =>
                                    d.id === activeDraft.id ? { ...d, script_text: null, discarded_scripts: "openai" } : d
                                  )
                                );
                              }}
                            >
                              Discard
                            </button>
                          )}

                          {/* Start Chat or Regenerate — only when OpenAI is selected */}
                          {selectedDraft === "openai" && (
                            confidenceResult.openai.total >= 90 ? (
                              <button
                                className="primary-btn"
                                style={{ marginTop: "8px", width: "100%" }}
                                onClick={() => setActiveDraft((prev) => ({ ...prev, chatStarted: true }))}
                              >
                                Start Chat
                              </button>
                            ) : (
                              <button
                                className="primary-btn"
                                style={{ marginTop: "8px", width: "100%" }}
                                onClick={handleRegenerate}
                                disabled={regenerating}
                              >
                                {regenerating ? "Regenerating..." : "Regenerate"}
                              </button>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Claude Draft Card — hidden if discarded */}
                  {activeDraft.claude_script && activeDraft.discarded_scripts !== "claude" && (
                    <div style={{
                      padding: "16px",
                      border: selectedDraft === "claude" ? "2px solid #22c55e" : "1px solid #bfdbfe",
                      borderRadius: "8px",
                      backgroundColor: "#f0f9ff",
                    }}>
                      <h4 style={{ margin: "0 0 8px 0", fontSize: "14px" }}>
                        Claude Draft
                        {confidenceResult && selectedDraft === "claude" && (
                          <span style={{ marginLeft: "8px", color: "#22c55e", fontSize: "12px" }}>✅ Selected</span>
                        )}
                      </h4>
                      <p style={{ fontSize: "13px", whiteSpace: "pre-wrap" }}>
                        {activeDraft.claude_script}
                      </p>

                      {confidenceResult && (
                        <div style={{ marginTop: "12px", borderTop: "1px solid #bfdbfe", paddingTop: "12px" }}>
                          {[
                            { label: "Accuracy", value: confidenceResult.claude.accuracy },
                            { label: "Completeness", value: confidenceResult.claude.completeness },
                            { label: "Clarity", value: confidenceResult.claude.clarity },
                          ].map((item) => (
                            <div key={item.label} style={{ marginBottom: "8px" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
                                <span style={{ fontSize: "12px", color: "#6b7280" }}>{item.label}</span>
                                <span style={{ fontSize: "12px", fontWeight: "600" }}>{item.value}/100</span>
                              </div>
                              <div style={{ backgroundColor: "#e5e7eb", borderRadius: "999px", height: "6px" }}>
                                <div style={{
                                  width: `${item.value}%`,
                                  backgroundColor: item.value >= 90 ? "#22c55e" : item.value >= 60 ? "#f59e0b" : "#ef4444",
                                  borderRadius: "999px",
                                  height: "6px",
                                }} />
                              </div>
                            </div>
                          ))}
                          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "8px" }}>
                            <span style={{ fontSize: "13px", fontWeight: "600" }}>Total</span>
                            <span style={{
                              fontSize: "13px", fontWeight: "700",
                              color: confidenceResult.claude.total >= 90 ? "#22c55e"
                                : confidenceResult.claude.total >= 60 ? "#f59e0b" : "#ef4444"
                            }}>
                              {confidenceResult.claude.total}/100
                            </span>
                          </div>
                          <p style={{ fontSize: "12px", marginTop: "6px" }}>{confidenceResult.claude.reason}</p>

                          {/* Discard — only when OpenAI is selected */}
                          {selectedDraft === "openai" && (
                            <button
                              className="secondary-btn"
                              style={{ marginTop: "8px", width: "100%" }}
                              onClick={async () => {
                                const ok = window.confirm("Discard the Claude draft?");
                                if (!ok) return;
                                await supabase
                                  .from("draft_scripts")
                                  .update({ claude_script: null, discarded_scripts: "claude" })
                                  .eq("id", activeDraft.id);
                                setActiveDraft((prev) => ({ ...prev, claude_script: null, discarded_scripts: "claude" }));
                                setDrafts((prev) =>
                                  prev.map((d) =>
                                    d.id === activeDraft.id ? { ...d, claude_script: null, discarded_scripts: "claude" } : d
                                  )
                                );
                              }}
                            >
                              Discard
                            </button>
                          )}

                          {/* Start Chat or Regenerate — only when Claude is selected */}
                          {selectedDraft === "claude" && (
                            confidenceResult.claude.total >= 90 ? (
                              <button
                                className="primary-btn"
                                style={{ marginTop: "8px", width: "100%" }}
                                onClick={() => setActiveDraft((prev) => ({
                                  ...prev,
                                  chatStarted: true,
                                  script_text: activeDraft.claude_script,
                                }))}
                              >
                                Start Chat
                              </button>
                            ) : (
                              <button
                                className="primary-btn"
                                style={{ marginTop: "8px", width: "100%" }}
                                onClick={handleRegenerate}
                                disabled={regenerating}
                              >
                                {regenerating ? "Regenerating..." : "Regenerate"}
                              </button>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* No confidence check yet */}
              {!confidenceResult && !activeDraft.chatStarted && (
                <p style={{ fontSize: "13px", color: "#6b7280", marginTop: "12px" }}>
                  Run confidence check before starting chat.
                </p>
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

          {/* Approved Scripts */}
          <button
            className="view-btn"
            onClick={() => setShowApprovedModal(true)}
          >
            View Approved Scripts
          </button>

          {/* Modal */}
          {showApprovedModal && (
            <div className="approved-modal">
              <div className="modal-content">
                <div className="modal-header">
                  <h3>Approved Scripts</h3>
                  <button
                    className="close-btn"
                    onClick={() => setShowApprovedModal(false)}
                  >
                    Close
                  </button>
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
