import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getAuth, signInWithCustomToken, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, collection, query, onSnapshot, writeBatch } from 'firebase/firestore';
import { Menu, X, Plus, Trash2, Edit, Check, ChevronDown, CheckCircle, Clock, XOctagon } from 'lucide-react';
// setLogLevel is imported here to debug firestore connection issues
import { setLogLevel } from 'firebase/firestore'; 

// --- Hardcoded Fallback Configuration (Implements User's Settings) ---
// Since environment variables proved unreliable during deployment, we hardcode the configuration
// here. This ensures the application always starts with the correct keys.

const HARDCODED_APP_ID = 'tmods-overall';
const HARDCODED_AUTH_TOKEN = 'dummy-auth-token-for-prod'; // Safe token placeholder
const HARDCODED_CONFIG_JSON = '{"apiKey":"AIzaSyCjLWKCJMmW3PiJ8SyZXDpA7QCTfbJyME8", "authDomain": "tmods-overall.firebaseapp.com", "projectId": "tmods-overall", "storageBucket": "tmods-overall.firebasestorage.app", "messagingSenderId": "672257211065", "appId": "1:672257211065:web:9e2eba91a621e984ca7968", "measurementId": "G-0TZBL5W7G9"}';

// We access the final value by prioritizing the internal Canvas globals, then the hardcoded strings.
const APP_ID = typeof __app_id !== 'undefined' ? __app_id : HARDCODED_APP_ID;
const INITIAL_AUTH_TOKEN = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : HARDCODED_AUTH_TOKEN;

// Function to construct the Firebase configuration object from environment variables
const getFirebaseConfig = () => {
    // 1. Prioritize the string provided by the Canvas global variable (for this editor environment)
    // 2. Fallback to the hardcoded JSON string provided by the user.
    let configString = typeof __firebase_config !== 'undefined' ? __firebase_config : HARDCODED_CONFIG_JSON;
    
    if (!configString) {
        console.warn("No Firebase Config string found in any expected variable.");
        return {};
    }
    
    // Safety checks before parsing
    if (configString === '{}' || configString === '""' || configString === 'null' || configString.length < 10) {
        console.warn(`Firebase Config string found, but is empty, boilerplate, or too short. Raw string received: "${configString}"`);
        return {};
    }
    
    try {
        const config = JSON.parse(configString);

        if (!config || Object.keys(config).length === 0 || !config.apiKey) {
             console.warn(`Attempted to parse config, but result was empty or missing apiKey. Raw string received: "${configString}"`);
             throw new Error("Missing or invalid Firebase configuration object (VITE_FIREBASE_CONFIG must be a valid JSON string).");
        }
        return config;
    } catch (e) {
        console.error(`Firebase Config Parsing Failed. Raw input: "${configString}" Error: ${e.message}`);
        throw new Error(`Invalid JSON format in Firebase configuration. Please check the VITE_FIREBASE_CONFIG value in Netlify.`);
    }
};

// --- Utility Functions ---

// Converts an object (like a Date or Firestore Timestamp) to a serializable string.
const sanitizeData = (data) => {
    if (!data) return data;
    return JSON.parse(JSON.stringify(data));
};

// Calculates the status badge color based on completion percentage.
const getStatusColor = (percent) => {
    if (percent === 100) return 'bg-green-600';
    if (percent > 0) return 'bg-yellow-500';
    return 'bg-red-500';
};
// Helper for text colors in SVG
const getTextColor = (percent) => {
    if (percent === 100) return 'text-green-600';
    if (percent > 0) return 'text-yellow-500';
    return 'text-red-500';
};


// Determines the label based on completion percentage.
const getStatusLabel = (percent) => {
    if (percent === 100) return 'Complete';
    if (percent > 0) return 'In Progress';
    return 'Not Started';
};

// Calculates overall completion percentage for an array of items (like parts or actions).
const calculateOverallCompletion = (items) => {
    if (!items || items.length === 0) return 0;
    const totalPercent = items.reduce((sum, item) => sum + (item.percentComplete || 0), 0);
    return Math.round(totalPercent / items.length);
};

// Calculates completion percentage based on completed steps.
const calculateStepCompletion = (steps) => {
    if (!steps || steps.length === 0) return 0;
    const completed = steps.filter(step => step.completed).length;
    return Math.round((completed / steps.length) * 100);
};

// Generates the default structure for a new Part/Drawing.
const createDefaultPart = (title) => ({
    id: crypto.randomUUID(),
    title: title || `New Part ${crypto.randomUUID().slice(0, 4)}`,
    imageUrl: '',
    actions: [],
    // For Lead Abatement, this is used to link to other scopes
    relatedScopeId: 'none', 
    percentComplete: 0,
});

// Defines the initial structure for all scopes (TMODs)
const initialScopesData = [
    { id: 'summary', title: 'MCR4 TMODs Summary', type: 'summary' },
    { id: 'lead_abatement', title: 'Lead Abatement', type: 'scope' },
    { id: '4113a', title: '4113a Civil Mod Interferences', type: 'scope' },
    { id: '4113b', title: '4113b FIF and Monorail', type: 'scope' },
    { id: '4113c', title: '4113c Feeder Lifting Frame', type: 'scope' },
    { id: '4115a', title: '4115a MET Civil', type: 'scope' },
    { id: '4115b', title: '4115b MET Mechanical', type: 'scope' },
    { id: 'helium_removal', title: 'Helium Supply Line removal', type: 'scope' },
    { id: '4219', title: "4219 'Header restraints Install'", type: 'scope' },
];

// Creates the default data structure for a standard scope page (non-Lead Abatement).
const createDefaultScopeData = (scopeId) => ({
    id: scopeId,
    // Prereqs that use simple dropdown status
    prereqStatusLeadAbatement: 'Not Started', 
    
    // Prereqs that use step tracking (initial status is set by step completion)
    prereqStatusMaterials: {
        status: 'Not Started',
        notes: '',
        steps: [
            { id: crypto.randomUUID(), text: 'Material Order Placed', completed: false },
        ]
    },
    prereqStatusGeneral: {
        status: 'Not Started',
        notes: '',
        steps: [
            { id: crypto.randomUUID(), text: 'Welders Certified', completed: false },
        ]
    },
    parts: [
        createDefaultPart('Drawing 01-A'),
        createDefaultPart('Drawing 01-B'),
    ]
});


// --- Firebase Hook ---

