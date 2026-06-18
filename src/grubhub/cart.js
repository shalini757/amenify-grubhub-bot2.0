const fs = require('fs');
const path = require('path');
const { logger } = require('../logger');
const { BotError, detectBlockers, dismissPopups } = require('./browser');

// Tiny helper: dismiss any open popup, swallow errors. Wraps the cross-
// module call so callers don't need to handle the no-popup case.
async function safeDismiss(page) {
  try { await dismissPopups(page); } catch (_) { /* non-fatal */ }
}

// When an item with required modifiers opens its customize modal, auto-pick
// a sensible default for each required section so the Add-to-bag CTA
// becomes enabled. Local-only (no Claude API). Strategy per section:
//   1. Find all clickable options (radio / checkbox / role-* / label-for)
//   2. PREFER options whose surrounding text has NO "+$X" upcharge suffix
//      (regular bread/cheese, not premium upsells)
//   3. Among options with no upcharge, pick the first
//   4. If every option has an upcharge, pick the cheapest one
//   5. Click and move to the next required section
//
// Footer button `[data-testid="emi-footer-cta"]` flips from "Make required
// choice (N) : $X" to "Add to bag" once everything's filled.
// "Select your bread"            → "bread"
// "Select your toasting option"  → "toasting"
// "Select your cheese"           → "cheese"
// Returns lower-case key, or null if the title doesn't match.
function deriveCategoryKey(title) {
  const m = String(title || '').match(/select your\s+(.+?)(?:\s+option)?\s*$/i);
  return m ? m[1].toLowerCase().trim().split(/\s+/)[0] : null;
}

// Walk the open modifier modal and return every section with its options
// as structured JSON. No HTML — just {key, title, required, selectMax,
// options:[{text, upcharge}]}. Used to feed the Claude modifier picker
// without sending raw DOM. `key` is normalized from the section title via
// the same deriveCategoryKey rule used elsewhere ("Select your bread" →
// "bread"), so callers can match Claude's pick back to a panel.
//
// Critical: Grubhub lazy-mounts panel contents. A collapsed panel has
// aria-expanded="false" and zero descendants — querying for options
// returns empty. Before scraping, we click each panel title to expand
// it (waiting briefly for the options to mount). Without this, every
// required section that wasn't already open would appear to have no
// options, and Claude would have nothing to pick from.
async function scrapeModifierModal(page) {
  // First, expand every panel that looks required. Done one at a time
  // so each click+wait completes before the next.
  const panelTitles = await page.$$('[data-testid="expansion-panel-title"]').catch(() => []);
  for (const titleEl of panelTitles) {
    const needsExpand = await titleEl
      .evaluate((el) => {
        const panel = el.parentElement;
        if (!panel) return false;
        const text = (el.innerText || '').trim();
        const isRequired = el.classList.contains('emi-invalid-item') || /\brequired\b/i.test(text);
        if (!isRequired) return false;
        const hasOptions = !!panel.querySelector(
          '[data-testid="emi-childOptions-submodifierBtn"], .emi-submodifier-btn, ' +
          'input[type="radio"]:not([disabled]), input[type="checkbox"]:not([disabled])',
        );
        return !hasOptions;
      })
      .catch(() => false);
    if (!needsExpand) continue;
    await titleEl.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});

    // Same 4-strategy expansion as fillRequiredModifiers — see comments there.
    async function waitReady(ms) {
      const dl = Date.now() + ms;
      while (Date.now() < dl) {
        const ok = await titleEl
          .evaluate((el) => {
            const panel = el.parentElement;
            return !!(panel && panel.querySelector('[data-testid="emi-childOptions-submodifierBtn"], .emi-submodifier-btn'));
          })
          .catch(() => false);
        if (ok) return true;
        await page.waitForTimeout(150);
      }
      return false;
    }

    await titleEl.click({ timeout: 1200 }).catch(() => {});
    let ready = await waitReady(1500);
    if (!ready) {
      await titleEl.evaluate((el) => {
        const tab = (el.parentElement || el).querySelector('[role="tab"]');
        if (tab) tab.click();
      }).catch(() => {});
      ready = await waitReady(1200);
    }
    if (!ready) {
      await titleEl.evaluate((el) => {
        const icon = (el.querySelector('.cb-icon-wrapper') || el.querySelector('svg.cb-icon'));
        if (icon) icon.click();
      }).catch(() => {});
      ready = await waitReady(1200);
    }
    if (!ready) {
      await titleEl.evaluate((el) => el.click()).catch(() => {});
      await waitReady(1200);
    }
  }

  return await page
    .evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none';
      };
      const dialog = document.querySelector('[role="dialog"], [aria-modal="true"], body.openDialog');
      const root = dialog || document.body;
      const panels = Array.from(root.querySelectorAll('[data-testid="expansion-panel-title"]'));
      const sections = [];
      for (const titleEl of panels) {
        if (!visible(titleEl)) continue;
        const title = (titleEl.innerText || '').trim();
        if (!title) continue;
        // Required iff Grubhub marks the panel invalid or the helper text
        // says "Select N (Required)". Optional sections are skipped by the
        // caller for the Claude path — we still include them for context.
        const isInvalid = titleEl.classList.contains('emi-invalid-item');
        const requiredText = /required/i.test(title);
        const selectMaxMatch = title.match(/select\s+(?:up to\s+)?(\d+)/i);
        const selectMax = selectMaxMatch ? parseInt(selectMaxMatch[1], 10) : 1;
        // Derive key from "Select your X" (matches deriveCategoryKey).
        const m = title.match(/select your\s+(.+?)(?:\s+option)?\s*$/i);
        const key = m ? m[1].toLowerCase().trim().split(/\s+/)[0] : null;
        const panel = titleEl.parentElement;
        if (!panel) continue;
        const optionNodes = Array.from(panel.querySelectorAll(
          '[data-testid="emi-childOptions-submodifierBtn"], .emi-submodifier-btn, ' +
          'input[type="radio"]:not([disabled]), input[type="checkbox"]:not([disabled]), ' +
          '[role="radio"]:not([aria-disabled="true"]), [role="checkbox"]:not([aria-disabled="true"])'
        ));
        const options = [];
        for (const node of optionNodes) {
          const own = (node.innerText || '').trim();
          let text = own;
          if (!/\+\s*\$/.test(own)) {
            const container = (node.closest('label, [role="row"], li, [data-testid*="modifier"], [data-testid*="option"]') ||
              node.parentElement || node);
            text = (container.innerText || '').trim();
          }
          if (!text) continue;
          const upMatch = text.match(/\+\s*\$\s*(\d+(?:\.\d{1,2})?)/);
          const upcharge = upMatch ? parseFloat(upMatch[1]) : 0;
          // Strip the upcharge suffix from the displayed name so the
          // optionText Claude returns matches DOM cleanly later.
          const cleanText = text.replace(/\s*\+\s*\$\s*\d+(?:\.\d{1,2})?\s*$/, '').trim();
          options.push({ text: cleanText.slice(0, 80), upcharge });
        }
        sections.push({ key, title: title.slice(0, 80), required: isInvalid || requiredText, selectMax, options });
      }
      return sections;
    })
    .catch(() => []);
}

// Apply a Claude-returned pick to the modal. Re-uses the same ranked-options
// in-page logic as the local path, but looks up by `optionText` first
// (word-boundary, then substring) instead of by upcharge. Returns true if
// the click landed; false otherwise so the caller can fall back to cheapest.
async function clickModifierByText(
  page,
  { sectionKey, optionText },
) {
  // Find the panel matching this section key.
  const panel = await page.evaluateHandle((key) => {
    const titles = Array.from(document.querySelectorAll('[data-testid="expansion-panel-title"]'));
    for (const t of titles) {
      const titleText = (t.innerText || '').trim();
      const m = titleText.match(/select your\s+(.+?)(?:\s+option)?\s*$/i);
      const k = m ? m[1].toLowerCase().trim().split(/\s+/)[0] : null;
      if (k === key) return t.parentElement;
    }
    return null;
  }, sectionKey).catch(() => null);
  if (!panel) return false;
  const panelEl = panel.asElement();
  if (!panelEl) return false;

  // Expand the panel first if collapsed.
  await panelEl.evaluate((el) => {
    const title = el.querySelector('[data-testid="expansion-panel-title"]');
    if (title) title.scrollIntoView({ block: 'center' });
  }).catch(() => {});

  const clicked = await panelEl.evaluate((root, wanted) => {
    const needle = String(wanted || '').toLowerCase().trim();
    if (!needle) return false;
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRe = new RegExp('\\b' + escape(needle) + '\\b', 'i');
    const sels = [
      '[data-testid="emi-childOptions-submodifierBtn"]',
      '.emi-submodifier-btn',
      'input[type="radio"]:not([disabled])',
      'input[type="checkbox"]:not([disabled])',
      '[role="radio"]:not([aria-disabled="true"])',
      '[role="checkbox"]:not([aria-disabled="true"])',
    ];
    for (const sel of sels) {
      const nodes = Array.from(root.querySelectorAll(sel));
      if (!nodes.length) continue;
      const scored = nodes.map((node) => {
        const own = (node.innerText || '').trim();
        const container = (node.closest('label, [role="row"], li, [data-testid*="modifier"], [data-testid*="option"]') ||
          node.parentElement || node);
        const containerText = (container.innerText || '').trim();
        const text = (own || containerText).toLowerCase();
        return { node, text };
      });
      // Word boundary first (best precision), then substring (loose match).
      let hit = scored.find((s) => wordRe.test(s.text));
      if (!hit) hit = scored.find((s) => s.text.includes(needle));
      if (hit) {
        hit.node.scrollIntoView({ block: 'center' });
        hit.node.click();
        return true;
      }
    }
    return false;
  }, optionText).catch(() => false);
  await panel.dispose().catch(() => {});
  return clicked;
}

