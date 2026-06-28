import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { LanguageProvider } from '@/i18n/LanguageContext.jsx'

function syncAppViewportHeight() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const vv = window.visualViewport;
  const height = Math.floor(vv?.height || window.innerHeight || document.documentElement.clientHeight || 0);
  if (height > 0) {
    document.documentElement.style.setProperty('--mana-app-height', `${height}px`);
  }
}

syncAppViewportHeight();
if (typeof window !== 'undefined') {
  window.addEventListener('resize', syncAppViewportHeight, { passive: true });
  window.addEventListener('orientationchange', syncAppViewportHeight, { passive: true });
  window.visualViewport?.addEventListener('resize', syncAppViewportHeight, { passive: true });
  window.visualViewport?.addEventListener('scroll', syncAppViewportHeight, { passive: true });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </React.StrictMode>,
)
