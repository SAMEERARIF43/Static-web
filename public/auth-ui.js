let authMode = 'login';
let currentSession = null;
let authReady = false;
let watchlistMigration = null;
let authReturnFocus = null;

const {
  normalizeWatchProgress
} = window.AnimeHubWatchlistUtils;
const { migrateWatchlistItems } = window.AnimeHubWatchlistUtils;

let resolveAuthReady;
window.animeHubAuthReady = new Promise(resolve => {
  resolveAuthReady = resolve;
});

function getAnimeHubAuthState() {
  return { ready: authReady, session: currentSession };
}

function watchlistCacheKey(userId) {
  return `anime_hub_watchlist_${userId}`;
}

function declinedWatchlistMigrationKey(userId) {
  return `anime_hub_watchlist_migration_declined_${userId}`;
}

// The per-user watchlist cache is DERIVED data: every item in it can be
// rebuilt from the watchlist table plus the catalog endpoint. Unreadable cache
// content is therefore discarded rather than treated as a fatal error, so a
// single corrupted value cannot keep a user signed out of their watchlist or
// make an already-committed cloud write look like it failed (AH-003).
function readWatchlistCache(userId) {
  const key = watchlistCacheKey(userId);
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch (error) {
    console.warn('Could not read the saved watchlist cache; treating it as empty.', error);
    return [];
  }
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn('The saved watchlist cache is not valid JSON; discarding it.', error);
    discardWatchlistCache(key);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn('The saved watchlist cache is not an array; discarding it.');
    discardWatchlistCache(key);
    return [];
  }
  return parsed;
}

// Best-effort cleanup of unusable cache content. A storage failure here must
// not replace one error with another, so it is only logged.
function discardWatchlistCache(key) {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.warn('Could not discard the unusable watchlist cache.', error);
  }
}

function writeWatchlistCache(userId, items) {
  localStorage.setItem(watchlistCacheKey(userId), JSON.stringify(items));
}

function normalizeWatchlistItem(item) {
  const id = Number(item?.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('A watchlist item has an invalid anime ID.');
  }
  return { ...item, id, ...normalizeWatchProgress(item) };
}