async function fillRequiredModifiers(
  page,
  { saveScreenshot, label, preferences = {}, itemName } = {},
) {
  // Claude path: when MODIFIER_MODE=claude is set, scrape the modal into
  // structured JSON, ask Claude to pick sensible defaults for each required
  // section, then click each pick by text. Falls back to the local-defaults
  // loop (below) for anything Claude couldn't decide or whose pick can't be
  // located on the modal — so a bad Claude response never blocks the cart.
  const useClaude = (process.env.MODIFIER_MODE || '').toLowerCase() === 'claude';
  if (useClaude) {
    try {
      const sections = await scrapeModifierModal(page);
      const required = sections.filter((s) => s.required && s.options.length);
      if (!required.length) {
        logger.info({ itemName }, 'fillRequiredModifiers: claude path — no required sections to pick');
      } else {
        // Skip sections the notes already cover — preferences win.
        const claudeSections = required.filter((s) => !(s.key && preferences[s.key]));
        let picks = [];
        if (claudeSections.length) {
          const { pickModifiers } = require('../claude/claudeClient');
          const res = await pickModifiers({ itemName: itemName || label || 'item', sections: claudeSections });
          picks = Array.isArray(res.picks) ? res.picks : [];
        }
        // Apply preferences first (deterministic), then Claude picks.
        for (const sec of required) {
          if (!sec.key) continue;
          const pref = preferences[sec.key];
          if (pref) {
            const ok = await clickModifierByText(page, { sectionKey: sec.key, optionText: pref });
            logger.info({ section: sec.key, value: pref, ok }, 'fillRequiredModifiers (claude path): applied notes preference');
            continue;
          }
          const pick = picks.find((p) => p.sectionKey === sec.key);
          if (!pick) continue;
          const ok = await clickModifierByText(page, { sectionKey: sec.key, optionText: pick.optionText });
          logger.info(
            { section: sec.key, picked: pick.optionText, reason: pick.reason, ok },
            'fillRequiredModifiers (claude path): applied claude pick',
          );
        }
        // After applying picks, give the modal a beat to revalidate. If
        // everything's filled the local loop below exits on its first iter.
        await page.waitForTimeout(400);
      }
    } catch (e) {
      logger.warn({ err: e.message, itemName }, 'fillRequiredModifiers: claude path failed — falling back to local cheapest-option loop');
    }
  }

  // Guard against grinding all attempts on a panel that won't expand or whose
  // pick never registers (the ~90s hang seen on some Kids-side modals): if the
  // SAME required section is still the blocker across repeated attempts, stop
  // the structured loop early and let the CTA sweep (caller) take over.
  let stuckTitle = null;
  let stuckCount = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    // Pick the next unfilled required panel. Wawa marks it two different ways:
    //   1. Panel-title element has class `emi-invalid-item` (original signal)
    //   2. Section heading text literally says "(Required)" but the
    //      class isn't applied (seen on the cheese section after bread/
    //      toasting were already picked — panel is required but the
    //      invalid-class is only used when the *whole modal* is invalid).
    // Strategy: find any panel-title that's either invalid-classed OR whose
    // helper text says "Required" AND no option has been selected yet
    // (no descendant `.emi-childOptions-submodifierBtn--selected` /
    //  no checked input). Return the panel-title element handle.
    const invalidSectionHandle = await page
      .evaluateHandle(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const titles = Array.from(document.querySelectorAll('[data-testid="expansion-panel-title"]'));
        for (const t of titles) {
          if (!visible(t)) continue;
          const text = (t.innerText || '').trim();
          const classInvalid = t.classList.contains('emi-invalid-item');
          // A choice-group validator (e.g. Red Lobster "Choose Side") renders a
          // [data-testid="quantity-validator"] reading "Select one" / "Select N"
          // and does NOT use Wawa's emi-invalid-item class or the word
          // "required" in the title. Recognize a required group by ANY of: the
          // invalid class, the word "required", or a "Select…" validator — but
          // EXCLUDE anything marked Optional so we never auto-fill optional
          // upsell sections.
          const validatorEl = t.querySelector('[data-testid="quantity-validator"]');
          const validatorText = (validatorEl && validatorEl.innerText || '').toLowerCase();
          const hay = (text + ' ' + validatorText).toLowerCase();
          const isOptional = /\boptional\b/.test(hay);
          const textRequired = /\brequired\b/i.test(text);
          const validatorRequired = !!validatorEl && /\bselect\b/.test(validatorText);
          if (isOptional) continue;
          if (!classInvalid && !textRequired && !validatorRequired) continue;
          // Skip if this section already has a selected option, regardless
          // of how Wawa marks it. We're looking for *unfilled* required.
          // Scope to the whole expansion section (tab + lazy content region),
          // not just the tab, so a selection in the mounted options is seen.
          const panel = (t.parentElement && t.parentElement.parentElement) || t.parentElement;
          if (!panel) continue;
          // How many options this section requires ("Select 2 (Required)" → 2,
          // "Select your bread" → 1). Playwright reads this straight from the
          // panel title text.
          const maxMatch = text.match(/select\s+(?:up to\s+)?(\d+)/i);
          const selectMax = maxMatch ? parseInt(maxMatch[1], 10) : 1;
          // How many options are already chosen in this panel. A required
          // section is only "filled" once the chosen count reaches selectMax —
          // so "Select 2" stays unfilled after a single pick (Grubhub's footer
          // CTA would still read "Make required choice (1)").
          const selectedCount = panel.querySelectorAll(
            '.emi-childOptions-submodifierBtn--selected, ' +
            '.emi-submodifier-btn--selected, ' +
            'input[type="radio"]:checked, input[type="checkbox"]:checked, ' +
            '[aria-checked="true"], ' +
            // Red Lobster: a chosen side row renders a quantity stepper whose
            // subtract button only exists at qty >= 1 → presence = selected.
            '[data-testid="quantity-input-subtract"]').length;
          if (selectedCount >= selectMax) continue;
          return t;
        }
        return null;
      })
      .catch(() => null);

    const invalidElement = invalidSectionHandle ? invalidSectionHandle.asElement() : null;
    if (!invalidElement) {
      if (invalidSectionHandle) await invalidSectionHandle.dispose().catch(() => {});
      break;
    }

    // Read this section's title text to derive its preference key.
    const sectionTitle = await invalidElement
      .evaluate((el) => {
        const h = (el.querySelector('h5, h4, h3, [data-testid="emi-category"]') || el);
        return ((h.innerText || '').trim());
      })
      .catch(() => '');
    const categoryKey = deriveCategoryKey(sectionTitle);
    const preferredValue = categoryKey && preferences ? preferences[categoryKey] : null;

    // No-progress guard: the same required section blocking us across attempts
    // means the structured path can't drive it. Bail out after a few repeats so
    // we don't burn ~7s/attempt × 8; the caller's CTA sweep is the fallback.
    if (sectionTitle && sectionTitle === stuckTitle) stuckCount += 1;
    else { stuckTitle = sectionTitle; stuckCount = 0; }
    if (stuckCount >= 2) {
      logger.warn({ sectionTitle, attempt }, 'fillRequiredModifiers: no progress on this required section after repeated attempts — stopping structured fill (CTA sweep will retry)');
      // Dump the modal HTML so the unfillable section's option markup (e.g. how
      // La Presa marks a selected "protein") is visible for adding a selector.
      try {
        const screenshotsDir = path.resolve(process.cwd(), 'screenshots');
        if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
        const safe = String(sectionTitle).replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'unknown';
        const dumpPath = path.join(screenshotsDir, `stuck-section-${safe}.html`);
        const html = await page.evaluate(() => {
          const d = document.querySelector('[role="dialog"], [aria-modal="true"], .openDialog');
          return d ? d.outerHTML : document.body.outerHTML;
        }).catch(() => '');
        if (html) { fs.writeFileSync(dumpPath, html, 'utf8'); logger.warn({ dumpPath, bytes: html.length, sectionTitle }, 'stuck-section modal HTML dumped'); }
      } catch (_) { /* non-fatal */ }
      await invalidSectionHandle?.dispose().catch(() => {});
      break;
    }

    // Walk up to find the <section class="cb-expansion-panel"> that wraps
    // BOTH the role="tab" toggle AND the lazy-mounted content region.
    // DOM structure confirmed from real dumps:
    //   <section class="cb-expansion-panel">
    //     <div role="tab" id=".." class="u-clickable">
    //       <div data-testid="expansion-panel-title" ...>   ← invalidElement
    //         (title, validator, caret)
    //       </div>
    //     </div>
    //     <div aria-expanded="false">                       ← content region
    //       (when expanded, panel-content with submodifier buttons mount here)
    //     </div>
    //   </section>
    //
    // So:
    //   tabEl   = invalidElement.parentElement           (the role="tab" div)
    //   panelEl = invalidElement.parentElement.parentElement (the <section>)
    const tabAndPanelHandles = await invalidElement
      .evaluateHandle((titleEl) => {
        const tab = titleEl.parentElement;
        const section = tab ? tab.parentElement : null;
        return { tab, section };
      })
      .catch(() => null);
    // evaluateHandle returns a JSHandle to the {tab, section} object — we
    // need to pull each out separately as ElementHandles.
    const tabHandleEl = await invalidElement.evaluateHandle((el) => el.parentElement).catch(() => null);
    const sectionHandleEl = await invalidElement.evaluateHandle((el) => el.parentElement && el.parentElement.parentElement).catch(() => null);
    if (tabAndPanelHandles) await tabAndPanelHandles.dispose().catch(() => {});
    const tabEl = tabHandleEl ? tabHandleEl.asElement() : null;
    const panelEl = sectionHandleEl ? sectionHandleEl.asElement() : null;
    if (!panelEl || !tabEl) {
      if (tabHandleEl) await tabHandleEl.dispose().catch(() => {});
      if (sectionHandleEl) await sectionHandleEl.dispose().catch(() => {});
      await invalidSectionHandle?.dispose().catch(() => {});
      logger.warn({ attempt, sectionTitle }, 'fillRequiredModifiers: panel section not found — skipping');
      continue;
    }

    // Expand the panel if collapsed. Grubhub lazy-mounts panel contents:
    // when aria-expanded="false" the option nodes simply don't exist in
    // the DOM, so querying them returns empty. We must click the title
    // and wait for either aria-expanded to flip OR for submodifier buttons
    // to appear inside the panel. Up to ~2s — clicks can fire animation,
    // and the dialog repaints once contents mount.
    await invalidElement.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});

    const alreadyExpanded = await panelEl
      .evaluate((root) => {
        const region = root.querySelector('[aria-expanded]');
        const expanded = region ? region.getAttribute('aria-expanded') === 'true' : true;
        const hasOptions = !!root.querySelector(
          '[data-testid="emi-childOptions-submodifierBtn"], .emi-submodifier-btn, ' +
          'input[type="radio"]:not([disabled]), input[type="checkbox"]:not([disabled]), ' +
          '[role="radio"]:not([aria-disabled="true"]), ' +
          // Red Lobster: each side option is a row with a quantity-stepper "+".
          '[data-testid="quantity-input-add"]',
        );
        return expanded && hasOptions;
      })
      .catch(() => false);

    if (!alreadyExpanded) {
      // Helper: wait briefly for the panel to mount its options.
      async function waitForExpanded(ms) {
        const dl = Date.now() + ms;
        while (Date.now() < dl) {
          if (!panelEl) return false;
          const ok = await panelEl
            .evaluate((root) => {
              const hasOptions = !!root.querySelector(
                '[data-testid="emi-childOptions-submodifierBtn"], .emi-submodifier-btn, ' +
                'input[type="radio"]:not([disabled]), input[type="checkbox"]:not([disabled]), ' +
                '[role="radio"]:not([aria-disabled="true"]), ' +
                // Red Lobster: side options are quantity-stepper "+" rows.
                '[data-testid="quantity-input-add"]',
              );
              return hasOptions;
            })
            .catch(() => false);
          if (ok) return true;
          await page.waitForTimeout(150);
        }
        return false;
      }

      // Diagnostic: what does the section actually look like? After the fix
      // panelEl is the <section class="cb-expansion-panel">, tabEl is the
      // role="tab" child. aria-expanded lives on a sibling div of the tab.
      const preClickDiag = await panelEl
        .evaluate((section) => {
          const tab = section.querySelector('[role="tab"]');
          const region = section.querySelector('[aria-expanded]');
          return {
            sectionTag: section.tagName.toLowerCase(),
            sectionClass: (section.className || '').toString().slice(0, 120),
            tabFound: !!tab,
            tabRole: tab ? tab.getAttribute('role') : null,
            tabId: tab ? tab.id : null,
            tabClass: tab ? (tab.className || '').toString().slice(0, 120) : null,
            ariaExpanded: region ? region.getAttribute('aria-expanded') : null,
            ariaExpandedTag: region ? region.tagName.toLowerCase() : null,
          };
        })
        .catch(() => null);
      logger.info({ sectionTitle, preClickDiag }, 'fillRequiredModifiers: pre-click DOM state');

      let expanded = false;

      // Strategy 1: Playwright click with force on the role="tab" element.
      // tabEl is the actual ARIA toggle Grubhub binds the handler to.
      await tabEl.click({ timeout: 1500, force: true }).catch((err) => {
        logger.warn({ sectionTitle, err: err.message }, 'fillRequiredModifiers: strategy 1 click threw');
      });
      expanded = await waitForExpanded(1800);
      if (!expanded) {
        logger.warn({ sectionTitle }, 'fillRequiredModifiers: strategy 1 (Playwright force click on [role=tab]) did not expand');
      }

      // Strategy 2: dispatch real pointerdown + pointerup + click event
      // sequence on the role="tab" element. Angular components often listen
      // for pointer events and ignore plain click().
      if (!expanded) {
        await tabEl
          .evaluate((el) => {
            const r = el.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = r.top + r.height / 2;
            const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerType: 'mouse' };
            try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
            try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (_) {}
            try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_) {}
            try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (_) {}
            try { el.dispatchEvent(new MouseEvent('click', opts)); } catch (_) {}
            try { el.click(); } catch (_) {}
          })
          .catch((err) => logger.warn({ sectionTitle, err: err.message }, 'fillRequiredModifiers: strategy 2 dispatch threw'));
        expanded = await waitForExpanded(1500);
        if (!expanded) {
          logger.warn({ sectionTitle }, 'fillRequiredModifiers: strategy 2 (pointer event dispatch on [role=tab]) did not expand');
        }
      }

      // Strategy 3: keyboard activation. role="tab" is focusable
      // (tabindex="0" in dumps). Enter or Space toggles ARIA tabs.
      if (!expanded) {
        await tabEl.focus().catch(() => {});
        await page.keyboard.press('Enter').catch(() => {});
        expanded = await waitForExpanded(1200);
        if (!expanded) {
          await tabEl.focus().catch(() => {});
          await page.keyboard.press('Space').catch(() => {});
          expanded = await waitForExpanded(1200);
        }
        if (!expanded) {
          logger.warn({ sectionTitle }, 'fillRequiredModifiers: strategy 3 (keyboard Enter/Space) did not expand');
        }
      }

      // Strategy 4: click the title element (descendant of tab) with force.
      if (!expanded) {
        await invalidElement.click({ timeout: 1500, force: true }).catch(() => {});
        expanded = await waitForExpanded(1500);
        if (!expanded) {
          logger.warn({ sectionTitle }, 'fillRequiredModifiers: strategy 4 (force click on title) did not expand');
        }
      }

      logger.info({ sectionTitle, expanded }, 'fillRequiredModifiers: panel expansion attempt');

      // If still not expanded, dump the panel HTML so we can see what
      // markup variant we're up against and add another strategy.
      if (!expanded) {
        try {
          const screenshotsDir = path.resolve(process.cwd(), 'screenshots');
          if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
          const safe = String(sectionTitle).replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'unknown';
          const dumpPath = path.join(screenshotsDir, `panel-wont-expand-${safe}.html`);
          const html = await panelEl.evaluate((el) => el.outerHTML).catch(() => '');
          if (html) {
            fs.writeFileSync(dumpPath, html, 'utf8');
            logger.warn({ dumpPath, bytes: html.length, sectionTitle }, 'fillRequiredModifiers: panel would not expand after 4 strategies — HTML dumped');
          }
        } catch (_) { /* non-fatal */ }
      }
    }

    // Score every option in this section by upcharge. Done in-page in a
    // single round-trip so we can compare them all and pick the best one.
    // Selector order matters: Grubhub's custom submodifier-button (a span
    // with testid "emi-childOptions-submodifierBtn") is the primary widget
    // on Wawa-style menus; native inputs come second; ARIA-role widgets
    // are the last fallback.
    const ranked = await panelEl.evaluate((root) => {
      const optionSelectors = [
        '[data-testid="emi-childOptions-submodifierBtn"]',
        '.emi-submodifier-btn',
        'input[type="radio"]:not([disabled])',
        'input[type="checkbox"]:not([disabled])',
        '[role="radio"]:not([aria-disabled="true"])',
        '[role="checkbox"]:not([aria-disabled="true"])',
        // Red Lobster: each side is a row with a quantity-stepper "+" button
        // (data-testid="quantity-input-add"). Clicking it sets qty 1 = chosen.
        // Last in the list so Wawa's widgets win when both somehow exist.
        '[data-testid="quantity-input-add"]',
      ];
      for (const sel of optionSelectors) {
        const nodes = Array.from(root.querySelectorAll(sel));
        if (!nodes.length) continue;
        const items = nodes.map((node, idx) => {
          // For span-based submodifier buttons the surcharge is inside
          // the button itself, not in an ancestor. Walk up only if the
          // node's own text doesn't already carry it.
          const own = (node.innerText || '').trim();
          let text = own;
          if (!/\+\s*\$/.test(own)) {
            const container = (
              node.closest('label, [role="row"], li, [data-testid*="modifier"], [data-testid*="option"]') ||
              node.parentElement || node);
            text = (container.innerText || '').trim();
          }
          const m = text.match(/\+\s*\$\s*(\d+(?:\.\d{1,2})?)/);
          const upcharge = m ? parseFloat(m[1]) : 0;
          // Is this option already chosen? For multi-select ("Select 2")
          // groups we must skip re-clicking a chosen option, because a second
          // click would DESELECT it. Detect via the selected class / checked
          // state / a mounted quantity-subtract button in the option's row.
          const optRow = node.closest('[role="row"], li, label') || node;
          const selected =
            node.classList.contains('emi-childOptions-submodifierBtn--selected') ||
            node.classList.contains('emi-submodifier-btn--selected') ||
            node.checked === true ||
            node.getAttribute('aria-checked') === 'true' ||
            !!optRow.querySelector('[data-testid="quantity-input-subtract"]');
          return { sel, idx, text: text.slice(0, 100), upcharge, selected };
        });
        items.sort((a, b) => a.upcharge - b.upcharge || a.idx - b.idx);
        return items;
      }
      return [];
    });

    // Catch-all: if none of the KNOWN option widgets matched, fall back to a
    // generic scan of the panel for any clickable option-like row. This keeps
    // the filler working on restaurants whose modal uses a layout we haven't
    // seen yet — instead of skipping the item. Each candidate is tagged with a
    // temporary data-bot-opt attribute so the existing click-by-(sel,idx) path
    // below can select it reliably. Less precise than a known widget (last
    // resort), so it runs ONLY when `ranked` is empty.
    let usedCatchAll = false;
    if (!ranked.length) {
      const generic = await panelEl.evaluate((root) => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const banned = (el) => {
          if (!el) return true;
          // Never the panel's own title/caret toggle, close, footer CTA, the
          // subtract (deselect) button, or qty input field.
          if (el.closest('[data-testid="expansion-panel-title"]')) return true;
          if (el.closest('[data-testid="cb-icon"]')) return true;
          const tid = (el.getAttribute('data-testid') || '').toLowerCase();
          if (/subtract|quantity-input-input|close|footer-cta|add-to-(bag|order)|caret/.test(tid)) return true;
          if (el.disabled || el.getAttribute('aria-disabled') === 'true') return true;
          return !visible(el);
        };
        const candSel = 'button, [role="button"], [role="option"], [role="menuitemradio"], a[href], label, li';
        const seenRows = new Set();
        const picks = [];
        let tag = 0;
        for (const el of Array.from(root.querySelectorAll(candSel))) {
          if (banned(el)) continue;
          // Dedupe to one candidate per visual row, so we don't pick both a
          // row and a button nested inside it.
          const row = (el.closest('li, [role="row"], [role="option"], label') || el.parentElement || el);
          const key = row;
          if (seenRows.has(key)) continue;
          // Require some label text — a real option has a name.
          const text = (row.innerText || el.innerText || '').trim();
          if (!text || text.length < 2) continue;
          seenRows.add(key);
          el.setAttribute('data-bot-opt', String(tag));
          const m = text.match(/\+\s*\$\s*(\d+(?:\.\d{1,2})?)/);
          picks.push({ sel: '[data-bot-opt]', idx: tag, text: text.slice(0, 100), upcharge: m ? parseFloat(m[1]) : 0 });
          tag += 1;
        }
        picks.sort((a, b) => a.upcharge - b.upcharge || a.idx - b.idx);
        // Re-tag in sorted order isn't needed: click path matches by attribute
        // value, and querySelectorAll('[data-bot-opt]')[idx] is index-by-DOM,
        // so map each pick's idx to its DOM position among tagged nodes.
        const tagged = Array.from(root.querySelectorAll('[data-bot-opt]'));
        return picks.map((p) => ({
          ...p,
          idx: tagged.findIndex((n) => n.getAttribute('data-bot-opt') === String(p.idx)),
        }));
      }).catch(() => []);
      if (generic.length) {
        ranked.push(...generic);
        usedCatchAll = true;
        logger.info(
          { attempt, sectionTitle, count: generic.length, first: generic[0] && generic[0].text },
          'fillRequiredModifiers: no known widget matched — using generic catch-all option scan',
        );
      }
    }

    // Diagnostic: if STILL zero options after the catch-all, the section's
    // markup is something we genuinely can't act on. Dump the panel HTML so we
    // can see it and add a proper selector.
    if (!ranked.length) {
      try {
        const screenshotsDir = path.resolve(process.cwd(), 'screenshots');
        if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
        const safeTitle = String(sectionTitle).replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'unknown_section';
        const dumpPath = path.join(screenshotsDir, `empty-panel-${safeTitle}.html`);
        const html = await panelEl.evaluate((el) => el.outerHTML).catch(() => '');
        if (html) {
          fs.writeFileSync(dumpPath, html, 'utf8');
          logger.warn({ attempt, sectionTitle, dumpPath, bytes: html.length }, 'fillRequiredModifiers: panel matched as required but 0 options scored — HTML dumped, share the option-row markup to add a selector');
        }
      } catch (_) { /* dump failure is non-fatal */ }
    }

    let picked = null;

    // How many options this section requires ("Select 2 (Required)" → 2) and
    // how many are already chosen, so this pass clicks exactly the remaining
    // count. Picking the CHEAPEST options keeps the required upcharge minimal —
    // that's the budget-safe choice here; the overall order max is enforced by
    // the budget-aware match step, this just avoids overspending on a required
    // group.
    const selMatch = String(sectionTitle).match(/select\s+(?:up to\s+)?(\d+)/i);
    const selectMax = selMatch ? parseInt(selMatch[1], 10) : 1;
    const alreadySelected = ranked.filter((o) => o.selected).length;
    const needed = Math.max(1, selectMax - alreadySelected);

    // Candidate pool: only options not already chosen (re-clicking a chosen
    // option would deselect it). `ranked` is already cheapest-first.
    const available = ranked.filter((o) => !o.selected);

    // If notes carry a preference for this section (e.g. bread=White Bread),
    // pick the option whose text contains that value — case-insensitive,
    // word-boundary match so "Wheat" doesn't accidentally match "Classic Wheat".
    let preferenceHit = null;
    if (preferredValue && available.length) {
      const needle = String(preferredValue).toLowerCase().trim();
      const wordRe = new RegExp('\\b' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      preferenceHit = available.find((opt) => wordRe.test(opt.text)) ||
        available.find((opt) => opt.text.toLowerCase().includes(needle));
    }

    // Build this pass's click list: the preference first (if any), then the
    // cheapest remaining options, up to `needed`, with no duplicates.
    const toClick = [];
    if (preferenceHit) toClick.push(preferenceHit);
    for (const opt of available) {
      if (toClick.length >= needed) break;
      if (opt === preferenceHit) continue;
      toClick.push(opt);
    }

    for (const choice of toClick) {
      try {
        // Click the nth matching option inside this panel. Grubhub's Angular
        // submodifier buttons (e.g. La Presa "Choose a protein → Chicken")
        // IGNORE a synthetic in-page node.click() — the same reason panel
        // expansion needs real events — so the click looked successful but the
        // option never got selected, the section stayed "required", and the
        // loop re-clicked (toggling it back off). Fix: tag the node and click it
        // with a REAL Playwright click (true pointer events), then fall back to
        // an in-page pointer-event sequence if that didn't take.
        const tagged = await panelEl.evaluate((root, { sel, idx }) => {
          const nodes = Array.from(root.querySelectorAll(sel));
          const node = nodes[idx];
          if (!node) return false;
          node.scrollIntoView({ block: 'center' });
          node.setAttribute('data-bot-opt-click', '1');
          return true;
        }, { sel: choice.sel, idx: choice.idx }).catch(() => false);
        let clickedOk = false;
        if (tagged) {
          const optLoc = page.locator('[data-bot-opt-click]').first();
          clickedOk = await optLoc.click({ timeout: 1500 }).then(() => true).catch(() => false);
          if (!clickedOk) {
            // Real-event fallback: dispatch a full pointer/mouse sequence in-page.
            clickedOk = await page.evaluate(() => {
              const el = document.querySelector('[data-bot-opt-click]');
              if (!el) return false;
              const r = el.getBoundingClientRect();
              const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerType: 'mouse' };
              try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (_) {}
              try { el.dispatchEvent(new MouseEvent('mousedown', o)); } catch (_) {}
              try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (_) {}
              try { el.dispatchEvent(new MouseEvent('mouseup', o)); } catch (_) {}
              try { el.dispatchEvent(new MouseEvent('click', o)); } catch (_) {}
              try { el.click(); } catch (_) {}
              return true;
            }).catch(() => false);
          }
          await page.evaluate(() => { const e = document.querySelector('[data-bot-opt-click]'); if (e) e.removeAttribute('data-bot-opt-click'); }).catch(() => {});
        }
        if (clickedOk) picked = choice;
        logger.info(
          {
            attempt,
            itemName,
            categoryKey,
            selectMax,
            needed,
            preferredValue: preferredValue || null,
            matchedPreference: preferenceHit === choice,
            text: choice.text,
            upcharge: choice.upcharge,
            sel: choice.sel,
          },
          preferenceHit === choice
            ? 'fillRequiredModifiers: picked option (matched notes preference)'
            : 'fillRequiredModifiers: picked option (cheapest)',
        );
      } catch (_) { /* fall through to fallback below */ }
    }

    if (!picked) {
      // Fallback: search globally inside any open dialog for the first
      // selectable option. Less precise but recovers when the panel's
      // descendants are rendered in a portal outside its DOM subtree.
      const globalOpt = page.locator(
        'body.openDialog [data-testid="emi-childOptions-submodifierBtn"], ' +
        'body.openDialog .emi-submodifier-btn, ' +
        '[role="dialog"] input[type="radio"]:not([disabled]), ' +
        '[role="dialog"] input[type="checkbox"]:not([disabled])',
      ).first();
      if (await globalOpt.isVisible({ timeout: 300 }).catch(() => false)) {
        await globalOpt.click({ timeout: 1500 }).catch(() => {});
        picked = { sel: 'dialog-global-fallback' };
        logger.info({ attempt }, 'fillRequiredModifiers: picked option via dialog-global fallback');
      }
    }

    if (!picked) {
      logger.warn({ attempt }, 'fillRequiredModifiers: no option could be clicked for an invalid section');
      if (saveScreenshot && label) {
        await saveScreenshot(page, `modifier-stuck-${label}`).catch(() => {});
      }
      // Also dump the modal HTML so we can identify the unknown widget
      // pattern and add the matching selector to optionSelectors above.
      try {
        const screenshotsDir = path.resolve(process.cwd(), 'screenshots');
        if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
        const dumpPath = path.join(screenshotsDir, `modifier-stuck-${label || 'item'}.html`);
        const modalHtml = await page
          .evaluate(() => {
            const dialog = document.querySelector('[role="dialog"], [aria-modal="true"], .openDialog');
            return dialog ? dialog.outerHTML : document.body.outerHTML;
          })
          .catch(() => '');
        if (modalHtml) {
          fs.writeFileSync(dumpPath, modalHtml, 'utf8');
          logger.warn({ dumpPath, bytes: modalHtml.length }, 'modal HTML dumped — share its option-row markup to add a new selector');
        }
      } catch (e) {
        logger.warn({ err: e.message }, 'failed to save modal HTML dump');
      }
      if (tabHandleEl) await tabHandleEl.dispose().catch(() => {});
      if (sectionHandleEl) await sectionHandleEl.dispose().catch(() => {});
      await invalidSectionHandle?.dispose().catch(() => {});
      return false;
    }
    if (tabHandleEl) await tabHandleEl.dispose().catch(() => {});
    if (sectionHandleEl) await sectionHandleEl.dispose().catch(() => {});
    await invalidSectionHandle?.dispose().catch(() => {});
    await page.waitForTimeout(280);

    // Authoritative satisfaction check after a pick. Some restaurants (e.g. La
    // Presa's "Choose a protein → Chicken" submodifier "+" tag) mark a selected
    // option in a way the per-option selected-class check can't read — so the
    // next iteration's invalid-section finder would re-detect this section as
    // unfilled and re-click the option, TOGGLING THE CHOICE BACK OFF. The footer
    // CTA is the source of truth: once it stops saying "Make required choice",
    // every required group is satisfied — stop now.
    if (picked) {
      const ctaSatisfied = await page
        .evaluate(() => {
          const cta = document.querySelector('[data-testid="emi-footer-cta"]');
          if (!cta) return false;
          const r = cta.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) return false;
          const t = (cta.innerText || '').toLowerCase();
          return !/make required choice|choose (one|a |an |your)|select (one|a |an |your)/.test(t);
        })
        .catch(() => false);
      if (ctaSatisfied) {
        logger.info({ attempt, itemName }, 'fillRequiredModifiers: footer CTA satisfied — required choices filled, stopping');
        break;
      }
    }
  }
  return true;
}

