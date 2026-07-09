import { Search } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import {
  createPersonCandidateProvider,
  createWorkOrderCandidateProvider,
  type ObjectCandidate,
} from "../../lib/objectCandidates";
import { objectRegistry } from "../../lib/objectRegistry";
import { cn } from "../../lib/utils";
import { Dialog } from "../ui/dialog";
import { consoleIcons } from "../console/icons";
import { navGroupLabel, navItemLabel } from "./nav-labels";
import { visibleNavItemsForRoles, type VisibleNavItem } from "./nav";

interface CommandPaletteProps {
  onClose: () => void;
  /** When provided (ConsoleShell), selecting a work/person result pins it into
   * the active screen instead of navigating — the pin's mount fetches live
   * detail (and, for a person, records the view-audit). Omitted on AppShell,
   * where there is no window engine, so results navigate. */
  onPinObject?: (candidate: ObjectCandidate) => void;
}

interface ScreenCommand {
  nav: VisibleNavItem;
  label: string;
  groupLabel: string;
  searchable: string;
}

// One selectable row in the flat, keyboard-navigable list. Group headers are
// rendered separately and are not part of this list.
type PaletteRow =
  | { type: "screen"; key: string; command: ScreenCommand }
  | { type: "object"; key: string; candidate: ObjectCandidate };

function normalize(value: string): string {
  return value.toLocaleLowerCase("ko-KR").replace(/\s+/g, "");
}

