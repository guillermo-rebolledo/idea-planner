import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Columns3,
  FileDiff,
  FileText,
  FolderOpen,
  GitCompareArrows,
  Inbox,
  LoaderCircle,
  ListTree,
  Maximize2,
  Menu,
  MessageSquareText,
  Minimize2,
  Monitor,
  MoreHorizontal,
  Moon,
  PanelLeftClose,
  PanelRightClose,
  Pin,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  TerminalSquare,
  X,
} from "lucide-react";
import "./styles.css";

// PROTOTYPE: Three radically different workspace variants, switchable via ?variant=.

type VariantKey = "A" | "B" | "C" | "D";
type RunState = "running" | "waiting" | "failed" | "ready" | "saved";
type ArtifactView = "preview" | "changes";
type StageKey = "developing" | "spec" | "tickets" | "failure" | "ready";
type ThemeKey = "system" | "light" | "dark";

type Idea = {
  id: number;
  title: string;
  phase: string;
  state: RunState;
  stateLabel: string;
  pinned?: boolean;
  dormant?: boolean;
  age: string;
};

const variants: Array<{ key: VariantKey; name: string }> = [
  { key: "A", name: "Mailbox" },
  { key: "B", name: "Focus Deck" },
  { key: "C", name: "Thread Ledger" },
  { key: "D", name: "Focus Mailbox" },
];

const stages: Array<{ key: StageKey; name: string }> = [
  { key: "developing", name: "Interview" },
  { key: "spec", name: "Spec review" },
  { key: "tickets", name: "Ticket review" },
  { key: "failure", name: "Publish failure" },
  { key: "ready", name: "Ready" },
];

const stageMeta: Record<StageKey, { phase: string; state: RunState; label: string }> = {
  developing: { phase: "Developing", state: "waiting", label: "Waiting for you" },
  spec: { phase: "Spec Review", state: "waiting", label: "Review needed" },
  tickets: { phase: "Ticket Review", state: "waiting", label: "Review needed" },
  failure: { phase: "Ticket Review", state: "failed", label: "Publication failed" },
  ready: { phase: "Ready", state: "ready", label: "Ready" },
};

const ideas: Idea[] = [
  {
    id: 1,
    title: "A calmer way to develop ideas",
    phase: "Developing",
    state: "waiting",
    stateLabel: "Waiting for you",
    pinned: true,
    age: "now",
  },
  {
    id: 2,
    title: "Offline API field guide",
    phase: "Spec Review",
    state: "running",
    stateLabel: "Claude is working",
    pinned: true,
    age: "3m",
  },
  {
    id: 3,
    title: "Build log visualizer",
    phase: "Captured",
    state: "saved",
    stateLabel: "Saved for later",
    pinned: true,
    dormant: true,
    age: "34d",
  },
  {
    id: 4,
    title: "Local-first changelog",
    phase: "Ticket Review",
    state: "failed",
    stateLabel: "Run failed",
    age: "18m",
  },
  {
    id: 5,
    title: "Sketch plugin architecture",
    phase: "Ready",
    state: "ready",
    stateLabel: "Ready",
    age: "2h",
  },
  {
    id: 6,
    title: "Personal docs search",
    phase: "Developing",
    state: "saved",
    stateLabel: "No action needed",
    age: "1d",
  },
];

const artifacts = [
  { name: "conversation.md", detail: "Updated now", changed: 18 },
  { name: "map.md", detail: "Updated 2m ago", changed: 9 },
  { name: "01-lifecycle.md", detail: "Updated 6m ago", changed: 14 },
];

const phaseNames = ["Captured", "Developing", "Spec Review", "Ticket Review", "Ready"];

function stateIcon(state: RunState, size = 14) {
  if (state === "running") return <LoaderCircle size={size} className="spin" />;
  if (state === "waiting") return <MessageSquareText size={size} />;
  if (state === "failed") return <AlertTriangle size={size} />;
  if (state === "ready") return <Check size={size} />;
  return <CircleDot size={size} />;
}

function StatusPill({
  state,
  label,
  compact = false,
}: {
  state: RunState;
  label: string;
  compact?: boolean;
}) {
  return (
    <span className={`status-pill status-${state} ${compact ? "compact" : ""}`}>
      {stateIcon(state)}
      {!compact && <span>{label}</span>}
    </span>
  );
}

function PhaseIndicator({ compact = false, phase = "Developing" }: { compact?: boolean; phase?: string }) {
  const currentIndex = phaseNames.indexOf(phase);
  return (
    <div className={`phase-indicator ${compact ? "phase-compact" : ""}`} aria-label="Idea phase">
      {phaseNames.map((phase, index) => (
        <React.Fragment key={phase}>
          <span className={index === currentIndex ? "phase-current" : index < currentIndex ? "phase-done" : ""}>
            {index === currentIndex ? <span className="phase-dot" /> : null}
            {compact ? (index === currentIndex ? phase : null) : phase}
          </span>
          {!compact && index < phaseNames.length - 1 ? <i /> : null}
        </React.Fragment>
      ))}
    </div>
  );
}