// Grubhub's testids drift; keep these as ordered fallback lists.
const ADD_TO_ORDER_SELECTORS = [
  // Wawa-style modifier modal: footer CTA flips from "Make required choice
  // (N) : $X" to "Add to bag" once all required groups are filled.
  '[data-testid="emi-footer-cta"]:not(.s-btn-primary--disabled)',
  '[data-testid="add-to-bag-cta"]',
  '[data-testid="add-to-cart-cta"]',
  '[data-testid="addToCartButton"]',
  'button:has-text("Add to order")',
  'button:has-text("Add to bag")',
  'button:has-text("Add to cart")',
  'button:has-text("Add item")',
];

// On the menu listing, items with no required modifiers expose a "+" pill
// in the card corner. Clicking it adds one unit straight to the bag —
// no modifier modal, no required-field traps.
const QUICK_ADD_SELECTOR = '[data-testid="quick-add-to-bag-button"]';

const QTY_PLUS_SELECTORS = [
  '[data-testid="quantity-stepper-plus"]',
  '[data-testid="qty-increment"]',
  'button[aria-label="Increase quantity"]',
  'button[aria-label*="ncrease" i]',
];

const MODAL_CLOSE_SELECTORS = [
  '[data-testid="modal-close"]',
  'button[aria-label="Close"]',
  'button[aria-label*="lose" i]',
];

const CART_REMOVE_SELECTORS = [
  '[data-testid="cart-item-remove"]',
  '[data-testid*="remove"]',
  'button[aria-label*="emove" i]',
  'button:has-text("Remove")',
];

const CART_EMPTY_BULK_SELECTORS = [
  '[data-testid="empty-cart"]',
  'button:has-text("Empty cart")',
  'button:has-text("Clear cart")',
  'button:has-text("Empty bag")',
];

const CART_EMPTY_CONFIRM_SELECTORS = [
  'button:has-text("Yes")',
  'button:has-text("Confirm")',
  'button:has-text("Empty")',
  'button:has-text("Clear")',
];

const CART_OPEN_SELECTORS = [
  // Primary: Grubhub's current nav-bar bag toggle.
  '[data-testid="toggleCart-bag-button"]',
  '[data-testid="cart-button"]',
  '[data-testid="header-cart"]',
  '[data-testid="cart"]',
  'button[aria-label="Your Bag"]',
  'button[aria-label*="cart" i]',
  'button[aria-label*="bag" i]',
  'a[href$="/cart"]',
  'a[href*="/cart"]',
];

const CART_SUBTOTAL_SELECTORS = [
  '[data-testid="cart-subtotal"]',
  '[data-testid="subtotal"]',
  '[data-testid="order-subtotal"]',
];

const CHECKOUT_BTN_SELECTORS = [
  '#ghs-cart-checkout-button',
  '[data-testid="checkout-btn"]',
  '[data-testid="proceed-to-checkout"]',
  '[data-testid="cart-checkout-button"]',
  'button:has-text("Proceed to Checkout")',
  'button:has-text("Proceed to checkout")',
  'a:has-text("Proceed to checkout")',
  'button:has-text("Checkout")',
  'a:has-text("Checkout")',
];

const CHECKOUT_TOTAL_SELECTORS = [
  '[data-testid="checkout-total"]',
  '[data-testid="order-total"]',
  '[data-testid="grand-total"]',
];

// Restaurant-page search bar. When the menu virtualizes items out of the
// DOM, pasting the requested name in here re-filters the visible list so
// the card we want is the only one rendered — much faster than scrolling.
const SEARCH_INPUT_SELECTORS = [
  // The RESTAURANT MENU filter — placeholder "Search <RestaurantName>".
  // This is the box that filters menu items, so it MUST come first.
  '#menu-search-input',
  '[data-testid="menu-search-input"]',
  '#menu-search-filter-input',
  'input[aria-label^="Search " i][type="search"]',
  // Last-resort: the global site search. Typing a menu item here searches
  // across Grubhub (restaurants), not this menu, so only use it if the menu
  // filter above genuinely isn't present.
  '#search-autocomplete-input',
  '[data-testid="search-autocomplete-input"]',
];

const MENU_ITEM_CONTAINERS = [
  '[data-testid="restaurant-menu-item"]',
  // Wawa pattern: product cards are Item-<numericId>. Exclude the sibling
  // -quickAdd wrapper so we don't try to add via the wrong handle.
  '[data-testid^="Item-"]:not([data-testid$="-quickAdd"])',
  '[data-testid*="menu-item"]',
  '[data-testid*="menuItem"]',
  'a[href*="/menuItem/"]',
  'article[id^="menuItem"]',
];

function parseDollar(text) {
  const m = String(text || '').match(/\$\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

async function findFirstVisible(
  page,
  selectors,
  { perTryMs = 600 } = {},
) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: perTryMs }).catch(() => false)) return { loc, sel };
  }
  return null;
}

async function clickFirstVisible(
  page,
  selectors,
  { timeout = 4000 } = {},
) {
  const hit = await findFirstVisible(page, selectors);
  if (!hit) return null;
  await hit.loc.click({ timeout }).catch(() => {});
  return hit.sel;
}

// Find the first non-price line in a card's innerText. Some restaurants
// render price before the name in the card (e.g. Wawa), so taking line[0]
// blindly would match against "$2.69" instead of the product name.
function nameLineFromInnerText(text) {
  const priceOnly = /^\s*\$?\s*\d+(?:\.\d{1,2})?\s*\+?\s*$/;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (priceOnly.test(line)) continue;
    return line.toLowerCase();
  }
  return '';
}

// Locate the menu-item card for `matchedName`. When `expectedPrice` is given AND
// more than one card matches the name (e.g. East Moon lists "Basil Chicken
// Dinner" in two sections at $19.95 and ~$18.95), pick the card whose parsed
// price is closest to expectedPrice — that disambiguates duplicates to the
// correct (addable) copy. When expectedPrice is absent or only one card matches,
// behaves exactly as before (returns the first match) so single-match restaurants
// (Red Lobster, La Presa) are unaffected.
async function findMenuItemHandle(
  page,
  matchedName,
  expectedPrice,
) {
  const target = String(matchedName || '').trim().toLowerCase();
  if (!target) return null;
  const wantPrice = (typeof expectedPrice === 'number' && Number.isFinite(expectedPrice)) ? expectedPrice : null;

  // Collect all cards matching `predicate(nameLine)`, then pick the best by
  // price when we have a target price and multiple candidates.
  async function pickBest(predicate) {
    const cands = [];
    for (const sel of MENU_ITEM_CONTAINERS) {
      const handles = await page.$$(sel).catch(() => []);
      for (const h of handles) {
        const txt = await h.evaluate((el) => (el.innerText || '').trim()).catch(() => '');
        if (predicate(nameLineFromInnerText(txt))) cands.push({ h, price: parseDollar(txt) });
      }
    }
    if (!cands.length) return null;
    if (wantPrice == null || cands.length === 1) return cands[0].h;
    const withPrice = cands.filter((c) => c.price != null);
    if (!withPrice.length) return cands[0].h;
    withPrice.sort((a, b) => Math.abs(a.price - wantPrice) - Math.abs(b.price - wantPrice));
    const best = withPrice[0];
    if (best.h !== cands[0].h) {
      console.log(`[cart] price-disambiguated "${matchedName}" -> $${best.price} (wanted ~$${wantPrice})`);
    }
    return best.h;
  }

  // Exact name-line match wins over substring.
  return (await pickBest((n) => n === target)) || (await pickBest((n) => n.includes(target)));
}

