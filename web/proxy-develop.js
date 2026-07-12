/**
 * proxy-develop.js — Finding 10 (P4 T5)
 *
 * Pure logic for the proxy-first intake mode and "Develop Selected" command.
 * No DOM dependency — testable with node --test without a browser.
 *
 * Consumed by web/main.js:
 *   - makeIntakeMode()           → mode state machine (replaces raw localStorage flag)
 *   - selectCardsForDevelop()    → identify cards eligible for selected-only develop
 *   - buildDevelopTask()         → build pool.submit descriptor at high priority
 */

// ---------------------------------------------------------------------------
// makeIntakeMode — lightweight state machine for proxy-first vs full-develop
// ---------------------------------------------------------------------------

/**
 * Create an intake mode controller.
 *
 * @param {boolean} initialProxy  true = proxy-first (fast, camera JPEG preview)
 *                                false = full-develop (RAW decode + LookRenderer)
 * @returns {{ isProxy, isFull, toggle, set }}
 */
export function makeIntakeMode(initialProxy) {
  let _proxy = !!initialProxy;
  return {
    isProxy: () => _proxy,
    isFull:  () => !_proxy,
    toggle:  () => { _proxy = !_proxy; },
    set:     (v) => { _proxy = !!v; },
  };
}

// ---------------------------------------------------------------------------
// selectCardsForDevelop — filters to proxy-completed, selected, idle cards
// ---------------------------------------------------------------------------

/**
 * Given a list of card descriptors (plain objects with .selected and .state),
 * return the subset eligible for "Develop Selected":
 *   - selected by the user
 *   - proxy-completed (_proxyView === true)
 *   - has a file attached (_file is truthy)
 *   - not currently being processed (_taskId is null/undefined/0)
 *
 * This prevents duplicate submissions and respects selection scope (F10:
 * "Develop Selected" only develops SELECTED cards, not all cards).
 *
 * @param {Array<{selected: boolean, state: object}>} cards
 * @returns {Array<{selected: boolean, state: object}>}
 */
export function selectCardsForDevelop(cards) {
  return cards.filter(c =>
    c.selected &&
    c.state._proxyView === true &&
    c.state._file &&
    !c.state._taskId
  );
}

// ---------------------------------------------------------------------------
// buildDevelopTask — descriptor for pool.submit
// ---------------------------------------------------------------------------

/**
 * Build the task descriptor that pool.submit receives for a "Develop Selected" card.
 * Always uses 'high' priority so user-initiated develop jumps the queue ahead of
 * any background auto-processing, matching the P4 T1 scheduler contract.
 *
 * @param {{ selected: boolean, state: object }} card  Card descriptor
 * @param {object} options  Current encode options (quality, effort, lossless, look, …)
 * @returns {{ card, file, priority: 'high', options }}
 */
export function buildDevelopTask(card, options) {
  return {
    card,
    file:     card.state._file,
    priority: 'high',
    options:  { ...options },
  };
}
