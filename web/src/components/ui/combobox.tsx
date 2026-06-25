import { Check, ChevronsUpDown, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { ko } from "../../i18n/ko";
import { cn } from "../../lib/utils";

export interface ComboboxOption {
  /** The value submitted to the API (e.g. a UUID). Never rendered as text. */
  id: string;
  /** The human-readable primary label shown to the user. */
  label: string;
  /** Optional secondary line (e.g. phone, model, customer). */
  sublabel?: string;
}

interface ComboboxProps {
  /** Stable id for the input, so an external <label htmlFor> associates. */
  id: string;
  options: ComboboxOption[];
  /** Currently selected option id, or "" when nothing is chosen. */
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  /** Accessible name when no visible <label> is wired by the caller. */
  ariaLabel?: string;
  disabled?: boolean;
  /** Allow clearing the selection back to "" (default true). */
  clearable?: boolean;
  className?: string;
}

/**
 * Accessible, searchable single-select combobox built on the WAI-ARIA combobox
 * pattern (text input + popup listbox). It shows each option's HUMAN label and
 * stores its `id` internally, so callers submit the id while the user never
 * sees a raw UUID. Filters options client-side by label/sublabel as the user
 * types; full keyboard support (↑/↓/Enter/Escape/Home/End).
 */
export function Combobox({
  id,
  options,
  value,
  onChange,
  placeholder,
  ariaLabel,
  disabled = false,
  clearable = true,
  className,
}: ComboboxProps) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () => options.find((option) => option.id === value),
    [options, value],
  );

  // While closed, the input shows the selected label; while open it shows the
  // live query so the user can type to filter.
  const inputValue = open ? query : (selected?.label ?? "");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => {
      const haystack = `${option.label} ${option.sublabel ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [options, query]);

  // Clamp the highlighted row into range as the filtered set shrinks. Derived
  // during render (no effect) so the index is always valid for the current list.
  const safeActiveIndex =
    filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1);

  // Close on outside pointer-down, matching the rest of the console's menus.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  function commit(option: ComboboxOption) {
    onChange(option.id);
    setOpen(false);
    setQuery("");
  }

  function openList() {
    if (disabled) return;
    setQuery("");
    setActiveIndex(
      Math.max(
        0,
        options.findIndex((option) => option.id === value),
      ),
    );
    setOpen(true);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) {
          openList();
          return;
        }
        setActiveIndex((current) =>
          filtered.length === 0 ? 0 : (current + 1) % filtered.length,
        );
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) {
          openList();
          return;
        }
        setActiveIndex((current) =>
          filtered.length === 0
            ? 0
            : (current - 1 + filtered.length) % filtered.length,
        );
        break;
      case "Home":
        if (open) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case "End":
        if (open) {
          event.preventDefault();
          setActiveIndex(Math.max(0, filtered.length - 1));
        }
        break;
      case "Enter":
        if (open && filtered[safeActiveIndex]) {
          event.preventDefault();
          commit(filtered[safeActiveIndex]);
        }
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          setOpen(false);
          setQuery("");
        }
        break;
      default:
        break;
    }
  }

  const activeOptionId =
    open && filtered[safeActiveIndex]
      ? `${listboxId}-opt-${filtered[safeActiveIndex].id}`
      : undefined;

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div className="relative">
        <input
          id={id}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          aria-label={ariaLabel}
          autoComplete="off"
          disabled={disabled}
          placeholder={placeholder}
          value={inputValue}
          className="min-h-12 w-full rounded border border-line bg-white px-3 py-2 pr-16 text-base text-ink outline-none transition focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-red-500"
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            if (!open) setOpen(true);
          }}
          onFocus={openList}
          onKeyDown={onKeyDown}
        />
        <div className="absolute inset-y-0 right-2 flex items-center gap-1">
          {clearable && selected && !disabled ? (
            <button
              type="button"
              aria-label={ko.combobox.clear}
              className="rounded p-1 text-steel hover:bg-muted-panel hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
              onClick={() => {
                onChange("");
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <X aria-hidden="true" size={14} />
            </button>
          ) : null}
          <ChevronsUpDown
            aria-hidden="true"
            size={16}
            className="text-steel"
          />
        </div>
      </div>
      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-line bg-white py-1 shadow-lg"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-steel" role="presentation">
              {ko.combobox.empty}
            </li>
          ) : (
            filtered.map((option, index) => {
              const isActive = index === safeActiveIndex;
              const isSelected = option.id === value;
              return (
                <li
                  key={option.id}
                  id={`${listboxId}-opt-${option.id}`}
                  role="option"
                  aria-selected={isSelected}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm",
                    isActive ? "bg-muted-panel" : "bg-white",
                  )}
                  // Pointer-down (not click) so the input's blur/outside handler
                  // doesn't close the list before the selection lands.
                  onPointerDown={(event) => {
                    event.preventDefault();
                    commit(option);
                  }}
                  onMouseEnter={() => {
                    setActiveIndex(index);
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-ink">
                      {option.label}
                    </span>
                    {option.sublabel ? (
                      <span className="block truncate text-xs text-steel">
                        {option.sublabel}
                      </span>
                    ) : null}
                  </span>
                  {isSelected ? (
                    <Check
                      aria-hidden="true"
                      size={16}
                      className="shrink-0 text-brand-teal"
                    />
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}

interface AsyncComboboxProps {
  id: string;
  /** Resolve the query to matching options (server-side typeahead). */
  search: (query: string) => Promise<ComboboxOption[]>;
  value: string;
  onChange: (id: string) => void;
  /**
   * Fired with the full option when the user picks one, so the caller can keep
   * its human label for display (the search endpoint is per-query, so a chosen
   * option may not be in a later result set).
   */
  onSelectOption?: (option: ComboboxOption) => void;
  /**
   * The option currently selected, so its human label renders even when it is
   * not in the latest search results. The caller holds it (it knows what was
   * picked); `undefined` shows the placeholder.
   */
  selectedOption?: ComboboxOption;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Async variant of {@link Combobox} for large datasets behind a search
 * endpoint (e.g. equipment autocomplete). Debounces the query, calls `search`,
 * and renders human labels while submitting the option `id`. Same ARIA combobox
 * semantics and keyboard support as the synchronous version.
 */
export function AsyncCombobox({
  id,
  search,
  value,
  onChange,
  onSelectOption,
  selectedOption,
  placeholder,
  ariaLabel,
  disabled = false,
  className,
}: AsyncComboboxProps) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ComboboxOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const inputValue = open ? query : (selectedOption?.label ?? "");

  const runSearch = useCallback(
    (q: string) => {
      let cancelled = false;
      const trimmed = q.trim();
      if (!trimmed) {
        setResults([]);
        setLoading(false);
        return () => {
          cancelled = true;
        };
      }
      setLoading(true);
      search(trimmed)
        .then((options) => {
          if (!cancelled) {
            setResults(options);
            setActiveIndex(0);
          }
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    },
    [search],
  );

  // Debounce the query -> search calls while the popup is open.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      runSearch(query);
    }, 200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [open, query, runSearch]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  function commit(option: ComboboxOption) {
    onChange(option.id);
    onSelectOption?.(option);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        setActiveIndex((current) =>
          results.length === 0 ? 0 : (current + 1) % results.length,
        );
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        setActiveIndex((current) =>
          results.length === 0
            ? 0
            : (current - 1 + results.length) % results.length,
        );
        break;
      case "Enter":
        if (open && results[activeIndex]) {
          event.preventDefault();
          commit(results[activeIndex]);
        }
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          setOpen(false);
          setQuery("");
        }
        break;
      default:
        break;
    }
  }

  const activeOptionId =
    open && results[activeIndex]
      ? `${listboxId}-opt-${results[activeIndex].id}`
      : undefined;

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div className="relative">
        <input
          id={id}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          aria-label={ariaLabel}
          autoComplete="off"
          disabled={disabled}
          placeholder={placeholder}
          value={inputValue}
          className="min-h-12 w-full rounded border border-line bg-white px-3 py-2 pr-16 text-base text-ink outline-none transition focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-red-500"
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => {
            if (!disabled) {
              setQuery("");
              setOpen(true);
            }
          }}
          onKeyDown={onKeyDown}
        />
        <div className="absolute inset-y-0 right-2 flex items-center gap-1">
          {selectedOption && !disabled ? (
            <button
              type="button"
              aria-label={ko.combobox.clear}
              className="rounded p-1 text-steel hover:bg-muted-panel hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
              onClick={() => {
                onChange("");
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <X aria-hidden="true" size={14} />
            </button>
          ) : null}
          <ChevronsUpDown aria-hidden="true" size={16} className="text-steel" />
        </div>
      </div>
      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-line bg-white py-1 shadow-lg"
        >
          {loading ? (
            <li className="px-3 py-2 text-sm text-steel" role="presentation">
              {ko.common.loading}
            </li>
          ) : results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-steel" role="presentation">
              {query.trim() ? ko.combobox.empty : ko.combobox.typeToSearch}
            </li>
          ) : (
            results.map((option, index) => {
              const isActive = index === activeIndex;
              const isSelected = option.id === value;
              return (
                <li
                  key={option.id}
                  id={`${listboxId}-opt-${option.id}`}
                  role="option"
                  aria-selected={isSelected}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm",
                    isActive ? "bg-muted-panel" : "bg-white",
                  )}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    commit(option);
                  }}
                  onMouseEnter={() => {
                    setActiveIndex(index);
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-ink">
                      {option.label}
                    </span>
                    {option.sublabel ? (
                      <span className="block truncate text-xs text-steel">
                        {option.sublabel}
                      </span>
                    ) : null}
                  </span>
                  {isSelected ? (
                    <Check
                      aria-hidden="true"
                      size={16}
                      className="shrink-0 text-brand-teal"
                    />
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}