const useFirebase = () => {
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [scopes, setScopes] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');

    const firebaseConfig = useMemo(() => {
        try {
            return getFirebaseConfig();
        } catch (e) {
            setError(e.message);
            return {};
        }
    }, []);
    
    const firebaseApp = useMemo(() => {
        // Log levels for better debugging in the console
        setLogLevel('debug');
        
        const config = firebaseConfig;

        if (!config.apiKey) {
            if (!error) { // Only set this generic error if a more specific one hasn't been thrown by getFirebaseConfig
                setError("Configuration Error: Firebase settings are missing. Please ensure Firebase Config is correctly provided.");
            }
            setIsLoading(false);
            return null;
        }
        return initializeApp(config);
    }, [firebaseConfig, error]); // Depend on error to potentially re-run if error state clears

    // 1. Initialization and Authentication
    useEffect(() => {
        if (!firebaseApp) return;

        const firestore = getFirestore(firebaseApp);
        const firebaseAuth = getAuth(firebaseApp);

        setDb(firestore);
        setAuth(firebaseAuth);

        const authenticate = async () => {
            try {
                if (INITIAL_AUTH_TOKEN && INITIAL_AUTH_TOKEN !== 'dummy-auth-token-for-prod') {
                    // Try to sign in with the provided custom token
                    await signInWithCustomToken(firebaseAuth, INITIAL_AUTH_TOKEN);
                } else {
                    // Fallback to anonymous sign-in
                    await signInAnonymously(firebaseAuth);
                }
            } catch (err) {
                console.error("Firebase Authentication Failed:", err);
                setError(`Authentication failed. Check your Firebase rules.`);
            }
        };

        const unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
            if (user) {
                setUserId(user.uid);
                console.log(`User Authenticated. UID: ${user.uid}`);
            } else {
                // We use the temporary user ID (from anon sign-in or a new UUID) 
                // but wait for the auth process to finish.
                setUserId(firebaseAuth.currentUser?.uid || crypto.randomUUID()); 
                console.log("Authentication state changed: User is logged out or anonymous.");
            }
        });

        authenticate();
        return () => unsubscribe();
    }, [firebaseApp]);

    // 2. Data Synchronization (Scopes and Parts)
    useEffect(() => {
        // Wait for db and authenticated userId to be ready, or if an error occurred.
        if (!db || !userId || error) return; 

        // Public collection path as per security rules
        const scopesColRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'scopes');
        const scopesQuery = query(scopesColRef);

        const unsubscribe = onSnapshot(scopesQuery, async (querySnapshot) => {
            console.log("Firestore Snapshot received.");
            
            let fetchedScopes = [];

            if (querySnapshot.empty) {
                console.log("Scopes collection is empty. Initializing data...");
                setIsLoading(true);
                await initializeDefaultData(db, userId);
                // Keep loading until the next snapshot confirms data presence
                return; 
            }

            // Process fetched data
            querySnapshot.forEach(doc => {
                // Ensure doc data exists before adding
                const data = doc.data();
                if (data) {
                    fetchedScopes.push(sanitizeData(data));
                }
            });

            // Merge fetched data with default structure to ensure all scopes are present
            const updatedScopes = initialScopesData.map(defaultScope => {
                const fetchedScope = fetchedScopes.find(s => s.id === defaultScope.id);
                if (fetchedScope) {
                    // Deep merge the fetched data over the defaults
                    return { ...defaultScope, ...fetchedScope };
                }
                // If a default scope is missing from the database, use its structure
                if (defaultScope.type === 'scope') {
                    return { ...defaultScope, ...createDefaultScopeData(defaultScope.id) };
                }
                return defaultScope;
            });
            
            console.log(`Found ${updatedScopes.length} scopes. Loading complete.`);
            setScopes(updatedScopes);
            setIsLoading(false);

        }, (e) => {
            console.error("Firestore Snapshot Error:", e);
            // Crucial: The main reason for this failure is usually security rules blocking the read.
            // A 400 Bad Request error on the stream often indicates 'permission-denied'.
            setError(`Failed to load data. Please check your Firebase Firestore Security Rules for read access on 'artifacts/${APP_ID}/public/data/'. Error: ${e.message}`);
            setIsLoading(false);
        });

        return () => unsubscribe();
    }, [db, userId, error]);


    // Data initialization helper
    const initializeDefaultData = async (firestore, currentUserId) => {
        const batch = writeBatch(firestore);

        // 1. Create a public user document to store the user's ID
        const userDocRef = doc(firestore, 'artifacts', APP_ID, 'public', 'data', 'users', currentUserId);
        batch.set(userDocRef, { userId: currentUserId, createdAt: new Date() });

        // 2. Create documents for all scope pages
        const allScopesToInit = initialScopesData.map(scope => {
            if (scope.type === 'scope') {
                return { ...scope, ...createDefaultScopeData(scope.id) };
            } else if (scope.id === 'summary') {
                return scope;
            }
            return null;
        }).filter(Boolean);

        // Special handling for Lead Abatement to avoid default prereqs
        const leadAbatementScopeId = 'lead_abatement';
        const leadAbatementIndex = allScopesToInit.findIndex(s => s.id === leadAbatementScopeId);
        if (leadAbatementIndex !== -1) {
            allScopesToInit[leadAbatementIndex] = {
                ...allScopesToInit[leadAbatementIndex],
                prereqStatusLeadAbatement: 'N/A',
                prereqStatusMaterials: { status: 'N/A', notes: '', steps: [] },
                prereqStatusGeneral: { status: 'N/A', notes: '', steps: [] },
                parts: [
                    createDefaultPart('Piping Section A1'),
                    createDefaultPart('Containment Area B'),
                ]
            };
        }

        allScopesToInit.forEach(scope => {
            const scopeData = {
                ...scope,
                createdAt: new Date(),
            };
            const docRef = doc(firestore, 'artifacts', APP_ID, 'public', 'data', 'scopes', scope.id);
            batch.set(docRef, scopeData);
        });
        
        try {
            await batch.commit();
            console.log("Default data committed. Waiting for Snapshot update...");
        } catch (e) {
            console.error("Batch commit failed:", e);
            setError(`Database Initialization Failed: ${e.message}. Please verify your network connection and Firebase security rules.`);
        }
    };


    // Update function for scope data
    const updateScopeData = useCallback(async (scopeId, data) => {
        if (!db) {
            console.error("Firestore not initialized.");
            return;
        }

        try {
            const docRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'scopes', scopeId);
            // Use setDoc with merge: true for partial updates
            await setDoc(docRef, sanitizeData(data), { merge: true });
        } catch (e) {
            console.error("Error updating document:", e);
            setError(`Error updating document: ${e.message}`);
        }
    }, [db]);


    return { scopes, userId, updateScopeData, isLoading, error, db };
};


// --- Component Utilities ---

// Generates a status indicator circle and label
const StatusBadge = ({ percent, readOnly }) => {
    const color = getStatusColor(percent);
    const label = getStatusLabel(percent);
    const icon = percent === 100 ? CheckCircle : percent > 0 ? Clock : XOctagon;

    return (
        <div className={`flex items-center space-x-2 text-sm font-semibold ${readOnly ? 'text-gray-500' : 'text-gray-800'}`}>
            <span className={`w-3 h-3 rounded-full ${color}`} />
            <span>{label}</span>
        </div>
    );
};

// Generates a small progress circle for the summary view
const MiniCircularProgress = ({ percent }) => {
    const radius = 15;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (percent / 100) * circumference;
    const strokeColor = getTextColor(percent);

    return (
        <div className="relative w-10 h-10 flex items-center justify-center">
            <svg className="w-full h-full transform -rotate-90" viewBox="0 0 32 32">
                {/* Background track */}
                <circle
                    cx="16"
                    cy="16"
                    r={radius}
                    fill="transparent"
                    stroke="#e5e7eb"
                    strokeWidth="3"
                />
                {/* Progress bar */}
                <circle
                    cx="16"
                    cy="16"
                    r={radius}
                    fill="transparent"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    className={strokeColor}
                />
            </svg>
            <span className="absolute text-[10px] font-bold text-gray-700">
                {percent}%
            </span>
        </div>
    );
};

