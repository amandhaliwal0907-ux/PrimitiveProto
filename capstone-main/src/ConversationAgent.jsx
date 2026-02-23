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
  // ---------------- State ----------------
  const initialPrimitive = draft?.enhanced_primitive || draft?.primitive_draft || {};
  const [primitive, setPrimitive] = useState(initialPrimitive);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");
  const [regeneratedScript, setRegeneratedScript] = useState("");
  const [showRegenerateButton, setShowRegenerateButton] = useState(false);
  const [guidedStep, setGuidedStep] = useState(0);
  const chatEndRef = useRef(null);

  // ---------------- Sync primitive when draft changes ----------------
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
    const fields = missingFields();

    // Only show guided-step suggestions
    if (fields.length > 0 && guidedStep < fields.length) {
      const field = fields[guidedStep];
      const suggestion = draft?.enhanced_primitive?.[field] || "";

      appendMessage(
        "assistant",
        `Field "${field}" is missing. Suggested: "${suggestion}"`
      );
    }

    // Show completion message only once
    if (fields.length === 0 && messages[messages.length - 1]?.role !== "assistant") {
      appendMessage(
        "assistant",
        `All required fields are complete.\n\nDo you want to make any further changes or approve?`
      );
    }
  }, [guidedStep, primitive]);

  // ---------------- Accept / Skip ----------------
  const savePrimitiveDraft = async (updated) => {
    setPrimitive(updated);
    await supabase
      .from("draft_scripts")
      .update({ primitive_draft: updated })
      .eq("id", draft.id);
  };

  const handleAcceptAI = async () => {
    const fields = missingFields();
    if (!fields.length) return;
    const field = fields[guidedStep];
    const value = draft?.enhanced_primitive?.[field];
    if (value) {
      const updated = { ...primitive, [field]: value };
      await savePrimitiveDraft(updated);
      appendMessage("assistant", `Accepted AI suggestion for "${field}".`);
      setGuidedStep((prev) => prev + 1);
    }
  };

  const handleSkip = async () => {
    const fields = missingFields();
    if (!fields.length) return;
    const field = fields[guidedStep];
    const updated = { ...primitive, [field]: "" };
    await savePrimitiveDraft(updated);
    appendMessage("assistant", `Skipped field "${field}".`);
    setGuidedStep((prev) => prev + 1);
  };

  // ---------------- Free Text Input ----------------
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
          `${data?.aiMessage || "AI did not respond."}\n\nDo you want to make further changes or approve?`
        );
      }
    } catch {
      appendMessage("assistant", "Could not process instruction.");
    } finally {
      setLoading(false);
    }
  };

  // ---------------- Approve Primitive ----------------
  const handleApprove = async () => {
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
        });

      if (error) {
        appendMessage("assistant", `Approval failed: ${error.message}`);
        return;
      }

      const { error: workflowError } = await supabase
        .from("draft_scripts")
        .update({ workflow_state: "video_ready" })
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
    }
  };

  // ---------------- Regenerate Script ----------------
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
        .update({ final_script: data.script })
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

  // ---------------- Approve Regenerated Script ----------------
 const handleApproveRegeneratedScript = async () => {
  if (!regeneratedScript) return;

  const { error: updateError } = await supabase
    .from("primitives")
    .update({ approved_script: regeneratedScript })
    .eq("script_id", draft.primitive_id);

  if (updateError) {
    appendMessage("assistant", "Failed to approve regenerated script.");
    return;
  }

  appendMessage("assistant", "Regenerated script approved.");

  // Pass the approved script to parent so it updates the list immediately
  refresh(draft.id, { ...draft, approved_script: regeneratedScript });

  // Clear local regenerated script state
  setRegeneratedScript("");

  
};

  // ---------------- Render ----------------
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

      <div className="guided-buttons">
        {missingFields().length > 0 && (
          <>
            <button className="primary-btn" onClick={handleAcceptAI}>Accept AI</button>
            <button className="secondary-btn" onClick={handleSkip}>Skip</button>
          </>
        )}
        <button className="primary-btn" onClick={handleApprove}>Approve</button>
      </div>

      <textarea
        rows={3}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder='Type instructions or edits...'
      />
      <button onClick={() => handleUserInput(input)} disabled={loading}>
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