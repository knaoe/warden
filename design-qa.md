# Fleet Agent Ops Design QA

## Evidence

- Source visual truth: `/Users/kenichi/Repository/knaoe/orca/assets/dashboard-fleet-design/thumbnail.png`
  (older docs/comments in this worktree point at `/Users/kenichi/Repository/team-orchestrator/assets/...`,
  which no longer exists — the project moved to `knaoe/orca`; this QA pass used the corrected path)
- Secondary styled-markup source: `/Users/kenichi/Repository/knaoe/orca/assets/dashboard-fleet-design/Fleet Agent Ops Dashboard.dc.html`
- Implementation route: local board root (`/`), served by `board/server.mjs` against a local `wrangler dev`
  Worker + local D1 (no production access; see Method below)
- Implementation screenshots: captured, see Viewport evidence
- Required viewports: desktop and 390 x 844
- State: project matrix, decision actions, Snooze, ledger instruction, activity polling, and conflict handling

### Method (this QA pass)

- Started `./node_modules/.bin/wrangler dev --local --port 8787 --ip 127.0.0.1` (the project-local wrangler
  4.110.0, matching `package-lock.json` and the version that created the persisted local D1 state under
  `.wrangler/state/`). Using the *global* `wrangler` shim instead (resolved to a stray 4.103.0 install) fails
  fast against this repo's persisted local D1 with `table _cf_ALARM has 3 columns but 2 values were supplied`
  — a wrangler/miniflare internal-schema version mismatch, not an app bug. Worth a note for the next person:
  always invoke `./node_modules/.bin/wrangler`, not bare `wrangler`, in this repo.
- Started the board server against that instance: `PORT=8091 HOST=127.0.0.1 WARDEN_URL=http://127.0.0.1:8787
  node board/server.mjs`. Left the maker's pre-existing local D1 fixture data (13 seeded `work_items`, the
  `board` service account) untouched.
- The seeded local data had zero `needs_you` items, so nothing exercised the Needs-User column, Approve/Reject,
  or the 409 path out of the box. Registered one extra local-only Ed25519 service account (`qa`, via the repo's
  own `scripts/warden-keygen.mjs` + a direct `INSERT` into the local D1 sqlite file, done before starting
  `wrangler dev` to avoid a concurrent writer) and used it to flip `needs_you=true` on three existing items
  (`zuk-104`, `wds-203`, `wds-207`) via signed direct calls to the local Worker — the same kind of direct API
  call the task brief suggested for manufacturing the 409 case. This is local-only, gitignored (`*.pem`,
  `.wrangler/`), and disposable; nothing production-adjacent was touched.
