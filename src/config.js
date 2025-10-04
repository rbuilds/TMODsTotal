/**
 * WARNING: For a real production app, these values should typically be loaded 
 * from secure environment variables (e.g., in a .env file ignored by git)
 * and injected during the build process.
 * * For this single-file React environment, we define them here.
 * * !!! REPLACE ALL PLACEHOLDER VALUES BELOW WITH YOUR ACTUAL FIREBASE CONFIG !!!
 */

// This ID is used by the app to create a unique path in Firestore 
// (e.g., /artifacts/mcr4-tmods-app-id/...)
// You can make this any unique string you want.
export const __app_id = "mcr4-tmods-app-id-unique"; 

// This is your standard Firebase project config object (from the Firebase Console -> Project Settings)
// This is converted to a JSON string for compatibility with the original environment.
const firebaseConfigObject = {
    apiKey: "AIzaSyCjLWKCJMmW3PiJ8SyZXDpA7QCTfbJyME8", 
    authDomain: "tmods-overall.firebaseapp.com",
    projectId: "tmods-overall",
    storageBucket: "tmods-overall.firebasestorage.app",
    messagingSenderId: "672257211065",
    appId: "1:672257211065:web:9e2eba91a621e984ca7968"
    // databaseURL is usually not required for Firestore-only projects
};

export const __firebase_config = JSON.stringify(firebaseConfigObject);

// This is normally a token provided by the environment for authenticated sign-in.
// For local/Netlify deployment, we leave it undefined so the app falls back 
// to signInAnonymously() to establish a user session.
export const __initial_auth_token = undefined;