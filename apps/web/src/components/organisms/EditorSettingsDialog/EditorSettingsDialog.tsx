import { Button, InputNumber, Modal, Segmented, Switch, Typography } from "antd";
import {
  EDITOR_SETTING_LIMITS,
  useEditorSettingsStore,
  type EditorSettings,
} from "../../../store/editorSettingsStore.ts";
import { useThemeStore, type ThemeChoice } from "../../../store/themeStore.ts";

interface EditorSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

/** One labelled row, so the settings read as a list rather than a form. */
const Row = ({
  label,
  hint,
  control,
}: {
  label: string;
  hint?: string;
  control: React.ReactNode;
}) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 16,
      padding: "10px 0",
      borderBottom: "1px solid var(--rc-border)",
    }}
  >
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 14 }}>{label}</div>
      {hint && (
        <div style={{ fontSize: 12, color: "var(--rc-text-subtle)", marginTop: 2 }}>
          {hint}
        </div>
      )}
    </div>
    <div style={{ flex: "none" }}>{control}</div>
  </div>
);

/** Editor preferences.
 *
 *  Font size, tab width, wrapping and the minimap were hardcoded, so anyone
 *  who found the defaults uncomfortable had no recourse at all.
 */
export const EditorSettingsDialog = ({ open, onClose }: EditorSettingsDialogProps) => {
  const settings = useEditorSettingsStore();
  const themeChoice = useThemeStore((state) => state.choice);
  const setThemeChoice = useThemeStore((state) => state.setChoice);

  return (
    <Modal
      open={open}
      title="Editor settings"
      onCancel={onClose}
      // Applied as they change rather than on a Save, so the effect is visible
      // behind the dialog while choosing.
      footer={
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <Button onClick={settings.reset}>Reset to defaults</Button>
          <Button type="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      }
      destroyOnHidden
    >
      <Typography.Paragraph style={{ color: "var(--rc-text-subtle)", fontSize: 13 }}>
        Changes apply immediately and are remembered on this device.
      </Typography.Paragraph>

      <Row
        label="Theme"
        hint="System follows your operating system"
        control={
          <Segmented<ThemeChoice>
            value={themeChoice}
            onChange={setThemeChoice}
            options={[
              { label: "System", value: "system" },
              { label: "Light", value: "light" },
              { label: "Dark", value: "dark" },
            ]}
          />
        }
      />

      <Row
        label="Font size"
        control={
          <InputNumber
            min={EDITOR_SETTING_LIMITS.fontSize.min}
            max={EDITOR_SETTING_LIMITS.fontSize.max}
            value={settings.fontSize}
            onChange={(value) => settings.set("fontSize", value ?? 14)}
            style={{ width: 84 }}
          />
        }
      />

      <Row
        label="Tab size"
        hint="Spaces inserted per indent level"
        control={
          <InputNumber
            min={EDITOR_SETTING_LIMITS.tabSize.min}
            max={EDITOR_SETTING_LIMITS.tabSize.max}
            value={settings.tabSize}
            onChange={(value) => settings.set("tabSize", value ?? 2)}
            style={{ width: 84 }}
          />
        }
      />

      <Row
        label="Word wrap"
        hint="Wrap long lines instead of scrolling sideways"
        control={
          <Switch
            checked={settings.wordWrap}
            onChange={(value) => settings.set("wordWrap", value)}
          />
        }
      />

      <Row
        label="Line numbers"
        control={
          <Switch
            checked={settings.lineNumbers}
            onChange={(value) => settings.set("lineNumbers", value)}
          />
        }
      />

      <Row
        label="Minimap"
        hint="The overview strip down the right edge"
        control={
          <Switch
            checked={settings.minimap}
            onChange={(value) => settings.set("minimap", value)}
          />
        }
      />

      <Row
        label="Format on save"
        hint="Runs the built-in formatter for the file's language before writing"
        control={
          <Switch
            checked={settings.formatOnSave}
            onChange={(value) => settings.set("formatOnSave", value)}
          />
        }
      />

      <Row
        label="Bracket pair colours"
        hint="Tint nested brackets by depth"
        control={
          <Switch
            checked={settings.bracketPairColorization}
            onChange={(value) => settings.set("bracketPairColorization", value)}
          />
        }
      />

      <Row
        label="Sticky scroll"
        hint="Pin the enclosing class and function above the viewport"
        control={
          <Switch
            checked={settings.stickyScroll}
            onChange={(value) => settings.set("stickyScroll", value)}
          />
        }
      />

      <Row
        label="Inlay hints"
        hint="Inferred parameter names and types, shown inline"
        control={
          <Switch
            checked={settings.inlayHints}
            onChange={(value) => settings.set("inlayHints", value)}
          />
        }
      />

      <Row
        label="Inline suggestions"
        hint="Preview the current completion as ghost text"
        control={
          <Switch
            checked={settings.inlineSuggest}
            onChange={(value) => settings.set("inlineSuggest", value)}
          />
        }
      />

      <Row
        label="Whitespace"
        hint="Where tabs and spaces are drawn"
        control={
          <Segmented<EditorSettings["renderWhitespace"]>
            value={settings.renderWhitespace}
            onChange={(value) => settings.set("renderWhitespace", value)}
            options={[
              { label: "None", value: "none" },
              { label: "Selection", value: "selection" },
              { label: "All", value: "all" },
            ]}
          />
        }
      />

      <Row
        label="Format on paste"
        control={
          <Switch
            checked={settings.formatOnPaste}
            onChange={(value) => settings.set("formatOnPaste", value)}
          />
        }
      />

      <Row
        label="Format on type"
        control={
          <Switch
            checked={settings.formatOnType}
            onChange={(value) => settings.set("formatOnType", value)}
          />
        }
      />

      <Row
        label="Column guides"
        hint="Vertical rules at columns 80 and 120"
        control={
          <Switch
            checked={settings.rulers}
            onChange={(value) => settings.set("rulers", value)}
          />
        }
      />

      <Row
        label="Cursor surrounding lines"
        hint="Lines kept below the cursor while scrolling"
        control={
          <InputNumber
            min={EDITOR_SETTING_LIMITS.cursorSurroundingLines.min}
            max={EDITOR_SETTING_LIMITS.cursorSurroundingLines.max}
            value={settings.cursorSurroundingLines}
            onChange={(value) => settings.set("cursorSurroundingLines", value ?? 3)}
            style={{ width: 84 }}
          />
        }
      />
    </Modal>
  );
};