async function getCloudWatchlist() {
  const session = currentSession;
  if (!session) throw new Error('A login session is required to load the cloud watchlist.');

  const { data, error } = await window.supabaseClient
    .from('watchlist')
    .select('anime_id, watch_status, current_episode, total_episodes, added_at, updated_at')
    .eq('user_id', session.user.id);
  if (error) throw error;

  const cache = readWatchlistCache(session.user.id);
  const cachedById = new Map(cache.map(item => [String(item.id), item]));
  const items = [];
  const missingIds = [];
  const rowsById = new Map();
  for (const row of data || []) {
    const id = Number(row.anime_id);
    if (!Number.isSafeInteger(id) || id < 1) continue;
    rowsById.set(String(id), row);
    const cached = cachedById.get(String(id));
    let progress;
    try {
      progress = normalizeWatchProgress({
        watchStatus: row.watch_status,
        currentEpisode: row.current_episode,
        totalEpisodes: row.total_episodes ?? cached?.totalEpisodes ?? cached?.episodes
      });
    } catch (error) {
      // One malformed row or poisoned cached total must not discard the rest of
      // the watchlist (AH-004b). The row is dropped from the cache rewrite, so a
      // later load re-fetches it from the catalog and recovers it.
      console.warn(`Ignoring watchlist row for anime ${id}: ${error.message}`);
      continue;
    }
    if (cached) items.push({ ...cached, ...progress });
    else missingIds.push(id);
  }

  // allSettled so a single unhydratable title (missing from the catalog, a bad
  // response, invalid progress) drops just that row instead of rejecting the
  // whole list (AH-004b). Order is preserved: results stay aligned with
  // missingIds, and only fulfilled rows are kept.
  const settled = await Promise.allSettled(missingIds.map(async id => {
    const response = await fetch(`/api/anime/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`Could not load anime ${id} for your cloud watchlist.`);
    const media = await response.json();
    if (!media?.id || Number(media.id) !== id) {
      throw new Error(`The catalog returned invalid details for anime ${id}.`);
    }
    const poster = media.coverImage?.extraLarge || media.coverImage?.large || '';
    const row = rowsById.get(String(id));
    return normalizeWatchlistItem({
      id,
      title: media.title?.english || media.title?.romaji || media.title?.native || `Anime ${id}`,
      poster,
      image: poster,
      rating: Number(media.averageScore || 0) / 10,
      type: media.format || 'TV',
      status: media.status || 'Unknown',
      episodes: media.episodes || 0,
      totalEpisodes: row?.total_episodes ?? media.episodes ?? null,
      currentEpisode: row?.current_episode ?? 0,
      watchStatus: row?.watch_status || 'plan_to_watch',
      genre: media.genres || [],
      genres: media.genres || []
    });
  }));

  const fetched = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') fetched.push(result.value);
    else console.warn(`Could not hydrate anime ${missingIds[index]} for your cloud watchlist: ${result.reason?.message || result.reason}`);
  });

  const merged = new Map(items.map(item => [String(item.id), item]));
  fetched.forEach(item => merged.set(String(item.id), item));
  writeWatchlistCache(session.user.id, [...merged.values()]);
  return [...items, ...fetched];
}

async function addCloudWatchlistItem(item) {
  const session = currentSession;
  if (!session) throw new Error('A login session is required to update the cloud watchlist.');
  const normalized = normalizeWatchlistItem(item);
  const { error } = await window.supabaseClient.from('watchlist').upsert(
    {
      user_id: session.user.id,
      anime_id: normalized.id,
      watch_status: normalized.watchStatus,
      current_episode: normalized.currentEpisode,
      total_episodes: normalized.totalEpisodes
    },
    { onConflict: 'user_id,anime_id', ignoreDuplicates: true }
  );
  if (error) throw error;

  const cache = readWatchlistCache(session.user.id);
  const next = cache.filter(saved => String(saved.id) !== String(normalized.id));
  next.push(normalized);
  writeWatchlistCache(session.user.id, next);
}

async function updateCloudWatchlistItem(id, changes) {
  const session = currentSession;
  if (!session) throw new Error('A login session is required to update the cloud watchlist.');
  const animeId = Number(id);
  if (!Number.isSafeInteger(animeId) || animeId < 1) {
    throw new Error('A watchlist item has an invalid anime ID.');
  }
  const normalized = normalizeWatchProgress(changes, { rejectOverflow: true });
  const { error } = await window.supabaseClient.from('watchlist')
    .update({
      watch_status: normalized.watchStatus,
      current_episode: normalized.currentEpisode,
      total_episodes: normalized.totalEpisodes
    })
    .eq('user_id', session.user.id)
    .eq('anime_id', animeId);
  if (error) throw error;

  const cache = readWatchlistCache(session.user.id);
  writeWatchlistCache(session.user.id, cache.map(item =>
    Number(item.id) === animeId ? { ...item, ...normalized } : item
  ));
  return normalized;
}

async function removeCloudWatchlistItem(id) {
  const session = currentSession;
  if (!session) throw new Error('A login session is required to update the cloud watchlist.');
  const animeId = Number(id);
  if (!Number.isSafeInteger(animeId) || animeId < 1) {
    throw new Error('A watchlist item has an invalid anime ID.');
  }

  const { error } = await window.supabaseClient.from('watchlist')
    .delete()
    .eq('user_id', session.user.id)
    .eq('anime_id', animeId);
  if (error) throw error;

  const cache = readWatchlistCache(session.user.id);
  writeWatchlistCache(session.user.id, cache.filter(item => Number(item.id) !== animeId));
}

window.getAnimeHubAuthState = getAnimeHubAuthState;
window.animeHubCloudWatchlist = {
  add: addCloudWatchlistItem,
  update: updateCloudWatchlistItem,
  list: getCloudWatchlist,
  remove: removeCloudWatchlistItem
};

async function syncLocalWatchlistToCloud(session) {
  if (watchlistMigration) return watchlistMigration;

  watchlistMigration = (async () => {
    const raw = localStorage.getItem('anime_hub_watchlist');
    if (!raw) return false;

    let localWatchlist;
    try {
      localWatchlist = JSON.parse(raw);
    } catch {
      throw new Error('The saved local watchlist is invalid; it was left unchanged.');
    }
    if (!Array.isArray(localWatchlist) || localWatchlist.length === 0) return false;
    const declinedKey = declinedWatchlistMigrationKey(session.user.id);
    if (sessionStorage.getItem(declinedKey) === 'true') return false;
    if (!confirm('We found an offline watchlist. Do you want to sync it to your account?')) {
      sessionStorage.setItem(declinedKey, 'true');
      return false;
    }

    const uniqueItems = [...new Map(
      localWatchlist.map(normalizeWatchlistItem).map(item => [String(item.id), item])
    ).values()];
    const { data: existing, error: readError } = await window.supabaseClient
      .from('watchlist')
      .select('anime_id, watch_status, current_episode, total_episodes')
      .eq('user_id', session.user.id);
    if (readError) throw readError;

    const existingIds = new Set((existing || []).map(row => String(row.anime_id)));
    const cache = readWatchlistCache(session.user.id);
    const mergedCache = new Map(cache.map(item => [String(item.id), item]));
    await migrateWatchlistItems({
      items: uniqueItems,
      existingIds,
      insert: async inserts => {
        const { error } = await window.supabaseClient.from('watchlist').upsert(
          inserts.map(item => ({
            user_id: session.user.id,
            anime_id: item.id,
            watch_status: item.watchStatus,
            current_episode: item.currentEpisode,
            total_episodes: item.totalEpisodes
          })),
          { onConflict: 'user_id,anime_id', ignoreDuplicates: true }
        );
        if (error) throw error;
      },
      verify: async () => {
        const { data, error } = await window.supabaseClient.from('watchlist')
          .select('anime_id, watch_status, current_episode, total_episodes')
          .eq('user_id', session.user.id);
        if (error) throw error;
        return data || [];
      },
      onVerified: async verified => {
        const verifiedById = new Map(verified.map(row => [String(row.anime_id), row]));
        uniqueItems.forEach(item => {
          const row = verifiedById.get(String(item.id));
          mergedCache.set(String(item.id), {
            ...item,
            ...(row ? normalizeWatchProgress({
              watchStatus: row.watch_status,
              currentEpisode: row.current_episode,
              totalEpisodes: row.total_episodes ?? item.totalEpisodes
            }) : {})
          });
        });
        writeWatchlistCache(session.user.id, [...mergedCache.values()]);
        localStorage.removeItem('anime_hub_watchlist');
      }
    });
    return true;
  })();

  try {
    return await watchlistMigration;
  } finally {
    watchlistMigration = null;
  }
}

async function handleAuthState(session) {
  currentSession = session || null;

  const isAuth = !!currentSession;
  const loginNav = document.getElementById('nav-login');
  const profileNav = document.getElementById('nav-profile');
  const logoutNav = document.getElementById('nav-logout');
  if (loginNav) loginNav.hidden = isAuth;
  if (profileNav) profileNav.hidden = !isAuth;
  if (logoutNav) logoutNav.hidden = !isAuth;

  if (isAuth) {
    const profileEmail = document.getElementById('profile-email');
    if (profileEmail) profileEmail.textContent = currentSession.user.email || '';
    const verifiedStatus = document.getElementById('profile-verified-status');
    if (verifiedStatus) {
      const confirmed = currentSession.user.email_confirmed_at;
      verifiedStatus.textContent = confirmed
        ? 'Email verified'
        : 'Email not yet verified — check your inbox';
      verifiedStatus.style.color = confirmed ? 'var(--success)' : 'var(--text-dim)';
    }
    try {
      await syncLocalWatchlistToCloud(currentSession);
    } catch (error) {
      console.error('Local watchlist migration failed; local data was retained:', error);
      window.dispatchEvent(new CustomEvent('animehub:toast', {
        detail: { message: 'Watchlist sync failed. Your local watchlist was kept.', type: 'error' }
      }));
    }
  } else {
    const pageProfile = document.getElementById('page-profile');
    if (pageProfile?.classList.contains('active') && typeof window.navigateToPage === 'function') {
      window.navigateToPage('home');
    }
  }

  window.dispatchEvent(new CustomEvent('animehub:auth-state', {
    detail: { authenticated: isAuth, userId: currentSession?.user?.id || null }
  }));
}

async function initSupabase() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('Could not load authentication configuration.');
    const config = await response.json();
    if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
      await handleAuthState(null);
      return;
    }
    if (!window.supabase?.createClient) throw new Error('Supabase authentication library did not load.');

    window.supabaseClient = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
    const { data, error } = await window.supabaseClient.auth.getSession();
    if (error) throw error;
    await handleAuthState(data.session);
    window.supabaseClient.auth.onAuthStateChange((_event, session) => {
      void handleAuthState(session);
    });
  } catch (error) {
    console.error('Auth initialization failed:', error);
    await handleAuthState(null);
  } finally {
    authReady = true;
    resolveAuthReady();
  }
}

function openAuthModal(mode) {
  authMode = mode;
  const modal = document.getElementById('auth-modal');
  const passwordWrapper = document.getElementById('auth-password-wrapper');
  const passwordField = document.getElementById('auth-password');
  const title = document.getElementById('auth-title');
  const error = document.getElementById('auth-error');
  const switchLink = document.getElementById('auth-switch-mode');

  if (modal?.hidden) authReturnFocus = document.activeElement;
  if (modal) modal.hidden = false;
  if (title) title.textContent = mode === 'login' ? 'Log In' : mode === 'signup' ? 'Sign Up' : 'Reset Password';
  if (error) error.textContent = '';
  
  const showPassword = mode !== 'reset';
  if (passwordWrapper) passwordWrapper.hidden = !showPassword;
  if (passwordField) passwordField.required = showPassword;
  if (passwordField) passwordField.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  
  if (switchLink) {
    switchLink.textContent = mode === 'login' ? 'Need an account? Sign Up' : 'Already have an account? Log In';
  }
  const forgotLink = document.getElementById('auth-forgot-link');
  if (forgotLink) forgotLink.hidden = mode === 'reset';

  const emailField = document.getElementById('auth-email');
  if (emailField) emailField.focus();
}

function closeAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.hidden = true;
  if (authReturnFocus instanceof HTMLElement && authReturnFocus.isConnected) authReturnFocus.focus();
  authReturnFocus = null;
}

async function submitAuth() {
  const errorElement = document.getElementById('auth-error');
  if (!window.supabaseClient) {
    if (errorElement) errorElement.textContent = 'Supabase is not configured.';
    return;
  }

  const email = document.getElementById('auth-email')?.value || '';
  const password = document.getElementById('auth-password')?.value || '';
  if (errorElement) errorElement.textContent = 'Loading...';
  try {
    if (authMode === 'login') {
      const { error } = await window.supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } else if (authMode === 'signup') {
      const { error } = await window.supabaseClient.auth.signUp({ email, password });
      if (error) throw error;
      if (errorElement) errorElement.textContent = 'Check your email for a verification link.';
      return;
    } else {
      const { error } = await window.supabaseClient.auth.resetPasswordForEmail(email);
      if (error) throw error;
      if (errorElement) errorElement.textContent = 'Password reset email sent. Check your inbox.';
      return;
    }
    closeAuthModal();
  } catch (error) {
    if (errorElement) errorElement.textContent = error.message || 'Authentication failed.';
  }
}

async function logOut() {
  if (!window.supabaseClient) return;
  try {
    const { error } = await window.supabaseClient.auth.signOut();
    if (error) throw error;
    await handleAuthState(null);
  } catch (error) {
    console.error('Logout failed:', error);
    alert('Logout failed. Please try again.');
  }
}

async function deleteAccount() {
  if (!confirm('Are you sure you want to permanently delete your account and its cloud data? This cannot be undone.')) return;
  if (!window.supabaseClient) {
    alert('Account deletion is unavailable because authentication is not configured.');
    return;
  }

  let session;
  try {
    const result = await window.supabaseClient.auth.getSession();
    if (result.error) throw result.error;
    session = result.data.session;
  } catch (error) {
    console.error('Could not verify the current login session:', error);
  }
  if (!session?.access_token) {
    alert('Please sign in again before deleting your account.');
    return;
  }

  const deleteButton = document.getElementById('profile-delete-btn');
  if (deleteButton) deleteButton.disabled = true;
  try {
    const response = await fetch('/api/account', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.message || 'Account deletion could not be completed. Your account has not been deleted.');
    }
  } catch (error) {
    console.error('Account deletion failed:', error);
    const failureMsg = error.message && error.message.includes('deleted')
      ? error.message
      : 'Account deletion could not be completed. Your account has not been deleted. Please try again later.';
    alert(failureMsg);
    if (deleteButton) deleteButton.disabled = false;
    return;
  }

  try {
    localStorage.removeItem('anime_hub_watchlist');
    localStorage.removeItem(watchlistCacheKey(session.user.id));
  } catch (error) {
    console.error('Could not clear all local watchlist data after account deletion:', error);
  }
  try {
    const { error: signOutError } = await window.supabaseClient.auth.signOut({ scope: 'local' });
    if (signOutError) console.error('Could not clear the local Supabase session after account deletion:', signOutError);
  } catch (error) {
    console.error('Could not clear the local Supabase session after account deletion:', error);
  }
  await handleAuthState(null);
  if (
    document.getElementById('page-profile')?.classList.contains('active') &&
    typeof window.navigateToPage === 'function'
  ) {
    window.navigateToPage('home');
  }
  alert('Your account and associated cloud records have been deleted.');
  if (deleteButton) deleteButton.disabled = false;
}

window.openAuthModal = openAuthModal;
window.closeAuthModal = closeAuthModal;
window.submitAuth = submitAuth;
window.logOut = logOut;
window.deleteAccount = deleteAccount;

document.getElementById('nav-login')?.addEventListener('click', event => {
  event.preventDefault();
  openAuthModal('login');
});
document.getElementById('nav-logout')?.addEventListener('click', event => {
  event.preventDefault();
  void logOut();
});
document.getElementById('profile-delete-btn')?.addEventListener('click', () => {
  void deleteAccount();
});
document.getElementById('auth-form')?.addEventListener('submit', event => {
  event.preventDefault();
  void submitAuth();
});
document.getElementById('auth-cancel-btn')?.addEventListener('click', closeAuthModal);
document.getElementById('auth-switch-mode')?.addEventListener('click', event => {
  event.preventDefault();
  openAuthModal(authMode === 'login' ? 'signup' : 'login');
});
document.getElementById('auth-forgot-link')?.addEventListener('click', event => {
  event.preventDefault();
  openAuthModal('reset');
});
document.getElementById('auth-modal')?.addEventListener('click', event => {
  if (event.target === event.currentTarget) closeAuthModal();
});
document.addEventListener('keydown', event => {
  const modal = document.getElementById('auth-modal');
  if (modal?.hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeAuthModal();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = [...modal.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled)')]
    .filter(element => !element.hidden);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

void initSupabase();