export function CommandPalette({ onClose, onPinObject }: CommandPaletteProps) {
  const { api, session } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const titleId = useId();
  const sectionId = useId();
  const resultsId = `${sectionId}-results`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [work, setWork] = useState<ObjectCandidate[]>([]);
  const [people, setPeople] = useState<ObjectCandidate[]>([]);

  const commands = useMemo<ScreenCommand[]>(() => {
    return visibleNavItemsForRoles(
      session?.roles,
      session?.group_roles,
      session?.feature_grants,
    ).map((nav) => {
      const label = navItemLabel(nav.key);
      const groupLabel = navGroupLabel(nav.groupKey);
      return {
        nav,
        label,
        groupLabel,
        searchable: normalize(`${label} ${groupLabel} ${nav.key} ${nav.href}`),
      };
    });
  }, [session?.roles, session?.group_roles, session?.feature_grants]);

  const filteredCommands = useMemo(() => {
    const needle = normalize(query);
    if (!needle) return commands;
    return commands.filter((command) => command.searchable.includes(needle));
  }, [commands, query]);

  const branchId = session?.branches?.[0];
  const workProvider = useMemo(
    () => createWorkOrderCandidateProvider(api),
    [api],
  );
  const personProvider = useMemo(
    () => (branchId ? createPersonCandidateProvider(api, branchId) : undefined),
    [api, branchId],
  );

  // Pending work + people from the real APIs, refreshed as the query changes.
  // The screen list stays instant/client-side; object lookups are async and
  // deny-by-omission (the providers are branch/RLS-scoped server-side).
  useEffect(() => {
    const guard = { live: true };
    // Debounce so a burst of keystrokes fires one pair of provider calls, not
    // one per character.
    const timer = setTimeout(() => {
      void (async () => {
        const [workResult, peopleResult] = await Promise.all([
          workProvider(query),
          personProvider ? personProvider(query) : Promise.resolve(null),
        ]);
        if (!guard.live) return;
        setWork(workResult.status === "ok" ? workResult.candidates : []);
        setPeople(peopleResult && peopleResult.status === "ok" ? peopleResult.candidates : []);
      })();
    }, 200);
    return () => {
      guard.live = false;
      clearTimeout(timer);
    };
  }, [workProvider, personProvider, query]);

  // Flat navigable list = screens, then work, then people.
  const rows = useMemo<PaletteRow[]>(() => {
    return [
      ...filteredCommands.map((command) => ({
        type: "screen" as const,
        key: `screen:${command.nav.key}`,
        command,
      })),
      ...work.map((candidate) => ({
        type: "object" as const,
        key: `work:${candidate.code}`,
        candidate,
      })),
      ...people.map((candidate) => ({
        type: "object" as const,
        key: `person:${candidate.code}`,
        candidate,
      })),
    ];
  }, [filteredCommands, work, people]);

  useEffect(() => {
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const boundedActiveIndex = Math.min(activeIndex, Math.max(0, rows.length - 1));
  const activeRowId = rows.length > 0 ? rowDomId(sectionId, rows[boundedActiveIndex]) : undefined;

  function close() {
    onClose();
  }

  function runScreen(command: ScreenCommand) {
    onClose();
    if (command.nav.href !== location.pathname) {
      const currentCommand = commands.find((item) => item.nav.href === location.pathname);
      void navigate(command.nav.href, {
        state: currentCommand
          ? {
              backStackSeed: {
                href: `${location.pathname}${location.search}`,
                pathname: location.pathname,
                label: currentCommand.label,
              },
            }
          : undefined,
      });
    }
  }

  function runObject(candidate: ObjectCandidate) {
    onClose();
    if (onPinObject) {
      onPinObject(candidate);
      return;
    }
    const ref = { id: candidate.id ?? candidate.code, code: candidate.code, name: candidate.label };
    void navigate(objectRegistry[candidate.kind].route(ref));
  }

  function runRow(row: PaletteRow) {
    if (row.type === "screen") runScreen(row.command);
    else runObject(row.candidate);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (rows.length === 0 ? 0 : (index + 1) % rows.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) =>
        rows.length === 0 ? 0 : (index - 1 + rows.length) % rows.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (rows.length > 0) runRow(rows[boundedActiveIndex]);
    }
  }

  const screenRows = rows.filter((row) => row.type === "screen");
  const workRows = rows.filter(
    (row): row is Extract<PaletteRow, { type: "object" }> =>
      row.type === "object" && row.candidate.kind === "workOrder",
  );
  const peopleRows = rows.filter(
    (row): row is Extract<PaletteRow, { type: "object" }> =>
      row.type === "object" && row.candidate.kind === "person",
  );

  return (
    <Dialog
      open
      onClose={close}
      titleId={titleId}
      initialFocusRef={inputRef}
      className="max-w-2xl overflow-hidden p-0"
    >
      <div className="border-b border-line px-4 py-3">
        <h2 id={titleId} className="text-sm font-semibold text-ink">
          {ko.shell.commandPalette.title}
        </h2>
        <p className="mt-1 text-xs text-steel">
          {ko.shell.commandPalette.description}
        </p>
      </div>
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Search aria-hidden="true" className="size-4 text-steel" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onInputKeyDown}
          placeholder={ko.shell.commandPalette.placeholder}
          aria-label={ko.shell.commandPalette.searchLabel}
          aria-activedescendant={activeRowId}
          aria-controls={resultsId}
          aria-expanded={rows.length > 0}
          aria-autocomplete="list"
          role="combobox"
          className="min-h-9 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-steel"
        />
        <kbd className="hidden rounded border border-line bg-muted-panel px-2 py-1 text-[10px] font-semibold text-steel sm:inline">
          Esc
        </kbd>
      </div>
      <div id={resultsId} aria-label={ko.shell.commandPalette.resultsLabel} className="max-h-96 overflow-y-auto p-2">
        {rows.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-steel">
            {ko.shell.commandPalette.empty}
          </p>
        ) : (
          <>
            <PaletteSection
              labelId={`${sectionId}-screens`}
              label={ko.shell.commandPalette.sections.screens}
              hasRows={screenRows.length > 0}
            >
              {screenRows.map((row) => (
                <ScreenRowButton
                  key={row.key}
                  id={rowDomId(sectionId, row)}
                  command={row.command}
                  active={rows[boundedActiveIndex]?.key === row.key}
                  currentPath={location.pathname}
                  onHover={() => {
                    setActiveIndex(rows.findIndex((r) => r.key === row.key));
                  }}
                  onRun={() => {
                    runScreen(row.command);
                  }}
                />
              ))}
            </PaletteSection>
            <PaletteSection
              labelId={`${sectionId}-work`}
              label={ko.shell.commandPalette.sections.work}
              hasRows={workRows.length > 0}
            >
              {workRows.map((row) => (
                <ObjectRowButton
                  key={row.key}
                  id={rowDomId(sectionId, row)}
                  candidate={row.candidate}
                  active={rows[boundedActiveIndex]?.key === row.key}
                  onHover={() => {
                    setActiveIndex(rows.findIndex((r) => r.key === row.key));
                  }}
                  onRun={() => {
                    runObject(row.candidate);
                  }}
                />
              ))}
            </PaletteSection>
            <PaletteSection
              labelId={`${sectionId}-people`}
              label={ko.shell.commandPalette.sections.people}
              hasRows={peopleRows.length > 0}
            >
              {peopleRows.map((row) => (
                <ObjectRowButton
                  key={row.key}
                  id={rowDomId(sectionId, row)}
                  candidate={row.candidate}
                  active={rows[boundedActiveIndex]?.key === row.key}
                  onHover={() => {
                    setActiveIndex(rows.findIndex((r) => r.key === row.key));
                  }}
                  onRun={() => {
                    runObject(row.candidate);
                  }}
                />
              ))}
            </PaletteSection>
          </>
        )}
      </div>
    </Dialog>
  );
}