// Bring a menu item into the DOM by navigating the menu's CATEGORY tabs,
// instead of using the live search bar. Grubhub virtualizes off-screen items,
// so an item that was captured during the category-walk scrape gets unmounted
// once you scroll away. Clicking its category tab re-renders that section, so
// findMenuItemHandle can locate it. We try the scraped category hint first
// (fast path), then fall back to walking every category tab until the item
// appears. Category tabs are <li data-testid="category_NAME"> in the sidebar.
async function findMenuItemByCategoryWalk(
  page,
  targetName,
  categoryHint,
  expectedPrice,
) {
  const cats = await page
    .$$eval('[data-testid^="category_"]', (els) =>
      els.map((el) => ({
        testid: el.getAttribute('data-testid'),
        name: (el.innerText || '').trim().split('\n')[0],
      })),
    )
    .catch(() => []);
  if (!cats.length) return null;

  // Visit the hinted category first, then all others.
  const ordered = [];
  if (categoryHint) {
    const hl = String(categoryHint).toLowerCase();
    const hit = cats.find((c) => c.name && c.name.toLowerCase() === hl);
    if (hit) ordered.push(hit);
  }
  for (const c of cats) if (!ordered.some((o) => o.testid === c.testid)) ordered.push(c);

  for (const cat of ordered) {
    const escaped = String(cat.testid).replace(/"/g, '\\"');
    const tab = page.locator(`[data-testid="${escaped}"]`).first();
    if (!(await tab.isVisible({ timeout: 600 }).catch(() => false))) continue;
    await tab.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(350);
    // A few short in-place scrolls so virtualized items in this category mount.
    for (let s = 0; s < 6; s++) {
      const h = await findMenuItemHandle(page, targetName, expectedPrice);
      if (h) {
        console.log(`[cart] found "${targetName}" in category "${cat.name}"`);
        return h;
      }
      await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {});
      await page.waitForTimeout(150);
    }
  }
  return null;
}

// Find or clear the restaurant page's search input. Returns the locator or
// null. We re-fetch each call because some pages re-mount the input when
// the menu re-filters.
async function findSearchInput(page) {
  for (const sel of SEARCH_INPUT_SELECTORS) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 250 }).catch(() => false)) return loc;
  }
  return null;
}

async function clearSearchInput(page) {
  const loc = await findSearchInput(page);
  if (!loc) return;
  const cur = (await loc.inputValue().catch(() => '')) || '';
  if (!cur) return;
  await loc.fill('').catch(() => {});
  // Filter usually re-expands within ~300ms once the search term is empty.
  await page.waitForTimeout(250);
}

// Paste the requested name into the restaurant search bar and re-run the
// DOM lookup. Used as a fallback for findMenuItemHandle when virtualization
// has unmounted the card or the menu is too long to scroll.
async function findMenuItemViaSearch(
  page,
  name,
  expectedPrice,
) {
  const search = await findSearchInput(page);
  if (!search) {
    console.log('[cart] no search input on page');
    return null;
  }
  await search.click({ timeout: 1200 }).catch(() => {});
  await search.fill('').catch(() => {});
  // Grubhub's menu filter listens on real keystrokes; .fill() sets the value
  // in a single bulk event and the filter never fires (same lesson as the
  // address autocomplete). Type character-by-character so the filter runs.
  await search.pressSequentially(String(name), { delay: 30 }).catch(() => {});
  // Wait for the menu to re-filter — short event-driven wait first, then a
  // small grace period for restaurants that animate the transition.
  await page
    .waitForSelector(
      '[data-testid="restaurant-menu-item"], [data-testid^="Item-"]:not([data-testid$="-quickAdd"])',
      { timeout: 2000 },
    )
    .catch(() => {});
  await page.waitForTimeout(400);
  console.log('[cart] searched:', name);
  const handle = await findMenuItemHandle(page, name, expectedPrice);
  if (!handle) {
    // Diagnostic: show what the filter actually surfaced, so a name mismatch
    // (vs. an empty filter / wrong container) is visible in the logs.
    const surfaced = await page
      .$$eval(
        '[data-testid="restaurant-menu-item"], [data-testid^="Item-"]:not([data-testid$="-quickAdd"])',
        (els) => els.slice(0, 8).map((el) => (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || ''),
      )
      .catch(() => []);
    console.log(`[cart] search surfaced ${surfaced.length} card(s):`, JSON.stringify(surfaced));
  }
  return handle;
}

async function readCartBadgeCount(page) {
  return await page
    .evaluate(() => {
      const sels = [
        '[data-testid="cart-count"]',
        '[data-testid="header-cart-count"]',
        '[data-testid*="cart"] [class*="badge" i]',
        '[aria-label*="cart" i] [class*="badge" i]',
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el) {
          const n = parseInt((el.innerText || el.textContent || '').trim(), 10);
          if (Number.isFinite(n)) return n;
        }
      }
      return null;
    })
    .catch(() => null);
}

// The modifier-required signal is heuristic: a disabled "Add to order"
// button can also just mean the modal is still hydrating. So we wait for
// the button to enable, and if it never does, look for an explicit
// "Required" label as confirmation before declaring it a modifier issue.
async function diagnoseAddBlocker(
  page,
  { maxWaitMs = 2500 } = {},
) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const hit = await findFirstVisible(page, ADD_TO_ORDER_SELECTORS, { perTryMs: 300 });
    if (!hit) {
      await page.waitForTimeout(300);
      continue;
    }
    const disabled = await hit.loc.isDisabled().catch(() => true);
    if (!disabled) return { state: 'enabled' };
    await page.waitForTimeout(350);
  }
  // The ADD_TO_ORDER_SELECTORS first entry excludes the disabled CTA via
  // `:not(.s-btn-primary--disabled)`. If the enabled button never appeared,
  // check whether the DISABLED footer CTA is sitting there with the
  // "Make required choice" copy — that's the unambiguous signal we're
  // looking at an unfilled modifier modal and need to fill it.
  const finalDiag = await page
    .evaluate(() => {
      const cta = document.querySelector('[data-testid="emi-footer-cta"]');
      if (cta) {
        const r = cta.getBoundingClientRect();
        const visible = r.width > 0 && r.height > 0;
        if (visible) {
          const text = (cta.innerText || '').toLowerCase();
          if (text.includes('required choice')) return 'required-unfilled';
        }
      }
      // Fallback: any visible panel-title marked invalid or carrying
      // "(Required)" helper text means a required section is unfilled.
      const titles = document.querySelectorAll('[data-testid="expansion-panel-title"]');
      for (const t of titles) {
        const tr = t.getBoundingClientRect();
        if (tr.width < 1 || tr.height < 1) continue;
        if (t.classList.contains('emi-invalid-item')) return 'required-unfilled';
        if (/\brequired\b/i.test(t.innerText || '')) return 'required-unfilled';
      }
      return null;
    })
    .catch(() => null);
  if (finalDiag === 'required-unfilled') return { state: 'required-unfilled' };

  const finalHit = await findFirstVisible(page, ADD_TO_ORDER_SELECTORS, { perTryMs: 300 });
  if (!finalHit) return { state: 'no-button' };
  const hasRequired = await page
    .evaluate(() => /\brequired\b/i.test(document.body.innerText || ''))
    .catch(() => false);
  return { state: hasRequired ? 'required-unfilled' : 'disabled-unknown' };
}

async function closeAnyModal(page) {
  if (await clickFirstVisible(page, MODAL_CLOSE_SELECTORS, { timeout: 1500 })) return;
  await page.keyboard.press('Escape').catch(() => {});
}

// Read the open modal/footer live and click the REAL add/proceed button. The
// static ADD_TO_ORDER_SELECTORS list misses restaurants whose CTA testid drifts,
// and Playwright's auto-wait does NOT detect Grubhub's class-based disabled
// state (s-btn*--disabled). So we scan the dialog, score every visible button by
// intent ("Add to bag/order/cart", a price-bearing CTA, "proceed"), reject the
// genuinely-disabled ones, tag the winner and click it with Playwright. Returns
// the clicked label, or null when nothing add-like is enabled.
async function clickAddOrProceed(page, { timeout = 4000 } = {}) {
  const tagged = await page
    .evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      const realDisabled = (el) => {
        if (el.disabled) return true;
        if (el.getAttribute('aria-disabled') === 'true') return true;
        // Only s-btn*--disabled is a REAL disabled state on Grubhub; other
        // --disabled BEM modifiers (emi-border-bottom--disabled, …) are cosmetic.
        const cls = (el.className || '').toString();
        if (/\bs-btn[\w-]*--disabled\b/.test(cls)) return true;
        return false;
      };
      const scope = document.querySelector('[role="dialog"], [aria-modal="true"], .openDialog') || document;
      const cands = Array.from(scope.querySelectorAll('button, [role="button"], [data-testid="emi-footer-cta"]'));
      let best = null;
      let bestScore = 0;
      for (const el of cands) {
        if (!visible(el) || realDisabled(el)) continue;
        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (!t) continue;
        // Never the things that close/cancel/deselect or re-open required choice.
        if (/make required choice|select (one|a |an |your)|^cancel$|^close$|remove|no thanks|not now/.test(t)) continue;
        let score = 0;
        if (/add to (bag|order|cart)|add item|add \d|^add\b/.test(t)) score += 100;
        if (/move to (bag|order)|update (item|order)|save/.test(t)) score += 60;
        if (/\$\s*\d/.test(t)) score += 30;
        if (/proceed|continue|checkout/.test(t)) score += 20;
        const tid = (el.getAttribute('data-testid') || '').toLowerCase();
        if (tid === 'emi-footer-cta') score += 15;
        if (/add|cart|bag/.test(tid)) score += 10;
        if (score > bestScore) { bestScore = score; best = el; }
      }
      document.querySelectorAll('[data-bot-add]').forEach((e) => e.removeAttribute('data-bot-add'));
      if (!best) return null;
      best.setAttribute('data-bot-add', '1');
      return { text: (best.innerText || best.textContent || '').trim().slice(0, 60), score: bestScore };
    })
    .catch(() => null);
  if (!tagged) return null;
  const loc = page.locator('[data-bot-add]').first();
  const ok = await loc
    .click({ timeout })
    .then(() => true)
    .catch(() => false);
  if (!ok) return null;
  logger.info({ picked: tagged.text, score: tagged.score }, 'clickAddOrProceed: clicked add/proceed button');
  return tagged.text || 'add';
}

// Universal required-choice resolver, independent of panel-expansion mechanics.
// It reads the footer CTA's "Make required choice (N)" counter (falling back to
// counting unfilled required panels), then repeatedly expands any collapsed
// required panel and clicks the cheapest un-selected option in the dialog,
// re-reading the counter after each click, until it reaches zero or stalls.
// This recovers items whose modifier panels the structured filler can't drive
// (e.g. Red Lobster Kids "Macaroni & Cheese" side).
async function sweepRequiredByCta(page, { maxClicks = 14 } = {}) {
  async function readNeeded() {
    return page
      .evaluate(() => {
        const cta = document.querySelector('[data-testid="emi-footer-cta"]');
        if (cta) {
          const t = (cta.innerText || '').toLowerCase();
          const m = t.match(/make required choice\s*\((\d+)\)/);
          if (m) return parseInt(m[1], 10);
          if (/required choice/.test(t)) return 1;
        }
        let n = 0;
        for (const tEl of document.querySelectorAll('[data-testid="expansion-panel-title"]')) {
          const r = tEl.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          const txt = tEl.innerText || '';
          const v = tEl.querySelector('[data-testid="quantity-validator"]');
          const vt = ((v && v.innerText) || '').toLowerCase();
          const invalid = tEl.classList.contains('emi-invalid-item') || /\brequired\b/i.test(txt) || (!!v && /\bselect\b/.test(vt));
          if (!invalid) continue;
          if (/\boptional\b/i.test(txt + ' ' + vt)) continue;
          const panel = (tEl.parentElement && tEl.parentElement.parentElement) || tEl.parentElement;
          const chosen = panel
            ? panel.querySelectorAll(
                '.emi-childOptions-submodifierBtn--selected, .emi-submodifier-btn--selected, ' +
                'input:checked, [aria-checked="true"], [data-testid="quantity-input-subtract"]',
              ).length
            : 0;
          if (chosen < 1) n += 1;
        }
        return n;
      })
      .catch(() => 0);
  }
  let needed = await readNeeded();
  if (!needed) return true;
  logger.info({ needed }, 'sweepRequiredByCta: required choices outstanding — sweeping by CTA');
  let clicks = 0;
  let lastNeeded = needed;
  let noProgress = 0;
  while (needed > 0 && clicks < maxClicks) {
    const action = await page
      .evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const dialog = document.querySelector('[role="dialog"], [aria-modal="true"], .openDialog') || document;
        // Expand the first collapsed required panel so its options mount.
        for (const tEl of dialog.querySelectorAll('[data-testid="expansion-panel-title"]')) {
          if (!visible(tEl)) continue;
          const txt = tEl.innerText || '';
          const v = tEl.querySelector('[data-testid="quantity-validator"]');
          const vt = ((v && v.innerText) || '').toLowerCase();
          const invalid = tEl.classList.contains('emi-invalid-item') || /\brequired\b/i.test(txt) || (!!v && /\bselect\b/.test(vt));
          if (!invalid || /\boptional\b/i.test(txt + ' ' + vt)) continue;
          const section = (tEl.parentElement && tEl.parentElement.parentElement) || tEl.parentElement;
          const region = section && section.querySelector('[aria-expanded]');
          if (region && region.getAttribute('aria-expanded') !== 'true') {
            const tab = (section && section.querySelector('[role="tab"]')) || tEl.parentElement || tEl;
            tab.click();
            return 'expanded';
          }
        }
        // TAG the cheapest un-selected option anywhere in the dialog (the real
        // click happens outside via Playwright — Grubhub's Angular submodifier
        // buttons ignore a synthetic in-page click).
        const optSel =
          '[data-testid="emi-childOptions-submodifierBtn"], .emi-submodifier-btn, ' +
          '[data-testid="quantity-input-add"], [role="radio"]:not([aria-disabled="true"]), ' +
          'input[type="radio"]:not([disabled]), input[type="checkbox"]:not([disabled])';
        const nodes = Array.from(dialog.querySelectorAll(optSel)).filter(visible);
        const scored = nodes
          .map((n) => {
            const row = n.closest('[role="row"], li, label') || n;
            const selected =
              n.classList.contains('emi-childOptions-submodifierBtn--selected') ||
              n.classList.contains('emi-submodifier-btn--selected') ||
              n.checked === true ||
              n.getAttribute('aria-checked') === 'true' ||
              !!row.querySelector('[data-testid="quantity-input-subtract"]');
            const text = (row.innerText || n.innerText || '').trim();
            const m = text.match(/\+\s*\$\s*(\d+(?:\.\d{1,2})?)/);
            return { n, selected, up: m ? parseFloat(m[1]) : 0 };
          })
          .filter((o) => !o.selected);
        scored.sort((a, b) => a.up - b.up);
        if (!scored.length) return false;
        document.querySelectorAll('[data-bot-sweep-opt]').forEach((e) => e.removeAttribute('data-bot-sweep-opt'));
        scored[0].n.scrollIntoView({ block: 'center' });
        scored[0].n.setAttribute('data-bot-sweep-opt', '1');
        return 'tagged';
      })
      .catch(() => false);
    if (action === 'expanded') {
      await page.waitForTimeout(300);
      continue;
    }
    if (action !== 'tagged') break;
    // Real Playwright click (true pointer events), with in-page pointer-event
    // fallback — same reason the structured filler needs it.
    const sweepLoc = page.locator('[data-bot-sweep-opt]').first();
    let sweepClicked = await sweepLoc.click({ timeout: 1500 }).then(() => true).catch(() => false);
    if (!sweepClicked) {
      await page.evaluate(() => {
        const el = document.querySelector('[data-bot-sweep-opt]');
        if (!el) return;
        const r = el.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerType: 'mouse' };
        try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (_) {}
        try { el.dispatchEvent(new MouseEvent('mousedown', o)); } catch (_) {}
        try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (_) {}
        try { el.dispatchEvent(new MouseEvent('mouseup', o)); } catch (_) {}
        try { el.dispatchEvent(new MouseEvent('click', o)); } catch (_) {}
        try { el.click(); } catch (_) {}
      }).catch(() => {});
    }
    await page.evaluate(() => { const e = document.querySelector('[data-bot-sweep-opt]'); if (e) e.removeAttribute('data-bot-sweep-opt'); }).catch(() => {});
    clicks += 1;
    await page.waitForTimeout(350);
    needed = await readNeeded();
    if (needed >= lastNeeded) {
      noProgress += 1;
      if (noProgress >= 3) break;
    } else {
      noProgress = 0;
      lastNeeded = needed;
    }
  }
  logger.info({ needed, clicks }, 'sweepRequiredByCta: done');
  return needed === 0;
}

