import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
// Import your configuration file. This is the fix!
// We must manually import these values because Netlify/Vite doesn't automatically
// provide them as global variables like the previous testing environment did.
import { APP_ID, FIREBASE_CONFIG, INITIAL_AUTH_TOKEN } from './config.js'; 

// --- CRITICAL FIX: Injecting Firebase Config Globally ---

// We are defining these variables on the global 'window' object.
// The main App.jsx file is written to look for these variables globally,
// so this step ensures that when the app starts, it finds the required keys.

// 1. App ID: A unique identifier for the application within the testing environment.
window.__app_id = APP_ID;

// 2. Firebase Config: Contains all the connection details for your database.
// We stringify it because the main App.jsx expects it as a string to be parsed later.
window.__firebase_config = JSON.stringify(FIREBASE_CONFIG); 

// 3. Initial Auth Token: The temporary token used to sign the user into Firebase.
window.__initial_auth_token = INITIAL_AUTH_TOKEN;

// --- Standard React Application Initialization ---

// This function starts the application.
ReactDOM.createRoot(document.getElementById('root')).render(
  // <React.StrictMode> helps identify potential problems in the code during development.
  <React.StrictMode>
    {/* This is the main component that holds your entire tracker application. */}
    <App />
  </React.StrictMode>,
);