function UsageIndicator() {
  return (
    <button className="usage-indicator" title="Context and token usage">
      <span className="usage-ring" aria-hidden="true">
        <span />
      </span>
      <span>38% context</span>
      <ChevronDown size={13} />
    </button>
  );
}

function RunControls({ minimal = false }: { minimal?: boolean }) {
  return (
    <div className={`run-controls ${minimal ? "minimal" : ""}`}>
      <button>
        <TerminalSquare size={14} />
        {!minimal && "Codex"}
        <ChevronDown size={12} />
      </button>
      <button>
        {!minimal && "GPT-5.4"}
        {minimal && <Bot size={14} />}
        <ChevronDown size={12} />
      </button>
      <button>
        {!minimal && "High"}
        {minimal && <Sparkles size={14} />}
        <ChevronDown size={12} />
      </button>
    </div>
  );
}

function ThemeControl({ theme, setTheme }: { theme: ThemeKey; setTheme: (theme: ThemeKey) => void }) {
  const themes: ThemeKey[] = ["system", "light", "dark"];
  const nextTheme = themes[(themes.indexOf(theme) + 1) % themes.length];
  const icon = theme === "system" ? <Monitor size={14} /> : theme === "light" ? <Sun size={14} /> : <Moon size={14} />;
  return <button className="theme-control" onClick={() => setTheme(nextTheme)} title={`Theme: ${theme}. Switch to ${nextTheme}.`}>{icon}<span>{theme}</span></button>;
}

function ActivityRow() {
  const [open, setOpen] = useState(false);
  return (
    <div className={`activity-row ${open ? "activity-open" : ""}`}>
      <button onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="activity-icon">
          <FileText size={14} />
        </span>
        <span>
          <strong>Updated planning files</strong>
          <small>3 files · 41 additions · 12 seconds</small>
        </span>
        <ChevronDown size={15} className="activity-chevron" />
      </button>
      {open ? (
        <div className="activity-details">
          <div>
            <code>.scratch/idea-workspace/map.md</code>
            <span className="positive">+9</span>
          </div>
          <div>
            <code>.scratch/idea-workspace/issues/01-lifecycle.md</code>
            <span className="positive">+14</span>
          </div>
          <div>
            <code>.scratch/idea-workspace/conversation.md</code>
            <span className="positive">+18</span>
          </div>
          <p><ShieldCheck size={13} /> Sensitive values redacted before logging</p>
        </div>
      ) : null}
    </div>
  );
}

function Conversation({
  composer,
  setComposer,
  condensed = false,
}: {
  composer: string;
  setComposer: (value: string) => void;
  condensed?: boolean;
}) {
  const [submittedResponse, setSubmittedResponse] = useState("");
  const suggestions = [
    "Keep the files local and visible",
    "Use a database as the source of truth",
    "Let me explain a different approach",
  ];
  const submitResponse = (response: string) => {
    if (!response.trim()) return;
    setSubmittedResponse(response.trim());
    setComposer("");
  };

  return (
    <div className={`conversation ${condensed ? "conversation-condensed" : ""}`}>
      <div className="conversation-scroll">
        <div className="phase-divider"><span>Developing</span></div>
        <article className="message message-user">
          <div className="avatar avatar-user">G</div>
          <div>
            <header><strong>You</strong><time>10:42</time></header>
            <p>
              I want a desktop app that helps people preserve a rough idea, then develop it through
              a focused conversation until it becomes a spec and a set of tickets.
            </p>
          </div>
        </article>

        <article className="message message-assistant">
          <div className="avatar avatar-ai"><Sparkles size={15} /></div>
          <div>
            <header>
              <strong>Wayfinder</strong>
              <span className="method-credit">Based on Matt Pocock’s skill</span>
              <time>10:42</time>
            </header>
            <p>
              The first boundary to settle is where the durable Idea lives. My recommendation is
              local-first Markdown: ordinary files the user can inspect in any editor, with the app
              acting as a focused interface over them.
            </p>
            <p>Which storage model should be the source of truth?</p>
          </div>
        </article>

        <ActivityRow />

        <article className="message message-user">
          <div className="avatar avatar-user">G</div>
          <div>
            <header><strong>You</strong><time>10:47</time></header>
            <p>Keep the files local and visible, like Obsidian does with Markdown.</p>
          </div>
        </article>

        <article className="message message-assistant latest-question">
          <div className="avatar avatar-ai"><Sparkles size={15} /></div>
          <div>
            <header>
              <strong>Wayfinder</strong>
              <span className="waiting-label">Waiting for you</span>
              <time>10:48</time>
            </header>
            <p>
              Then capture must be independent from AI execution. I recommend two explicit outcomes:
              <strong> Save for later</strong> preserves the Idea without starting a Run, while
              <strong> Start developing</strong> launches the selected workflow.
            </p>
            <p>Should both actions be available?</p>
            <div className="suggestions" aria-label="Suggested responses">
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion}
                  onClick={() => submitResponse(index === 0 ? "Yes, keep the files local and visible." : suggestion)}
                >
                  <span>{index + 1}</span>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        </article>
        {submittedResponse ? (
          <>
            <article className="message message-user submitted-message">
              <div className="avatar avatar-user">G</div>
              <div><header><strong>You</strong><span className="submitted-label"><Check size={11} /> Sent</span><time>now</time></header><p>{submittedResponse}</p></div>
            </article>
            <div className="next-run-state"><LoaderCircle size={13} className="spin" /> Wayfinder is continuing from your answer…</div>
          </>
        ) : null}
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            aria-label="Reply"
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            placeholder="Type a custom response…"
            rows={condensed ? 2 : 3}
          />
          <div className="composer-footer">
            <RunControls minimal={condensed} />
            <div className="composer-actions">
              <UsageIndicator />
              <button className="stop-button" title="Stop current Run"><Square size={13} /></button>
              <button className="send-button" disabled={!composer.trim()} title="Send response" onClick={() => submitResponse(composer)}>
                <Send size={15} />
              </button>
            </div>
          </div>
        </div>
        <small className="composer-note">Suggested responses send immediately. Use the composer for a custom answer.</small>
      </div>
    </div>
  );
}

