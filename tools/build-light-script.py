#!/usr/bin/env python3
"""Rebuild wiki-masterbetter-tags.me.js (the light script) from wiki-masterbetter.me.js (the full script).

The light script carries Feature MTG (mass-tagging), Rule 40 (wider tag manager modal) and the three switches of
Feature MLM's market bar. Their code is taken from the full script itself, so run this after changing any of them:

    python3 tools/build-light-script.py           rebuild if the light script is out of date (default)
    python3 tools/build-light-script.py --check   only report: exit status 1 if it is out of date, nothing written
    python3 tools/build-light-script.py --force   rewrite even if nothing changed

Python 3 standard library only. The market section below is a condensed hand-written copy (no median, watchlist or
settings window): only its CSS is taken from the full script. If Feature MLM's switches change in behaviour, edit it here.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FULL = ROOT / "wiki-masterbetter.me.js"
LIGHT = ROOT / "wiki-masterbetter-tags.me.js"

# Metadata of the light script (the version is its own, independent of the full script's)
LIGHT_VERSION = "1.0.0"
LIGHT_AUTHOR = "Pierre Bellan (https://github.com/pbellan)"

src = FULL.read_text(encoding="utf-8")
lines=src.split('\n')

def section(start_marker, end_after_func=None):
    """From the '// ====' line preceding the marker, up to the next '  // ====' line after end_after_func (or the marker)."""
    i=src.index(start_marker)
    a=src.rfind("  // ============================================================\n",0,i)
    anchor=src.index(end_after_func,i) if end_after_func else i
    b=src.index("  // ============================================================\n",anchor)
    return src[a:b]

rule40=section("  // Rule 40: whenever the tag manager modal","  function watchTagManagerModalWidth")
mtg=section("  // Feature MTG: mass-tag the untagged cards","  function watchMassTagging")

# helpers
wait=src[src.index("  function waitForElement("):src.index("  function insertStopWishlistCleanupButton")]
setter='''  const NATIVE_INPUT_VALUE_SETTER = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  ).set;

  function clearCollectionSearchInput(input) {
    NATIVE_INPUT_VALUE_SETTER.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
'''

# css of the MLM bar (items, switch) copied from the main script
c0=src.index("      .wm-mlm-hidden {")
c1=src.index("      .wm-mlm-median {")
mlm_css=src[c0:c1]
# drop the AWL-specific rule
mlm_css=re.sub(r"      /\* Hidden while Feature AWL.*?\n      \}\n","",mlm_css,flags=re.S)
assert "awl" not in mlm_css.lower()

header='''// ==UserScript==
// @name         Wiki-MasterBetter Étiquettes & Marché
// @namespace    http://tampermonkey.net
// @version      {LIGHT_VERSION}
// @description  Étiquetage en masse de la collection d'après des termes de recherche, et filtres de la liste des enchères (mise de départ, cartes possédées) sur wiki-masters.com
// @author       {LIGHT_AUTHOR}
// @match        https://www.wiki-masters.com/*
// @exclude      https://www.wiki-masters.com/battle*
// @exclude      https://www.wiki-masters.com/settings*
// @grant        GM_addStyle
// ==/UserScript==

// Script autonome, extrait de Wiki-MasterBetter : il ne reprend que
//   1. l'étiquetage en masse de la collection (Feature MTG), avec la modale « Gérer les étiquettes » élargie (Rule 40) ;
//   2. les trois interrupteurs de la page « Marché » (onglet « Parcourir ») : « Mise de départ », « Atténuer
//      possédées » et « Masquer possédées » (Feature MLM, sans la médiane des ventes ; Rule 41 pour l'atténuation).
// Ne l'installez pas en même temps que Wiki-MasterBetter : les deux ajouteraient les mêmes éléments aux mêmes
// endroits. Les réglages sont les mêmes (mêmes clés localStorage), donc on peut passer de l'un à l'autre.

(function () {
  "use strict";

  // ============================================================
  // Helpers shared by the features below
  // ============================================================
'''.replace("{LIGHT_VERSION}", LIGHT_VERSION).replace("{LIGHT_AUTHOR}", LIGHT_AUTHOR)+wait+setter+'''
'''

market='''  // ============================================================
  // Marketplace filters (Feature MLM's three switches, with Rule 41's dimming): on the market page (/marketplace,
  // "Parcourir" tab; every card is a div[id^="marketplace-auction-"]), a bar of compact switches (short label + a
  // small version of the site's own settings switch, the explanation being in the tooltip) is put in the page header,
  // between the title block and the "Sélectionner" button — at the top of the page, outside the list, which the site
  // re-renders. On narrow screens it wraps under the title. It holds:
  //   - "Mise de départ": hides the auctions that already have bids, keeping the ones whose card still shows the
  //     "Mise de départ" label (a card with bids shows another label); localStorage "wm-mlm-start-only".
  //   - "Atténuer possédées": makes the owned cards (the ones carrying the "Possédée" tag, span.bg-emerald-600/90)
  //     almost transparent, back to full visibility on hover (the "wm-owned-dimmed" class); localStorage
  //     "wm-owned-dim" (on by default).
  //   - "Masquer possédées": removes the owned cards from the view; localStorage "wm-mlm-hide-owned" (off by default).
  // Hiding is a CSS class on the card (never removing it, so React's list stays consistent); cards that appear later
  // ("Charger la suite") are handled by the page observer. A switch that hides cards shows how many. Finished
  // auctions (the "Historique" and "Gagnées" tabs) are never filtered.
  // ============================================================
  const OWNED_DIM_KEY = "wm-owned-dim";
  const OWNED_TAG_SELECTOR = "span.bg-emerald-600\\\\/90";
  const MLM_START_LABEL = "Mise de départ";
  const MLM_STORAGE_KEY = "wm-mlm-start-only";
  const MLM_HIDE_OWNED_KEY = "wm-mlm-hide-owned";
  const MLM_FINISHED_TAB_LABELS = ["Historique", "Gagnées"];
  const MLM_CARD_SELECTOR = 'div[id^="marketplace-auction-"]';

  const mlmReadFlag = (key, fallback = false) => {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value === "1";
    } catch {
      return fallback;
    }
  };
  const mlmWriteFlag = (key, value) => {
    try {
      localStorage.setItem(key, value ? "1" : "0");
    } catch {
      // Unwritable storage: the choice just won't stick
    }
  };
  let mlmStartOnly = mlmReadFlag(MLM_STORAGE_KEY);
  let mlmHideOwned = mlmReadFlag(MLM_HIDE_OWNED_KEY);
  let ownedDimEnabled = mlmReadFlag(OWNED_DIM_KEY, true);

  // The tab bar holding "Parcourir", "Mes ventes", "Mes enchères"... (the guild page has a similar bar)
  function marketFindTabBar() {
    return Array.from(
      document.querySelectorAll("div.overflow-x-auto.border-b"),
    ).find((bar) =>
      Array.from(bar.querySelectorAll(":scope > button")).some((button) =>
        button.textContent.trim().startsWith("Parcourir"),
      ),
    );
  }

  const marketActiveTabLabel = (tabBar) =>
    Array.from(tabBar.querySelectorAll(":scope > button"))
      .find((button) => button.classList.contains("border-b-2"))
      ?.textContent.trim() ?? "";

  function mlmHasStartBid(card) {
    return Array.from(card.querySelectorAll("span.uppercase")).some(
      (span) => span.textContent.trim() === MLM_START_LABEL,
    );
  }

  // One compact item of the bar: a short label and a switch (the site's switch look, scaled down), the
  // explanation being in the tooltip. The whole item is clickable; the switch inside stays focusable for the
  // keyboard (its click bubbles up to the item).
  function mlmBuildSwitchItem(key, label, tooltip, ariaLabel, onToggle) {
    const item = document.createElement("div");
    item.className = "wm-mlm-item";
    item.dataset.wmMlm = key;
    item.dataset.wmMlmLabel = label;
    item.dataset.wmMlmTip = tooltip;
    item.title = tooltip;

    const text = document.createElement("span");
    text.className = "wm-mlm-label";
    text.textContent = label;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "wm-mlm-switch";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", "false");
    button.setAttribute("aria-label", ariaLabel);
    const knob = document.createElement("span");
    knob.className = "wm-mlm-knob";
    button.append(knob);

    item.addEventListener("click", onToggle);
    item.append(text, button);
    return item;
  }

  // The page header (div.flex.items-start.justify-between holding the h1 "Marché" and the "Sélectionner" button)
  function mlmFindHeader(tabBar) {
    return Array.from(tabBar.parentElement.children).find(
      (el) =>
        el.matches("div.flex.items-start.justify-between") &&
        el.querySelector("h1"),
    );
  }

  function mlmEnsureBar(tabBar) {
    const header = mlmFindHeader(tabBar);
    if (!header) return null;

    let bar = document.querySelector(".wm-mlm-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "wm-mlm-bar";

      bar.append(
        mlmBuildSwitchItem(
          "start",
          "Mise de départ",
          "Mise de départ seulement : masque les enchères qui ont déjà reçu des mises",
          "Afficher seulement les enchères sans mise",
          () => {
            mlmStartOnly = !mlmStartOnly;
            mlmWriteFlag(MLM_STORAGE_KEY, mlmStartOnly);
            updateMarketplaceList();
          },
        ),
        mlmBuildSwitchItem(
          "dim",
          "Atténuer possédées",
          "Rend presque transparentes les cartes que vous possédez déjà (pleine visibilité au survol)",
          "Atténuer les cartes déjà possédées",
          () => {
            ownedDimEnabled = !ownedDimEnabled;
            mlmWriteFlag(OWNED_DIM_KEY, ownedDimEnabled);
            updateMarketplaceList();
          },
        ),
        mlmBuildSwitchItem(
          "hide",
          "Masquer possédées",
          "Retire de la liste les cartes que vous possédez déjà",
          "Masquer les cartes déjà possédées",
          () => {
            mlmHideOwned = !mlmHideOwned;
            mlmWriteFlag(MLM_HIDE_OWNED_KEY, mlmHideOwned);
            updateMarketplaceList();
          },
        ),
      );
    }
    // Between the title block and the "Sélectionner" button, once (React never moves foreign nodes)
    if (!header.classList.contains("wm-mlm-header")) {
      header.classList.add("wm-mlm-header");
    }
    if (bar.parentElement !== header) header.firstElementChild.after(bar);
    return bar;
  }

  // "hidden" is the number of cards the switch hides: shown after the label and in the tooltip while it is on
  function mlmSyncItem(bar, key, on, hidden) {
    const item = bar.querySelector(`.wm-mlm-item[data-wm-mlm="${key}"]`);
    if (!item) return;
    const button = item.querySelector(".wm-mlm-switch");
    if (button.getAttribute("aria-checked") !== String(on)) {
      button.setAttribute("aria-checked", String(on));
    }
    const shown = on && hidden > 0;
    const label = `${item.dataset.wmMlmLabel}${shown ? ` · ${hidden}` : ""}`;
    const labelEl = item.querySelector(".wm-mlm-label");
    if (labelEl.textContent !== label) labelEl.textContent = label;
    const tip = `${item.dataset.wmMlmTip}${shown ? ` (${hidden} masquée${hidden > 1 ? "s" : ""})` : ""}`;
    if (item.title !== tip) item.title = tip;
  }

  function updateMarketplaceList() {
    const onList = /^\\/marketplace\\/?$/.test(window.location.pathname);
    const tabBar = onList ? marketFindTabBar() : null;
    const activeTab = tabBar ? marketActiveTabLabel(tabBar) : "";
    const browse = activeTab.startsWith("Parcourir");
    const finished = MLM_FINISHED_TAB_LABELS.some((label) =>
      activeTab.startsWith(label),
    );

    // The switches live on top of the page, whatever the number of cards (a search may return none)
    const bar = browse ? mlmEnsureBar(tabBar) : null;
    if (!bar) {
      document.querySelectorAll(".wm-mlm-bar").forEach((el) => el.remove());
    }

    let noBidHidden = 0;
    let ownedHidden = 0;
    for (const card of document.querySelectorAll(MLM_CARD_SELECTOR)) {
      const owned = !!card.querySelector(OWNED_TAG_SELECTOR);
      let hide = false;
      if (browse && !finished) {
        const hideNoBid = mlmStartOnly && !mlmHasStartBid(card);
        const hideOwn = mlmHideOwned && owned;
        if (hideNoBid) noBidHidden++;
        if (hideOwn) ownedHidden++;
        hide = hideNoBid || hideOwn;
      }
      if (card.classList.contains("wm-mlm-hidden") !== hide) {
        card.classList.toggle("wm-mlm-hidden", hide);
      }
      const dim = browse && ownedDimEnabled && owned;
      if (card.classList.contains("wm-owned-dimmed") !== dim) {
        card.classList.toggle("wm-owned-dimmed", dim);
      }
    }

    if (bar) {
      mlmSyncItem(bar, "start", mlmStartOnly, noBidHidden);
      mlmSyncItem(bar, "dim", ownedDimEnabled, 0);
      mlmSyncItem(bar, "hide", mlmHideOwned, ownedHidden);
    }
  }

  function watchMarketplaceList() {
    GM_addStyle(`
      .wm-owned-dimmed {
        opacity: 0.05;
        transition: opacity 0.2s ease;
      }
      .wm-owned-dimmed:hover {
        opacity: 1;
      }
'''+mlm_css.rstrip('\n')+'''
    `);

    let debounceId = null;
    const scheduleUpdate = () => {
      clearTimeout(debounceId);
      debounceId = setTimeout(updateMarketplaceList, 300);
    };
    scheduleUpdate();
    new MutationObserver(scheduleUpdate).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

'''

footer='''  // Each feature is isolated: a failure in one must not prevent the other from starting
  function main() {
    const run = (name, fn) => {
      try {
        fn();
      } catch (error) {
        console.error(`[WMB-${name}]`, error);
      }
    };
    run("TMB", watchTagManagerModalWidth);
    run("MTG", watchMassTagging);
    run("MLM", watchMarketplaceList);
  }

  main();
})();
'''

# MTG's watch function: keep as is
w0=src.index("  function watchMassTagging() {")
# end of watchMassTagging = next top-level section marker after it
w1=src.index("  // ============================================================\n",w0)
watch=src[w0:w1]

out = header + "\n" + rule40 + mtg + market + footer

# Syntax check with node, when available, so that a broken extraction is never written
def node_check(code):
    try:
        done = subprocess.run(["node", "--check", "--input-type=commonjs", "-"], input=code, text=True, capture_output=True)
    except FileNotFoundError:
        return None
    return done

def main(argv):
    check = "--check" in argv
    force = "--force" in argv
    current = LIGHT.read_text(encoding="utf-8") if LIGHT.exists() else None
    if current == out and not force:
        print(f"{LIGHT.name}: up to date")
        return 0
    if check:
        print(f"{LIGHT.name}: OUT OF DATE (run python3 tools/build-light-script.py)")
        return 1
    done = node_check(out)
    if done is not None and done.returncode != 0:
        print("Generated script has a syntax error, nothing written:\n" + done.stderr, file=sys.stderr)
        return 2
    LIGHT.write_text(out, encoding="utf-8")
    print(f"{LIGHT.name}: rebuilt ({len(out.splitlines())} lines)")
    return 0

sys.exit(main(sys.argv[1:]))