// Calculates overall progress for Lead Abatement based on linked parts
const getLeadAbatementProgressForScope = (scopeId, allScopes) => {
    const leadAbatementScope = allScopes.find(s => s.id === 'lead_abatement');
    if (!leadAbatementScope || !leadAbatementScope.parts) {
        return { percent: 0, count: 0 };
    }

    const linkedParts = leadAbatementScope.parts.filter(part => part.relatedScopeId === scopeId);

    if (linkedParts.length === 0) {
        return { percent: 0, count: 0, isLinked: false };
    }

    // Calculate total steps completed vs total steps available across all linked parts
    const totalSteps = linkedParts.reduce((sum, part) => sum + part.actions.reduce((s, a) => s + (a.steps?.length || 0), 0), 0);
    const completedSteps = linkedParts.reduce((sum, part) => sum + part.actions.reduce((s, a) => s + (a.steps?.filter(step => step.completed).length || 0), 0), 0);
    
    const percent = totalSteps === 0 ? 0 : Math.round((completedSteps / totalSteps) * 100);

    return { percent, count: linkedParts.length, isLinked: true };
};


// --- Modals ---

// Modal for tracking steps and notes for Materials and General Prerequisites
const PrereqModal = ({ isOpen, onClose, prereqKey, scope, updateScopeData }) => {
    if (!isOpen) return null;

    const prereqData = scope[prereqKey];
    const [notes, setNotes] = useState(prereqData.notes || '');
    const [steps, setSteps] = useState(prereqData.steps || []);
    const [newStepText, setNewStepText] = useState('');

    const calculatedPercent = calculateStepCompletion(steps);

    const handleStepToggle = (id) => {
        setSteps(steps.map(step =>
            step.id === id ? { ...step, completed: !step.completed } : step
        ));
    };

    const handleAddStep = () => {
        if (newStepText.trim()) {
            setSteps([...steps, { id: crypto.randomUUID(), text: newStepText.trim(), completed: false }]);
            setNewStepText('');
        }
    };

    const handleDeleteStep = (id) => {
        setSteps(steps.filter(step => step.id !== id));
    };

    const handleSave = () => {
        const newStatus = getStatusLabel(calculatedPercent);

        const updatedScope = {
            ...scope,
            [prereqKey]: {
                ...prereqData,
                status: newStatus,
                notes: notes,
                steps: steps,
            }
        };

        updateScopeData(scope.id, updatedScope);
        onClose();
    };

    const titleMap = {
        prereqStatusMaterials: 'Materials Tracking',
        prereqStatusGeneral: 'General Prereqs Tracking',
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
                {/* Header */}
                <div className="p-5 border-b flex justify-between items-center bg-gray-50 rounded-t-xl">
                    <h2 className="text-xl font-bold text-gray-800">{titleMap[prereqKey]}</h2>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-800 p-2 rounded-full transition">
                        <X size={20} />
                    </button>
                </div>
                
                <div className="overflow-y-auto p-6 space-y-6">
                    {/* Progress Bar */}
                    <div className="bg-gray-100 rounded-lg p-4">
                        <div className="font-semibold text-lg mb-2 text-gray-700">Completion: {calculatedPercent}%</div>
                        <div className="w-full bg-gray-200 rounded-full h-3">
                            <div 
                                className={`h-3 rounded-full transition-all duration-500 ${getStatusColor(calculatedPercent)}`} 
                                style={{ width: `${calculatedPercent}%` }}
                            />
                        </div>
                    </div>

                    {/* Step List */}
                    <div className="space-y-3">
                        <h3 className="text-lg font-bold text-gray-800 border-b pb-2">Execution Steps ({steps.length})</h3>
                        {steps.map(step => (
                            <div key={step.id} className="flex items-center justify-between bg-white p-3 border rounded-lg shadow-sm">
                                <label className="flex items-center flex-grow cursor-pointer">
                                    <input 
                                        type="checkbox" 
                                        checked={step.completed} 
                                        onChange={() => handleStepToggle(step.id)} 
                                        className="form-checkbox h-5 w-5 text-indigo-600 rounded"
                                    />
                                    <span className={`ml-3 text-gray-700 ${step.completed ? 'line-through text-gray-500' : ''}`}>
                                        {step.text}
                                    </span>
                                </label>
                                <button onClick={() => handleDeleteStep(step.id)} className="text-red-500 hover:text-red-700 p-1 rounded-full transition ml-4">
                                    <Trash2 size={16} />
                                </button>
                            </div>
                        ))}

                        {/* Add Step Input */}
                        <div className="flex space-x-2 pt-2">
                            <input 
                                type="text" 
                                value={newStepText} 
                                onChange={(e) => setNewStepText(e.target.value)} 
                                placeholder="Add new step..."
                                className="flex-grow p-2 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500"
                            />
                            <button onClick={handleAddStep} className="bg-indigo-600 text-white p-2 rounded-lg hover:bg-indigo-700 transition flex items-center">
                                <Plus size={18} />
                            </button>
                        </div>
                    </div>

                    {/* Notes Section */}
                    <div>
                        <h3 className="text-lg font-bold text-gray-800 mb-2 border-b pb-1">Notes</h3>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            rows="4"
                            placeholder="Add detailed notes here..."
                            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500 resize-none"
                        />
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t flex justify-end bg-gray-50 rounded-b-xl">
                    <button 
                        onClick={handleSave} 
                        className="bg-green-600 text-white px-5 py-2 rounded-lg font-semibold hover:bg-green-700 transition shadow-md"
                    >
                        Save Changes
                    </button>
                </div>
            </div>
        </div>
    );
};


