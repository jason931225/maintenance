import { useEffect, useId, useRef, useState } from "react";

import type { EquipmentLookupResponse } from "../../api/types";
import { ko } from "../../i18n/ko";
import { cn } from "../../lib/utils";

interface ManagementNoComboboxProps {
  /** Stable id for the input, so an external <label htmlFor> associates. */
  id: string;
  /** The current management-no string (free text — the submitted value). */
  value: string;
  /** Fired on every keystroke and on selecting a suggestion. */
  onChange: (managementNo: string) => void;
  /** Equipment matches for the current query, shown as labelled suggestions. */
  suggestions: EquipmentLookupResponse[];
  placeholder?: string;
  ariaRequired?: boolean;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  className?: string;
}

/**
 * Free-text typeahead for the equipment management number. Replaces the native
 * `<datalist>` autocomplete (which silently fails on mobile Safari and renders
 * `<option>` labels inconsistently) with the WAI-ARIA combobox pattern: a text
 * input plus a popup listbox of equipment suggestions.
 *
 * Unlike the shared {@link Combobox}, the value here is the management-no STRING
 * itself, not an option id — the user may type a not-yet-registered number, and
 * the chosen string is what the form submits. Picking a suggestion just fills in
 * its management number. Full keyboard support (↑/↓/Enter/Escape).
 */
export function ManagementNoCombobox({
  id,
  value,
  onChange,
  suggestions,
  placeholder,
  ariaRequired,
  ariaInvalid,
  ariaDescribedBy,
  className,
}: ManagementNoComboboxProps) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const hasSuggestions = suggestions.length > 0;
  const safeActiveIndex = hasSuggestions
    ? Math.min(activeIndex, suggestions.length - 1)
    : 0;

  // Close on outside pointer-down, matching the rest of the console's menus.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  function managementNoOf(equipment: EquipmentLookupResponse) {
    return equipment.management_no ?? equipment.equipment_no;
  }

  function commit(equipment: EquipmentLookupResponse) {
    onChange(managementNoOf(equipment));
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
        if (!hasSuggestions) return;
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        setActiveIndex((current) => (current + 1) % suggestions.length);
        break;
      case "ArrowUp":
        if (!hasSuggestions) return;
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        setActiveIndex(
          (current) =>
            (current - 1 + suggestions.length) % suggestions.length,
        );
        break;
      case "Enter":
        if (open && hasSuggestions && suggestions[safeActiveIndex]) {
          event.preventDefault();
          commit(suggestions[safeActiveIndex]);
        }
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        break;
      default:
        break;
    }
  }

  const showList = open && hasSuggestions;
  const activeOptionId =
    showList && suggestions[safeActiveIndex]
      ? `${listboxId}-opt-${suggestions[safeActiveIndex].id}`
      : undefined;

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        aria-required={ariaRequired}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        className="min-h-12 w-full rounded border border-line bg-white px-3 py-2 text-base text-ink outline-none transition focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-red-500"
        onChange={(event) => {
          onChange(event.currentTarget.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onFocus={() => {
          if (hasSuggestions) setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {showList ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={ko.intake.managementNoSuggestions}
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-line bg-white py-1 shadow-lg"
        >
          {suggestions.map((equipment, index) => {
            const isActive = index === safeActiveIndex;
            const managementNo = managementNoOf(equipment);
            const isSelected = managementNo === value;
            return (
              <li
                key={equipment.id}
                id={`${listboxId}-opt-${equipment.id}`}
                role="option"
                aria-selected={isSelected}
                className={cn(
                  "cursor-pointer px-3 py-2 text-sm",
                  isActive ? "bg-muted-panel" : "bg-white",
                )}
                // Pointer-down (not click) so the input's outside handler does
                // not close the list before the selection lands.
                onPointerDown={(event) => {
                  event.preventDefault();
                  commit(equipment);
                }}
                onMouseEnter={() => {
                  setActiveIndex(index);
                }}
              >
                <span className="block truncate font-medium text-ink">
                  {managementNo}
                </span>
                <span className="block truncate text-xs text-steel">
                  {`${equipment.model ?? ko.common.unknown} / ${equipment.customer.name}`}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