// Count cart line items whose name matches the wanted name (case-insensitive
// substring). Used after each add to detect Wawa's "quick-add added one,
// then modal Add-to-bag added a second copy" pattern.
//
// Critical: the cart sidebar must be OPEN for this to work. Cart line items
// (the [data-testid="cart-item-remove"] buttons) only exist in the DOM when
// the sidebar is visible. Callers must invoke openCart() first, then wait
// briefly for items to mount. We re-poll for up to 1.5s in case the sidebar
// is still animating in.
async function countCartItemsByName(page, wantedName) {
  if (!wantedName) return 0;
  const deadline = Date.now() + 1500;
  let count = -1;
  let lastDiag = null;
  while (Date.now() < deadline) {
    const result = await page
      .evaluate((wanted) => {
        const needle = String(wanted).toLowerCase().trim();
        if (!needle) return { count: 0, diag: { reason: 'empty-needle' } };
        // Cart line items: each has a [data-testid="cart-item-remove"]
        // button. Walk up to find the row container that holds the item
        // name + modifier summary line.
        const removeButtons = Array.from(document.querySelectorAll('[data-testid="cart-item-remove"]'));
        // No remove buttons → cart sidebar didn't mount. Always return -1
        // ("can't count"), never 0. #ghs-cart-checkout-button is the menu
        // page's sticky footer CTA and is present even when the sidebar
        // is closed, so it can't be used as a sidebar-open signal. Caller
        // must treat -1 as "trust the optimistic add", not as a failure.
        if (!removeButtons.length) {
          // Grubhub's "global-cart" variant doesn't use cart-item-remove.
          // Use empty-cart-prompt as an authoritative signal: present means
          // the cart is genuinely empty (0); absent means items ARE present
          // but we can't name-match them in this variant, so try counting
          // line rows inside global-cart-body before giving up with -1.
          const emptyPrompt = document.querySelector('[data-testid="empty-cart-prompt"]');
          if (emptyPrompt) {
            const r = emptyPrompt.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { count: 0, diag: { reason: 'empty-cart-prompt-visible' } };
          }
          const body = document.querySelector('[data-testid="global-cart-body"], #global-cart, [data-testid="global-cart"]');
          if (body) {
            const text = (body.innerText || '').toLowerCase();
            // If the body has content and isn't the empty state, the add
            // worked even though we can't name-match the row in this variant.
            if (text && !/your (bag|cart) is empty|add items to get started/i.test(text)) {
              const rows = body.querySelectorAll('[data-testid*="cart-item" i], [data-testid*="cartItem" i], li');
              return { count: rows.length > 0 ? rows.length : 1, diag: { reason: 'global-cart-body-nonempty', rows: rows.length } };
            }
          }
          return { count: -1, diag: { reason: 'no-remove-buttons-sidebar-closed' } };
        }
        // Walk up from each Remove button until we find an ancestor whose
        // innerText contains the item name. Grubhub's row markup varies
        // across renders, so closest('li, [class*="cart-item"]') is not
        // reliable — sometimes the row is just a generic div. Cap the walk
        // at 8 levels to avoid matching the whole sidebar.
        let n = 0;
        const rowTexts = [];
        for (const remove of removeButtons) {
          let node = remove;
          let matched = false;
          let bestText = '';
          for (let depth = 0; depth < 8 && node; depth++) {
            const text = (node.innerText || '').toLowerCase();
            if (text.length > bestText.length) bestText = text;
            if (text.includes(needle)) { matched = true; break; }
            node = node.parentElement;
          }
          rowTexts.push(bestText.slice(0, 120));
          if (matched) n += 1;
        }
        return { count: n, diag: { removeButtonCount: removeButtons.length, needle, rowTexts } };
      }, wantedName)
      .catch(() => ({ count: -1, diag: { reason: 'evaluate-threw' } }));
    count = result && typeof result.count === 'number' ? result.count : -1;
    lastDiag = result && result.diag;
    if (count >= 0) {
      if (count === 0) logger.warn({ wantedName, diag: lastDiag }, '[countCartItemsByName] returned 0 — diagnostic dump');
      return count;
    }
    await page.waitForTimeout(200);
  }
  if (lastDiag) logger.warn({ wantedName, diag: lastDiag }, '[countCartItemsByName] returned -1 — diagnostic dump');
  return count;
}

// Poll up to timeoutMs for the cart to REFLECT an add. Critical because Chrome
// updates the cart asynchronously and slowly relative to our code: a single
// immediate check races ahead of the render and false-reports "not added"
// (e.g. empty-cart-prompt is still visible for a beat after Add-to-bag). We
// poll for any positive signal — the empty-cart prompt gone AND the item named
// in the cart / a remove button present / the global-cart body showing it.
// Returns { added, count } where count is best-effort (named matches, else 1).
async function confirmItemAdded(
  page,
  wantedName,
  { timeoutMs = 9000 } = {},
) {
  const needle = String(wantedName || '').toLowerCase().trim();
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const s = await page
      .evaluate((n) => {
        const vis = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return false;
          const st = window.getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none';
        };
        const emptyEl = document.querySelector('[data-testid="empty-cart-prompt"]');
        const emptyVisible = vis(emptyEl);
        const removeBtns = Array.from(document.querySelectorAll('[data-testid="cart-item-remove"]'));
        let named = 0;
        for (const b of removeBtns) {
          let node = b;
          for (let d = 0; d < 8 && node; d++) {
            if (n && (node.innerText || '').toLowerCase().includes(n)) { named += 1; break; }
            node = node.parentElement;
          }
        }
        const body = document.querySelector('[data-testid="global-cart-body"], [data-testid="global-cart"], #global-cart');
        const bodyHasName = !!(body && n && (body.innerText || '').toLowerCase().includes(n));
        return { emptyVisible, removeCount: removeBtns.length, named, bodyHasName };
      }, needle)
      .catch(() => null);
    if (s) {
      last = s;
      // Positive: cart is no longer the empty state AND we can see the item
      // (by name) OR at least one line item exists.
      if (!s.emptyVisible && (s.named > 0 || s.bodyHasName || s.removeCount > 0)) {
        return { added: true, count: s.named > 0 ? s.named : (s.removeCount || 1) };
      }
    }
    await page.waitForTimeout(400);
  }
  logger.warn({ wantedName, last }, '[confirmItemAdded] no positive cart signal within timeout');
  return { added: false, count: 0 };
}

// Remove N cart line items whose name matches the wanted name. Used to
// undo duplicate adds. Returns the number actually removed.
async function removeCartItemsByName(
  page,
  wantedName,
  n,
) {
  if (n <= 0 || !wantedName) return 0;
  let removed = 0;
  for (let i = 0; i < n; i++) {
    const clicked = await page
      .evaluate((wanted) => {
        const needle = String(wanted).toLowerCase().trim();
        const buttons = Array.from(document.querySelectorAll('[data-testid="cart-item-remove"]'));
        for (const btn of buttons) {
          let node = btn;
          for (let depth = 0; depth < 8 && node; depth++) {
            const text = (node.innerText || '').toLowerCase();
            if (text.includes(needle)) {
              btn.scrollIntoView({ block: 'center' });
              btn.click();
              return true;
            }
            node = node.parentElement;
          }
        }
        return false;
      }, wantedName)
      .catch(() => false);
    if (!clicked) break;
    removed += 1;
    // Confirm dialog occasionally pops per remove — short probe.
    await page.waitForTimeout(300);
  }
  return removed;
}

// Verify the restaurant page is showing a signed-in session. Different from
// browser.js#isLoggedIn (which only checks the homepage): this also rejects
// when the restaurant page itself has a Sign In link in the nav, since
// CDP-attached sessions can be signed in on one tab and out on another.
// Throws BotError so callers fail loudly instead of silently reporting
// fake `added` successes for items that never landed in the cart.
async function probeSignedIn(page) {
  return page
    .evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none';
      };
      // Strong positive signals that a real user is logged in. Any present
      // means signed-in — checked first so a stray "Sign in" link elsewhere
      // on the page can't produce a false negative.
      const positiveSelectors = [
        '[data-testid="main-menu-profile-btn"]',
        '[data-testid="signin-name"]',
        '[data-testid="account-profile-desktop"]',
        '[data-testid="account-history"]',
        '[data-testid="toggleCart-bag-button"]', // cart UI renders only for a live session
      ];
      for (const sel of positiveSelectors) {
        const el = document.querySelector(sel);
        if (el && visible(el)) {
          const hi = document.querySelector('[data-testid="signin-name"]');
          return { signedIn: true, signInLinks: [], hiText: hi ? (hi.innerText || '').trim() : '' };
        }
      }
      // Negative signal: a visible Sign In / Log In control whose ENTIRE label
      // is sign-in (anchored regex avoids matching "Sign in to see rewards"
      // body copy or aria text that can appear while still logged in).
      const candidates = (Array.from(document.querySelectorAll('a, button')))
        .filter((el) => visible(el))
        .filter((el) => /^\s*(sign\s*in|log\s*in)\s*$/i.test(el.innerText || ''))
        .slice(0, 5)
        .map((el) => (el.innerText || '').trim().slice(0, 30));
      return { signedIn: candidates.length === 0, signInLinks: candidates, hiText: '' };
    })
    .catch(() => ({ signedIn: true, signInLinks: [], hiText: '' })); // optimistic on probe failure
}

async function assertSignedIn(page) {
  let result = await probeSignedIn(page);

  // A single "signed-out" probe is unreliable mid-run: after heavy menu
  // interaction the restaurant header can transiently re-render without the
  // profile button while a stray "Sign in" link mounts. Before failing hard,
  // reload once (re-applies session cookies) and re-probe. Only a persistent
  // signed-out state after reload is treated as SESSION_EXPIRED.
  if (!result.signedIn) {
    logger.warn({ signInLinks: result.signInLinks, url: page.url() }, 'assertSignedIn: signed-out on first probe — reloading to confirm');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    result = await probeSignedIn(page);
  }

  if (!result.signedIn) {
    logger.warn({ signInLinks: result.signInLinks, url: page.url() }, 'assertSignedIn: signed-out state confirmed after reload');
    throw new BotError(
      'SESSION_EXPIRED',
      `Restaurant page shows signed-out state (Sign In link visible: "${result.signInLinks[0] || '?'}"). ` +
        `Sign in to the Chrome session and re-run.`,
    );
  }
  logger.info({ hiText: result.hiText, url: page.url() }, 'assertSignedIn: signed-in confirmed');
  return result;
}

