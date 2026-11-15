// ==UserScript==
// @name         Wiki-MasterBetter Étiquettes & Marché
// @namespace    http://tampermonkey.net
// @version      1.0.0
// @description  Étiquetage en masse de la collection d'après des termes de recherche, et filtres de la liste des enchères (mise de départ, cartes possédées) sur wiki-masters.com
// @author       Pierre Bellan (https://github.com/pbellan)
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
  function waitForElement(selector, timeout = 4000, interval = 100) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const el = document.querySelector(selector);
        if (el) {
          resolve(el);
          return;
        }
        if (Date.now() - start >= timeout) {
          resolve(null);
          return;
        }
        setTimeout(check, interval);
      };
      check();
    });
  }

  const NATIVE_INPUT_VALUE_SETTER = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  ).set;

  function clearCollectionSearchInput(input) {
    NATIVE_INPUT_VALUE_SETTER.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }


  // ============================================================
  // Rule 40: whenever the tag manager modal ("Gérer les étiquettes" — the one to create, rename,
  // recolor or delete tags) enters the DOM, widen it from the site's max-w-lg to 90vw so long tag names stay readable
  // and easy to edit. The modal is spotted from its h2 reading "Gérer les étiquettes": its closest
  // div.card-frame-solid gets the "wm-tag-manager-modal" class, which CSS turns into "max-width: 90vw". That class
  // doubles as the guard against re-processing it on every later mutation.
  // ============================================================
  function widenTagManagerModal() {
    document.querySelectorAll("h2").forEach((heading) => {
      if (heading.textContent.trim() !== "Gérer les étiquettes") return;

      const modal = heading.closest("div.card-frame-solid");
      if (modal && !modal.classList.contains("wm-tag-manager-modal")) {
        modal.classList.add("wm-tag-manager-modal");
      }
    });
  }

  function watchTagManagerModalWidth() {
    GM_addStyle(`
      .wm-tag-manager-modal {
        max-width: 90vw !important;
      }
    `);

    widenTagManagerModal();

    const observer = new MutationObserver(() => widenTagManagerModal());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ============================================================
  // Feature MTG: mass-tag the untagged cards of /collection from per-label search terms.
  //
  // Terms editor: every label row of the tag manager modal ("Gérer les étiquettes", Rule 40's wm-tag-manager-modal)
  // gets a text field holding that label's search terms, separated by commas ("louvre, versailles, panthéon"). They
  // are stored in localStorage under "tag-terms-{label name}" (emptying the field removes the entry). A renamed
  // label's terms follow it: when the row's name no longer matches the one its field was built for, the stored
  // value moves to the new key.
  //
  // Run: a "Étiquetage en masse 🏷️" button is appended to the filter bar of /collection (div.flex-wrap.gap-2, like
  // Feature EBC's). A small modal first lists every label that has terms, each with a checkbox (all checked) so the
  // run can be limited to some of them; "Lancer (N)" starts it. The modal is drawn like Feature EVL's "Estimations"
  // drawer: a fixed header (title, summary, "✕"), a bar of quick choices ("Tout", "Aucune", "Les N premières"), a list
  // that scrolls on its own and a fixed footer (how many labels and terms will run, "Lancer (N)"), so nothing needs
  // scrolling to reach them. Rows set the order labels are processed in (a card matching several labels gets the
  // first one): compact (drag handle, rank, checkbox, name, "N termes" whose tooltip lists the terms, ⤒ ▲ ▼ buttons)
  // and reordered by those buttons (the moved row stays in view) or by drag and drop (the list scrolls near its
  // edges); unchecked rows are dimmed. The order is saved in localStorage under
  // "tag-run-order" (a JSON array of label names; labels missing from it come last, alphabetically; a renamed label
  // keeps its place). It then sets the site's tag filter
  // (button[aria-label="Filtrer par étiquette"]) to its "Sans étiquette" entry, then for each label and each term
  //   1. types the term in the search field (native setter + "input" event, as Rule 28 does) and waits for the grid
  //      to settle (the site refreshes on every keystroke and shows a div.animate-spin while loading),
  //   2. repeats on the first page until the grid is empty: re-enters the select mode (the "Sélectionner" /
  //      "Quitter la sélection" button, which also drops any previous selection), selects the cards that carry no
  //      tag yet (same test as Feature SAT: no div.flex-wrap.shrink-0), presses the bulk bar's "Étiqueter" button
  //      (div.bottom-4) to open the "Appliquer une étiquette" modal and picks the label. Tagged cards leave the filtered grid, so there is no paging.
  // Only untagged cards are ever selected, so a card matching several labels keeps the first one it got. The run
  // aborts if the selection holds more cards than were clicked (a leftover selection would tag unrelated cards), or
  // if the grid is unchanged after tagging. Every failure is reported with what the script found instead.
  // Transfer: the tag manager modal also gets "Exporter les termes" / "Importer des termes" links under its title,
  // to save the terms and the run order to a JSON file and load them on another computer (see exportMassTagSettings).
  // The button turns into a stop button while running; the filter, search field and select mode are reset at the end.
  // A recap panel then lists, label by label, every card that was tagged as a grid of portraits with their names
  // (also shown when the run was stopped or failed, with the error on top). It is docked on the right and leaves the
  // page usable, so several cards can be reviewed in a row: clicking a portrait types the card's name in the search
  // field, which brings the card up in the grid to be re-tagged. Only its "✕" closes it. Same frame as the picker:
  // its header ("✕", summary) and the error line stay fixed, the portraits scroll, and each label's heading (with
  // its card count) sticks to the top while its grid scrolls.
  // Same as Feature EBC, keep the tab active during the run: background tabs get their timers throttled.
  // The site sometimes renders inconsistently, so massTagRetry runs a failed step (tag filter, typing a term, one
  // select-and-tag pass) a second time after closing any open modal and letting the page settle; only the second
  // error ends the run. Stopping the run skips the retry.
  // ============================================================
  const MASS_TAG_TERMS_PREFIX = "tag-terms-";
  const MASS_TAG_ORDER_KEY = "tag-run-order";
  const MASS_TAG_BUTTON_LABEL = "Étiquetage en masse 🏷️";
  const massTagState = { running: false, stop: false };

  function parseMassTagTerms(raw) {
    return (raw ?? "")
      .split(",")
      .map((term) => term.trim())
      .filter(Boolean);
  }

  function getTagManagerRowName(row) {
    return (
      row.querySelector("span.truncate.font-semibold")?.textContent.trim() ||
      null
    );
  }

  // Export / import of the terms and the run order, to carry them to another computer (same account: the labels
  // exist there too). Exported as a JSON file { version, order, terms: { label: "t1, t2" } }; importing replaces the
  // terms of the labels in the file (other labels are left alone) and takes its order for them.
  function exportMassTagSettings() {
    const terms = {};
    readMassTagEntries().forEach(({ name }) => {
      terms[name] = localStorage.getItem(MASS_TAG_TERMS_PREFIX + name);
    });
    const data = {
      version: 1,
      order: readMassTagEntries().map(({ name }) => name),
      terms,
    };

    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    link.download = "wmb-etiquetage-en-masse.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // Returns the number of labels imported; throws on a file that isn't an export
  function importMassTagSettings(text) {
    const data = JSON.parse(text);
    if (!data || typeof data.terms !== "object" || data.terms === null)
      throw new Error("format inconnu");

    let count = 0;
    Object.entries(data.terms).forEach(([name, value]) => {
      if (typeof value !== "string") return;

      if (value.trim()) {
        localStorage.setItem(MASS_TAG_TERMS_PREFIX + name, value);
        count++;
      }
    });
    if (Array.isArray(data.order)) {
      const imported = data.order.filter((name) => typeof name === "string");
      writeMassTagOrder([
        ...imported,
        ...readMassTagOrder().filter((name) => !imported.includes(name)),
      ]);
    }

    // Refresh the fields already built for the rows of the open modal
    document.querySelectorAll(".wm-mass-tag-terms").forEach((input) => {
      input.value =
        localStorage.getItem(MASS_TAG_TERMS_PREFIX + input.dataset.wmTagName) ??
        "";
    });
    return count;
  }

  function insertMassTagIoBar() {
    document.querySelectorAll(".wm-tag-manager-modal h2").forEach((heading) => {
      const modal = heading.closest(".wm-tag-manager-modal");
      if (modal.querySelector(".wm-mass-tag-io")) return;

      const bar = document.createElement("div");
      bar.className = "wm-mass-tag-io";

      const makeButton = (text, title, onClick) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = text;
        btn.title = title;
        btn.addEventListener("click", onClick);
        return btn;
      };

      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "application/json,.json";
      fileInput.hidden = true;
      fileInput.addEventListener("change", async () => {
        const file = fileInput.files[0];
        fileInput.value = "";
        if (!file) return;

        try {
          const count = importMassTagSettings(await file.text());
          window.alert(`${count} étiquette${count > 1 ? "s" : ""} importée${count > 1 ? "s" : ""}.`);
        } catch (error) {
          window.alert(`Import impossible : ${error.message}`);
        }
      });

      bar.append(
        makeButton(
          "⬇ Exporter les termes",
          "Enregistre les termes et l'ordre de traitement dans un fichier, pour les importer sur un autre ordinateur",
          () => {
            if (!readMassTagEntries().length) {
              window.alert("Aucun terme à exporter.");
              return;
            }
            exportMassTagSettings();
          },
        ),
        makeButton(
          "⬆ Importer des termes",
          "Charge un fichier exporté : remplace les termes des étiquettes qu'il contient",
          () => fileInput.click(),
        ),
        fileInput,
      );
      heading.insertAdjacentElement("afterend", bar);
    });
  }

  function insertMassTagTermsInputs() {
    insertMassTagIoBar();
    document
      .querySelectorAll(".wm-tag-manager-modal div.rounded-xl.border")
      .forEach((row) => {
        const name = getTagManagerRowName(row);
        if (!name) return; // the row is being renamed: its name field replaced the label

        const existing = row.querySelector(":scope > .wm-mass-tag-terms");
        if (existing) {
          const previousName = existing.dataset.wmTagName;
          if (previousName && previousName !== name) {
            const moved = localStorage.getItem(
              MASS_TAG_TERMS_PREFIX + previousName,
            );
            if (moved !== null) {
              localStorage.setItem(MASS_TAG_TERMS_PREFIX + name, moved);
              localStorage.removeItem(MASS_TAG_TERMS_PREFIX + previousName);
            }
            writeMassTagOrder(
              readMassTagOrder().map((entry) =>
                entry === previousName ? name : entry,
              ),
            );
            existing.dataset.wmTagName = name;
          }
          return;
        }

        const input = document.createElement("input");
        input.type = "text";
        input.className = "wm-mass-tag-terms";
        input.placeholder =
          "Termes de recherche pour l'étiquetage en masse, séparés par des virgules";
        input.dataset.wmTagName = name;
        input.value = localStorage.getItem(MASS_TAG_TERMS_PREFIX + name) ?? "";

        input.addEventListener("input", () => {
          const key = MASS_TAG_TERMS_PREFIX + input.dataset.wmTagName;
          if (input.value.trim()) localStorage.setItem(key, input.value);
          else localStorage.removeItem(key);
        });

        row.appendChild(input);
      });
  }

  function readMassTagEntries() {
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(MASS_TAG_TERMS_PREFIX)) continue;

      const terms = parseMassTagTerms(localStorage.getItem(key));
      if (terms.length) {
        entries.push({ name: key.slice(MASS_TAG_TERMS_PREFIX.length), terms });
      }
    }
    // Saved run order first; labels it doesn't know yet (new, or never reordered) follow alphabetically
    const order = readMassTagOrder();
    const rank = (name) => {
      const index = order.indexOf(name);
      return index === -1 ? order.length : index;
    };
    return entries.sort(
      (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name),
    );
  }

  function readMassTagOrder() {
    try {
      const order = JSON.parse(localStorage.getItem(MASS_TAG_ORDER_KEY) ?? "[]");
      return Array.isArray(order) ? order : [];
    } catch {
      return [];
    }
  }

  function writeMassTagOrder(names) {
    localStorage.setItem(MASS_TAG_ORDER_KEY, JSON.stringify(names));
  }

  const massTagSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function massTagWaitUntil(condition, timeout = 8000, interval = 100) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (condition()) return true;
      await massTagSleep(interval);
    }
    return condition();
  }

  async function massTagWaitForIdle() {
    await massTagSleep(500);
    await massTagWaitUntil(
      () => !document.querySelector("div.animate-spin"),
      15000,
    );
    await massTagSleep(200);
  }

  function findButtonByText(predicate, root = document) {
    return Array.from(root.querySelectorAll("button")).find((btn) =>
      predicate(btn.textContent.trim()),
    );
  }

  const normalizeButtonText = (text) => text.replace(/\s+/g, " ").trim();
  const isSelectButton = (text) =>
    /^s[ée]lectionner$/i.test(normalizeButtonText(text));
  const isQuitSelectButton = (text) =>
    /^quitter la s[ée]lection$/i.test(normalizeButtonText(text));

  // Returns an error message, or null once the select mode has been (re-)entered
  // The site sometimes renders neither toggle for a while (loading, re-render), so each attempt waits for one of
  // them, then the whole thing is retried after the page settles. Still in select mode after the attempts: carry on
  // (the selection check in massTagSelectUntaggedCards guards against a leftover selection).
  async function massTagResetSelectMode() {
    for (let attempt = 0; attempt < 4; attempt++) {
      findButtonByText(isQuitSelectButton)?.click();
      await massTagSleep(250);

      let enter = null;
      await massTagWaitUntil(() => {
        enter = findButtonByText(isSelectButton);
        return !!enter;
      }, 3000);
      if (enter) {
        enter.click();
        massTagLog("select mode entered");
        await massTagSleep(250);
        return null;
      }

      massTagLog(`« Sélectionner » missing (attempt ${attempt + 1})`);
      await massTagWaitForIdle();
    }

    if (findButtonByText(isQuitSelectButton)) return null;

    const main = document.querySelector("main") ?? document;
    return `bouton « Sélectionner » introuvable (boutons : ${describeButtons(main).slice(0, 600)})`;
  }

  function countSelectedCards() {
    return document.querySelectorAll("div.relative.isolate div.ring-4").length;
  }

  // Cards already selected (select mode kept after a failed reset) are left alone: clicking them would deselect.
  // "targets" is how many untagged cards the grid holds; "selected" how many cards are selected afterwards.
  // "cards" lists ({ name, image }) the untagged cards that ended up selected (what the bulk action is about to tag).
  async function massTagSelectUntaggedCards() {
    const untagged = Array.from(
      document.querySelectorAll("div.hover\\:scale-105"),
    ).filter((card) => !card.querySelector("div.flex-wrap.shrink-0"));
    const isSelected = (card) =>
      !!card.closest("div.relative.isolate")?.querySelector("div.ring-4");

    untagged.forEach((card) => {
      if (isSelected(card)) return;

      card.querySelector("img.scale-\\[1\\.8\\]")?.click();
    });
    await massTagSleep(300);

    // The card's portrait is the image inside its top block (the other image is the rarity background)
    const cards = untagged.filter(isSelected).map((card) => ({
      name: card.querySelector("h3")?.textContent.trim() ?? "?",
      image: card.querySelector("div.h-\\[45\\%\\] img")?.src ?? null,
    }));
    return { targets: untagged.length, selected: countSelectedCards(), cards };
  }

  const describeButtons = (root) =>
    Array.from(root.querySelectorAll("button"))
      .map((btn) => `« ${btn.textContent.trim().slice(0, 40)} »`)
      .join(", ") || "aucun";

  // Returns an error message (listing what was found, to ease diagnosing a site change), or null on success
  // Console trace of the run (SVGs stripped from the HTML dumps), to diagnose a change in the site's markup
  function massTagLog(step, element) {
    const html = element?.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, "<svg/>");
    console.log(`[WMB-MTG] ${step}`, html ?? "");
  }

  async function massTagApplyLabel(name) {
    const popover = await waitForElement("div.bottom-4", 4000);
    massTagLog("bulk bar (div.bottom-4)", popover);
    if (!popover) return "barre d'actions en masse (div.bottom-4) introuvable";

    const openBtn = findButtonByText(
      (text) => /^étiqueter$/i.test(normalizeButtonText(text)),
      popover,
    );
    if (!openBtn)
      return `bouton d'étiquetage introuvable dans la barre (boutons : ${describeButtons(popover)})`;
    massTagLog(`clicking « ${openBtn.textContent.trim()} »`);
    openBtn.click();

    const list = await waitForElement(".wm-multi-tag-list, div.max-h-64", 4000);
    massTagLog("tag list", list?.closest("div.fixed") ?? list);
    if (!list)
      return `liste des étiquettes introuvable après clic sur « ${openBtn.textContent.trim()} »`;

    const tagBtn = Array.from(list.querySelectorAll(":scope > button")).find(
      (btn) => {
        const text = btn.textContent.trim();
        return (
          text === name ||
          (text.startsWith(name) &&
            /^\s*\(?\d+\)?\s*$/.test(text.slice(name.length)))
        );
      },
    );
    if (!tagBtn) {
      const found = describeButtons(list);
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await massTagSleep(300);
      return `étiquette « ${name} » introuvable dans la modale (trouvées : ${found})`;
    }

    massTagLog(`clicking tag « ${tagBtn.textContent.trim()} »`);
    tagBtn.click();
    const closed = await massTagWaitUntil(() => !list.isConnected, 8000);
    massTagLog(`modal closed: ${closed}`);
    await massTagWaitForIdle();
    return null;
  }

  // Picks an entry of the tag filter's listbox (button[aria-label="Filtrer par étiquette"]) whose text matches
  // the predicate; returns an error message, or null on success
  async function massTagPickTagFilter(predicate) {
    const trigger = document.querySelector(
      'button[aria-label="Filtrer par étiquette"]',
    );
    if (!trigger) return "filtre d'étiquette introuvable";

    trigger.click();
    const listbox = await waitForElement('ul[role="listbox"]', 3000);
    if (!listbox) return "liste du filtre d'étiquette introuvable";

    const option = Array.from(listbox.querySelectorAll("li button")).find(
      (btn) => predicate(btn.textContent.trim()),
    );
    if (!option) {
      const found = describeButtons(listbox);
      trigger.click();
      return `option du filtre d'étiquette introuvable (options : ${found})`;
    }

    option.click();
    await massTagWaitForIdle();
    return null;
  }

  function getGridCardNames() {
    return Array.from(document.querySelectorAll("div.hover\\:scale-105 h3"))
      .map((h3) => h3.textContent.trim())
      .join("|");
  }

  // The site sometimes renders inconsistently (a button or a list missing for a moment, a grid not refreshed), so a
  // step that fails is given a second chance before the run gives up: the page is brought back to a neutral state
  // (open modal closed, loading finished, a pause), then the same step runs once more. "step" returns an error
  // message or null; the second error, if any, is the one reported.
  async function massTagRetry(label, step) {
    const error = await step();
    if (!error || massTagState.stop) return error;

    massTagLog(`${label} : ${error} -> nouvelle tentative`);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await massTagSleep(500);
    await massTagWaitForIdle();
    await massTagSleep(1500);
    if (massTagState.stop) return error;

    const retryError = await step();
    return retryError ? `${retryError} (après une nouvelle tentative)` : null;
  }

  // Types a term in the search field and waits for the grid; returns an error message, or null
  async function massTagSearchTerm(name, term) {
    const input = document.querySelector('input[placeholder^="Rechercher"]');
    if (!input) return "champ de recherche introuvable";

    massTagLog(`searching « ${term} » for ${name}`);
    NATIVE_INPUT_VALUE_SETTER.call(input, term);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await massTagWaitForIdle();
    return null;
  }

  // One pass over the grid: selects the untagged cards and tags them. Returns { error, done }: an error message (or
  // null) and whether the term has nothing left to tag. Every card tagged is added to recap.
  async function massTagProcessRound(name, term, recap) {
    // An empty grid (no match, or everything already tagged) has no select button: this term is done
    if (!document.querySelector("div.hover\\:scale-105")) {
      massTagLog(`"${term}": grid empty, done`);
      return { error: null, done: true };
    }

    const selectModeError = await massTagResetSelectMode();
    if (selectModeError) return { error: selectModeError, done: false };

    const namesBefore = getGridCardNames();
    const { targets, selected, cards } = await massTagSelectUntaggedCards();
    massTagLog(`"${term}" -> ${name}: ${targets} untagged, ${selected} selected`);
    if (targets === 0) return { error: null, done: true };
    if (selected > targets)
      return {
        error: "sélection résiduelle détectée, arrêt par sécurité",
        done: false,
      };

    const error = await massTagApplyLabel(name);
    if (error) return { error, done: false };

    if (!recap.has(name)) recap.set(name, new Map());
    cards.forEach(({ name: cardName, image }) =>
      recap.get(name).set(cardName, image),
    );

    if (getGridCardNames() === namesBefore)
      return {
        error:
          "les cartes étiquetées sont restées dans la grille, arrêt par sécurité",
        done: false,
      };
    return { error: null, done: false };
  }

  // Returns an error message, or null when the term was fully processed (or the run was stopped).
  async function massTagProcessTerm(name, term, recap) {
    const searchError = await massTagRetry(`${name} / « ${term} » (recherche)`, () =>
      massTagSearchTerm(name, term),
    );
    if (searchError) return searchError;

    // The "Sans étiquette" filter is on: every card tagged below leaves the grid, so the run stays on the first page
    // until it is empty (no cards left to select) rather than paging forward
    for (let round = 0; round < 1000 && !massTagState.stop; round++) {
      let done = false;
      const error = await massTagRetry(`${name} / « ${term} »`, async () => {
        const result = await massTagProcessRound(name, term, recap);
        done = result.done;
        return result.error;
      });
      if (error) return error;
      if (done) break;
    }
    return null;
  }

  async function runMassTagging(btn) {
    const available = readMassTagEntries();
    if (!available.length) {
      window.alert(
        "Aucun terme défini. Ajoutez-en dans « Gérer les étiquettes » (champ sous chaque étiquette).",
      );
      return;
    }

    const entries = await pickMassTagEntries(available);
    if (!entries?.length) return;

    massTagLog(`run started: ${entries.map(({ name }) => name).join(", ")}`);
    massTagState.running = true;
    massTagState.stop = false;
    btn.textContent = "⏹ Arrêter l'étiquetage";

    const recap = new Map();
    let error = await massTagRetry("filtre « Sans étiquette »", () =>
      massTagPickTagFilter((text) => /^sans\s/i.test(text)),
    );
    if (!error) {
      outer: for (const { name, terms } of entries) {
        for (const term of terms) {
          if (massTagState.stop) break outer;

          btn.title = `${name} : « ${term} »`;
          error = await massTagProcessTerm(name, term, recap);
          if (error) break outer;
        }
      }
      await massTagPickTagFilter((text) => /^toutes/i.test(text));
    }

    const input = document.querySelector('input[placeholder^="Rechercher"]');
    if (input) clearCollectionSearchInput(input);
    await massTagWaitForIdle();
    findButtonByText(isQuitSelectButton)?.click();

    massTagState.running = false;
    btn.textContent = MASS_TAG_BUTTON_LABEL;
    btn.title = "";
    showMassTagRecap(recap, error);
  }

  // Modal shell shared by the run's picker and recap: closed by its "✕", a click outside it, or Escape (caught
  // before the site's own Escape handling, Feature CME). onClose runs whichever way it closed.
  // A docked modal is a side panel that leaves the page behind interactive: only its "✕" closes it (Escape is left
  // to the site, and there is no click-outside).
  // Shared frame of the picker and the recap, drawn like the "Estimations" drawer (Feature EVL): a fixed header
  // (title, summary, icon buttons), then a body that scrolls on its own, so the close button and the actions
  // never leave the screen. Callers add their own bar between the header and the body, or a footer after it.
  function createMassTagModal(title, onClose = () => {}, docked = false) {
    document.querySelector(".wm-mass-tag-recap")?.remove();

    const overlay = document.createElement("div");
    overlay.className = docked
      ? "wm-mass-tag-recap wm-mass-tag-docked"
      : "wm-mass-tag-recap";

    const panel = document.createElement("div");
    panel.className = "wm-mass-tag-recap-panel";

    const close = () => {
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      onClose();
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    if (!docked) {
      document.addEventListener("keydown", onKeyDown, true);
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) close();
      });
    }

    const header = document.createElement("div");
    header.className = "wm-mass-tag-header";

    const titleBlock = document.createElement("div");
    const heading = document.createElement("h2");
    heading.className = "wm-mass-tag-title";
    heading.textContent = title;
    const summary = document.createElement("p");
    summary.className = "wm-mass-tag-summary";
    titleBlock.append(heading, summary);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "wm-mass-tag-icon-btn";
    closeBtn.textContent = "✕";
    closeBtn.title = "Fermer";
    closeBtn.addEventListener("click", close);

    header.append(titleBlock, closeBtn);

    const body = document.createElement("div");
    body.className = "wm-mass-tag-body";

    panel.append(header, body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    return {
      panel,
      body,
      close,
      setSummary: (text) => {
        summary.textContent = text;
      },
    };
  }

  // Lists every label with terms, each with a checkbox (all checked); resolves with the checked entries, or null
  // when cancelled
  function pickMassTagEntries(entries) {
    return new Promise((resolve) => {
      let result = null;
      const { panel, body, close, setSummary } = createMassTagModal(
        "Étiquetage en masse",
        () => resolve(result),
      );

      // Checked state travels with its entry when the rows are reordered
      const items = entries.map((entry) => ({ entry, checked: true }));
      const rows = document.createElement("div");
      rows.className = "wm-mass-tag-rows";

      const hint = document.createElement("p");
      hint.className = "wm-mass-tag-picker-hint";
      hint.textContent =
        "Seules les cartes sans étiquette sont étiquetées : une carte qui correspond à plusieurs étiquettes reçoit la première de la liste. Réordonnez avec ▲ ▼ ou par glisser-déposer (l'ordre est mémorisé) ; survolez « N termes » pour voir les termes.";

      // Bar under the header: the quick ways of choosing what runs, always in view
      const toolbar = document.createElement("div");
      toolbar.className = "wm-mass-tag-toolbar";

      const makeChip = (label, title, onClick) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "wm-mass-tag-chip";
        chip.textContent = label;
        chip.title = title;
        chip.addEventListener("click", onClick);
        return chip;
      };
      const setChecked = (predicate) => {
        items.forEach((item, index) => (item.checked = predicate(index)));
        render();
      };

      const firstInput = document.createElement("input");
      firstInput.type = "number";
      firstInput.min = "1";
      firstInput.max = String(items.length);
      firstInput.value = String(Math.min(5, items.length));
      firstInput.className = "wm-mass-tag-first";
      firstInput.title = "Nombre d'étiquettes à garder, en partant du haut de la liste";
      const applyFirst = () => {
        const count = Math.max(0, parseInt(firstInput.value, 10) || 0);
        setChecked((index) => index < count);
      };
      firstInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") applyFirst();
      });

      toolbar.append(
        makeChip("Tout", "Cocher toutes les étiquettes", () => setChecked(() => true)),
        makeChip("Aucune", "Décocher toutes les étiquettes", () => setChecked(() => false)),
        makeChip("Les", "Ne cocher que les premières étiquettes de la liste", applyFirst),
        firstInput,
        makeChip("premières", "Ne cocher que les premières étiquettes de la liste", applyFirst),
      );

      const footer = document.createElement("div");
      footer.className = "wm-mass-tag-footer";
      const footerInfo = document.createElement("span");
      footerInfo.className = "wm-mass-tag-summary";
      const startBtn = document.createElement("button");
      startBtn.type = "button";
      startBtn.className = "wm-mass-tag-go";
      footer.append(footerInfo, startBtn);

      body.append(hint, rows);
      panel.insertBefore(toolbar, body);
      panel.appendChild(footer);

      // Moves an item to a given position and keeps it in view
      const moveTo = (item, position, focusKind) => {
        const from = items.indexOf(item);
        const to = Math.min(Math.max(position, 0), items.length - 1);
        if (from === to) return;

        items.splice(from, 1);
        items.splice(to, 0, item);
        writeMassTagOrder(items.map(({ entry }) => entry.name));
        render(item, focusKind);
      };

      // Moves the dragged item before (or after) the one it was dropped on
      let dragged = null;
      const drop = (target, after) => {
        if (!dragged || dragged === target) return;

        const moved = dragged;
        items.splice(items.indexOf(moved), 1);
        items.splice(items.indexOf(target) + (after ? 1 : 0), 0, moved);
        writeMassTagOrder(items.map(({ entry }) => entry.name));
        render(moved);
      };
      const clearDropMarks = () =>
        rows
          .querySelectorAll(".wm-drop-before, .wm-drop-after")
          .forEach((el) => el.classList.remove("wm-drop-before", "wm-drop-after"));
      const isAfter = (event, row) => {
        const rect = row.getBoundingClientRect();
        return event.clientY > rect.top + rect.height / 2;
      };

      // The browser does not scroll a list by itself while a row is dragged: do it near the edges
      body.addEventListener("dragover", (event) => {
        if (!dragged) return;

        const rect = body.getBoundingClientRect();
        const edge = 48;
        if (event.clientY < rect.top + edge) body.scrollTop -= 14;
        else if (event.clientY > rect.bottom - edge) body.scrollTop += 14;
      });

      const render = (focusItem = null, focusKind = null) => {
        rows.replaceChildren();
        items.forEach((item, index) => {
          const row = document.createElement("div");
          row.className = "wm-mass-tag-picker-row";
          row.classList.toggle("wm-mass-tag-off", !item.checked);
          row.draggable = true;

          row.addEventListener("dragstart", (event) => {
            dragged = item;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", item.entry.name);
            row.classList.add("wm-dragging");
          });
          row.addEventListener("dragend", () => {
            dragged = null;
            row.classList.remove("wm-dragging");
            clearDropMarks();
          });
          row.addEventListener("dragover", (event) => {
            if (!dragged) return;

            event.preventDefault();
            clearDropMarks();
            row.classList.add(isAfter(event, row) ? "wm-drop-after" : "wm-drop-before");
          });
          row.addEventListener("drop", (event) => {
            event.preventDefault();
            drop(item, isAfter(event, row));
          });

          const handle = document.createElement("span");
          handle.className = "wm-mass-tag-picker-handle";
          handle.textContent = "⠿";
          handle.title = "Glisser pour réordonner : une carte reçoit la première étiquette de la liste";

          const rank = document.createElement("span");
          rank.className = "wm-mass-tag-picker-rank";
          rank.textContent = index + 1;

          const label = document.createElement("label");
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = item.checked;
          checkbox.addEventListener("change", () => {
            item.checked = checkbox.checked;
            row.classList.toggle("wm-mass-tag-off", !item.checked);
            refresh();
          });
          const nameEl = document.createElement("strong");
          nameEl.textContent = item.entry.name;
          label.append(checkbox, nameEl);

          const count = document.createElement("span");
          count.className = "wm-mass-tag-picker-count";
          count.textContent = `${item.entry.terms.length} terme${item.entry.terms.length > 1 ? "s" : ""}`;
          count.title = item.entry.terms.join("\n");

          const makeMove = (kind, text, title, position) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "wm-mass-tag-icon-btn";
            button.dataset.move = kind;
            button.textContent = text;
            button.title = title;
            button.disabled = index === position;
            button.addEventListener("click", () => {
              const target =
                kind === "up" ? index - 1 : kind === "down" ? index + 1 : position;
              moveTo(item, target, kind);
            });
            return button;
          };
          const top = makeMove("top", "⤒", "Mettre en premier", 0);
          const up = makeMove("up", "▲", "Monter d'un rang", 0);
          const down = makeMove("down", "▼", "Descendre d'un rang", items.length - 1);

          row.append(handle, rank, label, count, top, up, down);
          rows.appendChild(row);

          if (item === focusItem) {
            // The row moved: bring it back under the pointer and keep the same button ready for the next click
            row.scrollIntoView({ block: "nearest" });
            const again = row.querySelector(`[data-move="${focusKind}"]:not(:disabled)`);
            again?.focus({ preventScroll: true });
          }
        });
        refresh();
      };

      const refresh = () => {
        const checked = items.filter(({ checked }) => checked);
        const terms = checked.reduce((sum, { entry }) => sum + entry.terms.length, 0);
        startBtn.disabled = checked.length === 0;
        startBtn.textContent = `Lancer (${checked.length})`;
        setSummary(
          `${items.length} étiquette${items.length > 1 ? "s" : ""} avec des termes, dans l'ordre de traitement`,
        );
        footerInfo.textContent = `${checked.length} sur ${items.length} étiquette${items.length > 1 ? "s" : ""} · ${terms} terme${terms > 1 ? "s" : ""}`;
      };

      startBtn.addEventListener("click", () => {
        result = items.filter(({ checked }) => checked).map(({ entry }) => entry);
        close();
      });

      render();
    });
  }

  function showMassTagRecap(recap, error) {
    const total = Array.from(recap.values()).reduce(
      (sum, cards) => sum + cards.size,
      0,
    );
    const { panel, body, setSummary } = createMassTagModal(
      "Étiquetage en masse",
      undefined,
      true,
    );
    setSummary(
      `${total} carte${total > 1 ? "s" : ""} étiquetée${total > 1 ? "s" : ""}, dans ${recap.size} étiquette${recap.size > 1 ? "s" : ""}`,
    );

    // Fixed under the header, so it stays in view however far the list is scrolled
    if (error) {
      const errorEl = document.createElement("p");
      errorEl.className = "wm-mass-tag-recap-error";
      errorEl.textContent = `Étiquetage interrompu : ${error}`;
      panel.insertBefore(errorEl, body);
    }

    const hint = document.createElement("p");
    hint.className = "wm-mass-tag-picker-hint";
    hint.textContent =
      "Cliquez sur une carte pour la chercher dans la collection et la reclasser.";
    body.appendChild(hint);

    recap.forEach((cards, name) => {
      const heading = document.createElement("h3");
      heading.className = "wm-mass-tag-section";
      const headingName = document.createElement("span");
      headingName.textContent = name;
      const headingCount = document.createElement("span");
      headingCount.className = "wm-mass-tag-section-count";
      headingCount.textContent = String(cards.size);
      heading.append(headingName, headingCount);
      const grid = document.createElement("div");
      grid.className = "wm-mass-tag-recap-grid";
      Array.from(cards)
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([cardName, image]) => {
          const tile = document.createElement("figure");
          tile.title = `${cardName} : cliquer pour la chercher dans la collection`;
          tile.addEventListener("click", () => {
            const input = document.querySelector(
              'input[placeholder^="Rechercher"]',
            );
            if (!input) return;

            NATIVE_INPUT_VALUE_SETTER.call(input, cardName);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            panel
              .querySelectorAll("figure.wm-mass-tag-recap-current")
              .forEach((other) =>
                other.classList.remove("wm-mass-tag-recap-current"),
              );
            tile.classList.add("wm-mass-tag-recap-current");
          });
          if (image) {
            const img = document.createElement("img");
            img.src = image;
            img.alt = cardName;
            img.loading = "lazy";
            tile.appendChild(img);
          }
          const caption = document.createElement("figcaption");
          caption.textContent = cardName;
          tile.appendChild(caption);
          grid.appendChild(tile);
        });
      body.append(heading, grid);
    });
  }

  function insertMassTagButton() {
    if (!window.location.pathname.startsWith("/collection")) return;

    const filterBar = document.querySelector("div.flex-wrap.gap-2");
    if (!filterBar || filterBar.querySelector(":scope > .wm-mass-tag-btn"))
      return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wm-mass-tag-btn";
    btn.textContent = MASS_TAG_BUTTON_LABEL;
    btn.addEventListener("click", () => {
      if (massTagState.running) {
        massTagState.stop = true;
        btn.textContent = "Arrêt en cours…";
        return;
      }
      runMassTagging(btn);
    });
    filterBar.appendChild(btn);
  }

  function watchMassTagging() {
    GM_addStyle(`
      .wm-mass-tag-terms {
        width: 100%;
        margin-top: 0.5rem;
        padding: 0.375rem 0.75rem;
        border-radius: 0.5rem;
        border: 1px solid var(--color-border);
        background: var(--color-background);
        color: var(--color-foreground);
        font-size: 0.75rem;
      }
      .wm-mass-tag-io {
        display: flex;
        gap: 0.75rem;
        margin: 0.5rem 0;
        font-size: 0.75rem;
      }
      .wm-mass-tag-io button {
        background: none;
        border: none;
        cursor: pointer;
        opacity: 0.7;
        text-decoration: underline;
        color: inherit;
      }
      .wm-mass-tag-io button:hover {
        opacity: 1;
      }
      .wm-mass-tag-btn {
        border: none;
        border-radius: 0.5rem;
        padding: 0.25rem 0.5rem;
        background: #1d4ed8;
        opacity: 0.6;
        color: #fff;
        font-size: 0.75rem;
        font-weight: 600;
        cursor: pointer;
        transition: background-color 0.2s ease, opacity 0.2s ease;
      }
      .wm-mass-tag-btn:hover {
        background: #2563eb;
        opacity: 1;
      }
      .wm-mass-tag-recap {
        position: fixed;
        inset: 0;
        z-index: 100;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.6);
      }
      .wm-mass-tag-recap-panel {
        display: flex;
        flex-direction: column;
        width: min(40rem, 92vw);
        max-height: 88vh;
        overflow: hidden;
        border-radius: 0.75rem;
        border: 1px solid var(--color-border);
        background: var(--color-surface);
        color: var(--color-foreground);
      }
      .wm-mass-tag-header {
        display: flex;
        align-items: flex-start;
        gap: 0.25rem;
        flex-shrink: 0;
        padding: 1rem 1rem 0.75rem;
        border-bottom: 1px solid var(--color-border);
      }
      .wm-mass-tag-header > :first-child {
        flex: 1;
        min-width: 0;
      }
      .wm-mass-tag-title {
        font-family: var(--font-heading);
        font-size: 1.25rem;
        font-weight: 700;
      }
      .wm-mass-tag-summary {
        font-size: 0.8rem;
        opacity: 0.5;
      }
      .wm-mass-tag-body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 0 1rem 0.75rem;
      }
      .wm-mass-tag-toolbar,
      .wm-mass-tag-footer {
        display: flex;
        flex-shrink: 0;
        align-items: center;
        gap: 0.5rem;
        padding: 0.625rem 1rem;
      }
      .wm-mass-tag-toolbar {
        flex-wrap: wrap;
        border-bottom: 1px solid var(--color-border);
      }
      /* Same look as the "Estimations" drawer's chips and icon buttons (Feature EVL), which may be disabled */
      .wm-mass-tag-chip {
        padding: 0.25rem 0.75rem;
        border: none;
        border-radius: 9999px;
        background: var(--color-surface-light);
        color: inherit;
        font-size: 0.75rem;
        font-weight: 600;
        opacity: 0.7;
        cursor: pointer;
        transition: opacity 0.2s ease;
      }
      .wm-mass-tag-chip:hover {
        opacity: 1;
      }
      .wm-mass-tag-icon-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 1.75rem;
        height: 1.75rem;
        border: none;
        border-radius: 0.375rem;
        background: transparent;
        color: inherit;
        font-size: 0.85rem;
        opacity: 0.6;
        cursor: pointer;
        transition: background-color 0.2s ease, opacity 0.2s ease;
      }
      .wm-mass-tag-icon-btn:hover:not(:disabled) {
        opacity: 1;
        background: var(--color-surface-light);
      }
      .wm-mass-tag-first {
        width: 3.5rem;
        padding: 0.2rem 0.4rem;
        border-radius: 0.5rem;
        border: 1px solid var(--color-border);
        background: var(--color-background);
        color: var(--color-foreground);
        font-size: 0.75rem;
        text-align: center;
      }
      .wm-mass-tag-footer {
        justify-content: space-between;
        border-top: 1px solid var(--color-border);
      }
      .wm-mass-tag-go {
        padding: 0.4rem 1.1rem;
        border: none;
        border-radius: 0.5rem;
        background: #1d4ed8;
        color: #fff;
        font-size: 0.85rem;
        font-weight: 600;
        cursor: pointer;
        transition: background-color 0.2s ease, opacity 0.2s ease;
      }
      .wm-mass-tag-go:hover:not(:disabled) {
        background: #2563eb;
      }
      .wm-mass-tag-go:disabled {
        cursor: default;
        opacity: 0.3;
      }
      .wm-mass-tag-docked {
        justify-content: flex-end;
        align-items: stretch;
        padding: 0;
        background: none;
        pointer-events: none;
      }
      .wm-mass-tag-docked .wm-mass-tag-recap-panel {
        width: min(28rem, 42vw);
        max-height: none;
        border-radius: 0;
        border-width: 0 0 0 1px;
        pointer-events: auto;
        box-shadow: 0 0 24px rgba(0, 0, 0, 0.5);
      }
      .wm-mass-tag-section {
        position: sticky;
        top: 0;
        z-index: 1;
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin: 0 -1rem;
        padding: 0.6rem 1rem 0.35rem;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-surface);
        font-size: 0.875rem;
        font-weight: 700;
      }
      .wm-mass-tag-section-count {
        font-size: 0.75rem;
        font-variant-numeric: tabular-nums;
        color: var(--color-accent);
      }
      .wm-mass-tag-recap-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr));
        gap: 0.5rem;
        margin-top: 0.5rem;
      }
      .wm-mass-tag-recap-grid figure {
        margin: 0;
        text-align: center;
        cursor: pointer;
        border-radius: 0.5rem;
        outline: 2px solid transparent;
      }
      .wm-mass-tag-recap-grid figure:hover,
      .wm-mass-tag-recap-grid figure.wm-mass-tag-recap-current {
        outline-color: var(--color-accent);
      }
      .wm-mass-tag-recap-grid img {
        width: 100%;
        aspect-ratio: 3 / 4;
        object-fit: cover;
        border-radius: 0.5rem;
        background: var(--color-surface-light);
      }
      .wm-mass-tag-recap-grid figcaption {
        margin-top: 0.15rem;
        font-size: 0.65rem;
        line-height: 1.2;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .wm-mass-tag-picker-hint {
        margin: 0.6rem 0 0.4rem;
        font-size: 0.75rem;
        opacity: 0.6;
      }
      .wm-mass-tag-picker-row {
        display: grid;
        grid-template-columns: 1.1rem 1.5rem minmax(0, 1fr) auto 1.75rem 1.75rem 1.75rem;
        align-items: center;
        gap: 0.4rem;
        padding: 0.3rem 0.5rem;
        border-bottom: 1px solid var(--color-border);
        border-top: 2px solid transparent;
        font-size: 0.85rem;
      }
      .wm-mass-tag-picker-row.wm-mass-tag-off {
        opacity: 0.45;
      }
      .wm-mass-tag-picker-row.wm-dragging {
        opacity: 0.3;
      }
      .wm-mass-tag-picker-row.wm-drop-before {
        border-top-color: var(--color-accent);
      }
      .wm-mass-tag-picker-row.wm-drop-after {
        border-bottom: 2px solid var(--color-accent);
      }
      .wm-mass-tag-picker-row label {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        min-width: 0;
        cursor: pointer;
      }
      .wm-mass-tag-picker-row strong {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .wm-mass-tag-picker-handle {
        cursor: grab;
        opacity: 0.5;
        user-select: none;
        font-size: 1rem;
      }
      .wm-mass-tag-picker-row:hover .wm-mass-tag-picker-handle {
        opacity: 1;
      }
      .wm-mass-tag-picker-rank {
        text-align: right;
        font-size: 0.75rem;
        font-variant-numeric: tabular-nums;
        opacity: 0.5;
      }
      .wm-mass-tag-picker-count {
        font-size: 0.7rem;
        opacity: 0.6;
        cursor: help;
        text-decoration: underline dotted;
      }
      .wm-mass-tag-picker-row .wm-mass-tag-icon-btn:disabled {
        opacity: 0.15;
        cursor: default;
      }
      .wm-mass-tag-recap-error {
        flex-shrink: 0;
        margin: 0;
        padding: 0.5rem 1rem;
        border-bottom: 1px solid var(--color-border);
        color: #f87171;
        font-size: 0.8rem;
      }
    `);

    const update = () => {
      insertMassTagTermsInputs();
      insertMassTagButton();
    };
    update();

    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ============================================================
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
  const OWNED_TAG_SELECTOR = "span.bg-emerald-600\\/90";
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
    const onList = /^\/marketplace\/?$/.test(window.location.pathname);
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
      .wm-mlm-hidden {
        display: none !important;
      }
      /* The bar sits in the page header, between the title block and the "Sélectionner" button: compact items
         (label + small switch) styled after the site's switch (pill, white knob, accent colour when on) */
      .wm-mlm-header {
        flex-wrap: wrap;
      }
      /* The title block gives way (its subtitle wraps) before the switches drop to a second line */
      .wm-mlm-header > :first-child {
        flex: 1 1 12rem;
        min-width: 0;
      }
      .wm-mlm-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: flex-end;
        gap: 0.5rem;
        min-width: 0;
        margin-left: auto;
      }
      @media (max-width: 767px) {
        .wm-mlm-bar {
          order: 3;
          flex-basis: 100%;
          justify-content: flex-start;
          margin-left: 0;
        }
      }
      .wm-mlm-item {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.375rem 0.75rem;
        border: 1px solid var(--color-border);
        border-radius: 0.5rem;
        font-size: 0.8125rem;
        line-height: 1.25rem;
        color: color-mix(in srgb, var(--color-foreground) 80%, transparent);
        cursor: pointer;
        user-select: none;
        transition: background-color 0.2s;
      }
      .wm-mlm-item:hover {
        background: var(--color-surface-light);
      }
      .wm-mlm-label {
        white-space: nowrap;
      }
      .wm-mlm-switch {
        position: relative;
        flex-shrink: 0;
        width: 2.25rem;
        height: 1.25rem;
        padding: 0;
        border: 0;
        border-radius: 999px;
        background: var(--color-border);
        cursor: pointer;
        transition: background-color 0.3s;
      }
      .wm-mlm-switch[aria-checked="true"] {
        background: var(--color-accent);
      }
      .wm-mlm-switch:focus {
        outline: none;
      }
      .wm-mlm-switch:focus-visible {
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 50%, transparent);
      }
      .wm-mlm-knob {
        position: absolute;
        top: 0.125rem;
        left: 0.125rem;
        width: 1rem;
        height: 1rem;
        border-radius: 999px;
        background: #fff;
        box-shadow: 0 1px 3px rgb(0 0 0 / 0.3);
        transition: transform 0.3s;
      }
      .wm-mlm-switch[aria-checked="true"] .wm-mlm-knob {
        transform: translateX(1rem);
      }
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

  // Each feature is isolated: a failure in one must not prevent the other from starting
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
