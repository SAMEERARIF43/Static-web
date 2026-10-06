let authMode = 'login';
let currentSession = null;
let authReady = false;
let watchlistMigration = null;
let authReturnFocus = null;

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

function readWatchlistCache(userId) {
  const raw = localStorage.getItem(watchlistCacheKey(userId));
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('The saved cloud watchlist cache is invalid.');
  return parsed;
}

function writeWatchlistCache(userId, items) {
  localStorage.setItem(watchlistCacheKey(userId), JSON.stringify(items));
}

function normalizeWatchlistItem(item) {
  const id = Number(item?.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('A watchlist item has an invalid anime ID.');
  }
  return { ...item, id };
}

async function getCloudWatchlist() {
  const session = currentSession;
  if (!session) throw new Error('A login session is required to load the cloud watchlist.');

  const { data, error } = await window.supabaseClient
    .from('watchlist')
    .select('anime_id')
    .eq('user_id', session.user.id);
  if (error) throw error;

  const cache = readWatchlistCache(session.user.id);
  const cachedById = new Map(cache.map(item => [String(item.id), item]));
  const items = [];
  const missingIds = [];
  for (const row of data || []) {
    const id = Number(row.anime_id);
    if (!Number.isSafeInteger(id) || id < 1) continue;
    const cached = cachedById.get(String(id));
    if (cached) items.push(cached);
    else missingIds.push(id);
  }

  const fetched = await Promise.all(missingIds.map(async id => {
    const response = await fetch(`/api/anime/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`Could not load anime ${id} for your cloud watchlist.`);
    const media = await response.json();
    if (!media?.id || Number(media.id) !== id) {
      throw new Error(`The catalog returned invalid details for anime ${id}.`);
    }
    const poster = media.coverImage?.extraLarge || media.coverImage?.large || '';
    return normalizeWatchlistItem({
      id,
      title: media.title?.english || media.title?.romaji || media.title?.native || `Anime ${id}`,
      poster,
      image: poster,
      rating: Number(media.averageScore || 0) / 10,
      type: media.format || 'TV',
      status: media.status || 'Unknown',
      episodes: media.episodes || 0,
      genre: media.genres || [],
      genres: media.genres || []
    });
  }));

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
    { user_id: session.user.id, anime_id: normalized.id },
    { onConflict: 'user_id,anime_id', ignoreDuplicates: true }
  );
  if (error) throw error;

  const cache = readWatchlistCache(session.user.id);
  const next = cache.filter(saved => String(saved.id) !== String(normalized.id));
  next.push(normalized);
  writeWatchlistCache(session.user.id, next);
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
      .select('anime_id')
      .eq('user_id', session.user.id);
    if (readError) throw readError;

    const existingIds = new Set((existing || []).map(row => String(row.anime_id)));
    const inserts = uniqueItems
      .filter(item => !existingIds.has(String(item.id)))
      .map(item => ({ user_id: session.user.id, anime_id: item.id }));
    if (inserts.length) {
      const { error } = await window.supabaseClient.from('watchlist').upsert(inserts, {
        onConflict: 'user_id,anime_id',
        ignoreDuplicates: true
      });
      if (error) throw error;
    }

    const { data: verified, error: verifyError } = await window.supabaseClient
      .from('watchlist')
      .select('anime_id')
      .eq('user_id', session.user.id);
    if (verifyError) throw verifyError;
    const verifiedIds = new Set((verified || []).map(row => String(row.anime_id)));
    if (!uniqueItems.every(item => verifiedIds.has(String(item.id)))) {
      throw new Error('The cloud watchlist could not be verified; your local watchlist was kept.');
    }

    const cache = readWatchlistCache(session.user.id);
    const mergedCache = new Map(cache.map(item => [String(item.id), item]));
    uniqueItems.forEach(item => mergedCache.set(String(item.id), item));
    writeWatchlistCache(session.user.id, [...mergedCache.values()]);
    localStorage.removeItem('anime_hub_watchlist');
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
