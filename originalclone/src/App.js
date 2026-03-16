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
  const [showApprovedModal, setShowApprovedModal] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState("");


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

    if (error) console.error("Error fetching drafts:", error);
    else {
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

    if (error) console.error("Error fetching approved scripts:", error);
    else {
      console.log("Approved scripts from DB:", data);
      setApprovedScripts(data || []);}
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

    setActiveDraft({ ...latestDraft, enhanced_primitive: null });

    const isPrimitiveEmpty = (primitiveObj) =>
      !primitiveObj || !Object.values(primitiveObj).some((v) => (Array.isArray(v) ? v.length > 0 : !!v));

    if (isPrimitiveEmpty(latestDraft.enhanced_primitive)) {
      try {
        setActiveDraft((prev) => prev ? { ...prev, enhancing: true } : prev);

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
          setActiveDraft((prev) => prev ? { ...prev, enhancing: false } : prev);
          return;
        }

        const data = await res.json();
        const enhancedPrimitive = data.primitive || {};

        const { error: updateError } = await supabase
          .from("draft_scripts")
          .update({ enhanced_primitive: enhancedPrimitive })
          .eq("id", draft.id)
          .eq("user_id", user.id);

        if (updateError) console.error("Error saving enhanced primitive:", updateError);

        setDrafts((prev) =>
          prev.map((d) => (d.id === draft.id ? { ...d, enhanced_primitive: enhancedPrimitive } : d))
        );
        setActiveDraft((prev) =>
          prev ? { ...prev, enhanced_primitive: enhancedPrimitive, enhancing: false } : prev
        );
      } catch (err) {
        console.error("Error calling smooth-action:", err);
        setActiveDraft((prev) => prev ? { ...prev, enhancing: false } : prev);
      }
    } else {
      setActiveDraft(latestDraft);
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


function VoiceInputCard({ voiceTranscript, setVoiceTranscript }) {
  const [recording, setRecording] = useState(false);

  const startRecording = async () => {
    setRecording(true);
    
    console.log("Recording started...");
  };

  const stopRecording = async () => {
    setRecording(false);

    console.log("Recording stopped and transcribing...");
  };

  return (
    <div className="voice-input-card card">
      <h3>Want to switch to Voice? Hit the button below to start recording!</h3>
      <button
        className="primary-btn"
        onClick={recording ? stopRecording : startRecording}
      >
        {recording ? "Stop Recording" : "Start Recording"}
      </button>

      {voiceTranscript && (
        <>
          <textarea
            value={voiceTranscript}
            onChange={(e) => setVoiceTranscript(e.target.value)}
            rows={4}
            placeholder="Edit your transcription here..."
          />
          <button
            className="primary-btn"
            onClick={() => {
            
              setActiveDraft(prev =>
                prev ? { ...prev, chatInputText: voiceTranscript, chatStarted: true } : prev
              );
              setVoiceTranscript(""); 
            }}
          >
            Send to Chat
          </button>
        </>
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
        <button className="secondary-btn" onClick={() => supabase.auth.signOut()}>
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
            
            <button className="primary-btn" onClick={generateScript}>Generate Script</button>
          </div>

          {/* Draft List */}
          <div className="draft-list">
            <h3>Your Drafts</h3>
            {drafts.length === 0 && <p>No drafts yet.</p>}
            {drafts.map((d) => (
              <div key={d.id} className="draft-card">
                
                <p><strong>Script Status:</strong> {d.script_status}</p>
                <p><strong>Checklist ID:</strong> {d.primitive_id}</p>
                <p>{d.script_text}</p>
                <button className="secondary-btn" onClick={() => toggleDraft(d)}>
                  {activeDraft?.id === d.id ? "Close Draft" : "Open Draft"}
                </button>
                
               
              </div>
            ))}
          </div>
        </div>

        {/* Right Panel */}
        <div className="right-panel">
          {/* Active Draft Panel */}
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
{JSON.stringify(activeDraft.enhanced_primitive, (key, value) => {
    if (Array.isArray(value)) return value.join('\n - ');
    return value;
}, 2)}
</pre>
              </div>

              {!activeDraft.chatStarted && (
                <button
                  className="primary-btn"
                  onClick={() => setActiveDraft((prev) => ({ ...prev, chatStarted: true }))}
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
        setApprovedScripts(prev => [newApprovedScript, ...prev]);
      } else {
        fetchApprovedScripts();
      }


      setActiveDraft(prev => (prev?.id === removeDraftId ? null : prev));
    }}
/>
              )}
            </div>
          )}
  {/* Voice Input Card */}
  {activeDraft && (
    <VoiceInputCard
      voiceTranscript={voiceTranscript}
      setVoiceTranscript={setVoiceTranscript}
    />
  )}
         {/* Approved Scripts */}
{/* Button to open approved scripts modal */}
<button
  className="view-btn"
  onClick={() => setShowApprovedModal(true)}
>
  View Approved Scripts
</button>

{/* Modal / Blanket */}
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