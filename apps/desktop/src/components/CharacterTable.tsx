import type { CharacterMeta, VoiceOption } from "../types";

interface CharacterTableProps {
  characters: CharacterMeta[];
  voices: VoiceOption[];
  onGenderChange: (characterId: string, gender: string) => void;
  onVoiceChange: (characterId: string, voiceId: string) => void;
}

function confidenceColor(confidence: number): string {
  if (confidence >= 0.8) return "var(--success)";
  if (confidence >= 0.5) return "var(--warning)";
  return "var(--danger)";
}

export function CharacterTable({
  characters,
  voices,
  onGenderChange,
  onVoiceChange,
}: CharacterTableProps) {
  if (characters.length === 0) {
    return <p>No characters detected yet. Run analysis first.</p>;
  }

  return (
    <table className="character-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Aliases</th>
          <th>Confidence</th>
          <th>Gender</th>
          <th>Voice</th>
        </tr>
      </thead>
      <tbody>
        {characters.map((c) => (
          <tr key={c.id} className={c.confidence < 0.5 ? "low-confidence" : ""}>
            <td>
              {c.canonicalName}
              {c.confidence < 0.5 && (
                <span aria-label="Low confidence" className="warning-icon">
                  ⚠
                </span>
              )}
            </td>
            <td>{c.aliases.length > 0 ? c.aliases.join(", ") : "—"}</td>
            <td>
              <div className="confidence-bar">
                <div
                  className="confidence-fill"
                  style={{
                    width: `${Math.round(c.confidence * 100)}%`,
                    backgroundColor: confidenceColor(c.confidence),
                  }}
                />
                <span className="confidence-label">{Math.round(c.confidence * 100)}%</span>
              </div>
            </td>
            <td>
              <select
                className="dark-select"
                aria-label="Gender"
                value={c.gender}
                onChange={(e) => onGenderChange(c.id, e.target.value)}
              >
                <option value="unknown">Unknown</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="neutral">Neutral</option>
              </select>
            </td>
            <td>
              <select
                className="dark-select"
                aria-label="Voice"
                value={c.voiceId}
                onChange={(e) => onVoiceChange(c.id, e.target.value)}
              >
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.displayName}
                  </option>
                ))}
              </select>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
