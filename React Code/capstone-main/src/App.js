import { useState, useEffect } from "react";
import "./App.css";
import Auth from "./Auth";
import { supabase } from "./supabaseClient";
import { extractFileText } from "./fileUtils";
import ConversationAgent from "./ConversationAgent";

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [videoLoadingIds, setVideoLoadingIds] = useState([]);
  const [activeDraft, setActiveDraft] = useState(null);
  const [approvedScripts, setApprovedScripts] = useState([]);

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

  // -------------------------------
  // Fetch Drafts
  // -------------------------------
  const fetchDrafts = async () => {
    if (!user) return;

    const { data, error } = await supabase
      .from("draft_scripts")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching drafts:", error);
      return;
    }

    setDrafts(data || []);
  };

  useEffect(() => {
    fetchDrafts();
  }, [user]);

  // -------------------------------
  // Fetch Approved Scripts
  // -------------------------------
  const fetchApprovedScripts = async () => {
    if (!user) return;

    const { data, error } = await supabase
      .from("approved_scripts")
      .select("*")
      .eq("user_id", user.id)
      .not("approved_script", "is", null)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching approved scripts:", error);
      return;
    }

    setApprovedScripts(data || []);
  };

  useEffect(() => {
    fetchApprovedScripts();
  }, [user]);

  // -------------------------------
  // Upload file + create checklist row
  // -------------------------------
  const uploadFileToBucket = async () => {
    if (!file) {
      alert("Select a file first");
      return null;
    }

    const filePath = `uploads/${Date.now()}-${file.name}`;

    const { error: storageError } = await supabase.storage
      .from("checklists")
      .upload(filePath, file, { upsert: true });

    if (storageError) {
      alert(storageError.message);
      return null;
    }

    const { data: checklist, error: checklistError } = await supabase
      .from("checklists")
      .insert([{ file_name: file.name, file_url: filePath }])
      .select()
      .single();

    if (checklistError) {
      alert(checklistError.message);
      return null;
    }

    return checklist;
  };

  // -------------------------------
  // Generate Script
  // -------------------------------
  const generateScript = async () => {
    if (!file) {
      alert("Select checklist first");
      return;
    }

    try {
      const checklist = await uploadFileToBucket();
      if (!checklist?.id) {
        alert("Checklist creation failed");
        return;
      }

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
        alert("Script generation failed (server error)");
        return;
      }

      const data = await response.json();
      if (!data.script) {
        alert("Script generation failed (no script returned)");
        return;
      }

      const primitiveDraftToSave = data.primitiveDraft || {};

      const { data: newDraftArray, error: draftError } = await supabase
        .from("draft_scripts")
        .insert([
          {
            user_id: user.id,
            primitive_id: checklist.id,
            script_text: data.script,
            primitive_draft: primitiveDraftToSave,
            primitive_status: "draft",
            script_status: "draft",
            workflow_state: "primitive_clarification",
          },
        ])
        .select();

      if (draftError) {
        alert("Failed to save draft: " + draftError.message);
        return;
      }

      const newDraft = newDraftArray?.[0];
      if (!newDraft) {
        alert("Draft creation failed");
        return;
      }

      await fetchDrafts();
      setActiveDraft(newDraft);
      setFile(null);
      alert("Script and primitive draft generated successfully.");
    } catch (err) {
      console.error("Error generating script:", err);
      alert("Error generating script. See console for details.");
    }
  };

  // -------------------------------
  // Generate Video from Approved Script
  // -------------------------------
  const generateVideoFromApproved = async (approved) => {
    setVideoLoadingIds((prev) => [...prev, approved.id]);

    try {
      const res = await fetch(
        "https://javlnpnawmfpypapauyc.supabase.co/functions/v1/dynamic-processor",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            approvedScript: approved.approved_script,
            primitive: approved.primitive_json,
            approvedScriptId: approved.id,
          }),
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        console.error("Video generation error:", errText);
        alert("Video generation failed.");
        return;
      }

      const { videoUrl } = await res.json();

      const { error } = await supabase
        .from("approved_scripts")
        .update({
          video_url: videoUrl,
          video_status: "generated",
          updated_at: new Date().toISOString(),
        })
        .eq("id", approved.id);

      if (error) {
        console.error("Failed to save video url:", error);
        alert("Video URL save failed.");
        return;
      }

      await fetchApprovedScripts();
      alert("Video generated successfully.");
    } catch (err) {
      console.error("Error generating video:", err);
      alert("Video generation failed.");
    } finally {
      setVideoLoadingIds((prev) => prev.filter((id) => id !== approved.id));
    }
  };

  // -------------------------------
  // Toggle Draft
  // -------------------------------
  const toggleDraft = async (draft) => {
    if (activeDraft?.id === draft.id) {
      setActiveDraft(null);
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

    setActiveDraft({ ...latestDraft, enhanced_primitive: latestDraft.enhanced_primitive || null });

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
          console.error("Enhance primitive error:", errText);
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
        console.error("Error enhancing primitive:", err);
        setActiveDraft((prev) => (prev ? { ...prev, enhancing: false } : prev));
      }
    }
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
        <button className="secondary-btn" onClick={() => supabase.auth.signOut()}>
          Logout
        </button>
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
                  <button
                    className="primary-btn"
                    onClick={() => setActiveDraft((prev) => ({ ...prev, chatStarted: true }))}
                  >
                    Start Chat
                  </button>

                  <button
                    className="secondary-btn"
                    onClick={() => setActiveDraft(null)}
                  >
                    Close Draft
                  </button>
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

            {approvedScripts.map((a, index) => {
              const loadingVideo = videoLoadingIds.includes(a.id);

              return (
                <div key={a.id} className="approved-script-card">
                  <h4>
                    Approved Script {approvedScripts.length - index}
                    {a.version_number ? ` (v${a.version_number})` : ""}
                  </h4>

                  <pre className="script-content">{a.approved_script}</pre>

                  {a.video_status === "generated" && (
                    <span className="video-generated"> Video Generated</span>
                  )}

                  <button
                    className="primary-btn"
                    disabled={loadingVideo || !a.approved_script || a.video_status === "generated"}
                    onClick={() => generateVideoFromApproved(a)}
                  >
                    {loadingVideo ? "Generating..." : "Generate Video"}
                  </button>
                </div>
              );
            })}
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