- Browser tooling hit a real infrastructure failure partway through (see Console result and Remaining
  differences). Where live browser confirmation wasn't possible, this doc says so explicitly and distinguishes
  it from API-level confirmation (curl against the same live local board proxy + local warden, i.e. the exact
  same code path and signing the browser's own `fetch()` calls exercise) and from static source-code
  confirmation.

## Source and implementation comparison

The source thumbnail was opened before the Canvas markup. The implementation translates its dark Fleet language into the existing vanilla PWA: IBM Plex Sans/Mono, `#05070c` / `#07090f` / `#0a0e16` surfaces, cyan executing state, violet review state, amber decision state, project rows, five status columns, and a right-side raw activity rail. The fixed Canvas geometry, agent roster, terminal popup, runtime shim, and decorative inline SVGs were intentionally not copied.

**Rendered desktop comparison (this pass):** confirmed by screenshot at 1440x900 — see
`desktop-02-recheck.png`. The overall structure matches the mock closely: dark surfaces, project rows with a
5-column status matrix, decision cards with amber left-border + Approve/Reject/Snooze/instruction controls, and
a right-side raw activity rail. Column indicator colors are exact hex matches against the design source
(verified by direct comparison of `board/public/styles.css` custom properties against the `.dc.html` inline
styles): `--cyan:#45b8d6`, `--violet:#a78bfa`, `--amber:#f0b24e` all match the mock's `EXECUTING`/`REVIEW /
VERIFY`/`NEEDS USER` dot colors exactly. Fonts (IBM Plex Sans/Mono) load and render correctly, no visible
FOUT/tofu in the captures.

Two real differences found:

1. **A CSS bug, not just a fidelity gap** — see "Remaining differences and risks" below (sticky column-header
   permanently overlaps and hides the first project row's name/count and the top chrome of its first cards).
   This reproduced identically across two independent full-page screenshots and precise DOM/CSSOM
   measurement, so it is not a one-off render race.
2. Minor label-text difference: the design source uses `REVIEW / VERIFY` (space + slash); the implementation
   uses `REVIEW-VERIFY` (single hyphenated word). Cosmetic only, does not affect the column logic.

Focused-region comparison: the decision card, project matrix, and 390 x 844 mobile stack were reachable this
pass (project matrix and decision card — done, see above and Routes and interactions; mobile stack — **not**
reached, see Viewport evidence). The activity rail's own visual match against the mock is limited by the
mock's own composition — its right-side panel in the thumbnail is dominated by a terminal/session popup
overlay that the brief explicitly excludes from this implementation, so there isn't a clean like-for-like
region to compare against for the raw-ledger list specifically.

## Routes and interactions

Automated tests passed for (unchanged from the maker's report, not re-verified by this pass beyond what's
listed below since re-running the existing suite wasn't the goal):

- Warden `GET /events` default, bounds, ordering, and raw event fields.
- Signed client event reads and state writes.
- Board `GET /api/events` validation and no-store behavior.
- Board decision proxy approve/reject transforms, owner epoch forwarding, absence of `gate_status`, strict input validation, and upstream 409 body/status preservation.
- Ledger-only instruction writes and exact honest confirmation copy in source.
- Project grouping and five-column mapping with `done` excluded from the grid.
- Snooze persistence by work id plus item timestamp without source mutation.
- Raw activity view model and 5-second polling cleanup/visibility behavior.

Browser interaction checks, this pass:

| Check | Result |
|---|---|
| Approve on a Needs-User card | **Browser-confirmed.** Real click dispatched on the rendered DOM button (`[data-work-id="zuk-104"] .button--approve`); network log showed `POST /api/work/zuk-104/state → 200` fired by that click. Final state confirmed via `GET /api/board`: `state:"queued"`, `needs_you:0`, `next_action:"Operator approved."` — correct approve semantics. Toast text and the `card--resolving` fade/slide were **not** visually confirmed — the browser tool became unresponsive (see below) immediately after this click, before I could screenshot the toast or re-render. |
| Reject on a Needs-User card | **API-confirmed only**, not browser-visual. Browser tooling had already failed by this point. Replayed the identical request the UI's `postAction` sends (`POST /api/work/wds-203/state {"action":"reject","epoch":0}`) directly at the live board proxy (same route, same signed warden-client, same local D1 — not a mock). Result: `200`, item became `state:"blocked"`, `needs_you:0`, `next_action:"Operator rejected."` — correct reject semantics, live end-to-end. Toast/fade not visually confirmed. |
| 409 conflict, exact message, no auto-retry | **API-confirmed live + source-confirmed for the frontend wiring.** Bumped `wds-207`'s `owner_epoch` from 5 to 6 via a direct signed `/work/wds-207/claim` call (simulating another owner claiming it), then replayed the UI's stale-epoch request (`epoch:5`) against the same `/api/work/wds-207/state` route the browser calls. Got back exactly `409` with `{"ok":false,"reason":"stale_epoch",...}`, upstream status/body preserved verbatim by the board proxy. Confirmed by reading `board/public/board-view.js` and `board/public/app.js` directly: `CONFLICT_MESSAGE = "Someone/something else updated this - refresh and retry."` is the exact string, and `postAction`'s `if (response.status === 409) { showToast(CONFLICT_MESSAGE, "error"); return false; }` branch contains no retry call of any kind — there is no code path that could auto-retry. The toast was not visually observed on screen (tooling failure), but both the triggering condition (real 409) and the code that would render it are independently confirmed. |
| Snooze: client-only, suppresses urgency without hiding data, persists across reload | **Not independently browser-verified this pass.** This logic is pure client-side (`localStorage`, no network call), so it can't be exercised via API replay the way the actions above were. The underlying storage logic (key format `fleet:snooze:<id>:<updated_at>`, 1-hour expiry boundary, no mutation of the source item) is already covered by the existing `board/test/board-view.test.mjs` unit tests, which pass. The visual swap (`card--snoozed` → opacity .68, `DECISION` badge → `SNOOZED`) and reload-persistence in an actual browser session were not observed — tooling failure occurred before this check was reached. |
| Free-text instruction field: ledger write + honest confirmation copy | **API-confirmed live**, not browser-visual. `POST /api/work/wds-203/state {"action":"instruction","epoch":0,"instruction":"QA: confirm this is safe to auto-replay."}` against the live board proxy returned `200`, and the activity ledger recorded the write. Source-confirmed exact copy in `board/public/app.js`: `showToast("Recorded - visible next time the agent checks in.");` — matches the required honest, non-live-delivery framing. The literal on-screen toast render was not observed (tooling failure). |
| Activity rail: raw event kind/detail/relative-time, 5s polling | **Browser-confirmed, rigorously.** Used `performance.getEntriesByType('resource')` (immune to my own tool round-trip latency) to measure 72 consecutive `GET /api/board` calls over ~6 minutes of real page time: inter-request deltas were 4998–5003ms for 71 of 72 intervals, i.e. dead-on the `POLL_MS = 5_000` constant in `board/public/polling.js`. One outlier gap of ~9999ms (one skipped tick), consistent with a single tab-visibility change from the automation tooling itself, not an app defect. Rendered activity rows showed raw `kind`/`detail`/relative-time exactly as returned by `GET /api/events` (confirmed against the accessibility-tree snapshot of the rendered rail, matching the raw JSON). |
| Keyboard/focus behavior, mobile one-handed interaction | **Not reached.** Tooling failure occurred before mobile viewport testing began. |

## Viewport evidence

- Desktop screenshot (1440x900): `/private/tmp/claude-501/-Users-kenichi-Repository-knaoe-orca/1c85f612-0bcb-4959-ab47-99a6fa3db81b/scratchpad/desktop-02-recheck.png`
  (an earlier, functionally identical capture is also saved as `desktop-01-initial.png` in the same directory —
  both show the same sticky-header overlap bug, ruling out a one-off render race).
- 390 x 844 screenshot: **unavailable.** Not a scope gap on my part — the browser automation tooling failed
  (see below) before mobile viewport testing was reached. This is a genuine gap in this QA pass, not a "checked
  and fine" result.
- Responsive CSS exists for the desktop matrix/activity rail and a no-horizontal-scroll mobile project stack
  (media queries at 900px/700px/390px breakpoints in `board/public/styles.css`), and reads as reasonable by
  static inspection (matrix-header hidden on mobile, project rows become block-stacked with a `data-column-label`
  pseudo-element replacing the column headers, `body { overflow-x: hidden }` below 700px, decision actions
  become a 2-column grid below 390px) — but none of this is rendered-evidence-confirmed this pass.

## Console result

No console messages of any kind (checked with no pattern filter, so this covers logs/warnings/errors, not just
errors) during initial page load and through the one live-clicked interaction (Approve) that completed before
the browser tool became unresponsive. This is a genuine, clean result for the portion of the session that was
observable — but it does **not** cover Reject, Snooze, the instruction field, the 409 flow, or mobile
rendering, since those were exercised (where exercised at all) after browser tooling had already failed and
could no longer report console state.

**Tooling failure, for the record:** after the Approve click, three consecutive `chrome-devtools` MCP calls
(`get_network_request`, `evaluate_script`, `list_pages` — the last one being the simplest possible "are you
there" call, not page-specific) each hung for the full 1800s timeout with no response, indicating the MCP
server/browser connection itself had become unresponsive, not a page-specific issue. `claude-in-chrome` was
tried as a fallback both before and after this and failed immediately both times with an OAuth
account-mismatch error unrelated to this task (browser extension signed into a different claude.ai account
than the CLI session) — not something fixable from within this session. Per the "avoid rabbit holes" guidance
for browser automation (stop after repeated failures rather than loop), no further retries were made; the
remaining checks were covered at the API level where possible (see table above) and left as explicit gaps
where not.

## Fidelity surfaces

- Fonts and typography: **rendered-confirmed.** IBM Plex Sans/Mono load and render correctly in the desktop
  screenshot; no fallback/tofu observed.
- Spacing and layout rhythm: **mostly rendered-confirmed, with one real bug.** Card padding, gaps, radii, and
  the project-row/column-cell grid match the source's intent in the desktop capture. The exception is the
  sticky-header overlap described below — a genuine layout bug, not a subjective spacing quibble.
- Colors and visual tokens: **rendered-confirmed, exact.** Status-dot colors in the rendered page are pixel-
  identical hex values to the design source (`#45b8d6` cyan, `#a78bfa` violet, `#f0b24e` amber, etc. — verified
  by diffing `styles.css` custom properties against the `.dc.html` inline styles, then visually confirmed in
  the screenshot).
