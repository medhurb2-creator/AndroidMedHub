// scripts/pages/privacy.js
import * as ui from '../ui.js';
import * as router from '../router.js';

export async function init(context) {
  // Apply theme
  ui.applyTheme();

  // Theme toggle
  const themeToggle = context.root.querySelector('#theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }

  // Back to Sign Up button
  const backSignupBtn = context.root.querySelector('#back-signup-btn');
  if (backSignupBtn) {
    backSignupBtn.addEventListener('click', () => {
      router.navigateTo('signup');
    });
  }

  // Go to Welcome button
  const goWelcomeBtn = context.root.querySelector('#go-welcome-btn');
  if (goWelcomeBtn) {
    goWelcomeBtn.addEventListener('click', () => {
      router.navigateTo('welcome');
    });
  }

  // Back to Home button
  const backHomeBtn = context.root.querySelector('#back-home-btn');
  if (backHomeBtn) {
    backHomeBtn.addEventListener('click', () => {
      router.navigateTo(''); // goes to root (landing page)
    });
  }

  console.log('[Privacy] Initialized.');
}

export function destroy() {
  // Cleanup if needed
}