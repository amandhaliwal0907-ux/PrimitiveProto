import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

const PRIMITIVE_FIELDS = [
  "who",
  "trigger_condition",
  "preconditions",
  "required_action",
  "verification_method",
  "failure_consequences",
];

export default function ConversationAgent({ draft, refresh }) {
  // State 
  const initialPrimitive = draft?.enhanced_primitive || draft?.primitive_draft || {};
  const [primitive, setPrimitive] = useState(initialPrimitive);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");
  const [regeneratedScript, setRegeneratedScript] = useState("");
  const [showRegenerateButton, setShowRegenerateButton] = useState(false);

  const chatEndRef = useRef(null);
  
const [completionMessageShown, setCompletionMessageShown] = useState(false);
const [approving, setApproving] = useState(false);
const [simResult, setSimResult] = useState(null);
const [simLoading, setSimLoading] = useState(false);
const [listening, setListening] = useState(false); // microphone active


  // Sync primitive when draft changes 
  useEffect(() => {
    setPrimitive(draft?.enhanced_primitive || draft?.primitive_draft || {});
  }, [draft]);

  const missingFields = () =>
    PRIMITIVE_FIELDS.filter((f) => primitive?.[f] === undefined);



  const scrollToBottom = () => chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  const appendMessage = (role, content) => {
    setMessages((prev) => [...prev, { role, content }]);
    scrollToBottom();
  };

useEffect(() => {
  if (!completionMessageShown) {
    appendMessage(
      "assistant",
      `All required fields are complete.\n\nDo you want to make any further changes or approve?`
    );
    setCompletionMessageShown(true);
  }
}, [primitive, completionMessageShown]);

  // Accept / Skip 
  const savePrimitiveDraft = async (updated) => {
    setPrimitive(updated);
    await supabase
      .from("draft_scripts")
      .update({ primitive_draft: updated })
      .eq("id", draft.id);
  };

 


  //  Free Text Input 
  const handleUserInput = async (text) => {
    if (!text.trim()) return;

    appendMessage("user", text);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch(
        "https://javlnpnawmfpypapauyc.supabase.co/functions/v1/smart-action",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instruction: text,
            messages,
            currentPrimitive: primitive,
          }),
        }
      );

      const data = await res.json();

      if (data?.updates && Object.keys(data.updates).length > 0) {
        const updatedPrimitive = { ...primitive, ...data.updates };
        await savePrimitiveDraft(updatedPrimitive);

        appendMessage(
          "assistant",
          `Primitive Updated:\n${JSON.stringify(
            updatedPrimitive,
            null,
            2
          )}\n\nDo you want to make further changes or approve?`
        );
        setPrimitive(updatedPrimitive);
      } else {
        appendMessage(
          "assistant",
          `${data?.aiMessage || "Invalid request. Please only give edit, add, remove instructions."}\n\nDo you want to make further changes or approve?`
        );
      }
    } catch {
      appendMessage("assistant", "Could not process instruction.");
    } finally {
      setLoading(false);
    }
  };

  //  Approve Primitive 
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

      const { error } = await supabase
        .from("primitives")
        .insert({
          script_id: draft.primitive_id,
          primitive_json: primitive,
          user_id: draft.user_id
        });

      if (error) {
        appendMessage("assistant", `Approval failed: ${error.message}`);
        return;
      }

      const { error: workflowError } = await supabase
        .from("draft_scripts")
        .update({ workflow_state: "video_ready",  script_status: "approved",
  primitive_status: "approved" })
        .eq("id", draft.id);

      if (workflowError) {
        appendMessage("assistant", `Failed to update draft workflow: ${workflowError.message}`);
        return;
      }

      appendMessage("assistant", "Primitive approved for video generation.");
      refresh();
      setShowRegenerateButton(true);
    } catch (err) {
      appendMessage("assistant", `Approval failed: ${err.message}`);
      console.error("handleApprove error:", err);
    } finally {
      setApproving(true);
    }
  };

  // Regenerate Script 
  const handleRegenerateScript = async () => {
    setLoading(true);
    try {
      if (!draft?.primitive_id) {
        appendMessage("assistant", "Cannot regenerate: primitive_id missing in draft.");
        return;
      }

      const scriptId = draft.primitive_id;

      const { data: primData, error: fetchError } = await supabase
        .from("primitives")
        .select("primitive_json")
        .eq("script_id", scriptId)
        .maybeSingle();

      if (fetchError) {
        appendMessage("assistant", "Failed to fetch primitive.");
        return;
      }

      if (!primData?.primitive_json) {
        appendMessage("assistant", "Primitive data not found, cannot regenerate.");
        return;
      }

      const res = await fetch(
        "https://javlnpnawmfpypapauyc.supabase.co/functions/v1/smooth-action",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ primitive: primData.primitive_json }),
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        appendMessage("assistant", "Script regeneration failed (API error).");
        return;
      }

      const data = await res.json();

      if (!data?.script) {
        appendMessage("assistant", "Script regeneration returned no script.");
        return;
      }

      const { error: updateError } = await supabase
        .from("primitives")
        .update({ final_script: data.script, user_id: draft.user_id })
        .eq("script_id", scriptId);

      if (updateError) {
        appendMessage("assistant", "Failed to save regenerated script.");
        return;
      }

      setRegeneratedScript(data.script);
      appendMessage("assistant", "Script regenerated and saved successfully.");

    } catch (err) {
      appendMessage("assistant", "Script regeneration failed.");
    } finally {
      setLoading(false);
    }
  };

