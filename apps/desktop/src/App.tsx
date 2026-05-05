export function App() {
  const steps = [
    { label: "Import", status: "Ready" },
    { label: "Analyze", status: "Waiting" },
    { label: "Generate", status: "Waiting" },
    { label: "Export", status: "Waiting" },
  ];

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Workspace">
        <h1>Audiobook Generator</h1>
        <button className="primary-action" type="button">
          Import Book
        </button>
        <nav aria-label="Workflow">
          {steps.map((step) => (
            <div className="workflow-step" key={step.label}>
              <span>{step.label}</span>
              <small>{step.status}</small>
            </div>
          ))}
        </nav>
      </aside>

      <section className="workspace" aria-label="Audiobook job">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">Local desktop pipeline</p>
            <h2>Job Progress</h2>
          </div>
          <span className="status-pill">No active book</span>
        </header>

        <section className="progress-panel" aria-label="Pipeline progress">
          <div>
            <strong>Import a PDF or EPUB to begin.</strong>
            <p>Extraction, chapter detection, dialogue analysis, and local TTS run as resumable stages.</p>
          </div>
          <progress value="0" max="100" aria-label="Generation progress" />
        </section>

        <section className="grid">
          <article>
            <h3>Characters</h3>
            <p>Detected speakers, gender confidence, aliases, and assigned voices will appear here.</p>
          </article>
          <article>
            <h3>Chapters</h3>
            <p>Chapter scripts and generation state will be listed as the worker pipeline runs.</p>
          </article>
          <article>
            <h3>Rights</h3>
            <p>Unknown or restricted license status will require confirmation before generation.</p>
            <label className="attestation">
              <input type="checkbox" />
              <span>I have the right to convert this book</span>
            </label>
          </article>
          <article className="review-panel">
            <h3>Review</h3>
            <p>Low-confidence speakers and voices can be corrected globally before regeneration.</p>
            <label>
              <span>Character alias</span>
              <input aria-label="Character alias" placeholder="Lizzy = Elizabeth" />
            </label>
            <label>
              <span>Character gender</span>
              <select aria-label="Character gender" defaultValue="unknown">
                <option value="unknown">Unknown</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="neutral">Neutral</option>
              </select>
            </label>
            <label>
              <span>Assigned voice</span>
              <select aria-label="Assigned voice" defaultValue="neutral_dialogue_01">
                <option value="neutral_dialogue_01">Neutral Dialogue 01</option>
                <option value="female_adult_01">Female Adult 01</option>
                <option value="male_adult_01">Male Adult 01</option>
              </select>
            </label>
            <button className="secondary-action" type="button">
              Regenerate Affected Chapters
            </button>
          </article>
          <article>
            <h3>Export</h3>
            <p>Completed chapter audio and metadata exports will be available after generation.</p>
          </article>
        </section>
      </section>
    </main>
  );
}