// Modal for tracking steps, notes, and temporary image for Part Actions
const ActionModal = ({ isOpen, onClose, action, scope, part, updateScopeData }) => {
    if (!isOpen) return null;

    const [steps, setSteps] = useState(action.steps || []);
    const [notes, setNotes] = useState(action.notes || '');
    const [newStepText, setNewStepText] = useState('');
    const [dataURL, setDataURL] = useState(null); // Temporary image data URL

    const calculatedPercent = calculateStepCompletion(steps);

    const handleStepToggle = (id) => {
        setSteps(steps.map(step =>
            step.id === id ? { ...step, completed: !step.completed } : step
        ));
    };

    const handleAddStep = () => {
        if (newStepText.trim()) {
            setSteps([...steps, { id: crypto.randomUUID(), text: newStepText.trim(), completed: false }]);
            setNewStepText('');
        }
    };

    const handleDeleteStep = (id) => {
        setSteps(steps.filter(step => step.id !== id));
    };

    const handleImageUpload = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onloadend = () => {
                setDataURL(reader.result);
                // NOTE: We DO NOT call updateScopeData here to avoid saving the massive Base64 string to Firestore.
                // The image remains temporary (session-only).
            };
            reader.readAsDataURL(file);
        }
    };

    const handleSave = () => {
        const updatedAction = {
            ...action,
            notes: notes,
            steps: steps,
            percentComplete: calculatedPercent,
            // We only save basic metadata about the image, NOT the large dataURL itself.
            imageAttachment: dataURL ? { name: `Attachment-${new Date().toISOString()}`, saved: false } : null,
        };

        const updatedParts = scope.parts.map(p => {
            if (p.id === part.id) {
                const updatedActions = p.actions.map(a => 
                    a.id === action.id ? updatedAction : a
                );
                // Recalculate part completion based on updated actions
                const partCompletion = calculateOverallCompletion(updatedActions);
                return { ...p, actions: updatedActions, percentComplete: partCompletion };
            }
            return p;
        });

        const updatedScope = { ...scope, parts: updatedParts };
        updateScopeData(scope.id, updatedScope);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">
                {/* Header */}
                <div className="p-5 border-b flex justify-between items-center bg-gray-50 rounded-t-xl">
                    <h2 className="text-xl font-bold text-gray-800">Action: {action.title}</h2>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-800 p-2 rounded-full transition">
                        <X size={20} />
                    </button>
                </div>
                
                <div className="overflow-y-auto p-6 grid grid-cols-1 md:grid-cols-2 gap-8">
                    {/* Left Column: Steps and Notes */}
                    <div className="space-y-6">
                        {/* Progress Bar */}
                        <div className="bg-gray-100 rounded-lg p-4 shadow-inner">
                            <div className="font-semibold text-lg mb-2 text-gray-700">Action Progress: {calculatedPercent}%</div>
                            <div className="w-full bg-gray-200 rounded-full h-3">
                                <div 
                                    className={`h-3 rounded-full transition-all duration-500 ${getStatusColor(calculatedPercent)}`} 
                                    style={{ width: `${calculatedPercent}%` }}
                                />
                            </div>
                        </div>

                        {/* Step List */}
                        <div className="space-y-3">
                            <h3 className="text-lg font-bold text-gray-800 border-b pb-2">Execution Steps ({steps.length})</h3>
                            {steps.map(step => (
                                <div key={step.id} className="flex items-center justify-between bg-white p-3 border rounded-lg shadow-sm transition hover:shadow-md">
                                    <label className="flex items-center flex-grow cursor-pointer">
                                        <input 
                                            type="checkbox" 
                                            checked={step.completed} 
                                            onChange={() => handleStepToggle(step.id)} 
                                            className="form-checkbox h-5 w-5 text-indigo-600 rounded"
                                        />
                                        <span className={`ml-3 text-gray-700 ${step.completed ? 'line-through text-gray-500' : ''}`}>
                                            {step.text}
                                        </span>
                                    </label>
                                    <button onClick={() => handleDeleteStep(step.id)} className="text-red-500 hover:text-red-700 p-1 rounded-full transition ml-4">
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            ))}

                            {/* Add Step Input */}
                            <div className="flex space-x-2 pt-2">
                                <input 
                                    type="text" 
                                    value={newStepText} 
                                    onChange={(e) => setNewStepText(e.target.value)} 
                                    placeholder="Add new step..."
                                    className="flex-grow p-2 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500"
                                />
                                <button onClick={handleAddStep} className="bg-indigo-600 text-white p-2 rounded-lg hover:bg-indigo-700 transition flex items-center">
                                    <Plus size={18} />
                                </button>
                            </div>
                        </div>

                        {/* Notes Section */}
                        <div>
                            <h3 className="text-lg font-bold text-gray-800 mb-2 border-b pb-1">Notes</h3>
                            <textarea
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                rows="3"
                                placeholder="Add detailed notes here..."
                                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500 resize-none shadow-sm"
                            />
                        </div>
                    </div>
                    
                    {/* Right Column: Image Attachment */}
                    <div className="space-y-4">
                        <h3 className="text-lg font-bold text-gray-800 border-b pb-2">Image Attachment (Session Only)</h3>
                        <div className="border-2 border-dashed border-gray-300 rounded-xl p-6 text-center shadow-inner bg-white">
                            <input 
                                id="image-upload" 
                                type="file" 
                                accept="image/jpeg, image/png, image/jpg" 
                                onChange={handleImageUpload} 
                                className="hidden"
                            />
                            <label htmlFor="image-upload" className="cursor-pointer bg-blue-500 text-white px-4 py-2 rounded-lg font-semibold hover:bg-blue-600 transition inline-flex items-center shadow-md">
                                <Plus size={18} className="mr-2" />
                                Upload Image
                            </label>
                            <p className="text-xs text-gray-500 mt-2">Max 1MB. Image is only visible in the current session.</p>
                        </div>

                        {dataURL && (
                            <div className="relative border rounded-lg overflow-hidden shadow-lg">
                                <img src={dataURL} alt="Attachment Preview" className="w-full h-auto object-cover"/>
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t flex justify-end bg-gray-50 rounded-b-xl">
                    <button 
                        onClick={handleSave} 
                        className="bg-green-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-green-700 transition shadow-lg"
                    >
                        Save Action Progress
                    </button>
                </div>
            </div>
        </div>
    );
};


// --- Core Components ---

// Renders the details for a single Part/Drawing/Thing needing Abating
const DrawingCard = ({ part, scope, updateScopeData, allScopes, isLeadAbatementScope, otherScopeIds }) => {
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [newTitle, setNewTitle] = useState(part.title);
    const [actionModalOpen, setActionModalOpen] = useState(false);
    const [selectedAction, setSelectedAction] = useState(null);
    const [localImageUrl, setLocalImageUrl] = useState(part.imageUrl); // For temporary display

    // Determine the color for the Part card border
    const borderColor = useMemo(() => {
        if (part.percentComplete === 100) return 'border-green-600';
        if (part.percentComplete > 0) return 'border-yellow-500';
        return 'border-red-500';
    }, [part.percentComplete]);


    const handleRename = () => {
        if (newTitle.trim() === part.title) {
            setIsEditingTitle(false);
            return;
        }

        const updatedParts = scope.parts.map(p =>
            p.id === part.id ? { ...p, title: newTitle.trim() } : p
        );
        updateScopeData(scope.id, { ...scope, parts: updatedParts });
        setIsEditingTitle(false);
    };

    const handleDeletePart = () => {
        // Use a custom confirmation modal in a real app, but using window.confirm for simplicity here.
        if (!window.confirm(`Are you sure you want to delete Part: ${part.title}?`)) return;

        const updatedParts = scope.parts.filter(p => p.id !== part.id);
        updateScopeData(scope.id, { ...scope, parts: updatedParts });
    };

    const handleActionToggle = (actionId) => {
        // Only for Lead Abatement (simple checkbox toggle)
        if (!isLeadAbatementScope) return;

        const updatedActions = part.actions.map(a => 
            a.id === actionId ? { ...a, percentComplete: a.percentComplete === 100 ? 0 : 100, steps: a.steps.map(s => ({...s, completed: a.percentComplete === 0})) } : a
        );
        
        const partCompletion = calculateOverallCompletion(updatedActions);

        const updatedParts = scope.parts.map(p =>
            p.id === part.id ? { ...p, actions: updatedActions, percentComplete: partCompletion } : p
        );
        updateScopeData(scope.id, { ...scope, parts: updatedParts });
    };


    const handleActionClick = (action) => {
        if (isLeadAbatementScope) {
            // If Lead Abatement, clicking toggles completion directly (handled by handleActionToggle)
            handleActionToggle(action.id);
        } else {
            // For standard scopes, clicking opens the modal for step tracking
            setSelectedAction(action);
            setActionModalOpen(true);
        }
    };


    const handleImageUpload = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onloadend = () => {
                setLocalImageUrl(reader.result);
                // NOTE: We do not update Firestore here. The image is temporary (session-only).
            };
            reader.readAsDataURL(file);
        }
    };
    
    const handleRelatedScopeChange = (e) => {
        const newScopeId = e.target.value;
        const updatedParts = scope.parts.map(p => 
            p.id === part.id ? { ...p, relatedScopeId: newScopeId } : p
        );
        updateScopeData(scope.id, { ...scope, parts: updatedParts });
    };

    const handleAddAction = () => {
        // Use a custom modal instead of prompt in a real app
        const newActionTitle = window.prompt("Enter title for new action:");
        if (newActionTitle) {
            const newAction = {
                id: crypto.randomUUID(),
                title: newActionTitle,
                percentComplete: 0,
                notes: '',
                steps: isLeadAbatementScope ? [{ id: crypto.randomUUID(), text: 'Complete Abatement Task', completed: false }] : [{ id: crypto.randomUUID(), text: 'Perform Task 1', completed: false }],
            };
            const updatedParts = scope.parts.map(p =>
                p.id === part.id ? { ...p, actions: [...p.actions, newAction] } : p
            );
            
            // Recalculate part completion
            const newPart = updatedParts.find(p => p.id === part.id);
            if (newPart) {
                newPart.percentComplete = calculateOverallCompletion(newPart.actions);
            }

            updateScopeData(scope.id, { ...scope, parts: updatedParts });
        }
    };
    
    const handleDeleteAction = (actionId) => {
        const updatedActions = part.actions.filter(a => a.id !== actionId);
        const partCompletion = calculateOverallCompletion(updatedActions);

        const updatedParts = scope.parts.map(p =>
            p.id === part.id ? { ...p, actions: updatedActions, percentComplete: partCompletion } : p
        );
        updateScopeData(scope.id, { ...scope, parts: updatedParts });
    };

    const partCompletionPercent = part.percentComplete || 0;

    return (
        <div className={`bg-white rounded-xl shadow-lg border-b-4 ${borderColor} transition-shadow duration-300 hover:shadow-xl`}>
            {/* Action Modal (only for standard scopes) */}
            {selectedAction && !isLeadAbatementScope && (
                <ActionModal 
                    isOpen={actionModalOpen} 
                    onClose={() => setActionModalOpen(false)} 
                    action={selectedAction} 
                    scope={scope} 
                    part={part}
                    updateScopeData={updateScopeData} 
                />
            )}

            <div className="p-5 space-y-4">
                {/* Header (Title & Controls) */}
                <div className="flex justify-between items-center border-b pb-3">
                    <div className="flex items-center space-x-2">
                        {isEditingTitle ? (
                            <input
                                type="text"
                                value={newTitle}
                                onChange={(e) => setNewTitle(e.target.value)}
                                onBlur={handleRename}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); }}
                                className="text-lg font-bold p-1 border-b border-indigo-500 focus:outline-none"
                                autoFocus
                            />
                        ) : (
                            <h3 className="text-lg font-bold text-gray-800 flex items-center">
                                {part.title}
                                <button onClick={() => setIsEditingTitle(true)} className="ml-2 text-gray-400 hover:text-indigo-500 transition">
                                    <Edit size={16} />
                                </button>
                            </h3>
                        )}
                    </div>
                    
                    <div className="flex items-center space-x-2">
                        <StatusBadge percent={partCompletionPercent} />
                        <button onClick={handleDeletePart} className="text-red-500 hover:text-red-700 p-1 rounded-full transition bg-red-50 hover:bg-red-100">
                            <Trash2 size={18} />
                        </button>
                    </div>
                </div>

                {/* Main Content Area */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {/* Left Column: Image / Status */}
                    <div className="md:col-span-1 space-y-3">
                        <div className="relative w-full aspect-[4/3] bg-gray-100 rounded-lg overflow-hidden shadow-inner flex items-center justify-center border">
                            {localImageUrl ? (
                                <img src={localImageUrl} alt={part.title} className="w-full h-full object-cover" />
                            ) : (
                                <span className="text-gray-500 text-sm">No Image</span>
                            )}
                        </div>

                        {/* Image Upload */}
                        <div className="flex flex-col items-center">
                            <input 
                                id={`image-upload-${part.id}`} 
                                type="file" 
                                accept="image/jpeg, image/png, image/jpg" 
                                onChange={handleImageUpload} 
                                className="hidden"
                            />
                            <label htmlFor={`image-upload-${part.id}`} className="cursor-pointer text-indigo-600 hover:text-indigo-700 text-sm font-semibold transition">
                                Upload/Change Image
                            </label>
                            <p className="text-xs text-gray-500 mt-1">Image is session-only (not saved).</p>
                        </div>
                    </div>
                    
                    {/* Middle Column: Progress Bar & Related Scope Picker */}
                    <div className="md:col-span-1 space-y-3">
                        {/* Progress Bar */}
                        <div className="p-3 bg-gray-50 rounded-lg shadow-sm border">
                            <h4 className="text-sm font-semibold mb-1 text-gray-700">Completion: {partCompletionPercent}%</h4>
                            <div className="w-full bg-gray-200 rounded-full h-2">
                                <div 
                                    className={`h-2 rounded-full transition-all duration-500 ${getStatusColor(partCompletionPercent)}`} 
                                    style={{ width: `${partCompletionPercent}%` }}
                                />
                            </div>
                        </div>

                        {/* Related Scope Picker (Lead Abatement Only) */}
                        {isLeadAbatementScope && (
                            <div className="mt-4 p-3 bg-indigo-50 rounded-lg border border-indigo-200">
                                <label className="block text-sm font-medium text-indigo-700 mb-1">Related TMOD Scope</label>
                                <select 
                                    value={part.relatedScopeId || 'none'}
                                    onChange={handleRelatedScopeChange}
                                    className="w-full p-2 border border-indigo-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500 bg-white"
                                >
                                    <option value="none">-- Select Scope (Not Linked) --</option>
                                    {otherScopeIds.map(id => {
                                        const scopeTitle = allScopes.find(s => s.id === id)?.title;
                                        return (
                                            <option key={id} value={id}>
                                                {scopeTitle}
                                            </option>
                                        );
                                    })}
                                </select>
                                <p className="text-xs text-indigo-600 mt-1">Links this abatement item to a dependent scope.</p>
                            </div>
                        )}
                    </div>

                    {/* Right Column: Actions List */}
                    <div className="md:col-span-1 space-y-2">
                        <div className="flex justify-between items-center border-b pb-2">
                            <h4 className="text-sm font-bold text-gray-800">Action Items ({part.actions.length})</h4>
                            <button onClick={handleAddAction} className="text-green-600 hover:text-green-700 transition flex items-center text-xs font-semibold">
                                <Plus size={16} className="mr-1" /> Add
                            </button>
                        </div>
                        
                        <div className="max-h-36 overflow-y-auto pr-1 space-y-1">
                            {part.actions.map(action => (
                                <div 
                                    key={action.id} 
                                    className={`flex justify-between items-center p-2 rounded-lg transition ${isLeadAbatementScope ? 'bg-indigo-50 hover:bg-indigo-100 cursor-pointer' : 'bg-gray-50 hover:bg-gray-100 cursor-pointer'}`}
                                    onClick={() => handleActionClick(action)}
                                >
                                    {isLeadAbatementScope ? (
                                        // Simple checkbox for Lead Abatement
                                        <label className="flex items-center flex-grow text-sm font-medium text-gray-700 cursor-pointer">
                                            <input 
                                                type="checkbox" 
                                                checked={action.percentComplete === 100} 
                                                onChange={() => handleActionToggle(action.id)} 
                                                className="form-checkbox h-4 w-4 text-green-600 rounded"
                                                onClick={(e) => e.stopPropagation()} // Stop propagation to prevent modal logic
                                            />
                                            <span className={`ml-2 ${action.percentComplete === 100 ? 'line-through text-gray-500' : ''}`}>
                                                {action.title}
                                            </span>
                                        </label>
                                    ) : (
                                        // Complex action with progress for standard scopes
                                        <div className="flex-grow text-sm font-medium text-gray-700 truncate">
                                            {action.title}
                                            <span className="text-xs font-semibold text-indigo-500 ml-2">
                                                ({action.percentComplete}%)
                                            </span>
                                        </div>
                                    )}
                                    
                                    <button onClick={(e) => { e.stopPropagation(); handleDeleteAction(action.id); }} className="text-red-400 hover:text-red-600 p-1 rounded-full transition ml-2">
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};


// Renders the main content for any given scope page
const ScopePage = ({ scope, updateScopeData, allScopes, setCurrentPage }) => {
    // Determine if this is the special Lead Abatement page
    const isLeadAbatementScope = scope.id === 'lead_abatement';
    
    // Get all other scope IDs for the Lead Abatement picker
    const nonSummaryAndSelfScopes = allScopes.filter(s => s.type === 'scope' && s.id !== scope.id);
    const otherScopeIds = nonSummaryAndSelfScopes.map(s => s.id);

    // Filter out the summary scope for calculations
    const nonSummaryScopes = allScopes.filter(s => s.type === 'scope');

    // --- Prerequisite Section Handlers ---
    const [modalOpen, setModalOpen] = useState(false);
    const [selectedPrereqKey, setSelectedPrereqKey] = useState(null);
    
    const openPrereqModal = (key) => {
        setSelectedPrereqKey(key);
        setModalOpen(true);
    };

    // Calculate Lead Abatement progress from linked items
    const leadAbatementProgress = useMemo(() => {
        if (isLeadAbatementScope) return { percent: 100, isLinked: true }; // N/A, but forced to 100 to show 'N/A' status
        return getLeadAbatementProgressForScope(scope.id, nonSummaryScopes);
    }, [scope.id, nonSummaryScopes, isLeadAbatementScope]);


    const handlePrereqDropdownChange = (key, value) => {
        // Only updates the Lead Abatement status dropdown on non-Lead Abatement pages
        if (key === 'prereqStatusLeadAbatement' && !isLeadAbatementScope) return;

        updateScopeData(scope.id, { ...scope, [key]: value });
    };

    const handleAddPart = () => {
        const newPart = createDefaultPart();
        updateScopeData(scope.id, { ...scope, parts: [...scope.parts, newPart] });
    };

    // --- Report Export Function ---
    const handleExport = () => {
        const printWindow = window.open('', '', 'height=800,width=800');
        printWindow.document.write('<html><head><title>MCR4 TMOD Report</title>');
        printWindow.document.write('<style>');
        printWindow.document.write(`
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap');
            body { font-family: 'Inter', sans-serif; margin: 0; padding: 20px; background-color: #ffffff; }
            h1 { color: #1f2937; border-bottom: 3px solid #6366f1; padding-bottom: 10px; margin-bottom: 25px; }
            h2 { color: #374151; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-top: 30px; margin-bottom: 15px; }
            .part-card { border: 2px solid #e5e7eb; border-radius: 8px; margin-bottom: 25px; padding: 15px; page-break-inside: avoid; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
            .part-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
            .part-title { font-size: 1.1rem; font-weight: bold; }
            .status { font-weight: bold; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; }
            .status.notstarted { background-color: #fca5a5; color: #b91c1c; } /* red-300 */
            .status.inprogress { background-color: #fde68a; color: #b45309; } /* yellow-300 */
            .status.complete { background-color: #a7f3d0; color: #065f46; } /* green-300 */
            .progress-bar-container { background-color: #e5e7eb; border-radius: 5px; height: 10px; margin-top: 5px; }
            .progress-bar { height: 100%; border-radius: 5px; transition: width 0.5s; }
            .bg-green-600 { background-color: #059669; }
            .bg-yellow-500 { background-color: #f59e0b; }
            .bg-red-500 { background-color: #ef4444; }
            .progress-percent { font-size: 0.9rem; margin-top: 5px; text-align: right; }
            .actions-list { list-style: none; padding: 0; margin-top: 10px; }
            .actions-list li { padding: 5px 0; border-bottom: 1px dotted #f3f4f6; font-size: 0.9rem; display: flex; justify-content: space-between; }
            .actions-list li:last-child { border-bottom: none; }
            .image-container { width: 150px; height: 100px; overflow: hidden; margin-right: 15px; border-radius: 4px; border: 1px solid #ddd; float: left; }
            .image-container img { width: 100%; height: 100%; object-fit: cover; }
        `);
        printWindow.document.write('</style>');
        printWindow.document.write('</head><body>');

        printWindow.document.write(`<h1>TMOD Report: ${scope.title}</h1>`);
        
        // --- Parts Tracking Section ---
        const partSectionTitle = isLeadAbatementScope ? 'Things needing Abating' : 'Parts Tracking';
        printWindow.document.write(`<h2>${partSectionTitle} (${scope.parts?.length || 0})</h2>`);

        if (scope.parts && scope.parts.length > 0) {
            scope.parts.forEach(part => {
                const percent = part.percentComplete || 0;
                const statusLabel = getStatusLabel(percent);
                const statusClass = statusLabel.toLowerCase().replace(' ', '');
                const colorClass = getStatusColor(percent).replace('bg-', 'bg-');

                let actionsListHtml = '';
                if (part.actions) {
                    part.actions.forEach(action => {
                        const actionPercent = action.percentComplete || 0;
                        const actionStatus = actionPercent === 100 ? ' (Complete)' : actionPercent > 0 ? ` (${actionPercent}%)` : '';
                        actionsListHtml += `<li><span>${action.title}</span><span style="font-weight: 500;">${actionStatus}</span></li>`;
                    });
                }
                
                // Since images are session-only, this is primarily for structural completeness.
                const imageHtml = part.imageUrl ? 
                    `<div class="image-container"><img src="${part.imageUrl}" alt="Part Image" /></div>` : 
                    `<div class="image-container" style="display:flex; align-items:center; justify-content:center; background-color:#f0f0f0; color:#999; font-size:10px;">No Image</div>`;

                printWindow.document.write(`
                    <div class="part-card">
                        <div class="part-header">
                            <div class="part-title">${part.title}</div>
                            <span class="status ${statusClass}">${statusLabel}</span>
                        </div>
                        
                        <div style="clear: both;">
                            ${imageHtml}
                            <div style="margin-left: 175px;">
                                <div class="progress-bar-container">
                                    <div class="progress-bar ${colorClass}" style="width: ${percent}%;"></div>
                                </div>
                                <div class="progress-percent">${percent}% Complete</div>
                                
                                <h4 style="font-size: 1rem; margin-top: 15px; margin-bottom: 5px; font-weight: bold;">Actions</h4>
                                <ul class="actions-list">
                                    ${actionsListHtml}
                                </ul>
                            </div>
                        </div>
                        <div style="clear: both;"></div>
                    </div>
                `);
            });
        } else {
            printWindow.document.write('<p>No parts or items have been added to this scope yet.</p>');
        }


        printWindow.document.write('</body></html>');
        printWindow.document.close();
        
        // Use a timeout to ensure all content is rendered before printing.
        setTimeout(() => {
            printWindow.print();
            printWindow.close();
        }, 500); 
    };


    return (
        <div className="p-4 md:p-8 w-full">
            <PrereqModal 
                isOpen={modalOpen} 
                onClose={() => setModalOpen(false)} 
                prereqKey={selectedPrereqKey} 
                scope={scope} 
                updateScopeData={updateScopeData} 
            />

            {/* Header and Controls */}
            <div className="flex justify-between items-center mb-6 border-b pb-4">
                <h1 className="text-3xl font-extrabold text-gray-800">{scope.title}</h1>
                <div className="flex space-x-3">
                    <button 
                        onClick={handleExport}
                        className="bg-indigo-600 text-white px-4 py-2 rounded-lg font-semibold hover:bg-indigo-700 transition shadow-md flex items-center"
                    >
                        Export Report (PDF)
                    </button>
                </div>
            </div>

            {/* --- PREREQUISITE SECTION --- */}
            {!isLeadAbatementScope && (
                <div className="mb-8 p-6 bg-white rounded-xl shadow-lg space-y-4">
                    <h2 className="text-2xl font-bold text-gray-700 border-b pb-2">Prerequisite Status</h2>

                    {/* Prereq Row Helper Component */}
                    {([
                        { key: 'prereqStatusMaterials', title: 'Materials', isStepPrereq: true, isReadOnly: false },
                        { key: 'prereqStatusGeneral', title: 'General Prereqs', isStepPrereq: true, isReadOnly: false },
                        { key: 'prereqStatusLeadAbatement', title: 'Lead Abatement', isStepPrereq: false, isReadOnly: true },
                    ]).map(({ key, title, isStepPrereq, isReadOnly }) => {
                        
                        let currentStatus = scope[key];
                        let percent = 0;
                        let isLinked = true;
                        
                        if (key === 'prereqStatusLeadAbatement' && isReadOnly) {
                            // Lead Abatement is cross-linked
                            const progress = leadAbatementProgress;
                            percent = progress.percent;
                            isLinked = progress.isLinked;
                            currentStatus = getStatusLabel(percent);
                        } else if (isStepPrereq) {
                            // Materials & General are step-tracked
                            percent = calculateStepCompletion(currentStatus?.steps);
                            currentStatus = currentStatus?.status || 'Not Started'; // Use status from the object
                        } else {
                            // Default simple status
                            currentStatus = currentStatus || 'Not Started';
                            percent = currentStatus === 'Complete' ? 100 : currentStatus === 'In Progress' ? 50 : 0;
                        }

                        // Determine the status text based on the lead abatement link status
                        const statusDisplay = key === 'prereqStatusLeadAbatement' && !isLinked
                            ? 'N/A (No Abatement items linked to this scope)'
                            : isStepPrereq 
                            ? `${currentStatus} (${percent}%)`
                            : currentStatus;

                        return (
                            <div key={key} className="flex items-center justify-between p-3 border-b last:border-b-0">
                                <span className="text-lg font-medium text-gray-600">{title}</span>
                                
                                <div className="flex items-center space-x-3">
                                    {/* Detailed Tracking Button/Status */}
                                    {isStepPrereq && (
                                        <button 
                                            onClick={() => openPrereqModal(key)} 
                                            className="bg-gray-200 text-gray-700 px-3 py-1 rounded-full text-sm font-semibold hover:bg-gray-300 transition"
                                        >
                                            Track Steps ({percent}%)
                                        </button>
                                    )}

                                    {/* Read-Only Status Badge (Lead Abatement) */}
                                    {isReadOnly && (
                                        <div className={`px-3 py-1 rounded-full text-sm font-semibold ${getStatusColor(percent).replace('bg', 'bg')}`}>
                                            {statusDisplay}
                                        </div>
                                    )}

                                    {/* Dropdown Status (Only for simple/non-read-only) */}
                                    {!isReadOnly && !isStepPrereq && (
                                        <div className="relative">
                                            <select
                                                value={currentStatus}
                                                onChange={(e) => handlePrereqDropdownChange(key, e.target.value)}
                                                className="block appearance-none bg-white border border-gray-300 text-gray-700 py-2 px-4 pr-8 rounded-lg shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 text-base"
                                            >
                                                {['Not Started', 'In Progress', 'Complete'].map(status => (
                                                    <option key={status} value={status}>{status}</option>
                                                ))}
                                            </select>
                                            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-gray-700">
                                                <ChevronDown size={16} />
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* --- PARTS TRACKING SECTION --- */}
            <div className="p-6 bg-white rounded-xl shadow-lg space-y-6">
                <div className="flex justify-between items-center border-b pb-3">
                    <h2 className="text-2xl font-bold text-gray-700">
                        {isLeadAbatementScope ? 'Things needing Abating' : 'Parts Tracking'} ({scope.parts?.length || 0})
                    </h2>
                    <button onClick={handleAddPart} className="bg-green-600 text-white px-4 py-2 rounded-lg font-semibold hover:bg-green-700 transition shadow-md flex items-center">
                        <Plus size={18} className="mr-2" /> Add New
                    </button>
                </div>

                <div className="grid grid-cols-1 gap-6">
                    {scope.parts && scope.parts.map(part => (
                        <DrawingCard 
                            key={part.id} 
                            part={part} 
                            scope={scope} 
                            updateScopeData={updateScopeData} 
                            allScopes={nonSummaryAndSelfScopes}
                            isLeadAbatementScope={isLeadAbatementScope}
                            otherScopeIds={otherScopeIds}
                        />
                    ))}
                    {(!scope.parts || scope.parts.length === 0) && (
                        <p className="text-center text-gray-500 p-8 border border-dashed rounded-lg">Click "Add New" to start tracking parts for this scope.</p>
                    )}
                </div>
            </div>
        </div>
    );
};


// Renders the main summary page
const SummaryPage = ({ scopes, setCurrentPage }) => {
    const nonSummaryScopes = scopes.filter(s => s.type === 'scope');
    const totalScopes = nonSummaryScopes.length;
    
    // Calculate total project progress
    const overallCompletionPercent = calculateOverallCompletion(nonSummaryScopes);
    
    const scopeDataWithProgress = nonSummaryScopes.map(scope => {
        const percent = calculateOverallCompletion(scope.parts);
        return { ...scope, percent };
    });

    return (
        <div className="p-4 md:p-8 w-full space-y-8">
            <h1 className="text-3xl font-extrabold text-gray-800 border-b pb-4">Project Overview</h1>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* 1. Overall Completion Ring */}
                <div className="lg:col-span-1 bg-white p-6 rounded-xl shadow-lg flex flex-col items-center">
                    <h2 className="text-xl font-bold text-gray-700 mb-4 border-b pb-2 w-full text-center">TMODs Completion</h2>
                    
                    {/* Ring Chart */}
                    <div className="relative w-48 h-48 my-4">
                        <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                            {/* Background track */}
                            <circle
                                cx="50"
                                cy="50"
                                r="45"
                                fill="transparent"
                                stroke="#e5e7eb"
                                strokeWidth="10"
                            />
                            {/* Progress bar */}
                            <circle
                                cx="50"
                                cy="50"
                                r="45"
                                fill="transparent"
                                stroke="currentColor"
                                strokeWidth="10"
                                strokeDasharray={2 * Math.PI * 45}
                                strokeDashoffset={2 * Math.PI * 45 * (1 - overallCompletionPercent / 100)}
                                className={getTextColor(overallCompletionPercent)}
                            />
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                            <span className="text-5xl font-extrabold text-gray-800">
                                {overallCompletionPercent}%
                            </span>
                            <span className="text-sm font-medium text-gray-500 mt-1">
                                {totalScopes} Scopes
                            </span>
                        </div>
                    </div>
                    
                    <StatusBadge percent={overallCompletionPercent} />
                </div>

                {/* 2. Scope Breakdown Table/Chart */}
                <div className="lg:col-span-2 bg-white p-6 rounded-xl shadow-lg">
                    <h2 className="text-xl font-bold text-gray-700 mb-4 border-b pb-2">Scope Breakdown</h2>
                    
                    <div className="space-y-3">
                        {scopeDataWithProgress.map(scope => (
                            <div 
                                key={scope.id} 
                                className="flex items-center justify-between p-3 bg-gray-50 rounded-lg shadow-sm border border-transparent transition duration-200 hover:shadow-md hover:border-indigo-300 cursor-pointer"
                                onClick={() => setCurrentPage(scope.id)}
                            >
                                <span className="text-lg font-medium text-gray-700 w-2/5 truncate">
                                    {scope.title}
                                </span>
                                <div className="flex items-center space-x-4">
                                    <StatusBadge percent={scope.percent} readOnly={true} />
                                    <MiniCircularProgress percent={scope.percent} />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};


// --- Sidebar Navigation Component ---
const Sidebar = ({ isOpen, toggleSidebar, currentPage, setCurrentPage, scopes, userId }) => {
    const handleNavigation = (pageId) => {
        setCurrentPage(pageId);
        if (isOpen) {
            toggleSidebar();
        }
    };

    return (
        <>
            {/* Overlay */}
            {isOpen && (
                <div 
                    className="fixed inset-0 z-40 bg-black bg-opacity-50 transition-opacity md:hidden"
                    onClick={toggleSidebar}
                />
            )}

            {/* Sidebar Content */}
            <div className={`fixed top-0 left-0 h-full w-64 bg-white shadow-2xl z-50 transform transition-transform duration-300 ease-in-out 
                ${isOpen ? 'translate-x-0' : '-translate-x-full'} md:relative md:translate-x-0 md:shadow-lg md:h-screen md:flex md:flex-col`}>
                
                <div className="p-4 border-b flex justify-between items-center">
                    <h2 className="text-xl font-bold text-indigo-700">MCR4 TMODs</h2>
                    <button onClick={toggleSidebar} className="text-gray-500 hover:text-gray-800 md:hidden p-1">
                        <X size={24} />
                    </button>
                </div>

                <nav className="flex flex-col p-2 space-y-1 overflow-y-auto flex-grow">
                    {scopes.map(scope => (
                        <button
                            key={scope.id}
                            onClick={() => handleNavigation(scope.id)}
                            className={`flex items-center px-3 py-2 rounded-lg text-sm font-medium transition duration-150 
                                ${currentPage === scope.id 
                                    ? 'bg-indigo-100 text-indigo-700 shadow-sm font-semibold' 
                                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-800'}`}
                        >
                            {/* FIX: Ensure SVG icons have a defined size to prevent stretching/overlap before styles load */}
                            {scope.id === 'summary' ? (
                                <svg className="w-5 h-5 mr-3 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg>
                            ) : (
                                <svg className="w-5 h-5 mr-3 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path></svg>
                            )}
                            {scope.title}
                        </button>
                    ))}
                </nav>
            </div>
        </>
    );
};


// --- Main Application Component ---
export default function App() {
    const { scopes, userId, updateScopeData, isLoading, error } = useFirebase();
    const [currentPage, setCurrentPage] = useState('summary');
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);

    // Default to summary page if scope data loads and current page is missing
    useEffect(() => {
        if (!isLoading && scopes.length > 0 && !scopes.some(s => s.id === currentPage)) {
            setCurrentPage('summary');
        }
    }, [isLoading, scopes, currentPage]);

    const currentScope = scopes.find(s => s.id === currentPage);
    const scopeTitle = currentScope?.title || 'Loading...';

    if (error) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-red-50 text-red-800">
                <h1 className="text-2xl font-bold mb-3">Deployment Error</h1>
                <p className="text-lg mb-6 text-center">
                    Configuration Error: {error}. This is often caused by missing Firebase configuration keys.
                </p>
                <p className="text-sm text-center bg-red-100 p-3 rounded-lg border border-red-300">
                    Your environment must provide the global variables: 
                    <code className="block mt-2 font-mono">VITE_APP_ID, VITE_FIREBASE_CONFIG, VITE_AUTH_TOKEN</code> 
                    (using the VITE_ prefix for Netlify/Vite deployment).
                </p>
                <p className="text-sm font-semibold mt-4">User ID: {userId}</p>
            </div>
        );
    }

    if (isLoading || scopes.length === 0) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-gray-50">
                <div className="animate-spin rounded-full h-16 w-16 border-b-4 border-indigo-500 mb-4" />
                <h1 className="text-xl font-bold text-gray-700">Loading scope data or initializing...</h1>
                <p className="text-sm text-gray-500 mt-2">Connecting to Firestore and checking for default data.</p>
                <p className="text-sm font-semibold mt-4">User ID: {userId || 'Loading...'}</p>
            </div>
        );
    }

    const renderPage = () => {
        if (!currentScope) {
            return (
                <div className="p-8 text-center text-gray-500">
                    Scope not found. Please select a page from the menu.
                </div>
            );
        }
        
        if (currentPage === 'summary') {
            return <SummaryPage scopes={scopes} setCurrentPage={setCurrentPage} />;
        }
        
        return (
            <ScopePage 
                scope={currentScope} 
                updateScopeData={updateScopeData} 
                allScopes={scopes} 
                setCurrentPage={setCurrentPage} 
            />
        );
    };

    return (
        <div className="flex min-h-screen bg-gray-50">
            {/* Sidebar (Rendered once, CSS handles desktop vs mobile visibility) */}
            <Sidebar 
                isOpen={isSidebarOpen} 
                toggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)} 
                currentPage={currentPage} 
                setCurrentPage={setCurrentPage} 
                scopes={scopes}
                userId={userId}
            />

            {/* Main Content Area */}
            <div className="flex-grow flex flex-col transition-all duration-300">
                {/* Top Bar for Mobile Navigation */}
                <header className="flex items-center p-4 bg-white shadow-md md:hidden sticky top-0 z-30">
                    <button onClick={() => setIsSidebarOpen(true)} className="text-gray-700 hover:text-indigo-600 p-2 rounded-lg">
                        <Menu size={24} />
                    </button>
                    <h1 className="text-lg font-bold text-gray-800 ml-4 truncate">
                        {scopeTitle}
                    </h1>
                </header>

                {/* Main Content */}
                <main className="flex-grow p-4 md:p-0 overflow-x-hidden">
                    {renderPage()}
                </main>
                
                {/* Footer showing User ID */}
                <footer className="p-4 border-t bg-white text-xs text-gray-500 flex justify-between items-center">
                    <span>
                        MCR4 TMODs Tracker v1.0 | Collaborative Progress
                    </span>
                    <span>
                        User ID: {userId}
                    </span>
                </footer>
            </div>
        </div>
    );
}