const handleRunStressTest = async () => {
  setSimLoading(true);
  try {
    
    const res = await fetch(
      "https://javlnpnawmfpypapauyc.supabase.co/functions/v1/stress-test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primitive }),
      }
    );
    const data = await res.json();
    setSimResult(data);
    
  
    appendMessage("assistant", `Monte Carlo Simulation complete. The rule's risk score is ${data.riskScore}%. It is categorized as ${data.status}.`);
  } catch (err) {
    appendMessage("assistant", "Simulation failed. Please check network.");
  } finally {
    setSimLoading(false);
  }
};

  
  //  Approve Regenerated Script
 const handleApproveRegeneratedScript = async () => {
  if (!regeneratedScript) return;

  const { error: updateError } = await supabase
    .from("primitives")
    .update({ approved_script: regeneratedScript, user_id: draft.user_id })
    .eq("script_id", draft.primitive_id);

  if (updateError) {
    appendMessage("assistant", "Failed to approve regenerated script.");
    return;
  }

  appendMessage("assistant", "Regenerated script approved.");

refresh(draft.id);


  setRegeneratedScript("");

  
};

const getInsight = (riskScore) => {
  if (riskScore < 15) return "Low risk - safe to proceed.";
  if (riskScore < 30) return "Moderate risk - consider improvements.";
  return "High risk - needs revision.";
};

const startRecording = () => {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    alert("Speech recognition not supported in this browser.");
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    setListening(true);
  };

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    setInput(transcript); // Fill the chat input textarea
  };

  recognition.onend = () => {
    setListening(false);
  };

  recognition.start();
};

// Render 
  return (
    <div className="conversation-panel">
      <div className="messages-panel">
        {messages.map((msg, i) => (
          <div key={i} className={msg.role === "user" ? "user-message" : "ai-message"}>
            {msg.content}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>

    
       
       {/* --- START OF CORRECTED SECTION --- */}
<div className="safety-gate-section">
  
  {/* Monte Carlo Output */}
  {simResult && (
    <div className={`sim-card ${simResult.status.toLowerCase().replace(" ", "-")}`}>
      <div className="risk-header">
        <strong className="risk-title">Monte Carlo Reliability Test</strong>
        <span className="risk-badge">{simResult.status}</span>
      </div>

      <div className="risk-score">
        {simResult.riskScore}% Probability of Failure
      </div>

      <p className="risk-insight">
        <strong>Insight:</strong> {getInsight(simResult.riskScore)}
      </p>

      <p className="risk-recommendation">
        <strong>Recommendation:</strong> {simResult.recommendation}
      </p>
    </div>
  )}

  <div className="action-buttons">
    {/* Step 1: Run Simulation */}
    <button 
      className="primary-btn" 
      onClick={handleRunStressTest} 
      disabled={simLoading}
    >
      {simLoading ? "Running 1,000 Iterations..." : "Run Reliability Simulation"}
    </button>

    {/* Step 2: Approve */}
    <button 
      className="primary-btn approve-btn"
      onClick={handleApprove} 
      disabled={approving || simLoading}
    >
      {approving ? "Approved" : "Approve"}
    </button>
  </div>
</div>
 


<button 
  className="primary-btn"
  onClick={startRecording}
  style={{ backgroundColor: listening ? "red" : "#eee", marginBottom: "8px" }}
>
  {listening ? "Listening..." : " Start Recording"}
</button>

      <textarea
        rows={3}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder='Type instructions or edits...'
      />
      <button onClick={() => handleUserInput(input)} disabled={loading || approving}>
        {loading ? "Processing..." : "Send"}
      </button>

      {showRegenerateButton && !regeneratedScript && !loading && (
        <button className="primary-btn" onClick={handleRegenerateScript}>
          Regenerate Script
        </button>
      )}

      {regeneratedScript && (
        <div className="regenerated-script">
          <h4>Regenerated Script Preview</h4>

          <textarea
            rows={8}
            value={regeneratedScript}
            onChange={(e) => setRegeneratedScript(e.target.value)}
          />


          <button onClick={handleApproveRegeneratedScript}>
            Approve Regenerated Script
          </button>
        </div>
      )}
    </div>
  );
}
