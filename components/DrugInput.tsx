"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { DrugSuggestion } from "@/lib/interactions";

type Props = {
  fieldLabel: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
};

export default function DrugInput({ fieldLabel, value, onValueChange, placeholder }: Props) {
  const inputId = useId();
  const [suggestions, setSuggestions] = useState<DrugSuggestion[]>([]);
  const [isListOpen, setIsListOpen] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const skipNextFetch = useRef(false);

  useEffect(() => {
    // Picking a suggestion sets the input's value; that must not trigger a new search.
    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }
    const query = value.trim();
    if (!query) {
      setSuggestions([]);
      return;
    }
    const abortController = new AbortController();
    const debounceTimer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/drugs?q=${encodeURIComponent(query)}`, { signal: abortController.signal });
        const payload = (await response.json()) as { results?: DrugSuggestion[] };
        setSuggestions(payload.results ?? []);
        setActiveSuggestionIndex(-1);
      } catch {
        /* aborted or offline — keep previous suggestions */
      }
    }, 150);
    return () => {
      clearTimeout(debounceTimer);
      abortController.abort();
    };
  }, [value]);

  const pick = (suggestion: DrugSuggestion) => {
    skipNextFetch.current = true;
    onValueChange(suggestion.name);
    setIsListOpen(false);
    setSuggestions([]);
  };

  const shouldShowList = isListOpen && suggestions.length > 0;

  return (
    <div className="field">
      <label htmlFor={inputId}>{fieldLabel}</label>
      <input
        id={inputId}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={shouldShowList}
        aria-controls={`${inputId}-list`}
        onChange={(event) => {
          onValueChange(event.target.value);
          setIsListOpen(true);
        }}
        onFocus={() => setIsListOpen(true)}
        onBlur={() => setTimeout(() => setIsListOpen(false), 120)}
        onKeyDown={(event) => {
          if (!shouldShowList) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveSuggestionIndex((index) => Math.min(index + 1, suggestions.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveSuggestionIndex((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter" && activeSuggestionIndex >= 0) {
            event.preventDefault();
            pick(suggestions[activeSuggestionIndex]);
          } else if (event.key === "Escape") {
            setIsListOpen(false);
          }
        }}
      />
      {shouldShowList && (
        <ul className="suggestions" id={`${inputId}-list`} role="listbox">
          {suggestions.map((suggestion, suggestionIndex) => (
            <li
              key={suggestion.slug}
              role="option"
              aria-selected={suggestionIndex === activeSuggestionIndex}
              className={suggestionIndex === activeSuggestionIndex ? "active" : undefined}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(suggestion);
              }}
            >
              <span>{suggestion.name}</span>
              {suggestion.matched && suggestion.matched.toLowerCase() !== suggestion.name.toLowerCase() && (
                <span className="muted"> · {suggestion.matched}</span>
              )}
              <span className={`tag tag-${suggestion.kind}`}>{suggestion.kind}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
