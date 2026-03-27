// auth.js - Handles Google OAuth2 Login & Profile state

import { emitState, subscribeState } from '../../shared/state.js';

const BACKEND_URL = 'http://localhost:8080'; // Would be derived from config/env in production

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

    googleSignInBtn.addEventListener('click', async () => {
        try {
            googleSignInBtn.textContent = 'Authenticating...';
            googleSignInBtn.disabled = true;

            const token = await authenticateWithGoogle();
            const { sessionToken, user } = await verifyWithBackend(token);

            await chrome.storage.local.set({ sessionToken, userProfile: user });
            updateAuthUI(user);
        } catch (error) {
            console.error('Login Failed', error);
            alert(`Login Failed: ${error.message}`);
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
    const res = await fetch(`${BACKEND_URL}/api/auth/google`, {
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
