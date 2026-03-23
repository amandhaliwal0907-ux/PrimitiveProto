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

const isEmptyValue = (value) =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0);

export default function ConversationAgent({ draft, refresh }) {
  const initialPrimitive = draft?.enhanced_primitive || draft?.primitive_draft || {};

  const [primitive, setPrimitive] = useState(initialPrimitive);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");
  const [regeneratedScript, setRegeneratedScript] = useState("");
  const [showRegenerateButton, setShowRegenerateButton] = useState(false);
  const [guidedStep, setGuidedStep] = useState(0);

  const chatEndRef = useRef(null);
  const hasShownCompletionRef = useRef(false);

  // ---------------- Sync when draft changes ----------------
  useEffect(() => {
    setPrimitive(draft?.enhanced_primitive || draft?.primitive_draft || {});
    setMessages([]);
    setLoading(false);
    setInput("");
    setRegeneratedScript("");
    setShowRegenerateButton(false);
    setGuidedStep(0);
    hasShownCompletionRef.current = false;
  }, [draft]);

  const missingFields = () =>
    PRIMITIVE_FIELDS.filter((field) => isEmptyValue(primitive?.[field]));

  const scrollToBottom = () => {
    setTimeout(() => {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 0);
  };

  const appendMessage = (role, content) => {
    setMessages((prev) => [...prev, { role, content }]);
    scrollToBottom();
  };

  // ---------------- Guided helper ----------------
  useEffect(() => {
    const fields = missingFields();

    if (fields.length > 0 && guidedStep < fields.length) {
      const field = fields[guidedStep];
      const suggestion = draft?.enhanced_primitive?.[field] || "";

      const alreadyShown = messages.some(
        (msg) =>
          msg.role === "assistant" &&
          msg.content.includes(`Field "${field}" is missing`)
      );

      if (!alreadyShown) {
        appendMessage(
          "assistant",
          `Field "${field}" is missing. Suggested: "${suggestion}"`
        );
      }
    }

    if (fields.length === 0 && !hasShownCompletionRef.current) {
      hasShownCompletionRef.current = true;
      appendMessage(
        "assistant",
        "All required fields are complete.\n\nYou can approve this primitive now."
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guidedStep, primitive]);

  // ---------------- Save Primitive Draft ----------------
  const savePrimitiveDraft = async (updated) => {
    setPrimitive(updated);

    const { error } = await supabase
      .from("draft_scripts")
      .update({ primitive_draft: updated })
      .eq("id", draft.id);

    if (error) {
      console.error("Failed to save primitive draft:", error);
      appendMessage("assistant", "Failed to save draft changes.");
    }
  };

  // ---------------- Accept / Skip ----------------
  const handleAcceptAI = async () => {
    const fields = missingFields();
    if (!fields.length) return;

    const field = fields[guidedStep];
    const value = draft?.enhanced_primitive?.[field];

    if (!isEmptyValue(value)) {
      const updated = { ...primitive, [field]: value };
      await savePrimitiveDraft(updated);
      appendMessage("assistant", `Accepted AI suggestion for "${field}".`);
      setGuidedStep((prev) => prev + 1);
    } else {
      appendMessage("assistant", `No AI suggestion available for "${field}".`);
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

    const userMessage = { role: "user", content: text };
    const updatedMessages = [...messages, userMessage];

    setMessages(updatedMessages);
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
            messages: updatedMessages,
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
          `Primitive updated.\n${JSON.stringify(updatedPrimitive, null, 2)}`
        );
        setPrimitive(updatedPrimitive);
      } else {
        appendMessage("assistant", data?.aiMessage || "AI did not respond.");
      }
    } catch (err) {
      console.error("handleUserInput error:", err);
      appendMessage("assistant", "Could not process instruction.");
    } finally {
      setLoading(false);
    }
  };

  // ---------------- Approve Primitive ----------------
  const handleApprove = async () => {
    try {
      if (!draft?.id) {
        appendMessage("assistant", "Cannot approve: draft id is missing.");
        return;
      }

      if (!primitive || Object.keys(primitive).length === 0) {
        appendMessage("assistant", "Cannot approve: primitive is empty.");
        return;
      }

      const { error: saveEnhancedError } = await supabase
        .from("draft_scripts")
        .update({
          enhanced_primitive: primitive,
          workflow_state: "video_ready",
        })
        .eq("id", draft.id);

      if (saveEnhancedError) {
        appendMessage(
          "assistant",
          `Failed to approve primitive: ${saveEnhancedError.message}`
        );
        return;
      }

      appendMessage(
        "assistant",
        `Primitive approved.\n\nNow click "Regenerate Script" to generate the final approved script.`
      );

      setShowRegenerateButton(true);
    } catch (err) {
      console.error("handleApprove error:", err);
      appendMessage("assistant", `Approval failed: ${err.message}`);
    }
  };

  // ---------------- Regenerate Script ----------------
  const handleRegenerateScript = async () => {
    setLoading(true);

    try {
      if (!draft?.id) {
        appendMessage("assistant", "Cannot regenerate: draft id missing.");
        return;
      }

      const primitiveToUse = primitive;

      if (!primitiveToUse || Object.keys(primitiveToUse).length === 0) {
        appendMessage("assistant", "Primitive data not found, cannot regenerate.");
        return;
      }

      const res = await fetch(
        "https://javlnpnawmfpypapauyc.supabase.co/functions/v1/smooth-action",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ primitive: primitiveToUse }),
        }
      );

      if (!res.ok) {
        appendMessage("assistant", "Script regeneration failed (API error).");
        return;
      }

      const data = await res.json();

      if (!data?.script) {
        appendMessage("assistant", "Script regeneration returned no script.");
        return;
      }

      setRegeneratedScript(data.script);
      appendMessage(
        "assistant",
        "Script regenerated successfully. Review it below, then click 'Approve Regenerated Script' to save it."
      );
    } catch (err) {
      console.error("handleRegenerateScript error:", err);
      appendMessage("assistant", "Script regeneration failed.");
    } finally {
      setLoading(false);
    }
  };

  // ---------------- Approve Regenerated Script ----------------
  const handleApproveRegeneratedScript = async () => {
    if (!regeneratedScript) return;

    try {
      if (!draft?.id) {
        appendMessage("assistant", "Cannot save approved script: draft id missing.");
        return;
      }

      if (!draft?.user_id) {
        appendMessage("assistant", "Cannot save approved script: user id missing.");
        return;
      }

      const { data: lastVersionRows, error: versionError } = await supabase
        .from("approved_scripts")
        .select("version_number")
        .eq("draft_id", draft.id)
        .order("version_number", { ascending: false })
        .limit(1);

      if (versionError) {
        appendMessage(
          "assistant",
          `Failed to get version number: ${versionError.message}`
        );
        return;
      }

      const nextVersion = (lastVersionRows?.[0]?.version_number || 0) + 1;

      const { error: insertError } = await supabase
        .from("approved_scripts")
        .insert([
          {
            draft_id: draft.id,
            user_id: draft.user_id,
            primitive_json: primitive,
            final_script: regeneratedScript,
            approved_script: regeneratedScript,
            version_number: nextVersion,
            updated_at: new Date().toISOString(),
          },
        ]);

      if (insertError) {
        appendMessage("assistant", "Failed to approve regenerated script.");
        return;
      }

      appendMessage(
        "assistant",
        `Regenerated script approved and saved to history as version v${nextVersion}.`
      );

      setRegeneratedScript("");
      setShowRegenerateButton(false);

      await refresh();
    } catch (err) {
      console.error("handleApproveRegeneratedScript error:", err);
      appendMessage("assistant", "Failed to approve regenerated script.");
    }
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
            <button className="primary-btn" onClick={handleAcceptAI} disabled={loading}>
              Accept AI
            </button>
            <button className="secondary-btn" onClick={handleSkip} disabled={loading}>
              Skip
            </button>
          </>
        )}

        <button className="primary-btn" onClick={handleApprove} disabled={loading}>
          Approve Primitive
        </button>
      </div>

      <textarea
        rows={3}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Type instructions or edits..."
      />

      <button onClick={() => handleUserInput(input)} disabled={loading || !input.trim()}>
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
          <button onClick={handleApproveRegeneratedScript} disabled={loading}>
            Approve Regenerated Script
          </button>
        </div>
      )}
    </div>
  );
}
