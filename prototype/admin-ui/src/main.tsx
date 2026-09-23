// PROTOTYPE — three admin-surface variants on the /admin route, switchable via ?variant=A|B|C.
// Variant D is server-rendered by Hono at /ssr/ (see server/ssr.tsx).
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename="/admin">
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