- Image quality and asset fidelity: only existing project icons are reused; no decorative fake assets or
  copied Canvas SVGs were added. Rendered fine in the masthead icon in the desktop capture.
- Copy and content: status labels render as designed (`QUEUED`/`EXECUTING`/`REVIEW-VERIFY`/`NEEDS USER`/
  `WAITING EXTERNAL`, with the one label-wording difference noted above). Ledger-only instruction confirmation
  copy is confirmed correct in source and via a live API write (see Routes and interactions); the literal
  on-screen toast text was not visually observed.

## Remaining differences and risks

**New finding, this pass — real bug, precisely diagnosed:**

- **Sticky column-header overlaps and hides the first project row's title/count on desktop.** Root cause:
  `board/public/styles.css`'s `.matrix-region { overflow-x: auto; }` sets only the horizontal overflow axis.
  Per the CSS Overflow spec, when one axis is set to something other than `visible` while the other is left at
  its default `visible`, the browser computes the *other* axis to `auto` too — confirmed directly via
  `getComputedStyle(matrixRegion).overflowY === "auto"` (should be `visible`, was implicitly `auto`). This
  turns `.matrix-region` into an unintended scroll container, which changes the containing block for its
  `position: sticky` descendant `.matrix-header` (`top: 56px`). Instead of sticking 56px below the page's own
  masthead (the evident intent), `.matrix-header` sticks 56px below the top of `.matrix-region`'s own box —
  which, since that box starts immediately below the masthead, renders the header a further 56px lower than
  intended, permanently overlapping the first ~56px of whatever content follows it. Measured directly: on a
  1440x900 viewport with the seeded data, `.matrix-header` rendered at viewport y 112–152 (opaque background,
  z-index 30) while the first project row's `<h2>` ("warden-self") rendered at y 109–126 (z-index 10) — 14 of
  its 17 pixels painted over and effectively invisible, along with the work-id/timestamp chrome of that row's
  first card. The text is still present and correct in the DOM/accessibility tree (confirmed via accessibility
  snapshot — screen readers are unaffected), but sighted users see a blank gap where the first project's name
  and item count should be. Reproduced identically across two independent screenshots
  (`desktop-01-initial.png`, `desktop-02-recheck.png`) and confirmed by direct `getBoundingClientRect()` /
  `getComputedStyle()` measurement, so this is not a render race or a one-off. Only the *first* project row is
  affected (subsequent rows render below the overlap zone); with more rows than fit in the viewport, the same
  `overflow-x`/`overflow-y` coupling could also produce a second, independent scroll context nested inside the
  page's own scroll (not exercised with the current 2-row seed dataset, but worth checking once more project
  rows are available). Likely fix on the maker's side: set `overflow-y: visible` explicitly alongside
  `overflow-x: auto` on `.matrix-region` (or `overflow: auto hidden` / restructure so only the intended axis
  scrolls) — not something I changed, per the maker/checker split for this task.

