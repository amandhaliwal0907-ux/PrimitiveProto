//Updated conversationAgent part with the updated cross confidence checking 

import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

const SUPABASE_FUNCTIONS_URL = "https://javlnpnawmfpypapauyc.supabase.co/functions/v1";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Shared headers for all Supabase edge function calls
// Authorization is required — without it Supabase returns 401
const supabaseHeaders = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
};

const PRIMITIVE_FIELDS = [
  "who",
  "trigger_condition",
  "preconditions",
  "required_action",
  "verification_method",
  "failure_consequences",
];

export default function ConversationAgent({ draft, refresh }) {

  const initialPrimitive = draft?.enhanced_primitive || draft?.primitive_draft || {};
  const [primitive, setPrimitive] = useState(initialPrimitive);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");
  const [completionMessageShown, setCompletionMessageShown] = useState(false);
  const [approving, setApproving] = useState(false);
  const [simResult, setSimResult] = useState(null);
  const [simLoading, setSimLoading] = useState(false);
  const [listening, setListening] = useState(false);

  const [showRegenerateButton, setShowRegenerateButton] = useState(false);
  const [regenLoading, setRegenLoading] = useState(false);

  // Stores the two regenerated scripts in React state
  // null = not yet generated, "" = discarded by user
  const [openaiRegenScript, setOpenaiRegenScript] = useState(null);
  const [claudeRegenScript, setClaudeRegenScript] = useState(null);
  //for making the regenerated script editable 
  const [editingOpenai, setEditingOpenai] = useState(false); // toggles edit mode for OpenAI card
  const [editingClaude, setEditingClaude] = useState(false); // toggles edit mode for Claude card

  const [crossConfidenceResult, setCrossConfidenceResult] = useState(null);
  const [crossConfidenceLoading, setCrossConfidenceLoading] = useState(false);

  const chatEndRef = useRef(null);

  // Re-sync primitive whenever the draft prop changes
  useEffect(() => {
    setPrimitive(draft?.enhanced_primitive || draft?.primitive_draft || {});
  }, [draft]);

  const scrollToBottom = () => chatEndRef.current?.scrollIntoView({ behavior: "smooth" });

  const appendMessage = (role, content) => {
    setMessages((prev) => [...prev, { role, content }]);
    scrollToBottom();
  };

  // Show initial completion message once when component mounts
  useEffect(() => {
    if (!completionMessageShown) {
      appendMessage(
        "assistant",
        `All required fields are complete.\n\nDo you want to make any further changes or approve?`
      );
      setCompletionMessageShown(true);
    }
  }, [primitive, completionMessageShown]);

  // Saves the updated primitive to draft_scripts table while user is editing
  const savePrimitiveDraft = async (updated) => {
    setPrimitive(updated);
    await supabase
      .from("draft_scripts")
      .update({ primitive_draft: updated })
      .eq("id", draft.id);
  };

  // Sends user's text instruction to smart-action edge function
  // which returns field updates or an AI message
  const handleUserInput = async (text) => {
    if (!text.trim()) return;
    appendMessage("user", text);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/smart-action`, {
        method: "POST",
        headers: supabaseHeaders,
        body: JSON.stringify({ instruction: text, messages, currentPrimitive: primitive }),
      });
      const data = await res.json();
      if (data?.updates && Object.keys(data.updates).length > 0) {
        const updatedPrimitive = { ...primitive, ...data.updates };
        await savePrimitiveDraft(updatedPrimitive);
        appendMessage(
          "assistant",
          `Primitive Updated:\n${JSON.stringify(updatedPrimitive, null, 2)}\n\nDo you want to make further changes or approve?`
        );
        setPrimitive(updatedPrimitive);
      } else {
        appendMessage(
          "assistant",
          `${data?.aiMessage || "Invalid request. Please give instructions only about addition, removal or modification."}\n\nDo you want to make further changes or approve?`
        );
      }
    } catch {
      appendMessage("assistant", "Could not process instruction.");
    } finally {
      setLoading(false);
    }
  };

  // Approves the primitive — inserts it into the primitives table
  // and updates draft_scripts workflow state to approved
  const handleApprove = async () => {
    if (approving) return;
    setApproving(true);
    try {
      if (!draft.primitive_id) {
        appendMessage("assistant", "Cannot approve: primitive_id missing in draft.");
        return;
      }
      if (!primitive || Object.keys(primitive).length === 0) {
        appendMessage("assistant", "Cannot approve: primitive is empty.");
        return;
      }

      // Insert primitive into primitives table
      const { error } = await supabase
        .from("primitives")
        .insert({ script_id: draft.primitive_id, primitive_json: primitive, user_id: draft.user_id });

      if (error) { appendMessage("assistant", `Approval failed: ${error.message}`); return; }

      // Update workflow state in draft_scripts table
      const { error: workflowError } = await supabase
        .from("draft_scripts")
        .update({ workflow_state: "video_ready", script_status: "approved", primitive_status: "approved" })
        .eq("id", draft.id);

      if (workflowError) {
        appendMessage("assistant", `Failed to update draft workflow: ${workflowError.message}`);
        return;
      }

      appendMessage("assistant", "Primitive approved. You can now regenerate the script for video generation.");
      refresh();
      setShowRegenerateButton(true);
    } catch (err) {
      appendMessage("assistant", `Approval failed: ${err.message}`);
      console.error("handleApprove error:", err);
    } finally {
      setApproving(true); //this was false that was enabling the buttons, noe disables 
    }
  };

  //UPDATED: Regenerate both scripts and save both to database 
  // Previously only the OpenAI script was saved as final_script (now removed)
  // Now both openai_script and claude_script are saved to the primitives table
  // so they persist across page refreshes and are not lost from React state
  const handleRegenerateScript = async () => {
    if (!draft?.primitive_id) {
      appendMessage("assistant", "Cannot regenerate: primitive_id missing in draft.");
      return;
    }

    const scriptId = draft.primitive_id;
    setRegenLoading(true);
    setOpenaiRegenScript(null);
    setClaudeRegenScript(null);
    setCrossConfidenceResult(null);

    try {
      // Fetch the approved primitive JSON from the primitives table
      const { data: primData, error: fetchError } = await supabase
        .from("primitives")
        .select("primitive_json")
        .eq("script_id", scriptId)
        .maybeSingle();

      if (fetchError || !primData?.primitive_json) {
        appendMessage("assistant", "Primitive data not found, cannot regenerate.");
        return;
      }

      const primitiveJson = primData.primitive_json;

      // Call both edge functions in parallel
      // smooth-action → OpenAI generates the script
      // regenerateClaude → Claude generates the script
      const [openaiRes, claudeRes] = await Promise.all([
        fetch(`${SUPABASE_FUNCTIONS_URL}/smooth-action`, {
          method: "POST",
          headers: supabaseHeaders,
          body: JSON.stringify({ primitive: primitiveJson }),
        }),
        fetch(`${SUPABASE_FUNCTIONS_URL}/regenerateClaude`, {
          method: "POST",
          headers: supabaseHeaders,
          body: JSON.stringify({ primitive: primitiveJson }),
        }),
      ]);

      if (!openaiRes.ok) { appendMessage("assistant", "OpenAI script regeneration failed."); return; }
      if (!claudeRes.ok) { appendMessage("assistant", "Claude script regeneration failed."); return; }

      const openaiData = await openaiRes.json();
      const claudeData = await claudeRes.json();

      const openaiScript = openaiData?.script || "";
      const claudeScript = claudeData?.script || "";

      if (!openaiScript) { appendMessage("assistant", "OpenAI returned no script."); return; }
      if (!claudeScript) { appendMessage("assistant", "Claude returned no script."); return; }

      //CHANGED: Save BOTH scripts to the primitives table
      // before, only saved openaiScript to final_script column (now removed)
      // Now: saves openai_script and claude_script to their own dedicated columns
      // This ensures both scripts survive page refreshes
      const { error: saveError } = await supabase
        .from("primitives")
        .update({
          openai_script: openaiScript,   // saves OpenAI generated script
          claude_script: claudeScript,   // saves Claude generated script
        })
        .eq("script_id", scriptId);

      if (saveError) {
        console.error("Failed to save scripts to DB:", saveError);
        appendMessage("assistant", "Scripts generated but failed to save to database.");
        return;
      }

      // Also store in React state for immediate use in this session
      setOpenaiRegenScript(openaiScript);
      setClaudeRegenScript(claudeScript);

      appendMessage("assistant", "Two regenerated scripts are ready. Run the confidence check to compare them against the original checklist, then approve the better one.");

    } catch (err) {
      console.error("Regeneration error:", err);
      appendMessage("assistant", "Script regeneration failed.");
    } finally {
      setRegenLoading(false);
    }
  };

  // Validates both scripts against the original checklist (document_text)
  // Claude scores the OpenAI script, OpenAI scores the Claude script
  // This is cross-scoring to reduce bias
  const handleCrossConfidenceCheck = async () => {
    if (!openaiRegenScript || !claudeRegenScript) {
      appendMessage("assistant", "Both scripts must be generated before running the confidence check.");
      return;
    }

    // Use document_text as the source of truth (original checklist item)
    const checklistItem = draft?.document_text;
    if (!checklistItem) {
      appendMessage("assistant", "Original checklist not found in draft. Cannot run confidence check.");
      return;
    }

    setCrossConfidenceLoading(true);
    setCrossConfidenceResult(null);

    try {
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/crossCheckConfidence`, {
        method: "POST",
        headers: supabaseHeaders,
        body: JSON.stringify({
          openai_script: openaiRegenScript,
          claude_script: claudeRegenScript,
          checklist_item: checklistItem,  // original checklist is the source of truth
        }),
      });

      if (!res.ok) {
        appendMessage("assistant", "Confidence check failed.");
        return;
      }

      const result = await res.json();
      setCrossConfidenceResult(result);
      appendMessage(
        "assistant",
        `Confidence check complete.\nOpenAI script scored ${result.openai.score}/100.\nClaude script scored ${result.claude.score}/100.\nApprove the script you want to use for video generation.`
      );
    } catch (err) {
      console.error("Cross confidence error:", err);
      appendMessage("assistant", "Confidence check failed.");
    } finally {
      setCrossConfidenceLoading(false);
    }
  };

  // Saves the winning script to approved_script column in primitives table
  // The approved script is what gets used for video generation
  // The losing script is removed from the UI (but still saved in its own DB column)
  const handleApproveRegenScript = async (winner, loser) => {
    if (!winner) return;
    try {
      const { error: updateError } = await supabase
        .from("primitives")
        .update({ approved_script: winner, user_id: draft.user_id })
        .eq("script_id", draft.primitive_id);

      if (updateError) { appendMessage("assistant", "Failed to approve script."); return; }

      appendMessage("assistant", "Script approved and saved. It will now appear in View Approved Scripts.");

      // Remove the losing script from the UI only
      // It remains saved in the database (openai_script or claude_script column)
      if (loser === "openai") setOpenaiRegenScript("");
      else setClaudeRegenScript("");

      refresh(draft.id);
    } catch (err) {
      appendMessage("assistant", `Approval failed: ${err.message}`);
    }
  };

  // Removes the selected script from the UI only
  // The script remains saved in the database (openai_script or claude_script column)
  const handleDiscardRegenScript = (which) => {
    const ok = window.confirm(`Discard the ${which === "openai" ? "OpenAI" : "Claude"} script?`);
    if (!ok) return;
    if (which === "openai") setOpenaiRegenScript("");
    else setClaudeRegenScript("");
    setCrossConfidenceResult(null);
    appendMessage("assistant", `${which === "openai" ? "OpenAI" : "Claude"} script discarded.`);
  };

  // Runs Monte Carlo stress test on the primitive via the stress-test edge function
  // Returns a risk score and recommendation, error here
  const handleRunStressTest = async () => {
    setSimLoading(true);
    try {
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/stress-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }, //updated stress headers, new change
        body: JSON.stringify({ primitive }),
      });
      const data = await res.json();
      setSimResult(data);
      appendMessage("assistant", `Monte Carlo Simulation complete. The rule's risk score is ${data.riskScore}%. It is categorized as ${data.status}.`);
    } catch (err) {
      appendMessage("assistant", "Simulation failed. Please check network.");
    } finally {
      setSimLoading(false);
    }
  };

  // Returns a human-readable insight based on the risk score
  const getInsight = (riskScore) => {
    if (riskScore < 15) return "Low risk - safe to proceed.";
    if (riskScore < 30) return "Moderate risk - consider improvements.";
    return "High risk - needs revision.";
  };

  // Starts browser speech recognition and fills the input field with the transcript
  const startRecording = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { alert("Speech recognition not supported in this browser."); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => setListening(true);
    recognition.onresult = (event) => setInput(event.results[0][0].transcript);
    recognition.onend = () => setListening(false);
    recognition.start();
  };

  // Reusable score bar component for displaying confidence check results
  const ScoreBar = ({ label, value }) => (
    <div style={{ marginBottom: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
        <span style={{ fontSize: "12px", color: "#6b7280" }}>{label}</span>
        <span style={{ fontSize: "12px", fontWeight: "600" }}>{value}/100</span>
      </div>
      <div style={{ backgroundColor: "#e5e7eb", borderRadius: "999px", height: "6px" }}>
        <div style={{
          width: `${value}%`,
          backgroundColor: value >= 80 ? "#22c55e" : value >= 60 ? "#f59e0b" : "#ef4444",
          borderRadius: "999px",
          height: "6px",
          transition: "width 0.4s ease",
        }} />
      </div>
    </div>
  );

  return (
    <div className="conversation-panel">

      {/* Chat message history */}
      <div className="messages-panel">
        {messages.map((msg, i) => (
          <div key={i} className={msg.role === "user" ? "user-message" : "ai-message"}>
            {msg.content}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>

      {/* Monte Carlo simulation result and Approve primitive button */}
      <div className="safety-gate-section">
        {simResult && (
          <div className={`sim-card ${simResult.status.toLowerCase().replace(" ", "-")}`}>
            <div className="risk-header">
              <strong className="risk-title">Monte Carlo Reliability Test</strong>
              <span className="risk-badge">{simResult.status}</span>
            </div>
            <div className="risk-score">{simResult.riskScore}% Probability of Failure</div>
            <p className="risk-insight"><strong>Insight:</strong> {getInsight(simResult.riskScore)}</p>
            <p className="risk-recommendation"><strong>Recommendation:</strong> {simResult.recommendation}</p>
          </div>
        )}

        <div className="action-buttons">
          <button className="primary-btn" onClick={handleRunStressTest} disabled={simLoading}>
            {simLoading ? "Running 1,000 Iterations..." : "Run Reliability Simulation"}
          </button>
          <button className="primary-btn approve-btn" onClick={handleApprove} disabled={approving || simLoading}>
            {approving ? "Approved" : "Approve"}
          </button>
        </div>
      </div>

      {/* Voice recording button */}
      <button
        className="primary-btn"
        onClick={startRecording}
        style={{ backgroundColor: listening ? "red" : "#eee", marginBottom: "8px" }}
      >
        {listening ? "Listening..." : "Start Recording"}
      </button>

      {/* Text input for user instructions */}
      <textarea
        rows={3}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Type instructions or edits..."
      />
      <button onClick={() => handleUserInput(input)} disabled={loading || approving}>
        {loading ? "Processing..." : "Send"}
      </button>

      {/* Show Regenerate Script button after primitive is approved
          Hidden once scripts are generated (openaiRegenScript is no longer null) */}
      {showRegenerateButton && openaiRegenScript === null && !regenLoading && (
        <button className="primary-btn" style={{ marginTop: "16px" }} onClick={handleRegenerateScript}>
          Regenerate Script
        </button>
      )}

      {/* Loading indicator while both scripts are being generated */}
      {regenLoading && (
        <p style={{ fontSize: "13px", color: "#6b7280", marginTop: "12px" }}>
          Generating two script versions using enhanced primitives…
        </p>
      )}

      {/* Side-by-side script cards shown after regeneration */}
      {(openaiRegenScript || claudeRegenScript) && (
        <div style={{ marginTop: "24px" }}>
          <h3 style={{ fontSize: "15px", fontWeight: "600", marginBottom: "4px" }}>
            Regenerated Scripts
          </h3>
          {/* Clarifies to the user what the confidence check is measuring */}
          <p style={{ fontSize: "12px", color: "#6b7280", marginBottom: "12px" }}>
            Confidence scores are calculated by validating each script against the original checklist item.
          </p>

          {/* Show confidence check button only when both scripts exist and check hasn't run yet */}
          {openaiRegenScript && claudeRegenScript && !crossConfidenceResult && (
            <button
              className="primary-btn"
              style={{ marginBottom: "16px" }}
              onClick={handleCrossConfidenceCheck}
              disabled={crossConfidenceLoading}
            >
              {crossConfidenceLoading ? "Checking Confidence..." : "Check Confidence"}
            </button>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>

          {/*OpenAI Script Card */}
            {openaiRegenScript && (
              <div style={{
                padding: "16px",
                // Green border if OpenAI scored higher, grey otherwise
                border: crossConfidenceResult
                  ? crossConfidenceResult.openai.score >= crossConfidenceResult.claude.score
                    ? "2px solid #22c55e" : "1px solid #e5e7eb"
                  : "1px solid #e5e7eb",
                borderRadius: "8px",
                backgroundColor: "#f9fafb",
              }}>
                <h4 style={{ margin: "0 0 8px 0", fontSize: "14px" }}>
                  OpenAI Script
                  {crossConfidenceResult && crossConfidenceResult.openai.score >= crossConfidenceResult.claude.score && (
                    <span style={{ marginLeft: "8px", color: "#22c55e", fontSize: "12px" }}>✅ Higher Score</span>
                  )}
                </h4>
              {/*making the changes over here to make the openAI and claude script card editable*

              <p style={{ fontSize: "13px", whiteSpace: "pre-wrap", marginBottom: "12px" }}>
                  {openaiRegenScript}
                </p>*/}

              {editingOpenai ? (
                <textarea
                  value={openaiRegenScript}
                  onChange={(e) => setOpenaiRegenScript(e.target.value)}
                  rows={8}
                  style={{ width: "100%", fontSize: "13px", marginBottom: "12px" }}
                />
              ) : (
                <p style={{ fontSize: "13px", whiteSpace: "pre-wrap", marginBottom: "12px" }}>
                  {openaiRegenScript}
                </p>
              )}
              <button onClick={() => setEditingOpenai((prev) => !prev)}>
                {editingOpenai ? "Done Editing" : "Edit Script"}
              </button>

          {/* Show score breakdown after confidence check runs */}
                {crossConfidenceResult && (
                  <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: "12px", marginBottom: "12px" }}>
                    <p style={{ fontSize: "12px", fontWeight: "600", marginBottom: "8px" }}>
                      Scored by Claude AI · vs Original Checklist
                    </p>
                    <ScoreBar label="Accuracy" value={crossConfidenceResult.openai.accuracy} />
                    <ScoreBar label="Completeness" value={crossConfidenceResult.openai.completeness} />
                    <ScoreBar label="Clarity" value={crossConfidenceResult.openai.clarity} />
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: "8px", paddingTop: "8px", borderTop: "1px solid #e5e7eb" }}>
                      <span style={{ fontSize: "13px", fontWeight: "600" }}>Total</span>
                      <span style={{
                        fontSize: "13px", fontWeight: "700",
                        color: crossConfidenceResult.openai.score >= 80 ? "#22c55e"
                          : crossConfidenceResult.openai.score >= 60 ? "#f59e0b" : "#ef4444"
                      }}>
                        {crossConfidenceResult.openai.score}/100
                      </span>
                    </div>
                    <p style={{ fontSize: "12px", color: "#6b7280", marginTop: "6px" }}>
                      {crossConfidenceResult.openai.reason}
                    </p>
                  </div>
                )}

          {/* Approve saves this script to approved_script column in primitives
          Discard removes it from UI only still saved in openai_script column, should we remove from db too?? */}
                <div style={{ display: "flex", gap: "8px" }}>
                  <button className="primary-btn" style={{ flex: 1 }}
                    onClick={() => handleApproveRegenScript(openaiRegenScript, "claude")}>
                    Approve
                  </button>
                  <button className="secondary-btn" style={{ flex: 1 }}
                    onClick={() => handleDiscardRegenScript("openai")}>
                    Discard
                  </button>
                </div>
              </div>
            )}

            {/*Claude Script Card */}
            {claudeRegenScript && (
              <div style={{
                padding: "16px",
                // Green border if Claude scored higher, blue otherwise
                border: crossConfidenceResult
                  ? crossConfidenceResult.claude.score > crossConfidenceResult.openai.score
                    ? "2px solid #22c55e" : "1px solid #bfdbfe"
                  : "1px solid #bfdbfe",
                borderRadius: "8px",
                backgroundColor: "#f0f9ff",
              }}>
                <h4 style={{ margin: "0 0 8px 0", fontSize: "14px" }}>
                  Claude Script
                  {crossConfidenceResult && crossConfidenceResult.claude.score > crossConfidenceResult.openai.score && (
                    <span style={{ marginLeft: "8px", color: "#22c55e", fontSize: "12px" }}>✅ Higher Confidence ✅</span>
                  )}
                </h4>
              {/*making the changes over here to make the openAI and claude script card editable* editingClaude, setEditingClaude
                <p style={{ fontSize: "13px", whiteSpace: "pre-wrap", marginBottom: "12px" }}>
                  {claudeRegenScript}
                </p>*/}
              
              {editingClaude ? (
                <textarea
                  value={claudeRegenScript}
                  onChange={(e) => setOpenaiRegenScript(e.target.value)}
                  rows={8}
                  style={{ width: "100%", fontSize: "13px", marginBottom: "12px" }}
                />
              ) : (
                <p style={{ fontSize: "13px", whiteSpace: "pre-wrap", marginBottom: "12px" }}>
                  {claudeRegenScript}
                </p>
              )}
              <button onClick={() => setEditingClaude ((prev) => !prev)}>
                {editingClaude ? "Done Editing" : "Edit Script"}
              </button>

                {/* Show score breakdown after confidence check runs */}
                {crossConfidenceResult && (
                  <div style={{ borderTop: "1px solid #bfdbfe", paddingTop: "12px", marginBottom: "12px" }}>
                    <p style={{ fontSize: "12px", fontWeight: "600", marginBottom: "8px" }}>
                      Scored by OpenAI · vs Original Checklist
                    </p>
                    <ScoreBar label="Accuracy" value={crossConfidenceResult.claude.accuracy} />
                    <ScoreBar label="Completeness" value={crossConfidenceResult.claude.completeness} />
                    <ScoreBar label="Clarity" value={crossConfidenceResult.claude.clarity} />
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: "8px", paddingTop: "8px", borderTop: "1px solid #bfdbfe" }}>
                      <span style={{ fontSize: "13px", fontWeight: "600" }}>Total</span>
                      <span style={{
                        fontSize: "13px", fontWeight: "700",
                        color: crossConfidenceResult.claude.score >= 80 ? "#22c55e"
                          : crossConfidenceResult.claude.score >= 60 ? "#f59e0b" : "#ef4444"
                      }}>
                        {crossConfidenceResult.claude.score}/100
                      </span>
                    </div>
                    <p style={{ fontSize: "12px", color: "#6b7280", marginTop: "6px" }}>
                      {crossConfidenceResult.claude.reason}
                    </p>
                  </div>
                )}

                {/* Approve saves this script to approved_script column in primitives
                    Discard removes it from UI only, still saved in claude_script column */}
                <div style={{ display: "flex", gap: "8px" }}>
                  <button className="primary-btn" style={{ flex: 1 }}
                    onClick={() => handleApproveRegenScript(claudeRegenScript, "openai")}>
                    Approve
                  </button>
                  <button className="secondary-btn" style={{ flex: 1 }}
                    onClick={() => handleDiscardRegenScript("claude")}>
                    Discard
                  </button>
                </div>
              </div>
            )}

          </div>
        </div>
      )}
    </div>
  );
}
