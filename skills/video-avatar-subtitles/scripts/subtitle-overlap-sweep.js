// Subtitle safe-zone detector — see ../references/MOBILE-SIZING.md.
//
// Paste into browser devtools console (or run via an MCP preview_eval tool)
// on the running presentation. Steps through every step by clicking the
// stage, and reports how many pixels (if any) each step's lowest visible
// text runs past the top edge of the subtitle bar.
//
// Assumes the same DOM conventions web-video-presentation's scaffold uses:
//   .stage-frame     — clickable root that advances one step per click
//   .subtitle-bar    — the bottom caption bar (adjust selector if your
//                       project names it differently)
//   .scene           — wrapper around the current chapter's rendered step
//
// Adjust TOTAL_STEPS to the sum of every chapter's narrations.length
// (i.e. chapters.reduce((s, c) => s + c.narrations.length, 0)) before running,
// and reset the stepper's localStorage cursor to {chapter:0, step:0} first
// (or just reload the page fresh) so the sweep starts from the beginning.
//
// A positive `overlap` means that step's content bottom edge is
// `overlap`px BELOW the subtitle bar's top edge — i.e. content is running
// under the subtitle scrim. Single-digit results are usually animation-
// timing sampling noise (harmless); double digits or more need a real fix.

(async () => {
  const TOTAL_STEPS = 37; // <-- set this to your project's actual step count
  const STEP_WAIT_MS = 60; // let one animation frame settle before measuring

  const stage = document.querySelector(".stage-frame");
  if (!stage) {
    console.error("subtitle-overlap-sweep: .stage-frame not found — adjust selectors for this project");
    return;
  }

  const results = [];
  for (let i = 0; i < TOTAL_STEPS; i++) {
    await new Promise((r) => setTimeout(r, STEP_WAIT_MS));

    const sub = document.querySelector(".subtitle-bar");
    const subTop = sub ? sub.getBoundingClientRect().top : Infinity;

    const scene = document.querySelector(".scene");
    let maxBottom = 0;
    let worstText = "";
    if (scene) {
      const walker = document.createTreeWalker(scene, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent.trim()) continue;
        const parent = node.parentElement;
        if (!parent) continue;
        const rect = parent.getBoundingClientRect();
        if (rect.bottom > maxBottom) {
          maxBottom = rect.bottom;
          worstText = node.textContent.trim().slice(0, 24);
        }
      }
    }

    results.push({ step: i, overlap: Math.round(maxBottom - subTop), worstText });
    stage.click(); // advance to the next step
  }

  const offenders = results.filter((r) => r.overlap > 5);
  console.log(`Swept ${results.length} steps — ${offenders.length} with overlap > 5px:`);
  console.table(offenders);
  return offenders;
})();