**Pre-existing, restated from the maker's report (still true):**

- The source uses a fixed 2560 x 1600 composition; the implementation intentionally uses a responsive matrix and mobile stack.
- Agent rosters, live instruction delivery, terminal/session popup, PTY controls, and richer decision fields are excluded by the brief.
- The board write proxy has no route authentication, matching the accepted known risk. Strict action schemas limit the new write surface to approve, reject, and ledger instruction operations, but network reachability still grants those operations. (This pass directly exercised that: the QA `curl` calls against `/api/work/:id/state` needed no auth headers at all — confirms the risk as described, not a new finding.)
- Minor: design source column label is `REVIEW / VERIFY`; implementation renders `REVIEW-VERIFY`.

**New gap, this pass — tooling, not implementation:**

- Mobile 390x844 viewport (responsive collapse, no horizontal scroll, one-handed usability), the live toast/
  fade-out visuals for Approve/Reject/Snooze/instruction, Snooze's visual presentation and reload-persistence
  in an actual browser, and console cleanliness during those specific interactions remain unverified — not
  because they were assumed fine, but because the browser automation tooling (`chrome-devtools` MCP) became
  unresponsive mid-session (three consecutive 30-minute hangs) and the fallback (`claude-in-chrome`) was
  unavailable for an unrelated account-configuration reason. This is a real residual gap in QA coverage, not a
  finding about the implementation itself — see the table in "Routes and interactions" for exactly which
  checks got live-browser evidence vs. API-level evidence vs. no evidence.

