import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx'; // Path fixed to direct import
import './index.css'; // Path fixed to direct import

// --- Standard React Application Initialization ---

// This function starts the application.
ReactDOM.createRoot(document.getElementById('root')).render(
  // <React.StrictMode> helps identify potential problems in the code during development.
  <React.StrictMode>
    {/* This is the main component that holds your entire tracker application. */}
    <App />
  </React.StrictMode>,
);