function ReviewConversation({
  stage,
  composer,
  setComposer,
}: {
  stage: Exclude<StageKey, "developing">;
  composer: string;
  setComposer: (value: string) => void;
}) {
  const [submittedResponse, setSubmittedResponse] = useState("");
  const submitResponse = (response: string) => {
    if (!response.trim()) return;
    setSubmittedResponse(response.trim());
    setComposer("");
  };
  const copy = {
    spec: {
      phase: "Spec Review",
      title: "The MVP Spec draft is ready to review",
      body: "I synthesized the accepted planning decisions and the complete Conversation into spec.md. The deterministic input manifest contains 9 artifacts and Conversation snapshot 24.",
      prompt: "Which testing seam should the MVP use before you accept this Spec?",
      suggestions: ["Test the adapter boundary with recorded events", "Use end-to-end Electron tests", "Propose a balanced testing seam"],
      action: "Accept MVP Spec",
    },
    tickets: {
      phase: "Ticket Review",
      title: "I drafted five vertical implementation slices",
      body: "Each ticket is independently verifiable and sized for a fresh agent context. The blocker graph is acyclic; two tickets can start immediately.",
      prompt: "Approve the breakdown, or tell me how its granularity or dependencies should change.",
      suggestions: ["Approve and create ticket files", "Too coarse — split ticket 3", "Fix dependencies", "Merge tickets 4 and 5"],
      action: "Approve and create ticket files",
    },
    failure: {
      phase: "Ticket Review",
      title: "Ticket publication did not complete",
      body: "No partial Planning Package became authoritative. Four files validated, but ticket 05 has an unresolved blocker. The staged candidates are retained for recovery.",
      prompt: "Fix the dependency and review the changed breakdown, or retry unchanged publication.",
      suggestions: ["Fix ticket 05 dependency", "Show validation details", "Retry unchanged publication"],
      action: "Retry publication",
    },
    ready: {
      phase: "Ready",
      title: "The Planning Package is ready",
      body: "The accepted Spec and five Implementation Tickets are now durable Markdown. Two frontier tickets have no blockers and can be implemented independently.",
      prompt: "You can edit the files directly, refine this Idea through a new Proposal, or implement it in your external Codex or Claude interface.",
      suggestions: ["Refine this Idea", "Show the implementation frontier", "Open Planning Package"],
      action: "Open Planning Package",
    },
  }[stage];

  const tickets = [
    ["01", "Create the Idea Library shell", "No blockers"],
    ["02", "Stream normalized harness events", "No blockers"],
    ["03", "Run the planning interview", "Blocked by 01, 02"],
    ["04", "Review and accept the MVP Spec", "Blocked by 03"],
    ["05", "Publish implementation tickets", stage === "failure" ? "Invalid blocker: 07" : "Blocked by 04"],
  ];

  return (
    <div className="conversation review-conversation">
      <div className="conversation-scroll">
        <div className="history-carryover"><Check size={13} /> Earlier Developing conversation remains above</div>
        <div className="phase-divider"><span>{copy.phase}</span></div>
        <article className="message message-assistant review-message">
          <div className="avatar avatar-ai">{stage === "tickets" || stage === "failure" ? <ListTree size={15} /> : <Sparkles size={15} />}</div>
          <div>
            <header>
              <strong>{stage === "ready" ? "Planning complete" : "Wayfinder"}</strong>
              <span className={stage === "failure" ? "error-label" : stage === "ready" ? "ready-label" : "waiting-label"}>
                {stageMeta[stage].label}
              </span>
              <time>11:26</time>
            </header>
            <h2>{copy.title}</h2>
            <p>{copy.body}</p>

            {stage === "spec" ? (
              <div className="review-card testing-card">
                <span className="review-card-icon"><ShieldCheck size={16} /></span>
                <div><strong>Testing seam</strong><small>Required before Spec acceptance</small></div>
                <b>Decision needed</b>
              </div>
            ) : null}

            {stage === "tickets" || stage === "failure" || stage === "ready" ? (
              <div className="ticket-breakdown">
                <header><strong>{stage === "ready" ? "Implementation frontier" : "Proposed breakdown"}</strong><span>{stage === "ready" ? "2 ready now" : "5 tickets"}</span></header>
                {tickets.map(([number, title, blocker], index) => (
                  <div className={stage === "ready" && index < 2 ? "frontier-ticket" : ""} key={number}>
                    <b>{number}</b><span><strong>{title}</strong><small>{blocker}</small></span>
                    {stage === "failure" && index === 4 ? <AlertTriangle size={14} /> : stage === "ready" && index < 2 ? <CheckCircle2 size={14} /> : null}
                  </div>
                ))}
              </div>
            ) : null}

            {stage === "ready" ? (
              <details className="implement-guide">
                <summary><Code2 size={14} /> Implement elsewhere</summary>
                <p>Use <code>spec.md</code> and the frontier ticket in Codex or Claude with Matt Pocock’s <code>/implement</code> skill.</p>
                <p className="guide-warning"><AlertTriangle size={13} /> The upstream workflow may commit to your current branch. Review it in your chosen TUI or GUI first.</p>
              </details>
            ) : null}

            <p>{copy.prompt}</p>
            <div className="suggestions" aria-label="Suggested responses">
              {copy.suggestions.map((suggestion, index) => (
                <button key={suggestion} onClick={() => submitResponse(suggestion)}>
                  <span>{index + 1}</span>{suggestion}
                </button>
              ))}
            </div>
            {stage === "spec" || stage === "tickets" || stage === "failure" ? (
              <button className={`phase-action ${stage === "failure" ? "retry-action" : ""}`} onClick={() => submitResponse(copy.action)}>
                {stage === "failure" ? <AlertTriangle size={14} /> : <Check size={14} />}{copy.action}
              </button>
            ) : null}
          </div>
        </article>
        {submittedResponse ? (
          <>
            <article className="message message-user submitted-message">
              <div className="avatar avatar-user">G</div>
              <div><header><strong>You</strong><span className="submitted-label"><Check size={11} /> Sent</span><time>now</time></header><p>{submittedResponse}</p></div>
            </article>
            {stage !== "ready" ? <div className="next-run-state"><LoaderCircle size={13} className="spin" /> {stage === "failure" ? "Validating the repaired package…" : "Continuing from your answer…"}</div> : null}
          </>
        ) : null}
      </div>
      <div className="composer-wrap">
        <div className="composer">
          <textarea aria-label="Reply" value={composer} onChange={(event) => setComposer(event.target.value)} placeholder="Discuss, choose a suggestion, or type a custom response…" rows={3} />
          <div className="composer-footer">
            <RunControls />
            <div className="composer-actions"><UsageIndicator /><button className="send-button" disabled={!composer.trim()} onClick={() => submitResponse(composer)}><Send size={15} /></button></div>
          </div>
        </div>
        <small className="composer-note">Suggested responses send immediately. Custom responses stay editable until sent.</small>
      </div>
    </div>
  );
}