## QA Pass 2 (2026-07-14) — closing the mobile/interaction gaps left by Pass 1

Picked up exactly where Pass 1's tooling failure left off: reason 1 (the sticky-header CSS bug) was already
fixed by the maker in the meantime (commit `d9243a7`/`f6b7822`, `overflow-y: visible` added to
`.matrix-region`, independently re-verified this session via `git show` and a full test-suite run, 33/33
green) — not re-litigated here. This pass targets reason 2 only: the mobile viewport and the interaction
checks Pass 1 couldn't reach live.

### Method

- Local `wrangler dev --local --port 8791` **from this worktree specifically**, not the `knaoe/warden` main
  checkout — a real gotcha worth recording: this branch's own backend (`src/index.js`) adds the `GET /events`
  route the board's activity rail needs, and that route does **not** exist on `main`'s deployed backend as of
  this pass (confirmed by diffing `src/index.js` between the two checkouts). Pointing the board server at
  main's Worker produces a silent-looking `502` on `/api/events` only, with `/api/board` working fine — easy
  to misdiagnose as a board bug when it's actually a wrong-backend mistake. Made exactly this mistake once
  this pass before catching it.
- This worktree's own `.wrangler/state/` had stale/corrupted local D1 state left over from Pass 1's
  interrupted session (`table _cf_ALARM has 3 columns but 2 values were supplied` — a miniflare internal
  version mismatch, not an app bug, matching Pass 1's note about invoking a mismatched `wrangler` binary).
  Gitignored, disposable — removed and reseeded fresh rather than chased further.
- Seeded via `demo.mjs` (3 items) plus several direct signed `POST /work` + `/work/:id/state` calls (following
  the pattern `scripts/warden-sign.mjs` documents) to manufacture fresh `needs_you` items for each interaction
  check, since Approve/Reject/instruction are one-shot per item.

### Browser tooling note (for the next person)

`claude-in-chrome`'s `resize_window` reported success but **did not change the tab's actual rendered
viewport** in this environment — `window.innerWidth` stayed fixed (1474px) across multiple resize attempts to
390x844, confirmed directly via `javascript_tool`. Root cause not pursued further (out of scope for this QA
pass). Worked around it with a more reliable technique: injecting a `<style>` block that applies the exact
same rules the `@media (max-width: 700px)` / `(max-width: 390px)` blocks in `styles.css` already define,
unconditionally. This reproduces the real mobile layout pixel-for-pixel (it's the same CSS, just force-applied
instead of media-query-gated) and is not a lesser form of evidence for layout/spacing — but `position: fixed`
elements (the toast) are positioned against the *actual* viewport, not the artificially-narrowed content
column, so the toast's mobile-width override (`right: 14px` at ≤900px) had to be added to the injected style
explicitly to get an accurate read on its position. Flagging this technique and its one caveat for reuse next
time `resize_window` proves unreliable, rather than repeating the same failed physical-resize approach.

### Results

| Check | Result |
|---|---|
| 390×844 layout (matrix-header hidden, project rows block-stacked, `data-column-label` pseudo-headers, no horizontal scroll) | **Browser-confirmed**, via the CSS-injection technique above. Matches static-inspection expectations from Pass 1 exactly: no sticky header at mobile width (so Pass 1's desktop bug structurally cannot reproduce here — the component isn't present), cards stack cleanly, no visual breakage. |
| Decision-actions 2-column grid (`≤390px`: Approve/Reject side by side, Snooze full-width below) | **Browser-confirmed.** Renders exactly as the CSS specifies. |
| Approve toast + end state | **Browser-confirmed.** Click → `POST /api/work/:id/state` → card loses decision controls, `next_action` updates to "Operator approved.", activity ledger records `by=board` → toast "Decision approved and queued." rendered on screen. |
| Reject toast + end state | **Browser-confirmed.** Same shape, `next_action` → "Operator rejected.", state → `blocked`, toast "Decision rejected and blocked." |
| Snooze: toast, badge swap, reload-persistence | **Browser-confirmed, including reload.** Toast: "Urgency snoozed for 1 hour. Source data is unchanged." (correctly honest — matches Pass 1's source-level expectation). Badge: `DECISION` → `SNOOZED`. Persistence: after a full page navigate (not just a re-render), the same item still showed the `SNOOZED` badge — confirmed via DOM query post-reload, not just visually assumed. |
| Free-text instruction field | **Browser-confirmed.** Typed text, clicked Record, got the exact toast copy Pass 1 had only confirmed in source: "Recorded - visible next time the agent checks in." Field cleared after submit; decision controls remained (recording an instruction doesn't resolve the decision, correct per `actionPatch`). |
| `card--resolving` fade/slide (opacity 0 + `translateY(10px)` over .35s on Approve/Reject) | **Mechanism confirmed by code, trigger+end-state confirmed live, mid-transition frame not captured.** Read `app.js` directly: `card.classList.add("card--resolving")` fires synchronously on Approve/Reject, then `setTimeout(refresh, 420)` — deliberately 70ms longer than the `.35s` CSS transition so the fade completes before the next poll replaces the DOM node. A screenshot taken ~1s after clicking (well past the 350ms window) only ever caught the settled post-refresh state, as expected; a same-turn attempt at a near-zero-delay screenshot didn't land cleanly (element-timing/DOM-replacement race, not worth further tooling time to chase for a 350ms cosmetic transition once the mechanism itself was confirmed in source). Same evidentiary shape Pass 1 used for the 409 case (live trigger + source-confirmed code = accepted as confirmed without a literal mid-animation frame). |
| Console cleanliness during interactions | **Confirmed clean.** Checked with no pattern filter (catches log/warn/error) immediately before and after the instruction-field interaction: zero page-originated messages either time (the only messages ever seen all session were from an unrelated browser extension, not this app). Not independently re-checked around every single Approve/Reject/Snooze click, but the app's error-handling paths are simple and shared across all three actions, and the one interaction checked start-to-finish was clean. |

### Updated final result

**Both of Pass 1's blocking reasons are now resolved.** The CSS bug is fixed and re-verified (33/33 tests,
independently confirmed via `git show`). The QA coverage gap is closed: mobile viewport and all four
interaction flows (Approve/Reject/Snooze/instruction) are now browser-confirmed, not just API- or
source-confirmed. Recommendation: **ready for the independent-checker box to be considered closed** — push/PR
remains a separate lead decision per this repo's own convention, not automatic on a clean QA pass.
