(function attachWatchlistUtils(root, factory) {
  const utils = factory();
  if (typeof module === 'object' && module.exports) module.exports = utils;
  if (root) root.AnimeHubWatchlistUtils = utils;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const WATCH_STATUS_VALUES = Object.freeze([
    'watching', 'completed', 'plan_to_watch', 'on_hold', 'dropped'
  ]);

  function normalizeWatchStatus(value) {
    const status = value === undefined || value === null ? 'plan_to_watch' : String(value);
    if (!WATCH_STATUS_VALUES.includes(status)) {
      throw new RangeError('A watchlist item has an invalid watch status.');
    }
    return status;
  }

  function normalizeEpisodeValue(value, field, { allowNull = false } = {}) {
    if ((value === null || value === undefined || value === '') && allowNull) return null;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new RangeError(`A watchlist item has an invalid ${field}.`);
    }
    return number;
  }

  function normalizeWatchProgress(item, { rejectOverflow = false } = {}) {
    const totalEpisodes = normalizeEpisodeValue(
      item.totalEpisodes ?? item.episodes,
      'total episode count',
      { allowNull: true }
    );
    let currentEpisode = normalizeEpisodeValue(item.currentEpisode ?? 0, 'current episode');
    const watchStatus = normalizeWatchStatus(item.watchStatus);
    if (watchStatus === 'completed' && totalEpisodes !== null) {
      currentEpisode = totalEpisodes;
    } else if (totalEpisodes !== null && currentEpisode > totalEpisodes) {
      if (rejectOverflow) {
        throw new RangeError(`Current episode cannot exceed the known total of ${totalEpisodes}.`);
      }
      currentEpisode = totalEpisodes;
    }
    return { watchStatus, currentEpisode, totalEpisodes };
  }

  function shouldActivateCardFromTarget(target) {
    if (!target || typeof target.closest !== 'function') return true;
    return !target.closest('button, input, select, textarea, option, [data-watch-controls]');
  }

  async function updateWatchlistState({ watchlist, index, changes, hasSession, cloudUpdate, save }) {
    if (index < 0 || index >= watchlist.length) throw new Error('The title is not in your watchlist.');
    const previous = watchlist[index];
    const next = {
      ...previous,
      ...normalizeWatchProgress({ ...previous, ...changes }, { rejectOverflow: true })
    };
    if (hasSession) await cloudUpdate(next.id, next);
    watchlist[index] = next;
    save();
    return { next, previous };
  }

  async function migrateWatchlistItems({ items, existingIds, insert, verify, onVerified }) {
    const inserts = items.filter(item => !existingIds.has(String(item.id)));
    if (inserts.length) await insert(inserts);
    const verified = await verify();
    const verifiedIds = new Set(verified.map(row => String(row.anime_id)));
    if (!items.every(item => verifiedIds.has(String(item.id)))) {
      throw new Error('The cloud watchlist could not be verified; your local watchlist was kept.');
    }
    await onVerified(verified);
    return verified;
  }

  return {
    WATCH_STATUS_VALUES,
    normalizeWatchStatus,
    normalizeEpisodeValue,
    normalizeWatchProgress,
    shouldActivateCardFromTarget,
    updateWatchlistState,
    migrateWatchlistItems
  };
});
