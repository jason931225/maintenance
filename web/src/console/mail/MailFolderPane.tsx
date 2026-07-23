import { ko } from "../../i18n/ko";
import { PolicyGated } from "../policy";
import { folderRoleLabel, MAIL_ACTIONS } from "./mailScreenConfig";
import { buttonBaseStyle, sectionTitleStyle, separatorPaneStyle, stackStyle } from "./styles";
import type { ConsoleMailFolder } from "./types";

export function MailFolderPane({
  folders,
  selectedFolderId,
  onSelectFolder,
}: {
  folders: ConsoleMailFolder[];
  selectedFolderId?: string;
  onSelectFolder: (folderId: string | undefined) => void;
}) {
  const T = ko.console.mail.folder;
  const rows: Array<{ id?: string; label: string; unread: number; total: number }> = [
    {
      label: T.all,
      unread: folders.reduce((sum, folder) => sum + folder.unread_count, 0),
      total: folders.reduce((sum, folder) => sum + folder.total_count, 0),
    },
    ...folders.map((folder) => ({
      id: folder.id,
      label: folderRoleLabel(folder.role, folder.name),
      unread: folder.unread_count,
      total: folder.total_count,
    })),
  ];
  return (
    <nav className="mail-screen__folders" aria-label={T.navLabel} style={separatorPaneStyle}>
      <h2 style={sectionTitleStyle}>{T.navLabel}</h2>
      <div style={stackStyle}>
        {rows.map((row) => {
          const selected = row.id === selectedFolderId || (!row.id && !selectedFolderId);
          return (
            <PolicyGated key={row.id ?? "all"} action={MAIL_ACTIONS.read} resource={{ kind: "mail_folder", id: row.id }}>
              <button
                type="button"
                aria-current={selected ? "page" : undefined}
                style={{
                  ...buttonBaseStyle,
                  justifyContent: "space-between",
                  display: "flex",
                  borderColor: selected ? "var(--ink)" : "var(--border)",
                  background: selected ? "var(--muted)" : "var(--surface)",
                }}
                onClick={() => { onSelectFolder(row.id); }}
              >
                <span>{row.label}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>
                  {T.count(row.unread, row.total)}
                </span>
              </button>
            </PolicyGated>
          );
        })}
      </div>
    </nav>
  );
}
