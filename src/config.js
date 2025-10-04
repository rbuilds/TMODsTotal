// This file exports the necessary configuration for Firebase and the application
// environment, allowing it to work correctly on Netlify.

// --- YOUR FIREBASE CONFIGURATION ---

// 1. Application Identifier: Used for unique data storage paths in Firestore.
export const APP_ID = "mcr4-tmods-project"; 

// 2. Initial Authentication Token: This is a placeholder for the custom token
// the app expects to receive to sign in.
export const INITIAL_AUTH_TOKEN = "dummy-auth-token-for-prod";

// 3. Firebase Configuration: Your specific project keys from the Firebase Console.
// This data allows your application to connect to the 'tmods-overall' project.
export const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCjLWKCJMmW3PiJ8SyZXDpA7QCTfbJyME8",
    authDomain: "tmods-overall.firebaseapp.com",
    projectId: "tmods-overall",
    storageBucket: "tmods-overall.firebasestorage.app",
    messagingSenderId: "672257211065",
    appId: "1:672257211065:web:9e2eba91a621e984ca7968",
    measurementId: "G-0TZBL5W7G9"
};