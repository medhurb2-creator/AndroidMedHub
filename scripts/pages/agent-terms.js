// scripts/pages/agent-terms.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as auth from '../auth.js';

let $;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  // ===== DOM refs =====
  const backBtn = $('#backBtn');
  const themeToggle = $('#themeToggle');
  const acceptBtn = $('#acceptBtn');
  const backBtnAccept = $('#backBtnAccept');

  // ===== Back button =====
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      window.history.back();
    });
  }
  if (backBtnAccept) {
    backBtnAccept.addEventListener('click', () => {
      window.history.back();
    });
  }

  // ===== Theme toggle =====
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }

  // ===== Accept button =====
  if (acceptBtn) {
    acceptBtn.addEventListener('click', () => {
      const user = auth.getUser();
      if (user) {
        // Logged in: go to agent application
        router.navigateTo('agent-registration');
      } else {
        // Not logged in: go to signup with agent flag
        router.navigateTo('signup?isAgent=true');
      }
    });
  }

  console.log('[AgentTerms] Initialized');
}

export function destroy() {
  // Cleanup if needed
}