function ArtifactContent({ view, stage = "developing" }: { view: ArtifactView; stage?: StageKey }) {
  if (view === "changes") {
    return (
      <div className="diff-view">
        <div className="diff-summary">
          <span>map.md</span>
          <strong><b>+9</b> <i>−2</i></strong>
        </div>
        <pre>
          <span className="diff-context">@@ Destination @@</span>
          <span className="diff-old">- Build an AI project planner.</span>
          <span className="diff-new">+ Build a local-first Idea development workspace.</span>
          <span className="diff-new">+ AI begins only after an explicit user action.</span>
          <span className="diff-context"> </span>
          <span className="diff-context"> ## Decisions so far</span>
          <span className="diff-new">+ Use one permanent Conversation per Idea.</span>
          <span className="diff-new">+ Keep all planning Markdown draft until Ready.</span>
        </pre>
      </div>
    );
  }

  if (stage === "spec") {
    return (
      <div className="markdown">
        <p className="eyebrow">DRAFT · INPUTS FROZEN</p>
        <h1>Commonplace MVP Specification</h1>
        <p className="lead">A local-first desktop workspace that develops preserved Ideas through deliberate AI-assisted planning.</p>
        <h2>Accepted behavior</h2>
        <ul><li>One permanent Conversation per Idea.</li><li>AI begins only through explicit user action.</li><li>Planning files remain read-only until Ready.</li></ul>
        <h2>Testing seam</h2>
        <blockquote>Decision pending in the Conversation before this Spec can be accepted.</blockquote>
      </div>
    );
  }

  if (stage === "tickets" || stage === "failure") {
    return (
      <div className="markdown">
        <p className="eyebrow">{stage === "failure" ? "STAGED · PUBLICATION FAILED" : "ACCEPTED SPEC"}</p>
        <h1>Implementation tickets</h1>
        <p className="lead">Five dependency-aware vertical slices derived from the accepted Spec.</p>
        <h2>Publication rule</h2>
        <p className="lead">No ticket file becomes authoritative until the complete approved set validates and publishes transactionally.</p>
        <blockquote>{stage === "failure" ? "Ticket 05 references missing ticket 07. No partial package was published." : "Review granularity and blocking edges in the Conversation before files are created."}</blockquote>
      </div>
    );
  }

  if (stage === "ready") {
    return (
      <div className="markdown">
        <p className="eyebrow ready-eyebrow">ACCEPTED · EDITABLE</p>
        <h1>Planning Package</h1>
        <p className="lead">The accepted baseline is durable, portable, and ready for an implementation agent.</p>
        <h2>Contents</h2>
        <ul><li>conversation.md</li><li>spec.md</li><li>issues/01–05</li></ul>
        <blockquote>Further AI changes are Proposals and require explicit approval.</blockquote>
      </div>
    );
  }

  return (
    <div className="markdown">
      <p className="eyebrow">DRAFT ARTIFACT</p>
      <h1>Conversation and Artifact lifecycle</h1>
      <p className="lead">
        Preserve the Idea before starting AI, then advance through explicit user-controlled phases.
      </p>
      <h2>Working model</h2>
      <ul>
        <li>One permanent Conversation belongs to each Idea.</li>
        <li>A Run is one user submission followed by AI work.</li>
        <li>All generated Markdown remains draft until Ready.</li>
      </ul>
      <h2>Phase gates</h2>
      <ol>
        <li><strong>Developing</strong> — Grill Me or Wayfinder interview</li>
        <li><strong>Spec Review</strong> — iterative MVP Spec</li>
        <li><strong>Ticket Review</strong> — dependency-aware slices</li>
      </ol>
      <blockquote>Nothing advances because the model merely says it is done.</blockquote>
    </div>
  );
}

