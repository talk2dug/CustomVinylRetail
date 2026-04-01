import React from "react";

export const BrandWatermark: React.FC = () => {
  return (
    <div
      style={{
        position: "absolute",
        bottom: 60,
        right: 20,
        fontSize: 20,
        color: "rgba(255,255,255,0.5)",
        fontFamily: "Arial, sans-serif",
        fontWeight: "bold",
        textShadow: "1px 1px 3px rgba(0,0,0,0.7)",
        pointerEvents: "none",
      }}
    >
      Blue Ridge Custom Co
    </div>
  );
};