async function addItemsToCart(
  page,
  matchedItems,
  { saveScreenshot, preferences } = {},
) {
  // Fail loudly before doing anything if the session isn't valid. Without
  // this, every add silently no-ops and the bot reports fake successes.
  await assertSignedIn(page);

  const added = [];
  const skipped = [];
  const beforeAll = await readCartBadgeCount(page);
  console.log('[cart] adding', matchedItems.length, 'items, badge=', beforeAll);

  for (const item of matchedItems) {
    const targetName = item.matched_name;
    const qty = typeof item.qty === 'number' && Number.isFinite(item.qty) && item.qty > 0 ? item.qty : 1;
    const before = await readCartBadgeCount(page);

    // Reset any leftover menu-search filter so the DOM locate sees the full
    // menu (a prior item's search-relocate can leave the box filtered).
    await clearSearchInput(page).catch(() => {});

    // Use the SCRAPED menu, not the live search bar. First try the item in the
    // currently-rendered DOM; if virtualization has unmounted it, navigate to
    // its category tab (using the scraped category hint, then walking all
    // categories) to re-render it. This mirrors how the scraper found it.
    let handle = await findMenuItemHandle(page, targetName, item.matched_price);
    if (!handle) {
      handle = await findMenuItemByCategoryWalk(page, targetName, item.category, item.matched_price);
    }
    if (!handle) {
      console.log('[cart] skip:', targetName, '— menu node not found (DOM + category walk)');
      skipped.push({ name: targetName, reason: 'menu node not found' });
      continue;
    }

    await handle.scrollIntoViewIfNeeded().catch(() => {});

    // Prefer the quick-add button when present — it adds 1 unit without
    // opening the modifier modal. Search the card itself first (Chicho's
    // pattern: button is a descendant), then the card's parent (Wawa
    // pattern: quick-add div is a sibling of the card). Absence means
    // "fall back to modal" (item probably has required modifiers).
    async function findQuickAdd() {
      if (!handle) return null;
      const inCard = await handle.$(QUICK_ADD_SELECTOR).catch(() => null);
      if (inCard && (await inCard.isVisible().catch(() => false))) return inCard;
      const fromParent = await handle.evaluateHandle(
        (el, sel) => (el.parentElement ? el.parentElement.querySelector(sel) : null),
        QUICK_ADD_SELECTOR,
      ).catch(() => null);
      if (!fromParent) return null;
      const asElement = fromParent.asElement();
      if (!asElement) {
        await fromParent.dispose().catch(() => {});
        return null;
      }
      if (await asElement.isVisible().catch(() => false)) return asElement;
      await asElement.dispose().catch(() => {});
      return null;
    }

    const quickAdd = await findQuickAdd();
    if (quickAdd) {
      // Click the quick-add button. On items with required modifiers
      // (Wawa hoagies), the "+" pill opens the customize modal instead
      // of adding straight to bag. Detect that: if the modifier modal
      // is visible after the click, fall through to the modifier path
      // — quick-add did NOT succeed.
      await quickAdd.click({ timeout: 4000 }).catch(() => {});
      // Poll for up to 4s — Wawa's modifier modal sometimes takes 2-3s
      // to mount on the Italian Hoagie / Turkey Hoagie cards (panel
      // content lazy-loads after a network roundtrip). 1500ms was too
      // tight: the modal opened post-deadline and we falsely declared
      // "no modal, item must have been quick-added", left it open, and
      // the next item's checkout click then found no cart sidebar.
      // Strict signal: footer CTA "Make required choice" copy OR a
      // required-titled panel — distinguishes the modifier modal from
      // post-add upsell modals (which have a CTA but no required copy).
      const modalDeadline = Date.now() + 4000;
      let modalOpened = false;
      while (Date.now() < modalDeadline) {
        modalOpened = await page
          .evaluate(() => {
            const cta = document.querySelector('[data-testid="emi-footer-cta"]');
            if (!cta) return false;
            const r = cta.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) return false;
            // Stronger signal: footer CTA copy says "Make required choice"
            // (modifier modal in unfilled state), OR a panel-title with
            // .emi-invalid-item or "(Required)" text is visible. Either
            // confirms this is the modifier modal, not an upsell.
            const ctaText = (cta.innerText || '').toLowerCase();
            if (ctaText.includes('required choice')) return true;
            const titles = document.querySelectorAll('[data-testid="expansion-panel-title"]');
            for (const t of titles) {
              const tr = t.getBoundingClientRect();
              if (tr.width < 1 || tr.height < 1) continue;
              if (t.classList.contains('emi-invalid-item')) return true;
              if (/\brequired\b/i.test(t.innerText || '')) return true;
            }
            return false;
          })
          .catch(() => false);
        if (modalOpened) break;
        await page.waitForTimeout(150);
      }

      if (modalOpened) {
        console.log('[cart] quick-add opened modifier modal for', targetName, '— falling through to fill-required path');
        // Don't `continue` — let the code below handle the modal. We've
        // already clicked the item (via quick-add), so the modal is open.
      } else {
        // Last-chance diagnostic: dump what's actually visible. If the
        // user reports a modal is opening but we didn't detect it, the
        // CTA copy or panel-title text must be different from what we're
        // matching. Capture both so we can see and adjust.
        const diag = await page
          .evaluate(() => {
            const cta = document.querySelector('[data-testid="emi-footer-cta"]');
            const ctaText = cta ? (cta.innerText || '').slice(0, 200) : null;
            const ctaVisible = cta
              ? (() => { const r = cta.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()
              : false;
            const titles = (Array.from(document.querySelectorAll('[data-testid="expansion-panel-title"]')))
              .filter((t) => { const r = t.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
              .slice(0, 5)
              .map((t) => ({
                text: (t.innerText || '').slice(0, 120),
                classes: (t.className || '').toString().slice(0, 80),
                hasRequiredText: /\brequired\b/i.test(t.innerText || ''),
                hasInvalidClass: t.classList.contains('emi-invalid-item'),
              }));
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
              .filter((d) => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
              .length;
            return { ctaPresent: !!cta, ctaVisible, ctaText, titles, dialogCount: dialogs };
          })
          .catch(() => null);
        logger.info({ targetName, diag }, '[cart] quick-add: no modal detected — post-click diagnostic');
        // Also screenshot so we can SEE the page state. ctaVisible=false +
        // titles=[] + dialogCount=0 could mean (a) the item really added to
        // bag without any modal, (b) a sign-in / address gate is covering
        // the page and blocked the click, or (c) the modal opened then
        // immediately closed. The screenshot disambiguates.
        if (saveScreenshot) {
          await saveScreenshot(page, `quick-add-no-modal-${targetName.replace(/[^a-z0-9]+/gi, '_')}`).catch(() => {});
        }
        // Also check whether we're logged in or have a sign-in modal up.
        const authDiag = await page
          .evaluate(() => {
            const signInLinks = (Array.from(document.querySelectorAll('a, button')))
              .filter((el) => {
                const r = el.getBoundingClientRect();
                if (r.width < 1 || r.height < 1) return false;
                return /sign\s*in|log\s*in/i.test(el.innerText || '');
              })
              .slice(0, 3)
              .map((el) => (el.innerText || '').trim().slice(0, 40));
            const accountBtn = document.querySelector('[data-testid="main-menu-profile-btn"]');
            const accountBtnVisible = !!accountBtn && (() => {
              const r = accountBtn.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            })();
            return { signInLinks, accountBtnVisible, url: location.href };
          })
          .catch(() => null);
        logger.info({ targetName, authDiag }, '[cart] auth state at point of no-modal');
      }
      // Original else-branch follows:
      if (!modalOpened) {
        // True quick-add success: no modal opened, item went straight to bag.
        let clicks = 1;
        let prevBadge = before;
        const bumpDeadline = Date.now() + 1500;
        while (Date.now() < bumpDeadline) {
          const cur = await readCartBadgeCount(page);
          if (cur != null && prevBadge != null && cur > prevBadge) {
            prevBadge = cur;
            break;
          }
          await page.waitForTimeout(120);
        }
        await safeDismiss(page);
        // For qty > 1 we need additional clicks on the same quick-add.
        for (let k = 1; k < qty; k++) {
          const btn = await findQuickAdd();
          if (!btn) break;
          await btn.click({ timeout: 4000 }).catch(() => {});
          clicks += 1;
          const d2 = Date.now() + 1500;
          while (Date.now() < d2) {
            const cur = await readCartBadgeCount(page);
            if (cur != null && prevBadge != null && cur > prevBadge) {
              prevBadge = cur;
              break;
            }
            await page.waitForTimeout(120);
          }
          await safeDismiss(page);
        }
        const after = await readCartBadgeCount(page);
        console.log('[cart] quick-added:', targetName, 'x', clicks, '(badge', before, '→', after + ')');

        // Late-modal guard: if a modifier modal mounted AFTER our poll
        // window (the bug we just fixed by extending the deadline to 4s),
        // the "quick add" didn't actually go through — Grubhub opened the
        // customize modal instead. Detect it here and reroute to the
        // modifier-fill path so we don't leave a stuck modal blocking
        // the next item's checkout click.
        const lateModal = await page
          .evaluate(() => {
            const cta = document.querySelector('[data-testid="emi-footer-cta"]');
            if (!cta) return false;
            const r = cta.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) return false;
            if (/required choice/i.test(cta.innerText || '')) return true;
            const titles = document.querySelectorAll('[data-testid="expansion-panel-title"]');
            for (const t of titles) {
              const tr = t.getBoundingClientRect();
              if (tr.width < 1 || tr.height < 1) continue;
              if (t.classList.contains('emi-invalid-item')) return true;
              if (/\brequired\b/i.test(t.innerText || '')) return true;
            }
            return false;
          })
          .catch(() => false);
        if (lateModal) {
          logger.warn({ targetName }, '[cart] late modifier modal detected after quick-add — rerouting to modal-fill path');
          // Fall through (do NOT continue) so the code below handles the modal.
        } else {
          // Dedupe + verify pass (quick-add path). Poll for the cart to
          // reflect the add — Chrome lags our code, so a single immediate
          // check races ahead and false-fails.
          await openCart(page).catch(() => {});
          const confQA = await confirmItemAdded(page, targetName);
          if (!confQA.added) {
            const badgeMoved = before != null && after != null && after > before;
            if (badgeMoved) {
              // Cart never named the item but the badge bumped — weak proof
              // the add went through; keep it rather than dropping a real add.
              console.log('[cart] could-not-verify (badge-only proof):', targetName);
              added.push({ name: targetName, qty: clicks, before, after, via: 'quickAdd', cartCount: -1 });
              continue;
            }
            // Quick-add reported success but the item never landed in the cart —
            // the located card was a wrong/duplicate copy whose "+" doesn't add
            // (e.g. East Moon lists "Basil Chicken Dinner" in two sections).
            // Re-locate the exact item via the in-page SEARCH and FALL THROUGH to
            // the modal/add path with the fresh card instead of giving up.
            logger.warn({ targetName, before, after }, '[cart] quick-add did not reflect in cart — re-locating via search, retrying via modal path');
            await closeAnyModal(page).catch(() => {});
            const fresh = await findMenuItemViaSearch(page, targetName, item.matched_price).catch(() => null);
            if (fresh) {
              handle = fresh;
              await handle.scrollIntoViewIfNeeded().catch(() => {});
              // do NOT continue — fall through to the card-click/modal path below
            } else {
              console.log('[cart] dedupe:', targetName, 'NOT in cart — recording as skipped');
              skipped.push({ name: targetName, reason: 'quick-add reported but item absent from cart' });
              continue;
            }
          } else if (confQA.count > qty) {
            const removedQA = await removeCartItemsByName(page, targetName, confQA.count - qty);
            logger.warn({ targetName, inCart: confQA.count, qty, removedQA }, '[cart] dedupe: removed surplus copies after quick-add');
            console.log('[cart] dedupe:', targetName, 'inCart=' + confQA.count, 'wanted=' + qty, 'removed=' + removedQA);
            added.push({ name: targetName, qty: clicks, before, after, via: 'quickAdd', cartCount: confQA.count - removedQA });
            continue;
          } else {
            console.log('[cart] verified:', targetName, 'inCart=' + confQA.count);
            added.push({ name: targetName, qty: clicks, before, after, via: 'quickAdd', cartCount: confQA.count });
            continue;
          }
        }
      }
    }

    // Skip the card click if the modifier modal is already open (e.g.
    // because the quick-add `+` button above popped it instead of adding
    // straight to bag). Same strict check as the quick-add path — looks
    // for "Make required choice" copy or an emi-invalid-item / "(Required)"
    // panel-title, not just any emi-footer-cta (which upsells also have).
    const modalAlreadyOpen = await page
      .evaluate(() => {
        const cta = document.querySelector('[data-testid="emi-footer-cta"]');
        if (!cta) return false;
        const r = cta.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return false;
        if (/required choice/i.test(cta.innerText || '')) return true;
        const titles = document.querySelectorAll('[data-testid="expansion-panel-title"]');
        for (const t of titles) {
          const tr = t.getBoundingClientRect();
          if (tr.width < 1 || tr.height < 1) continue;
          if (t.classList.contains('emi-invalid-item')) return true;
          if (/\brequired\b/i.test(t.innerText || '')) return true;
        }
        return false;
      })
      .catch(() => false);
    if (!modalAlreadyOpen) {
      await handle.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1100);

      // If the card click opened NEITHER a modifier modal NOR an add button,
      // the located handle was a wrong/duplicate or stale card — the category
      // walk name-matches across the whole menu and can grab a same-named card
      // in the wrong section (e.g. East Moon matched "Basil Chicken Dinner" in
      // the noodle-bowl section, which had no add affordance). Re-locate the
      // exact item via the in-page SEARCH box (filters to the typed name) and
      // click that fresh card.
      const openedSomething = await page
        .evaluate(() => {
          const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const cta = document.querySelector('[data-testid="emi-footer-cta"]');
          const addBtn = document.querySelector('[data-testid="add-to-bag-cta"], [data-testid="add-to-cart-cta"], [data-testid="addToCartButton"]');
          const dialog = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).some(vis);
          return vis(cta) || vis(addBtn) || dialog;
        })
        .catch(() => false);
      if (!openedSomething) {
        logger.warn({ targetName }, '[cart] card click opened no modal/add — re-locating via search and retrying');
        const fresh = await findMenuItemViaSearch(page, targetName, item.matched_price).catch(() => null);
        if (fresh) {
          handle = fresh;
          await handle.scrollIntoViewIfNeeded().catch(() => {});
          const qa = await handle.$(QUICK_ADD_SELECTOR).catch(() => null);
          if (qa && (await qa.isVisible().catch(() => false))) {
            await qa.click({ timeout: 4000 }).catch(() => {});
          } else {
            await handle.click({ timeout: 5000 }).catch(() => {});
          }
          await page.waitForTimeout(1200);
        }
      }
    }

    let diag = await diagnoseAddBlocker(page);
    if (diag.state === 'required-unfilled' || diag.state === 'disabled-unknown') {
      // Required-modifier path: auto-pick the first option for each
      // required group, then re-check whether the Add button enabled.
      // Look up notes-driven modifier preferences for this item. Preferences
      // are keyed by the user's requested name in notes (e.g. "Italian
      // Hoagie"), but the menu may match a slightly different name — check
      // both. Case-insensitive lookup defends against capitalization drift.
      const prefMap = preferences || {};
      let itemPrefs = (item.requested ? prefMap[item.requested] : undefined) || prefMap[targetName] || null;
      if (!itemPrefs) {
        const wantedLower = String(item.requested || targetName).toLowerCase();
        const hitKey = Object.keys(prefMap).find((k) => k.toLowerCase() === wantedLower);
        if (hitKey) itemPrefs = prefMap[hitKey];
      }

      // STRICT_MODIFIERS=true: if the user did NOT specify a preference for
      // this item in the notes (e.g. "Italian Hoagie modifiers: bread=White
      // Bread, cheese=Provolone"), do not let the bot pick on its own. Close
      // the modal and mark the item for human review. This is the right
      // default for production — the bot shouldn't guess "Junior Roll" or
      // "Pepper Jack" for a resident.
      const strict = (process.env.STRICT_MODIFIERS || '').toLowerCase() === 'true';
      if (strict && !itemPrefs) {
        if (saveScreenshot) {
          await saveScreenshot(page, `strict-no-prefs-${targetName.replace(/[^a-z0-9]+/gi, '_')}`).catch(() => {});
        }
        await closeAnyModal(page);
        console.log('[cart] skip:', targetName, '— required modifiers but no preferences in notes (STRICT_MODIFIERS=true)');
        skipped.push({ name: targetName, reason: 'required modifiers but no preferences in notes' });
        continue;
      }

      console.log('[cart] modifier-required for', targetName, itemPrefs ? '— using notes preferences' : '— filling defaults (cheapest)');
      const filledOk = await fillRequiredModifiers(page, {
        saveScreenshot,
        label: targetName.replace(/[^a-z0-9]+/gi, '_'),
        preferences: itemPrefs || {},
        itemName: targetName,
      });
      if (filledOk) {
        await page.waitForTimeout(500);
        diag = await diagnoseAddBlocker(page);
      }
      // Universal fallback: if the structured filler couldn't satisfy every
      // required group (panel wouldn't expand, unknown widget, pick didn't
      // register), sweep the dialog by the footer CTA's "Make required choice
      // (N)" counter — clicking the cheapest un-selected option until N hits
      // zero. This is what recovers items like Red Lobster's Kids "Macaroni &
      // Cheese" whose side panel the structured path can't drive.
      if (!filledOk || diag.state === 'required-unfilled' || diag.state === 'disabled-unknown') {
        const swept = await sweepRequiredByCta(page);
        if (swept) {
          await page.waitForTimeout(400);
          diag = await diagnoseAddBlocker(page);
        }
      }
      if (diag.state === 'required-unfilled' || diag.state === 'disabled-unknown') {
        if (saveScreenshot) {
          await saveScreenshot(page, `blocked-${diag.state}-${targetName.replace(/[^a-z0-9]+/gi, '_')}`).catch(() => {});
        }
        await closeAnyModal(page);
        console.log('[cart] skip:', targetName, '— still', diag.state, 'after auto-fill + sweep');
        skipped.push({ name: targetName, reason: diag.state });
        continue;
      }
    }

    // Bump qty via the modal's stepper, if exposed.
    for (let i = 1; i < qty; i++) {
      const plus = await findFirstVisible(page, QTY_PLUS_SELECTORS, { perTryMs: 400 });
      if (!plus) break;
      await plus.loc.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(180);
    }

    // Click the add/proceed button. Prefer a live DOM scan (clickAddOrProceed)
    // that reads the actual modal buttons and respects Grubhub's class-based
    // disabled state, then fall back to the static selector list.
    let clickedAdd = await clickAddOrProceed(page, { timeout: 5000 });
    if (!clickedAdd) clickedAdd = await clickFirstVisible(page, ADD_TO_ORDER_SELECTORS, { timeout: 5000 });
    if (!clickedAdd) {
      if (saveScreenshot) {
        await saveScreenshot(page, `no-add-btn-${targetName.replace(/[^a-z0-9]+/gi, '_')}`).catch(() => {});
      }
      await closeAnyModal(page);
      console.log('[cart] skip:', targetName, '— add button not found');
      skipped.push({ name: targetName, reason: 'add-to-order button not found' });
      continue;
    }

    // Modal closes on success; if it lingers, give it a beat and force-close.
    await page.waitForTimeout(1400);
    await closeAnyModal(page);

    // Verify + dedupe pass (modal-fill path). Open the cart sidebar, wait
    // for it to mount, then count the requested item:
    //   - inCart === -1 → sidebar not readable, optimistic add but flagged
    //   - inCart === 0  → silent failure (signed-out or modal-Add didn't
    //                     commit), demote to skipped
    //   - inCart > qty  → Wawa double-add, remove the surplus
    //   - inCart === qty → perfect
    await openCart(page).catch(() => {});
    // Poll for the cart to reflect the add — Chrome is slow relative to our
    // code, so checking once here races ahead and false-fails.
    const conf = await confirmItemAdded(page, targetName);
    const after = await readCartBadgeCount(page);
    const badgeBumped = before != null && after != null && after > before;

    if (!conf.added) {
      // The name-based cart read can race (sidebar not mounted/readable yet),
      // giving a false "absent" even when the item IS in the cart. The cart
      // BADGE count going up (before → after) is an independent, reliable proof
      // that the add committed. If the badge bumped, trust it and accept the
      // add instead of wrongly skipping a successfully-added item.
      if (badgeBumped) {
        logger.warn({ targetName, before, after }, '[cart] modal-fill: name-verify failed but cart badge increased — accepting add (sidebar read likely raced)');
        console.log('[cart] verified-by-badge:', targetName, '(badge', before, '→', after + ')');
        added.push({ name: targetName, qty, before, after, badgeBumped, cartCount: -1 });
        continue;
      }
      logger.warn({ targetName, before, after }, '[cart] modal-fill: cart never reflected the add (no name match, no badge bump)');
      console.log('[cart] verify:', targetName, 'NOT in cart after modal Add to bag — recording as skipped');
      skipped.push({ name: targetName, reason: 'modal Add to bag clicked but item absent from cart' });
      continue;
    }
    if (conf.count > qty) {
      const surplus = conf.count - qty;
      const removedN = await removeCartItemsByName(page, targetName, surplus);
      logger.warn(
        { targetName, inCart: conf.count, qty, surplus, removedN },
        '[cart] dedupe: removed surplus copies after modal add',
      );
      console.log('[cart] dedupe:', targetName, 'inCart=' + conf.count, 'wanted=' + qty, 'removed=' + removedN);
    } else {
      console.log('[cart] verified:', targetName, 'inCart=' + conf.count);
    }
    console.log('[cart] added:', targetName, 'x', qty, '(badge', before, '→', after + ')');
    added.push({ name: targetName, qty, before, after, badgeBumped, cartCount: conf.count });
  }

  console.log('[cart] done — added:', added.length, 'skipped:', skipped.length);
  return { added, skipped, initialBadge: beforeAll };
}

// Open the cart sidebar/modal. Grubhub has no standalone /cart page — the
// cart UI is always inline on the restaurant or checkout pages, so the
// only way to reach it is to click a cart button. If no cart button is
// visible (typical at the very start of a run when the cart is empty),
// return false instead of navigating to /cart (which 404s).
//
// Defensive sequence: (1) scroll back to the top so the cart button (in
// the global nav header) is always reachable without auto-scroll; (2)
// dismiss any pre-existing popup that could intercept the click; (3) click.
async function openCart(page) {
  if (/\/(cart|checkout)/i.test(page.url())) return true;
  // Sidebar is "mounted" when checkout button, a remove button, or the empty-
  // cart prompt is visible. We VERIFY this rather than assuming success — a
  // silently-unopened cart is the root of most "item absent" false negatives.
  const MOUNTED = '#ghs-cart-checkout-button, [data-testid="cart-item-remove"], [data-testid="empty-cart"], [data-testid="empty-cart-prompt"]';
  const isMounted = () => page.waitForSelector(MOUNTED, { timeout: 2500 }).then(() => true).catch(() => false);

  // Up to 2 attempts — the click can land before the SPA wires the handler.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await dismissPopups(page);
    const clicked = await clickFirstVisible(page, CART_OPEN_SELECTORS, { timeout: 4000 });
    if (clicked && await isMounted()) {
      await dismissPopups(page);
      return true;
    }
    await page.waitForTimeout(400);
  }
  // Final check: maybe it was already open and the click target wasn't found.
  if (await isMounted()) { await dismissPopups(page); return true; }
  logger.warn('openCart: cart sidebar did not mount after retries');
  return false;
}