function ArtifactInspector({
  view,
  setView,
  focus,
  setFocus,
  compact = false,
  stage = "developing",
}: {
  view: ArtifactView;
  setView: (view: ArtifactView) => void;
  focus: boolean;
  setFocus: (focus: boolean) => void;
  compact?: boolean;
  stage?: StageKey;
}) {
  const [selected, setSelected] = useState("map.md");
  return (
    <section className={`artifact-inspector ${compact ? "artifact-compact" : ""}`}>
      <header className="artifact-header">
        <div>
          <span className="section-kicker">MARKDOWN</span>
          <h2>{selected}</h2>
        </div>
        <div className="icon-actions">
          <button title={focus ? "Exit focus" : "Focus artifact"} onClick={() => setFocus(!focus)}>
            {focus ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button title="More"><MoreHorizontal size={16} /></button>
        </div>
      </header>
      <div className="artifact-tabs">
        <button className={view === "preview" ? "active" : ""} onClick={() => setView("preview")}>
          <FileText size={14} /> Preview
        </button>
        <button className={view === "changes" ? "active" : ""} onClick={() => setView("changes")}>
          <GitCompareArrows size={14} /> Changes <span>3</span>
        </button>
      </div>
      {!compact ? (
        <div className="artifact-files">
          {artifacts.map((artifact) => (
            <button
              key={artifact.name}
              className={selected === artifact.name ? "selected" : ""}
              onClick={() => setSelected(artifact.name)}
            >
              <FileText size={14} />
              <span><strong>{artifact.name}</strong><small>{artifact.detail}</small></span>
              <b>+{artifact.changed}</b>
            </button>
          ))}
        </div>
      ) : null}
      <div className="artifact-body"><ArtifactContent view={view} stage={stage} /></div>
      <footer className="artifact-footer">
        <span><Clock3 size={13} /> Snapshot 18</span>
        <span>{stage === "ready" ? "Accepted baseline · Editable" : `Read-only while ${stageMeta[stage].phase}`}</span>
      </footer>
    </section>
  );
}

function IdeaRows({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`idea-rows ${compact ? "idea-rows-compact" : ""}`}>
      <p className="group-label">Pinned <span>3</span></p>
      {ideas.slice(0, 3).map((idea) => (
        <button key={idea.id} className={idea.id === 1 ? "idea-row active" : "idea-row"} title={idea.title}>
          {compact ? (
            <>
              <span className="compact-title">{idea.title.slice(0, 1)}</span>
              <StatusPill state={idea.state} label={idea.stateLabel} compact />
            </>
          ) : (
            <>
              <div className="idea-row-top">
                <strong>{idea.title}</strong>
                <time>{idea.age}</time>
              </div>
              <div className="idea-row-bottom">
                <span>{idea.phase}</span>
                {idea.dormant ? <em>Dormant</em> : <StatusPill state={idea.state} label={idea.stateLabel} />}
              </div>
            </>
          )}
        </button>
      ))}
      {!compact ? <p className="group-label">Recent <span>3</span></p> : null}
      {!compact
        ? ideas.slice(3).map((idea) => (
            <button key={idea.id} className="idea-row">
              <div className="idea-row-top">
                <strong>{idea.title}</strong>
                <time>{idea.age}</time>
              </div>
              <div className="idea-row-bottom">
                <span>{idea.phase}</span>
                <StatusPill state={idea.state} label={idea.stateLabel} />
              </div>
            </button>
          ))
        : null}
    </div>
  );
}

