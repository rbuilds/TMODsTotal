// This file exports the necessary configuration for Firebase and the application
// environment, allowing it to work correctly on Netlify.

// *** IMPORTANT: REPLACE ALL PLACEHOLDER VALUES WITH YOUR ACTUAL FIREBASE KEYS ***

// 1. Application Identifier: Used for unique data storage paths in Firestore.
export const APP_ID = "mcr4-tmods-project"; // You can use this default value.

// 2. Initial Authentication Token: This is a placeholder for the custom token
// the app expects to receive to sign in. We use a dummy value for deployment.
export const INITIAL_AUTH_TOKEN = "dummy-auth-token-for-prod";

// 3. Firebase Configuration: Your specific project keys from the Firebase Console.
// Replace everything inside the braces { ... } with your actual settings.
export const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCjLWKCJMmW3PiJ8SyZXDpA7QCTfbJyME8", 
    authDomain: "tmods-overall.firebaseapp.com",
    projectId: "tmods-overall",
    storageBucket: "tmods-overall.firebasestorage.app",
    messagingSenderId: "672257211065",
    appId: "1:672257211065:web:9e2eba91a621e984ca7968"
};