// Empties whatever cart the current session is holding. Called at the
// start of every order run so we never inherit items from a crashed
// previous run or — critically in CDP-attach mode — from the user's
// real Chrome session.
async function clearCart(
  page,
  { saveScreenshot } = {},
) {
  const opened = await openCart(page);
  if (!opened) {
    logger.info('clearCart: no cart button visible — cart is empty, nothing to clear');
    return { method: 'noop', removed: 0 };
  }
  await detectBlockers(page).catch(() => {});

  // Fast path: a single "Empty cart" / "Clear cart" button.
  // Short visibility probe — if it isn't on the sidebar it won't appear later.
  const bulk = await clickFirstVisible(page, CART_EMPTY_BULK_SELECTORS, { timeout: 800 });
  if (bulk) {
    await clickFirstVisible(page, CART_EMPTY_CONFIRM_SELECTORS, { timeout: 1500 });
    // Wait for the cart to actually empty rather than sleeping 1.9s blindly.
    await page
      .waitForSelector('[data-testid="cart-item-remove"]', { state: 'detached', timeout: 2000 })
      .catch(() => {});
    logger.info({ via: bulk }, 'cart cleared (bulk)');
    if (saveScreenshot) await saveScreenshot(page, 'cart-cleared').catch(() => {});
    return { method: 'bulk', removed: null };
  }

  // Fallback: click Remove buttons one at a time until none are visible.
  // Most carts are 0-5 items; cap iterations and use tight per-step waits.
  let removed = 0;
  for (let i = 0; i < 12; i++) {
    const c = await clickFirstVisible(page, CART_REMOVE_SELECTORS, { timeout: 600 });
    if (!c) break;
    removed += 1;
    // Confirm dialogs sometimes appear per-remove — short probe only.
    await clickFirstVisible(page, CART_EMPTY_CONFIRM_SELECTORS, { timeout: 250 });
    await page.waitForTimeout(180);
  }
  logger.info({ removed }, 'cart cleared (iterative)');
  if (saveScreenshot) await saveScreenshot(page, 'cart-cleared').catch(() => {});
  return { method: 'iterate', removed };
}

async function readCartSubtotal(page) {
  // Try to open the cart sidebar; if it isn't reachable (empty cart, or
  // already inline) just fall through and read whatever's on screen.
  await openCart(page);
  for (const sel of CART_SUBTOTAL_SELECTORS) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 600 }).catch(() => false)) {
      const v = parseDollar(await loc.innerText().catch(() => ''));
      if (v != null) return v;
    }
  }
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const m =
    bodyText.match(/Subtotal[^$]{0,60}\$\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i) ||
    bodyText.match(/Items?\s+subtotal[^$]{0,60}\$\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

async function proceedToCheckout(page) {
  const urlBeforeAll = page.url();
  // Sweep any leftover popup before the first click.
  await dismissPopups(page);

  // Network instrumentation: track every XHR/fetch around the checkout
  // clicks. If click 1 fires a cart-validation request that 4xx's or
  // never completes, that's why click 2 has no effect (the React onClick
  // is still in its in-flight state, debouncing further clicks).
  const networkLog = [];
  const onRequest = (req) => {
    const url = req.url();
    if (/checkout|cart|order/i.test(url)) {
      networkLog.push({ phase: 'request', method: req.method(), url: url.slice(0, 200) });
    }
  };
  const onResponse = (res) => {
    const url = res.url();
    if (/checkout|cart|order/i.test(url)) {
      networkLog.push({ phase: 'response', status: res.status(), url: url.slice(0, 200) });
    }
  };
  page.on('request', onRequest);
  page.on('response', onResponse);

  // Click 1: open the cart sidebar's checkout flow.
  let clicked = await clickFirstVisible(page, CHECKOUT_BTN_SELECTORS, { timeout: 2500 });
  if (!clicked) {
    await openCart(page);
    clicked = await clickFirstVisible(page, CHECKOUT_BTN_SELECTORS, { timeout: 6000 });
  }
  if (!clicked) {
    // Diagnostic: enumerate every visible button so we can see what's on the
    // page when no known checkout selector matched. Common cause on Wawa: the
    // "Often bought with" upsell modal opens after a quick-add and hides the
    // cart sidebar. The dump shows which close-button selector to add to
    // dismissPopups, or which new checkout button to add to CHECKOUT_BTN_SELECTORS.
    const diag = await page
      .evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const out = [];
        for (const el of Array.from(document.querySelectorAll('button, [role="button"], a'))) {
          if (!visible(el)) continue;
          const text = (el.innerText || '').trim().slice(0, 80);
          const testid = el.getAttribute('data-testid');
          const aria = el.getAttribute('aria-label');
          const id = el.id || null;
          if (!text && !testid && !aria && !id) continue;
          out.push({
            tag: el.tagName.toLowerCase(),
            text,
            id,
            testid: testid || null,
            aria: aria || null,
          });
          if (out.length >= 60) break;
        }
        return {
          url: location.href,
          dialogCount: document.querySelectorAll('[role="dialog"], [aria-modal="true"]').length,
          openDialogBody: document.body.classList.contains('openDialog'),
          candidates: out,
        };
      })
      .catch(() => null);
    logger.warn({ diag }, 'proceedToCheckout: 1st click — no checkout button matched. Diagnostic dump (paste so we can add the right selector).');
    throw new BotError('CHECKOUT_BTN_NOT_FOUND', 'No checkout button visible on cart page');
  }
  logger.info({ via: clicked }, 'phase 5: clicked checkout (1st)');
  await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(900);

  // What does the page look like after click 1? If the cart sidebar
  // collapsed (no checkout button visible) OR a modal popped up that
  // we don't recognize, that's the answer to "why doesn't click 2
  // navigate". Dump the visible buttons + dialogs so we can see.
  const postClick1Diag = await page
    .evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'));
      const visibleDialogs = dialogs.filter(visible).map((d) => ({
        ariaLabel: d.getAttribute('aria-label') || null,
        testid: d.getAttribute('data-testid') || null,
        textHead: (d.innerText || '').trim().slice(0, 200),
      }));
      const checkoutBtn = document.querySelector('#ghs-cart-checkout-button');
      const allCheckoutCandidates = (Array.from(document.querySelectorAll(
        '#ghs-cart-checkout-button, [data-testid="checkout-btn"], button',
      ))).filter(visible).filter((b) => /checkout|place order|continue/i.test(b.innerText || '')).slice(0, 8).map((b) => ({
        text: (b.innerText || '').trim().slice(0, 60),
        id: b.id || null,
        testid: b.getAttribute('data-testid') || null,
        disabled: b.disabled || b.classList.contains('s-btn-primary--disabled'),
      }));
      return {
        url: location.href,
        urlChangedToCheckout: /\/checkout\//.test(location.href),
        checkoutBtnPresent: !!checkoutBtn,
        checkoutBtnVisible: checkoutBtn ? visible(checkoutBtn) : false,
        checkoutBtnDisabled: checkoutBtn ? (checkoutBtn.disabled || checkoutBtn.classList.contains('s-btn-primary--disabled')) : null,
        visibleDialogs,
        visibleCheckoutCandidates: allCheckoutCandidates,
      };
    })
    .catch((e) => ({ error: e && e.message }));
  logger.info({ postClick1Diag }, 'phase 5: state AFTER click 1 (this explains why click 2 may or may not work)');

  // Click 2: always required on Grubhub. Between clicks, three states
  // are possible — handle each:
  //   (a) Modal open over the cart  → dismissPopups closes it
  //   (b) Cart sidebar closed       → openCart re-opens it
  //   (c) Already navigated to /checkout/ → 2nd click is a no-op
  await dismissPopups(page);

  // Wait patiently (up to 4s) for the checkout button to be visible again
  // after the 1st click — there's often a brief animation while the cart
  // sidebar re-renders or a modal closes. waitForSelector is event-driven,
  // so it exits as soon as the button shows up.
  await page
    .waitForSelector('#ghs-cart-checkout-button, [data-testid="checkout-btn"]', { state: 'visible', timeout: 4000 })
    .catch(() => {});

  // If still not visible AND we're not already on /checkout/, the cart
  // sidebar likely collapsed — re-open it.
  const stillVisible = await page.locator('#ghs-cart-checkout-button').first()
    .isVisible({ timeout: 300 }).catch(() => false);
  if (!stillVisible && !/\/checkout\//.test(page.url())) {
    logger.info('checkout button still not visible after wait — re-opening cart sidebar');
    await openCart(page);
    await dismissPopups(page);
    await page
      .waitForSelector('#ghs-cart-checkout-button, [data-testid="checkout-btn"]', { state: 'visible', timeout: 3000 })
      .catch(() => {});
  }

  const second = await clickFirstVisible(page, CHECKOUT_BTN_SELECTORS, { timeout: 4000 });
  if (second) {
    logger.info({ via: second }, 'phase 5: clicked checkout (2nd)');
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  } else {
    // 2nd click failed to find the button. Capture diagnostics so we can
    // see what modal is in the way and which selector to add. This is a
    // common failure mode when Grubhub fires a minimum-order / promo
    // modal that doesn't match our existing close-button patterns.
    logger.warn('phase 5: 2nd checkout button not visible — capturing diagnostics');
    const diag = await page
      .evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const out = [];
        const sels = 'button, [role="button"], [role="dialog"] *[data-testid], [aria-modal="true"] *';
        for (const el of Array.from(document.querySelectorAll(sels))) {
          if (!visible(el)) continue;
          const text = (el.innerText || '').trim().slice(0, 80);
          const testid = el.getAttribute('data-testid');
          const aria = el.getAttribute('aria-label');
          if (!text && !testid && !aria) continue;
          out.push({
            tag: el.tagName.toLowerCase(),
            text,
            testid: testid || null,
            aria: aria || null,
            cls: (el.className || '').toString().slice(0, 100),
          });
          if (out.length >= 40) break;
        }
        return { url: location.href, modalCount: document.querySelectorAll('[role="dialog"], [aria-modal="true"]').length, candidates: out };
      })
      .catch(() => null);
    logger.warn({ diag }, 'phase 5: visible-button diagnostic (paste close-button selector to add it to dismissPopups)');
  }

  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);

  let finalUrl = page.url();

  // Fallback: if the two clicks didn't navigate, wait up to 10s more for
  // the URL to flip. Grubhub sometimes fires a slow XHR (cart-validation)
  // before redirecting. waitForURL is event-driven so it exits the moment
  // the URL matches.
  if (!/\/checkout\//.test(finalUrl)) {
    logger.info({ finalUrl }, 'proceedToCheckout: URL not yet /checkout/ — waiting up to 10s for navigation');
    await page.waitForURL(/\/checkout\//, { timeout: 10000 }).catch(() => {});
    finalUrl = page.url();
  }

  // Last resort: one more checkout click. The 2nd click sometimes lands
  // a millisecond before Grubhub's cart-validation XHR returns, in which
  // case nothing navigates. A 3rd click after another 2s settle catches
  // that race. We deliberately avoid page.goto('/cart') here — that URL
  // 404s on Grubhub (the real cart is the sidebar dialog).
  if (!/\/checkout\//.test(finalUrl)) {
    logger.info({ finalUrl }, 'proceedToCheckout: still not at /checkout/ — one more click attempt');
    await page.waitForTimeout(2000);
    await dismissPopups(page);
    const third = await clickFirstVisible(page, CHECKOUT_BTN_SELECTORS, { timeout: 4000 });
    if (third) {
      logger.info({ via: third }, 'phase 5: clicked checkout (3rd)');
      await page.waitForURL(/\/checkout\//, { timeout: 12000 }).catch(() => {});
      finalUrl = page.url();
    }
  }

  page.off('request', onRequest);
  page.off('response', onResponse);

  if (!/\/checkout\//.test(finalUrl)) {
    logger.warn({ urlBeforeAll, finalUrl, networkLog: networkLog.slice(0, 40) }, 'proceedToCheckout: URL did not change to /checkout/ — network activity during clicks');
  } else {
    logger.info({ finalUrl, networkLogSize: networkLog.length }, 'proceedToCheckout: reached checkout');
  }
  return finalUrl;
}

async function readCheckoutTotal(page) {
  // Only attempt to read the checkout total when we're actually on the
  // checkout page. Otherwise random "$X" amounts on the restaurant page
  // (delivery minimums, free-delivery thresholds, upsell carousels) get
  // picked up by the body-text regex and reported as the cart total.
  if (!/\/checkout\//.test(page.url())) {
    logger.warn({ url: page.url() }, 'readCheckoutTotal: not on /checkout/ — returning null (no body-text guess)');
    return null;
  }

  // Poll-until-present: wait for a known total element to render before
  // reading, so we don't snapshot the price mid-hydration (this read used to
  // race the checkout page's last paint after proceedToCheckout). Event-driven
  // — returns the instant the total mounts; bounded so a missing element still
  // falls through to the body-text regex below.
  await page
    .waitForSelector(CHECKOUT_TOTAL_SELECTORS.join(', '), { state: 'visible', timeout: 5000 })
    .catch(() => {});

  for (const sel of CHECKOUT_TOTAL_SELECTORS) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 600 }).catch(() => false)) {
      const v = parseDollar(await loc.innerText().catch(() => ''));
      if (v != null) return v;
    }
  }
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  // Try the strongest signals first: explicit "Total", then "Grand total" / "Order total".
  const candidates = [
    /Grand total[^$]{0,40}\$\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i,
    /Order total[^$]{0,40}\$\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i,
    /\bTotal\b[^$]{0,40}\$\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i,
  ];
  for (const re of candidates) {
    const m = bodyText.match(re);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
  }
  return null;
}

