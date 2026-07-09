import { Search } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { cn } from "../../lib/utils";
import { Dialog } from "../ui/dialog";
import { navGroupLabel, navItemLabel } from "./nav-labels";
import { visibleNavItemsForRoles, type VisibleNavItem } from "./nav";

interface CommandPaletteProps {
  onClose: () => void;
}

interface CommandItem {
  nav: VisibleNavItem;
  label: string;
  groupLabel: string;
  searchable: string;
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("ko-KR").replace(/\s+/g, "");
}

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const { session } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const commands = useMemo<CommandItem[]>(() => {
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

  useEffect(() => {
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const boundedActiveIndex = Math.min(
    activeIndex,
    Math.max(0, filteredCommands.length - 1),
  );

  function close() {
    onClose();
  }

  function run(command: CommandItem) {
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

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) =>
        filteredCommands.length === 0 ? 0 : (index + 1) % filteredCommands.length,
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) =>
        filteredCommands.length === 0
          ? 0
          : (index - 1 + filteredCommands.length) % filteredCommands.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (filteredCommands.length > 0) {
        run(filteredCommands[boundedActiveIndex]);
      }
    }
  }

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
          className="min-h-9 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-steel"
        />
        <kbd className="hidden rounded border border-line bg-muted-panel px-2 py-1 text-[10px] font-semibold text-steel sm:inline">
          Esc
        </kbd>
      </div>
      <div className="max-h-96 overflow-y-auto p-2">
        {filteredCommands.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-steel">
            {ko.shell.commandPalette.empty}
          </p>
        ) : (
          <ul aria-label={ko.shell.commandPalette.resultsLabel} className="grid gap-1">
            {filteredCommands.map((command, index) => (
              <li key={command.nav.key}>
                <button
                  type="button"
                  aria-current={command.nav.href === location.pathname ? "page" : undefined}
                  onMouseEnter={() => { setActiveIndex(index); }}
                  onClick={() => { run(command); }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition",
                    index === boundedActiveIndex
                      ? "bg-muted-panel text-ink"
                      : "text-steel hover:bg-muted-panel/70 hover:text-ink",
                  )}
                >
                  <command.nav.Icon size={16} aria-hidden="true" className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{command.label}</span>
                    <span className="block truncate text-xs text-steel">
                      {command.groupLabel} · {command.nav.href}
                    </span>
                  </span>
                  {command.nav.href === location.pathname ? (
                    <span className="rounded-full bg-white px-2 py-0.5 text-xs text-steel">
                      {ko.shell.commandPalette.current}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
