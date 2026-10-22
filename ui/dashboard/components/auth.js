// auth.js - Handles Google OAuth2 Login & Profile state

import { emitState } from '../../shared/state.js';
import { showToast } from '../../shared/utils.js';
import { sendMessage } from '../../shared/messaging.js';

async function getBackendUrl() {
    const res = await sendMessage('GET_SETTINGS');
    return res.data?.backendUrl || 'http://localhost:8080';
}

/**
 * chrome.identity needs a real OAuth client ID in manifest.json
 */
function hasOAuthClientId() {
    const clientId = chrome.runtime.getManifest().oauth2?.client_id || '';
    return clientId.endsWith('.apps.googleusercontent.com') && !clientId.startsWith('YOUR_');
}

const googleSignInBtn = document.getElementById('googleSignInBtn');
const googleSignOutBtn = document.getElementById('googleSignOutBtn');
const userProfileUnauth = document.getElementById('userProfileUnauth');
const userProfileAuth = document.getElementById('userProfileAuth');
const userProfileName = document.getElementById('userProfileName');
const userProfileAvatar = document.getElementById('userProfileAvatar');

export async function initAuth() {
    if (!googleSignInBtn) return;

    // Check existing session
    const { sessionToken, userProfile } = await chrome.storage.local.get(['sessionToken', 'userProfile']);
    if (sessionToken && userProfile) {
        updateAuthUI(userProfile);
    }

    if (!hasOAuthClientId()) {
        googleSignInBtn.disabled = true;
        googleSignInBtn.title = 'Set oauth2.client_id in manifest.json to enable Google sign-in (see README).';
    }

    googleSignInBtn.addEventListener('click', async () => {
        if (!hasOAuthClientId()) {
            showToast('Google sign-in is not configured: set oauth2.client_id in manifest.json (see README).', 'error');
            return;
        }
        try {
            googleSignInBtn.textContent = 'Authenticating...';
            googleSignInBtn.disabled = true;

            const token = await authenticateWithGoogle();
            const { sessionToken, user } = await verifyWithBackend(token);

            await chrome.storage.local.set({ sessionToken, userProfile: user });
            updateAuthUI(user);
        } catch (error) {
            console.error('Login Failed', error);
            showToast(`Login Failed: ${error.message}`, 'error');
        } finally {
            googleSignInBtn.textContent = 'Sign In';
            googleSignInBtn.disabled = false;
        }
    });

    googleSignOutBtn.addEventListener('click', async () => {
        await chrome.storage.local.remove(['sessionToken', 'userProfile']);

        // Clear cached token securely
        chrome.identity.getAuthToken({ interactive: false }, (token) => {
            if (token) {
                chrome.identity.removeCachedAuthToken({ token }, () => { });
            }
        });

        updateAuthUI(null);
    });
}

function updateAuthUI(user) {
    if (user) {
        userProfileUnauth.style.display = 'none';
        userProfileAuth.style.display = 'flex';
        userProfileName.textContent = user.name || 'User';
        userProfileAvatar.src = user.picture || '../../icons/icon48.png';
        emitState('AUTH_STATE_CHANGED', { isAuthenticated: true, user });
    } else {
        userProfileUnauth.style.display = 'block';
        userProfileAuth.style.display = 'none';
        emitState('AUTH_STATE_CHANGED', { isAuthenticated: false, user: null });
    }
}

async function authenticateWithGoogle() {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: true }, (token) => {
            if (chrome.runtime.lastError) {
                return reject(chrome.runtime.lastError);
            }
            if (!token) {
                return reject(new Error('Failed to get auth token.'));
            }
            resolve(token);
        });
    });
}

async function verifyWithBackend(token) {
    const res = await fetch(`${await getBackendUrl()}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || 'Backend verification failed.');
    }
    return data;
}