// Fill the resident's contact info + special instructions into the
// checkout-page form. Each field is independently optional — if the input
// isn't present (or already has the right value) we skip it. Returns a
// summary of what got written.
async function fillCheckoutContact(
  page,
  { firstName, lastName, phone, unit, specialInstructions } = {},
) {
  const result = { firstName: 'skipped', lastName: 'skipped', phone: 'skipped', unit: 'skipped', specialInstructions: 'skipped' };

  // On the all-in-one review page, contact fields are hidden behind an
  // "Edit" button. If we have a name/phone to write and the field isn't
  // directly visible, open the modal first.
  let modalOpened = false;
  if (firstName || lastName || phone) {
    const firstNameDirect = await page.locator('#firstName').first()
      .isVisible({ timeout: 400 }).catch(() => false);
    if (!firstNameDirect) {
      const editBtn = page.locator('[data-testid="checkout-edit-contact"]').first();
      if (await editBtn.isVisible({ timeout: 1200 }).catch(() => false)) {
        await editBtn.click({ timeout: 2500 }).catch(() => {});
        logger.info('clicked checkout-edit-contact — opened contact modal');
        await page.waitForSelector('#firstName, input[name="firstName"]', { timeout: 4000 }).catch(() => {});
        modalOpened = true;
      } else {
        logger.info('contact fields not directly visible and no Edit button — Grubhub may have all contact info saved');
      }
    }
  }

  async function setIfPresent(selectors, value, key) {
    // First, find the input. We need to know whether the field exists on
    // the page regardless of whether we have a value, so we report both
    // axes accurately ("field absent" vs "field present but no value").
    let foundLoc = null;
    let foundSel = null;
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
        foundLoc = loc;
        foundSel = sel;
        break;
      }
    }
    if (!foundLoc) {
      result[key] = 'no matching input visible';
      return;
    }
    if (!value) {
      const current = (await foundLoc.inputValue().catch(() => '')) || '';
      result[key] = `no value provided (field present, current="${current}")`;
      return;
    }
    const current = (await foundLoc.inputValue().catch(() => '')) || '';
    if (current.trim() === String(value).trim()) {
      result[key] = `already "${value}" (${foundSel})`;
      return;
    }
    // Force clear+paste to overwrite any session-prefilled value (e.g.
    // the bot account's own name). fill() sets the value + fires `input`
    // in one shot — no per-char delay.
    await foundLoc.click({ timeout: 1500 }).catch(() => {});
    await foundLoc.fill(String(value)).catch(() => {});
    // Blur so the SPA commits the value to its form state. Without this the
    // typed value can still be "in-flight" when the approval screenshot fires,
    // so the field looks empty in Slack even though we typed it.
    await foundLoc.blur().catch(() => {});
    result[key] = `set via ${foundSel} (was "${current}")`;
  }

  await setIfPresent(
    ['#firstName', 'input[name="firstName"]', 'input[placeholder="First Name"]', 'input[aria-label*="First name" i]'],
    firstName,
    'firstName',
  );
  await setIfPresent(
    ['#lastName', 'input[name="lastName"]', 'input[placeholder="Last Name"]', 'input[aria-label*="Last name" i]'],
    lastName,
    'lastName',
  );
  await setIfPresent(
    ['#phone', 'input[name="phone"]', 'input[type="tel"]', 'input[placeholder*="Phone" i]', 'input[aria-label*="phone" i]'],
    phone,
    'phone',
  );
  // Unit / apt → the "Apt., suite, floor, etc." field (#address2).
  await setIfPresent(
    ['#address2', 'input[name="address2"]', 'input[placeholder*="Apt" i]', 'input[placeholder*="suite" i]', 'input[aria-label*="Address 2" i]'],
    unit,
    'unit',
  );
  await setIfPresent(
    [
      '#specialInstructions',
      'textarea[name="specialInstructions"]',
      'textarea[name="instructions"]',
      'textarea[placeholder*="special instructions" i]',
      'textarea[aria-label*="driver" i]',
    ],
    specialInstructions,
    'specialInstructions',
  );

  // If we opened the contact-edit modal, save it now (Grubhub uses Update/
  // Save labels on the modal's primary button — try both).
  if (modalOpened) {
    const saveSelectors = [
      '[data-testid="checkout-edit-contact-save"]',
      '[data-testid*="contact"] button[type="submit"]',
      '[role="dialog"] button:has-text("Save")',
      '[role="dialog"] button:has-text("Update")',
      '[role="dialog"] button[type="submit"]',
    ];
    let saved = false;
    for (const sel of saveSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
        await btn.click({ timeout: 2500 }).catch(() => {});
        saved = true;
        logger.info({ via: sel }, 'saved contact-edit modal');
        await page.waitForTimeout(600);
        break;
      }
    }
    if (!saved) logger.warn('contact-edit modal was opened but no Save/Update button found');
  }

  logger.info(result, 'fillCheckoutContact result');
  return result;
}

// Pick an address label (Home / Work / Other) and click "Continue to
// payment method". Lands us on the payment-method page. Returns the new
// page URL plus what got clicked.
async function submitCheckoutGather(
  page,
  { addressLabel = 'home' } = {},
) {
  const labelSelectors = [
    `[data-testid="address-label-${addressLabel}"]`,
    '[data-testid="address-label-home"]',
    '[data-testid^="address-label-"]',
    `button:has-text("${addressLabel.charAt(0).toUpperCase() + addressLabel.slice(1)}")`,
  ];
  let labelClicked = null;
  for (const sel of labelSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
      await loc.click({ timeout: 2000 }).catch(() => {});
      labelClicked = sel;
      logger.info({ via: sel }, 'clicked address label');
      break;
    }
  }
  if (!labelClicked) {
    logger.warn('no address-label button visible — Grubhub may not require it for this restaurant');
  }

  const submitSelectors = [
    '#checkout-gather-submit',
    'button[id*="checkout-gather"]',
    'button.btn-sbmt-gather',
    'button:has-text("Continue to payment method")',
    'button:has-text("Continue to Payment")',
  ];
  let submitClicked = null;
  for (const sel of submitSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
      const beforeUrl = page.url();
      await loc.click({ timeout: 3000 }).catch(() => {});
      submitClicked = sel;
      logger.info({ via: sel }, 'clicked Continue to payment');
      // Wait for either URL change or DOM update indicating payment page.
      await Promise.race([
        page.waitForURL((u) => String(u) !== beforeUrl, { timeout: 12000 }).catch(() => {}),
        page.waitForSelector(
          '[data-testid*="payment"], [data-testid*="card"], input[id*="card" i], #card-number, [data-testid="checkout-submit"]',
          { timeout: 12000 },
        ).catch(() => {}),
      ]);
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
      break;
    }
  }
  if (!submitClicked) {
    // The gather→payment intermediate page only appears when the account
    // is missing address/contact details. On logged-in accounts with saved
    // info, Grubhub fast-paths to the all-in-one review page. That's not
    // an error — it just means we're already at the right place.
    logger.info('no "Continue to payment method" button — already on final review page (single-page checkout)');
    return { labelClicked, submitClicked: null, url: page.url(), skipped: true };
  }
  return { labelClicked, submitClicked, url: page.url() };
}

// Enumerates every visible form control on the page along with its stable
// attributes (data-testid, id, name, aria-label, placeholder, label text).
// Used to discover selectors for the checkout fields we need to fill —
// run it once after `proceedToCheckout`, save the output, and pick the
// hooks for address / phone / name fill from the dump.
async function dumpCheckoutForm(page) {
  return await page
    .evaluate(() => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      // Walk up to find an associated <label for=...> or wrapping <label>.
      const labelFor = (el) => {
        if (el.id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lbl) return (lbl.innerText || '').trim().slice(0, 80);
        }
        const parentLabel = el.closest('label');
        if (parentLabel) return (parentLabel.innerText || '').trim().slice(0, 80);
        // Last resort: nearest preceding text within 2 levels up.
        let p = el.parentElement;
        for (let depth = 0; depth < 3 && p; depth++, p = p.parentElement) {
          const t = (p.innerText || '').trim();
          if (t && t.length < 120) return t.slice(0, 80);
        }
        return '';
      };
      const fields = [];
      for (const el of Array.from(document.querySelectorAll('input, select, textarea, button'))) {
        if (!isVisible(el)) continue;
        const tag = el.tagName.toLowerCase();
        // Skip non-form buttons that are clearly nav/menu (no clear label).
        if (tag === 'button' && !el.innerText && !el.getAttribute('aria-label')) continue;
        fields.push({
          tag,
          type: el.getAttribute('type') || null,
          testid: el.getAttribute('data-testid') || null,
          id: el.id || null,
          name: el.getAttribute('name') || null,
          ariaLabel: el.getAttribute('aria-label') || null,
          placeholder: el.getAttribute('placeholder') || null,
          autocomplete: el.getAttribute('autocomplete') || null,
          label: labelFor(el),
          buttonText: tag === 'button' ? (el.innerText || '').trim().slice(0, 60) : null,
        });
      }
      return { url: location.href, count: fields.length, fields };
    })
    .catch((err) => ({ error: err.message, fields: [] }));
}

async function gatherCheckoutSnapshot(page) {
  return await page
    .evaluate(() => {
      const visibleText = (sel) => {
        const out = [];
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          const t = (el.innerText || '').trim();
          if (t) out.push(t.slice(0, 220));
          if (out.length >= 3) break;
        }
        return out;
      };
      return {
        url: location.href,
        title: document.title,
        headings: visibleText('h1, h2'),
        address: visibleText('[data-testid*="address"], [aria-label*="address" i]'),
        payment: visibleText('[data-testid*="payment"], [aria-label*="payment" i]'),
        tip: visibleText('[data-testid*="tip"], [aria-label*="tip" i]'),
      };
    })
    .catch(() => null);
}

module.exports = {
  addItemsToCart,
  openCart,
  clearCart,
  readCartSubtotal,
  proceedToCheckout,
  readCheckoutTotal,
  gatherCheckoutSnapshot,
  dumpCheckoutForm,
  fillCheckoutContact,
  submitCheckoutGather,
  placeOrder,
  ensureOrderType,
  assertSignedIn,
};

// Ensure the restaurant page is in the requested order type (delivery|pickup).
// Grubhub renders a two-button toggle on the restaurant page with stable ids
// #delivery-button and #pickup-button. The currently-selected one has
// aria-pressed="true". Clicking the other flips state and triggers a menu
// re-fetch (different prices / availability / no delivery fee on pickup).
//
// Returns { changed: bool, before: 'delivery'|'pickup'|null, after: 'delivery'|'pickup'|null, err?: string }.
// Non-fatal: if the toggle isn't visible we log and continue — some restaurants
// only support one mode and the toggle is hidden.
async function ensureOrderType(page, wanted) {
  const want = (wanted || '').toLowerCase();
  if (want !== 'delivery' && want !== 'pickup') {
    return { changed: false, before: null, after: null, err: `unknown wanted=${wanted}` };
  }

  // The Delivery/Pickup toggle (#delivery-button / #pickup-button, role=button,
  // aria-pressed) is rendered by the SPA a beat AFTER navigation. Checking
  // immediately gets a false "no toggle" and the bot never switches to pickup —
  // leaving a pickup order stuck on Delivery (and on a restaurant that doesn't
  // deliver to the address, every add then fails). Wait for it to mount first.
  await page.waitForSelector('#delivery-button, #pickup-button', { timeout: 8000 }).catch(() => {});

  const state = await page.evaluate(() => {
    const d = document.querySelector('#delivery-button');
    const p = document.querySelector('#pickup-button');
    const pressed = (el) => !!el && el.getAttribute('aria-pressed') === 'true';
    return {
      hasToggle: !!(d || p),
      currentDelivery: pressed(d),
      currentPickup: pressed(p),
    };
  }).catch(() => ({ hasToggle: false }));

  if (!state.hasToggle) {
    logger.warn('ensureOrderType: no delivery/pickup toggle on page (even after wait) — restaurant may only support one mode');
    return { changed: false, before: null, after: null, err: 'no-toggle' };
  }

  const current = state.currentPickup ? 'pickup' : (state.currentDelivery ? 'delivery' : null);
  if (current === want) {
    logger.info({ orderType: current }, 'ensureOrderType: already in requested mode');
    return { changed: false, before: current, after: current };
  }

  const buttonSel = want === 'pickup' ? '#pickup-button' : '#delivery-button';
  const clicked = await page.locator(buttonSel).first()
    .click({ timeout: 3000 })
    .then(() => true)
    .catch((e) => { logger.warn({ err: e.message }, 'ensureOrderType: toggle click failed'); return false; });

  if (!clicked) {
    return { changed: false, before: current, after: current, err: 'click-failed' };
  }

  // Wait for the menu to re-render. Grubhub may refetch items + update the
  // cart sidebar. We wait for either a menu item to mount OR a brief settle —
  // whichever comes first. networkidle is too aggressive (ads keep firing).
  await page
    .waitForSelector(
      '[data-testid="restaurant-menu-item"], [data-testid^="Item-"]:not([data-testid$="-quickAdd"])',
      { timeout: 8000 },
    )
    .catch(() => {});
  await page.waitForTimeout(800);

  // Verify the flip actually happened (anti-stale-DOM check).
  const after = await page.evaluate(() => {
    const d = document.querySelector('#delivery-button');
    const p = document.querySelector('#pickup-button');
    if (p && p.getAttribute('aria-pressed') === 'true') return 'pickup';
    if (d && d.getAttribute('aria-pressed') === 'true') return 'delivery';
    return null;
  }).catch(() => null);

  logger.info({ before: current, after, wanted: want, changed: after === want }, 'ensureOrderType: toggle attempt complete');
  return { changed: after === want, before: current, after };
}

// ---- Phase 6: Place Order ----
//
// Click the final "Place Order" button on the checkout review page and wait
// for Grubhub to redirect to the confirmation page (URL pattern: /order/<id>).
// Returns { ok, grubhubOrderId, confirmationUrl, error } so the caller can
// write success or failure back to the sheet without inspecting the page.
//
// Safety: this function refuses to click unless the current URL contains
// /checkout/.../review. We never want to fire Place Order on the menu page
// (where it doesn't exist anyway) or on a half-loaded checkout page.
//
// Defined below the module.exports because Node hoists function declarations
// (not function expressions) — the name is bound before exports evaluates.
async function placeOrder(page) {
  const url = page.url();
  if (!/\/checkout\/[^/]+\/review/i.test(url)) {
    return { ok: false, error: `placeOrder refused: not on /checkout/.../review (url=${url})` };
  }
  await dismissPopups(page);

  // Find the Place Order button. Grubhub uses several selectors across
  // restaurant types — try the most specific (testid) first.
  const PLACE_ORDER_SELECTORS = [
    '[data-testid="place-order-button"]',
    '[data-testid="place-order"]',
    'button:has-text("Place order")',
    'button:has-text("Place Order")',
  ];
  const clicked = await clickFirstVisible(page, PLACE_ORDER_SELECTORS, { timeout: 8000 });
  if (!clicked) {
    return { ok: false, error: 'Place Order button not visible on /review page' };
  }
  logger.info({ via: clicked }, 'placeOrder: clicked');

  // Wait for the URL to flip to /order/<id> (confirmation page). Grubhub
  // can take 5-15s on slow connections while it actually charges the card.
  // 30s is generous but not unbounded — if we never reach /order/, something
  // is genuinely wrong (card declined, modal blocking, etc.) and the caller
  // needs to know.
  await page.waitForURL(/\/order\//, { timeout: 30000 }).catch(() => {});
  const finalUrl = page.url();
  const m = finalUrl.match(/\/order\/([^/?#]+)/i);
  if (!m) {
    return { ok: false, error: `placeOrder: URL did not change to /order/<id> (finalUrl=${finalUrl})`, confirmationUrl: finalUrl };
  }
  const grubhubOrderId = m[1];
  logger.info({ grubhubOrderId, finalUrl }, 'placeOrder: confirmation page reached');
  return { ok: true, grubhubOrderId, confirmationUrl: finalUrl };
}
