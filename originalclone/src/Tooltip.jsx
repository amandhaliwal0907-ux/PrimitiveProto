import React, { useState } from "react";
import "./Tooltip.css";

function Tooltip({ text, children }) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="tooltip-wrapper">
      <div
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        className="tooltip-trigger"
      >
        {children}
      </div>
      {visible && <div className="tooltip-box">{text}</div>}
    </div>
  );
}

export default Tooltip;