function VariantA(props: WorkspaceProps) {
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  if (props.focusArtifact) {
    return (
      <main className="focus-artifact-page">
        <header className="focus-artifact-topbar">
          <button onClick={() => props.setFocusArtifact(false)}><ArrowLeft size={15} /> Back to Conversation</button>
          <PhaseIndicator />
          <StatusPill state="waiting" label="Waiting for you" />
        </header>
        <ArtifactInspector {...props.artifactProps} focus setFocus={props.setFocusArtifact} />
      </main>
    );
  }

  return (
    <main className={`variant-a ${leftOpen ? "" : "left-closed"} ${rightOpen ? "" : "right-closed"}`}>
      <aside className="mail-sidebar">
        <header className="brand-row">
          <div className="brand-mark"><Sparkles size={16} /></div>
          <strong>Commonplace</strong>
          <button><Settings2 size={15} /></button>
        </header>
        <button className="new-idea"><Plus size={15} /> New Idea</button>
        <div className="search-box"><Search size={14} /><input placeholder="Search Ideas" /></div>
        <IdeaRows />
        <footer><button><Archive size={14} /> Archive</button><span>12 Ideas</span></footer>
      </aside>
      <section className="mail-main">
        <header className="workspace-header">
          <div className="workspace-title">
            <button onClick={() => setLeftOpen(!leftOpen)} title="Toggle inbox"><PanelLeftClose size={16} /></button>
            <div>
              <span>SOFTWARE IDEA</span>
              <h1>A calmer way to develop ideas</h1>
            </div>
          </div>
          <div className="workspace-tools">
            <button className="changes-button" onClick={() => props.setArtifactView("changes")}>
              <FileDiff size={15} /> Changes <b>3</b>
            </button>
            <button><Pin size={15} /></button>
            <button onClick={() => setRightOpen(!rightOpen)} title="Toggle artifacts"><PanelRightClose size={16} /></button>
          </div>
        </header>
        <div className="phase-row"><PhaseIndicator /><StatusPill state="waiting" label="Waiting for you" /></div>
        <Conversation composer={props.composer} setComposer={props.setComposer} />
      </section>
      <aside className="mail-artifacts">
        <ArtifactInspector {...props.artifactProps} />
      </aside>
      {!leftOpen ? <button className="restore-left" onClick={() => setLeftOpen(true)}><Menu size={17} /></button> : null}
      {!rightOpen ? <button className="restore-right" onClick={() => setRightOpen(true)}><FileText size={17} /></button> : null}
    </main>
  );
}

function VariantB(props: WorkspaceProps) {
  const [drawerOpen, setDrawerOpen] = useState(true);

  return (
    <main className="variant-b">
      <aside className="focus-idea-rail">
        <div className="brand-mark"><Sparkles size={16} /></div>
        <button className="rail-new" title="New Idea"><Plus size={17} /></button>
        <IdeaRows compact />
        <div className="rail-spacer" />
        <button title="Search"><Search size={17} /></button>
        <button title="Settings"><Settings2 size={17} /></button>
      </aside>
      <section className="focus-main">
        <header className="focus-header">
          <div>
            <span className="section-kicker">PINNED · SOFTWARE IDEA</span>
            <h1>A calmer way to develop ideas</h1>
          </div>
          <div className="focus-header-state">
            <PhaseIndicator compact />
            <StatusPill state="waiting" label="Waiting for you" />
            <button className={drawerOpen ? "active" : ""} onClick={() => setDrawerOpen(!drawerOpen)}>
              <Columns3 size={16} /> Artifacts <b>3</b>
            </button>
          </div>
        </header>
        <Conversation composer={props.composer} setComposer={props.setComposer} />
      </section>
      {drawerOpen ? (
        <div className="artifact-drawer">
          <ArtifactInspector {...props.artifactProps} compact />
          <button className="drawer-close" onClick={() => setDrawerOpen(false)}><X size={16} /></button>
        </div>
      ) : null}
      <div className="focus-running-dock">
        <div><LoaderCircle size={14} className="spin" /><span><strong>Offline API field guide</strong><small>Claude is working</small></span></div>
        <button><Square size={12} /> Stop</button>
      </div>
    </main>
  );
}

