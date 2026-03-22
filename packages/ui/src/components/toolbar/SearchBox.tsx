import React from "react";
import { Search } from "lucide-react";

interface SearchBoxProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchInputRef?: React.Ref<HTMLInputElement>;
}

export function SearchBox({ searchQuery, onSearchChange, searchInputRef }: SearchBoxProps) {
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <Search size={12} style={{ position: "absolute", left: 6, color: "#999", pointerEvents: "none" }} />
      <input
        ref={searchInputRef}
        type="text"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search… (⌘K)"
        aria-label="Search tasks"
        style={{
          padding: "3px 24px 3px 22px",
          border: "1px solid #ddd",
          borderRadius: 3,
          fontSize: 11,
          width: 140,
          outline: "none",
          background: "#f8f8f8",
        }}
      />
      {searchQuery && (
        <button
          type="button"
          onClick={() => onSearchChange("")}
          aria-label="Clear search"
          style={{
            position: "absolute",
            right: 2,
            top: "50%",
            transform: "translateY(-50%)",
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: 12,
            color: "#888",
            padding: "0 4px",
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
