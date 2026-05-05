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
            <h3>Export</h3>
            <p>Completed chapter audio and metadata exports will be available after generation.</p>
          </article>
        </section>
      </section>
    </main>
  );
}