function rowDomId(prefix: string, row: PaletteRow): string {
  return `${prefix}-row-${row.key.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

// One labeled section: heading (a real <p>) sits OUTSIDE the <ul>, which then
// only contains <li> rows — valid list semantics, zero axe violations. The
// group is named via aria-labelledby so SR users hear the section.
function PaletteSection({
  labelId,
  label,
  hasRows,
  children,
}: {
  labelId: string;
  label: string;
  hasRows: boolean;
  children: ReactNode;
}) {
  if (!hasRows) return null;
  return (
    <div role="group" aria-labelledby={labelId} className="mb-1">
      <p id={labelId} className="px-3 pb-1 pt-2 text-[10px] font-extrabold uppercase text-steel">
        {label}
      </p>
      <ul className="grid gap-1">{children}</ul>
    </div>
  );
}

function ScreenRowButton({
  id,
  command,
  active,
  currentPath,
  onHover,
  onRun,
}: {
  id: string;
  command: ScreenCommand;
  active: boolean;
  currentPath: string;
  onHover: () => void;
  onRun: () => void;
}) {
  return (
    <li>
      <button
        id={id}
        type="button"
        aria-current={command.nav.href === currentPath ? "page" : undefined}
        onMouseEnter={onHover}
        onClick={onRun}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition",
          active ? "bg-muted-panel text-ink" : "text-steel hover:bg-muted-panel/70 hover:text-ink",
        )}
      >
        <command.nav.Icon size={16} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{command.label}</span>
          <span className="block truncate text-xs text-steel">
            {command.groupLabel} · {command.nav.href}
          </span>
        </span>
        {command.nav.href === currentPath ? (
          <span className="rounded-full bg-white px-2 py-0.5 text-xs text-steel">
            {ko.shell.commandPalette.current}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function ObjectRowButton({
  id,
  candidate,
  active,
  onHover,
  onRun,
}: {
  id: string;
  candidate: ObjectCandidate;
  active: boolean;
  onHover: () => void;
  onRun: () => void;
}) {
  const Icon = consoleIcons[objectRegistry[candidate.kind].icon];
  return (
    <li>
      <button
        id={id}
        type="button"
        onMouseEnter={onHover}
        onClick={onRun}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition",
          active ? "bg-muted-panel text-ink" : "text-steel hover:bg-muted-panel/70 hover:text-ink",
        )}
      >
        <Icon size={16} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-ink">{candidate.label}</span>
          <span className="block truncate text-xs text-steel">
            {objectRegistry[candidate.kind].kindLabel} · {candidate.code}
          </span>
        </span>
      </button>
    </li>
  );
}
