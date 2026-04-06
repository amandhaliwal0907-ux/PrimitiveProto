import React from "react";
import "./ProcessStepper.css";

const WORKFLOW_STEPS = [
  { id: 1, label: "Upload Checklist", state: "upload" },
  { id: 2, label: "Generate Script", state: "generate_script" },
  { id: 3, label: "Review Draft", state: "primitive_clarification" },
  { id: 4, label: "Enhance Primitive", state: "enhanced_primitive" },
  { id: 5, label: "Chat & Refine", state: "chat_refinement" },
  { id: 6, label: "Approve Script", state: "approved" },
];

function ProcessStepper({ currentStep, completedSteps = [] }) {
  const getStepStatus = (stepId) => {
    if (completedSteps.includes(stepId)) return "completed";
    if (currentStep === stepId) return "current";
    if (stepId < currentStep) return "completed";
    return "pending";
  };

  return (
    <div className="process-stepper">
      <h4 className="stepper-title">Workflow Progress</h4>
      <div className="stepper-container">
        {WORKFLOW_STEPS.map((step, index) => (
          <React.Fragment key={step.id}>
            <div className={`stepper-step ${getStepStatus(step.id)}`}>
              <div className="step-circle">
                {getStepStatus(step.id) === "completed" ? (
                  <span className="step-checkmark">✓</span>
                ) : (
                  <span className="step-number">{step.id}</span>
                )}
              </div>
              <div className="step-label">{step.label}</div>
            </div>

            {index < WORKFLOW_STEPS.length - 1 && (
              <div
                className={`stepper-line ${
                  getStepStatus(step.id + 1) === "completed"
                    ? "completed"
                    : getStepStatus(step.id) === "current"
                    ? "current"
                    : "pending"
                }`}
              />
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

export default ProcessStepper;
