import "./EditorButton.css";

interface EditorButtonProps {
  isActive: boolean;
}

export const EditorButton = ({ isActive }: EditorButtonProps) => {
  function handleClick() {
    // TODO: Implement click handler
  }

  return (
    <button
      className="editor-button"
      style={{
        color: isActive ? "white" : "#959eba",
        backgroundColor: isActive ? "#303242" : "#4a4859",
        borderTop: isActive ? "2px solid #f7b9dd" : "none",
      }}
      onClick={handleClick}
    >
      file.js
    </button>
  );
};