function VariantC(props: WorkspaceProps) {
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [showInbox, setShowInbox] = useState(false);

  return (
    <main className="variant-c">
      <header className="ledger-topbar">
        <div className="ledger-brand"><div className="brand-mark"><Sparkles size={15} /></div><strong>Commonplace</strong></div>
        <nav className="idea-strip">
          {ideas.slice(0, 4).map((idea) => (
            <button key={idea.id} className={idea.id === 1 ? "active" : ""}>
              <StatusPill state={idea.state} label={idea.stateLabel} compact />
              <span>{idea.title}</span>
            </button>
          ))}
        </nav>
        <button className="all-ideas" onClick={() => setShowInbox(!showInbox)}><Inbox size={15} /> All Ideas</button>
      </header>
      {showInbox ? (
        <div className="ledger-inbox-popover">
          <header><strong>All Ideas</strong><button onClick={() => setShowInbox(false)}><X size={15} /></button></header>
          <div className="search-box"><Search size={14} /><input placeholder="Search Ideas" autoFocus /></div>
          <IdeaRows />
        </div>
      ) : null}
      <section className="ledger-context">
        <div>
          <span className="section-kicker">DEVELOPING · WAYFINDER</span>
          <h1>A calmer way to develop ideas</h1>
        </div>
        <PhaseIndicator />
        <div className="ledger-context-actions">
          <UsageIndicator />
          <StatusPill state="waiting" label="Waiting for you" />
        </div>
      </section>
      <section className={`ledger-body ${showArtifacts ? "ledger-reviewing" : ""}`}>
        <div className="ledger-thread">
          <Conversation composer={props.composer} setComposer={props.setComposer} condensed />
        </div>
        <aside className="ledger-checkpoints">
          <header>
            <span><FileText size={15} /><strong>Document checkpoints</strong></span>
            <button onClick={() => setShowArtifacts(!showArtifacts)}>
              {showArtifacts ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
            </button>
          </header>
          {!showArtifacts ? (
            <>
              <button className="checkpoint-card current" onClick={() => setShowArtifacts(true)}>
                <span><FileText size={15} /><strong>Lifecycle decision</strong></span>
                <small>map.md · Snapshot 18</small>
                <p>One permanent Conversation. Explicit phase gates. Final package acceptance.</p>
                <b><GitCompareArrows size={13} /> 9 changes</b>
              </button>
              <button className="checkpoint-card" onClick={() => setShowArtifacts(true)}>
                <span><FileText size={15} /><strong>Storage model</strong></span>
                <small>01-lifecycle.md · Snapshot 12</small>
                <p>Local Markdown remains portable and inspectable outside the app.</p>
              </button>
              <div className="checkpoint-note"><Clock3 size={14} /><span>Next checkpoint is created when you continue to Spec Review.</span></div>
            </>
          ) : (
            <ArtifactInspector {...props.artifactProps} compact />
          )}
        </aside>
      </section>
    </main>
  );
}

function VariantD(props: WorkspaceProps) {
  const [inboxOpen, setInboxOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const meta = stageMeta[props.stage];

  return (
    <main className={`variant-d ${inboxOpen ? "" : "inbox-closed"}`}>
      <aside className="focus-mailbox-sidebar">
        <header className="focus-mailbox-brand">
          <div className="brand-mark"><Sparkles size={16} /></div>
          <strong>Commonplace</strong>
          <button onClick={() => setInboxOpen(false)} title="Collapse inbox"><PanelLeftClose size={15} /></button>
        </header>
        <button className="focus-mailbox-new"><Plus size={15} /> New Idea</button>
        <div className="focus-mailbox-search"><Search size={14} /><input placeholder="Search Ideas" /></div>
        <IdeaRows />
        <footer>
          <button><Archive size={14} /> Archive</button>
          <span>12 Ideas</span>
        </footer>
      </aside>

      <section className="focus-mailbox-main">
        <header className="focus-header">
          <div className="focus-mailbox-title">
            {!inboxOpen ? (
              <button onClick={() => setInboxOpen(true)} title="Open inbox"><Menu size={16} /></button>
            ) : null}
            <div>
              <span className="section-kicker">PINNED · SOFTWARE IDEA</span>
              <h1>A calmer way to develop ideas</h1>
            </div>
          </div>
          <div className="focus-header-state">
            <PhaseIndicator compact phase={meta.phase} />
            <StatusPill state={meta.state} label={meta.label} />
            <ThemeControl theme={props.theme} setTheme={props.setTheme} />
            <button className={drawerOpen ? "active" : ""} onClick={() => setDrawerOpen(!drawerOpen)}>
              <Columns3 size={16} /> Artifacts <b>3</b>
            </button>
          </div>
        </header>
        {props.stage === "developing" ? (
          <Conversation composer={props.composer} setComposer={props.setComposer} />
        ) : (
          <ReviewConversation key={props.stage} stage={props.stage} composer={props.composer} setComposer={props.setComposer} />
        )}
      </section>

      {drawerOpen ? (
        <div className="focus-mailbox-drawer">
          <ArtifactInspector {...props.artifactProps} stage={props.stage} compact />
          <button className="drawer-close" onClick={() => setDrawerOpen(false)}><X size={16} /></button>
        </div>
      ) : null}

      {props.stage === "developing" ? (
        <div className="focus-running-dock">
          <div><LoaderCircle size={14} className="spin" /><span><strong>Offline API field guide</strong><small>Claude is working</small></span></div>
          <button><Square size={12} /> Stop</button>
        </div>
      ) : null}
    </main>
  );
}

type WorkspaceProps = {
  stage: StageKey;
  theme: ThemeKey;
  setTheme: (theme: ThemeKey) => void;
  composer: string;
  setComposer: (value: string) => void;
  artifactView: ArtifactView;
  setArtifactView: (view: ArtifactView) => void;
  focusArtifact: boolean;
  setFocusArtifact: (focus: boolean) => void;
  artifactProps: {
    view: ArtifactView;
    setView: (view: ArtifactView) => void;
    focus: boolean;
    setFocus: (focus: boolean) => void;
  };
};

function PrototypeSwitcher({
  variant,
  setVariant,
  stage,
  setStage,
}: {
  variant: VariantKey;
  setVariant: (variant: VariantKey) => void;
  stage: StageKey;
  setStage: (stage: StageKey) => void;
}) {
  const currentIndex = variants.findIndex((item) => item.key === variant);
  const cycle = (direction: -1 | 1) => {
    const next = variants[(currentIndex + direction + variants.length) % variants.length];
    setVariant(next.key);
  };

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft") cycle(-1);
      if (event.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });

  return (
    <>
      {variant === "D" ? (
        <nav className="stage-switcher" aria-label="Workflow state walkthrough">
          <small>WORKFLOW STATE</small>
          {stages.map((item) => <button className={stage === item.key ? "active" : ""} key={item.key} onClick={() => setStage(item.key)}>{item.name}</button>)}
        </nav>
      ) : null}
      <div className="prototype-switcher" aria-label="Prototype variants">
        <button onClick={() => cycle(-1)} title="Previous variant"><ArrowLeft size={16} /></button>
        <span><small>THROWAWAY PROTOTYPE</small><strong>{variant} — {variants[currentIndex].name}</strong></span>
        <button onClick={() => cycle(1)} title="Next variant"><ArrowRight size={16} /></button>
      </div>
    </>
  );
}

function App() {
  const initialVariant = useMemo(() => {
    const value = new URLSearchParams(window.location.search).get("variant")?.toUpperCase();
    return variants.some((variant) => variant.key === value) ? (value as VariantKey) : "A";
  }, []);
  const [variant, setVariantState] = useState<VariantKey>(initialVariant);
  const initialStage = useMemo(() => {
    const value = new URLSearchParams(window.location.search).get("stage")?.toLowerCase();
    return stages.some((stage) => stage.key === value) ? (value as StageKey) : "developing";
  }, []);
  const [stage, setStageState] = useState<StageKey>(initialStage);
  const [theme, setTheme] = useState<ThemeKey>("system");
  const [composer, setComposer] = useState("");
  const [artifactView, setArtifactView] = useState<ArtifactView>("preview");
  const [focusArtifact, setFocusArtifact] = useState(false);

  const setVariant = (next: VariantKey) => {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", next);
    window.history.replaceState({}, "", url);
    setFocusArtifact(false);
    setVariantState(next);
  };

  const setStage = (next: StageKey) => {
    const url = new URL(window.location.href);
    url.searchParams.set("stage", next);
    window.history.replaceState({}, "", url);
    setComposer("");
    setStageState(next);
  };

  const props: WorkspaceProps = {
    stage,
    theme,
    setTheme,
    composer,
    setComposer,
    artifactView,
    setArtifactView,
    focusArtifact,
    setFocusArtifact,
    artifactProps: {
      view: artifactView,
      setView: setArtifactView,
      focus: focusArtifact,
      setFocus: setFocusArtifact,
    },
  };

  return (
    <div className="app-theme" data-theme={theme}>
      {variant === "A" ? <VariantA {...props} /> : null}
      {variant === "B" ? <VariantB {...props} /> : null}
      {variant === "C" ? <VariantC {...props} /> : null}
      {variant === "D" ? <VariantD {...props} /> : null}
      <PrototypeSwitcher variant={variant} setVariant={setVariant} stage={stage} setStage={setStage} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
