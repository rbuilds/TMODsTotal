import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot, collection, query, writeBatch } from 'firebase/firestore';
import { Menu, X, CheckCircle, Clock, XCircle, ChevronDown, ChevronUp, Plus, Trash2, Loader, LayoutDashboard, Settings, Edit, Upload, FileText, Image, Download } from 'lucide-react';

// --- FIREBASE CONFIGURATION & UTILITIES ---

// Global variables provided by the environment
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-mcr4-tmods-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Convert firestore timestamp to readable string
const timeConverter = (timestamp) => {
  if (timestamp?.toDate) {
    return timestamp.toDate().toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }
  return 'N/A';
};

// --- DATA STRUCTURE & LOGIC UTILITIES ---

const SCOPE_NAMES = [
  'Lead Abatement',
  '4113a Civil Mod Interferences',
  '4113b FIF and Monorail',
  '4113c Feeder Lifting Frame',
  '4115a MET Civil',
  '4115b MET Mechanical',
  'Helium Supply Line removal',
  '4219 Header restraints Install'
];

const LEAD_ABATEMENT_TITLE = 'Lead Abatement';
const LEAD_ABATEMENT_ID = 'lead_abatement';
const OTHER_SCOPES = SCOPE_NAMES.filter(name => name !== LEAD_ABATEMENT_TITLE);

const getStatusColor = (status) => {
  switch (status) {
    case 'Complete': return 'bg-green-100 text-green-700 border-green-500';
    case 'In Progress': return 'bg-yellow-100 text-yellow-700 border-yellow-500';
    case 'Not Started': return 'bg-red-100 text-red-700 border-red-500';
    case 'N/A': return 'bg-gray-100 text-gray-700 border-gray-500';
    default: return 'bg-gray-100 text-gray-700 border-gray-500';
  }
};

/**
 * Checks if a prerequisite key supports step-based tracking.
 */
const isStepPrereq = (key) => key === 'materials' || key === 'generalPrereqs';

/**
 * Calculates the percentage complete based on steps.
 * @param {Array<Object>} steps
 * @returns {number} percentage
 */
const calculatePercentFromSteps = (steps) => {
    if (!steps || steps.length === 0) {
        return 0;
    }
    const completedSteps = steps.filter(s => s.isComplete).length;
    const totalSteps = steps.length;
    return totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
};


/**
 * Calculates the overall status for a drawing based on its actions.
 * @param {Array<Object>} actions
 * @returns {'red'|'yellow'|'green'}
 */
const getDrawingStatus = (actions) => {
  if (!actions || actions.length === 0) return 'red';

  let totalPercent = 0;
  let validActions = 0;

  actions.forEach(action => {
      // Calculate percent based on steps in the action modal
      const currentPercent = calculatePercentFromSteps(action.steps);
      totalPercent += currentPercent;
      validActions++;
  });

  if (validActions === 0) return 'red';

  const overallAverage = totalPercent / validActions;

  if (overallAverage === 100) return 'green'; // All 100%
  if (overallAverage === 0) return 'red'; // All 0%
  if (overallAverage > 0 && overallAverage < 100) return 'yellow'; // Mixed or anything started but not all finished

  return 'red'; // Fallback to Not Started
};

const getStatusBorder = (status) => {
  switch (status) {
    case 'green': return 'border-green-500';
    case 'yellow': return 'border-yellow-500';
    case 'red': return 'border-red-500';
    default: return 'border-gray-300';
  }
};

/**
 * Calculates the total completion percentage of lead abatement items
 * specifically related to a given target scope.
 * @param {Object} allScopes - The full scopes object from Firestore.
 * @param {string} targetScopeId - The ID of the scope being checked (e.g., '4113a_civil_mod_interferences').
 * @returns {{percent: number, totalSteps: number, completedSteps: number, linkedItemsCount: number}}
 */
const getLeadAbatementProgressForScope = (allScopes, targetScopeId) => {
    const abatementScope = allScopes[LEAD_ABATEMENT_ID];

    if (!abatementScope || !abatementScope.drawings) {
        return { percent: 0, totalSteps: 0, completedSteps: 0, linkedItemsCount: 0 };
    }

    // Filter drawings in the Lead Abatement scope that are linked to the current target scope
    const relevantDrawings = abatementScope.drawings.filter(
        d => d.relatedScopeId === targetScopeId
    );
    
    if (relevantDrawings.length === 0) {
        return { percent: 0, totalSteps: 0, completedSteps: 0, linkedItemsCount: 0 }; 
    }

    let totalSteps = 0;
    let completedSteps = 0;
    
    relevantDrawings.forEach(drawing => {
        drawing.actions.forEach(action => {
            // NOTE: Even for simplified abatement actions, completion is determined by steps (usually just one step)
            totalSteps += action.steps?.length || 0;
            completedSteps += (action.steps || []).filter(s => s.isComplete).length;
        });
    });

    const percent = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
    
    return { percent, totalSteps, completedSteps, linkedItemsCount: relevantDrawings.length };
};


/**
 * Generates initial data for a single scope page.
 */
const createDefaultScopeData = (title) => {
  const scopeId = title.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const defaultDrawingName = `${title.substring(0, 4)}-PART-${Math.floor(Math.random() * 900) + 100}`;

  return {
    id: scopeId,
    title,
    // Prereqs now use objects to hold status, steps, and notes
    prereqs: {
      materials: {
          status: 'Not Started',
          notes: 'Initial material requisition and long-lead item tracking.',
          steps: [
              { id: crypto.randomUUID(), description: 'Issue Material Request (MR)', isComplete: false },
              { id: crypto.randomUUID(), description: 'Confirm long-lead items delivery date', isComplete: false },
              { id: crypto.randomUUID(), description: 'Verify materials received against bill of materials', isComplete: false }
          ]
      },
      leadAbatement: {
          // Status is ignored for non-Lead Abatement scopes, but needed for initialization
          status: title.includes('Lead') ? 'In Progress' : 'Not Started', 
          notes: title.includes('Lead') ? 'Abatement area defined and isolation setup started.' : 'Status derived from linked abatement items.',
          steps: []
      },
      generalPrereqs: {
          status: 'Not Started',
          notes: 'Obtaining required permits and access clearances.',
          steps: [
              { id: crypto.randomUUID(), description: 'Obtain Area Access Permit (AAP)', isComplete: false },
              { id: crypto.randomUUID(), description: 'Complete Job Hazard Analysis (JHA)', isComplete: false }
          ]
      }
    },
    drawings: [
      {
        id: crypto.randomUUID(),
        name: defaultDrawingName,
        description: `Part/Area requiring modification for ${title}`,
        imageUrl: '', // For temporary client-side image display
        relatedScopeId: null, // Field to link abatement items to the related scope
        actions: [
          {
            id: crypto.randomUUID(),
            description: 'Perform Initial Site Survey',
            percentComplete: 0,
            notes: 'Check for potential interferences.',
            // Default actions for abatement should be single step for simple checkmark functionality
            steps: [{ id: crypto.randomUUID(), description: 'Action complete?', isComplete: false }],
            imageAttachment: null, // Stores { name } for local display
          },
        ]
      },
    ]
  };
};

// --- FIREBASE HOOK ---
const useFirebase = () => {
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [userId, setUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [scopes, setScopes] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // 1. Initialization and Authentication
  useEffect(() => {
    if (!firebaseConfig) {
      console.error("Firebase config is missing.");
      setError("Configuration Error: Firebase settings are missing.");
      setIsLoading(false);
      return;
    }

    try {
      const app = initializeApp(firebaseConfig);
      const firestore = getFirestore(app);
      const authInstance = getAuth(app);

      setDb(firestore);
      setAuth(authInstance);

      const handleAuth = async (user) => {
        if (user) {
          setUserId(user.uid);
        } else {
          // If the initial token didn't work or user signed out, sign in anonymously
          await signInAnonymously(authInstance);
        }
        setIsAuthReady(true);
      };

      // Set up the listener for auth state changes
      const unsubscribe = onAuthStateChanged(authInstance, (user) => {
        if (!user && initialAuthToken) {
          // Attempt custom sign-in if token exists
          signInWithCustomToken(authInstance, initialAuthToken)
            .then(({ user: customUser }) => handleAuth(customUser))
            .catch(async (e) => {
              console.error("Custom token sign-in failed. Falling back to anonymous.", e);
              await signInAnonymously(authInstance);
            });
        } else {
          handleAuth(user);
        }
      });

      return () => unsubscribe();

    } catch (e) {
      console.error("Firebase initialization failed:", e);
      setError("Firebase Initialization Failed. Check configuration.");
      setIsLoading(false);
    }
  }, []);

  // 2. Data Listener (onSnapshot) and Initialization
  useEffect(() => {
    if (db && isAuthReady) {
      const collectionPath = `/artifacts/${appId}/public/data/scopes`;
      const q = query(collection(db, collectionPath));

      const unsubscribe = onSnapshot(q, async (querySnapshot) => {
        // We set loading true here to cover the time taken to process the snapshot/commit batch
        // The final resolution to false happens only on success or explicit error.
        setIsLoading(true); 
        const fetchedScopes = {};
        querySnapshot.forEach((doc) => {
          fetchedScopes[doc.id] = doc.data();
        });

        if (querySnapshot.empty) {
          console.log("Snapshot 1: Scopes collection is empty. Initializing data...");
          // If empty, commit the batch and rely on the subsequent snapshot to resolve loading.
          const batch = writeBatch(db);
          SCOPE_NAMES.forEach(title => {
            const scopeData = createDefaultScopeData(title);
            const docRef = doc(db, collectionPath, scopeData.id);
            batch.set(docRef, scopeData);
          });
          try {
             await batch.commit();
             console.log("Default data committed. Waiting for Snapshot 2 (Real-time update)...");
             // Do NOT set setScopes or setIsLoading(false) here. Wait for the triggered snapshot (Snapshot 2).
          } catch (batchError) {
             console.error("Batch commit failed:", batchError);
             setError("Failed to initialize project data: " + batchError.message);
             setIsLoading(false); // Resolve loading on failure
          }
        } else {
          // Snapshot 2 (or a normal snapshot) has data. Resolve loading state.
          console.log(`Snapshot received. Found ${querySnapshot.size} scopes. Loading complete.`);
          setScopes(fetchedScopes);
          setIsLoading(false); // Resolve loading only when data is successfully fetched
        }
      }, (e) => {
        console.error("Firestore data snapshot failed:", e);
        setError("Error fetching project data: " + e.message);
        setIsLoading(false); // Resolve loading on any snapshot error
      });

      return () => unsubscribe();
    }
  }, [db, isAuthReady]);

  // 3. Update Function
  const updateScopeData = useCallback(async (scopeId, updatedData) => {
    if (!db) return console.error("Database not initialized.");
    try {
      const collectionPath = `/artifacts/${appId}/public/data/scopes`;
      const docRef = doc(db, collectionPath, scopeId);
      await setDoc(docRef, updatedData, { merge: false }); // Overwrite the specific scope document
      console.log(`Scope ${scopeId} updated successfully.`);
    } catch (e) {
      console.error("Error updating document: ", e);
      setError("Failed to save progress: " + e.message);
    }
  }, [db]);

  return { scopes, userId, isLoading, error, updateScopeData };
};

// --- PREREQUISITE MODAL COMPONENT ---

const PrereqModal = ({ prereqKey, prereqData, scope, onClose, updateScopeData }) => {
    const [currentPrereq, setCurrentPrereq] = useState(prereqData);
    const [newStep, setNewStep] = useState('');

    const titleMap = {
        materials: 'Materials Tracking Steps',
        generalPrereqs: 'General Prerequisite Steps',
        leadAbatement: 'Lead Abatement Process'
    };
    const title = titleMap[prereqKey] || prereqKey;
    const isTrackable = isStepPrereq(prereqKey);
    const percentComplete = isTrackable ? calculatePercentFromSteps(currentPrereq.steps) : 0;

    const handleSave = () => {
        let updatedStatus = currentPrereq.status;
        
        if (isTrackable) {
            const percent = calculatePercentFromSteps(currentPrereq.steps);
            if (percent === 100) updatedStatus = 'Complete';
            else if (percent > 0) updatedStatus = 'In Progress';
            else updatedStatus = 'Not Started';
        }

        const updatedPrereq = { 
            ...currentPrereq, 
            status: updatedStatus,
            lastUpdated: new Date()
        };
        
        const newPrereqs = { ...scope.prereqs, [prereqKey]: updatedPrereq };
        updateScopeData(scope.id, { ...scope, prereqs: newPrereqs });
        onClose();
    };

    const handleStepToggle = (stepId) => {
        const newSteps = currentPrereq.steps.map(step => 
            step.id === stepId ? { ...step, isComplete: !step.isComplete } : step
        );
        setCurrentPrereq(prev => ({ ...prev, steps: newSteps }));
    };

    const handleAddStep = () => {
        if (newStep.trim()) {
            const step = {
                id: crypto.randomUUID(),
                description: newStep.trim(),
                isComplete: false,
            };
            setCurrentPrereq(prev => ({ ...prev, steps: [...prev.steps, step] }));
            setNewStep('');
        }
    };

    const handleDeleteStep = (stepId) => {
        const newSteps = currentPrereq.steps.filter(step => step.id !== stepId);
        setCurrentPrereq(prev => ({ ...prev, steps: newSteps }));
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-70 p-4" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg md:max-w-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                
                {/* Modal Header */}
                <div className="p-5 border-b flex justify-between items-center sticky top-0 bg-white rounded-t-xl">
                    <h3 className="text-xl font-bold text-gray-800 flex items-center">
                        <CheckCircle className="w-6 h-6 mr-2 text-green-600"/> {title}
                    </h3>
                    <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100 transition">
                        <X className="w-5 h-5 text-gray-500"/>
                    </button>
                </div>

                {/* Modal Content */}
                <div className="p-5 space-y-6">
                    
                    {isTrackable && (
                        <div className="space-y-2">
                            <div className="text-lg font-semibold text-gray-700">Completion Status: {percentComplete}%</div>
                            <div className="w-full bg-gray-200 rounded-full h-3">
                                <div className="h-3 rounded-full transition-all duration-500" style={{ width: `${percentComplete}%`, backgroundColor: percentComplete === 100 ? '#10B981' : (percentComplete > 0 ? '#F59E0B' : '#EF4444') }}></div>
                            </div>
                        </div>
                    )}

                    {/* Step Tracker */}
                    {isTrackable && (
                        <div className="bg-gray-50 p-4 rounded-lg border">
                            <h4 className="font-bold text-gray-800 mb-3 flex items-center">
                                <FileText className="w-4 h-4 mr-2 text-blue-600"/> Execution Steps ({currentPrereq.steps.filter(s => s.isComplete).length}/{currentPrereq.steps.length})
                            </h4>
                            <div className="space-y-2">
                                {currentPrereq.steps.map(step => (
                                    <div key={step.id} className="flex items-center p-2 rounded-md hover:bg-white transition bg-white shadow-sm">
                                        <input 
                                            type="checkbox" 
                                            checked={step.isComplete} 
                                            onChange={() => handleStepToggle(step.id)}
                                            className="h-5 w-5 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer"
                                        />
                                        <span className={`ml-3 text-sm flex-1 ${step.isComplete ? 'line-through text-gray-500' : 'text-gray-800'}`}>
                                            {step.description}
                                        </span>
                                        <button onClick={() => handleDeleteStep(step.id)} className="text-red-400 hover:text-red-600 p-1 transition">
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>

                            {/* Add New Step */}
                            <div className="flex mt-3 space-x-2">
                                <input
                                    type="text"
                                    placeholder="Add new step..."
                                    value={newStep}
                                    onChange={(e) => setNewStep(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleAddStep()}
                                    className="flex-1 p-2 border rounded-lg text-sm focus:ring-blue-500 focus:border-blue-500"
                                />
                                <button onClick={handleAddStep} className="bg-blue-600 text-white p-2 rounded-lg hover:bg-blue-700 transition">
                                    <Plus className="w-5 h-5" />
                                </button>
                            </div>
                        </div>
                    )}
                    
                    {/* Notes Section */}
                    <div>
                        <h4 className="font-bold text-gray-800 mb-2">Notes</h4>
                        <textarea
                            value={currentPrereq.notes}
                            onChange={(e) => setCurrentPrereq(prev => ({ ...prev, notes: e.target.value }))}
                            placeholder="Add detailed notes or observations..."
                            rows="3"
                            className="w-full p-2 text-sm border rounded-lg focus:ring-blue-500 focus:border-blue-500 transition bg-white"
                        />
                    </div>
                </div>

                {/* Modal Footer */}
                <div className="p-4 border-t flex justify-end sticky bottom-0 bg-white rounded-b-xl">
                    <button 
                        onClick={handleSave} 
                        className="bg-green-600 text-white p-3 rounded-lg font-semibold hover:bg-green-700 transition shadow-lg"
                    >
                        Save & Close
                    </button>
                </div>
            </div>
        </div>
    );
};


// --- ACTION MODAL COMPONENT (Only used for non-abatement scopes) ---

const ActionModal = ({ action, scope, drawing, onClose, updateScopeData }) => {
    const [currentAction, setCurrentAction] = useState(action);
    const [newStep, setNewStep] = useState('');
    const [tempImage, setTempImage] = useState(action.imageAttachment || null); 

    const percentComplete = useMemo(() => 
        calculatePercentFromSteps(currentAction.steps)
    , [currentAction.steps]);


    const handleSave = () => {
        let attachmentToPersist = null;
        if (tempImage) {
            attachmentToPersist = { name: tempImage.name };
        }

        const updatedAction = { 
            ...currentAction, 
            percentComplete: percentComplete, 
            imageAttachment: attachmentToPersist, 
            lastUpdated: new Date()
        };

        const newDrawings = scope.drawings.map(d => {
            if (d.id === drawing.id) {
                return {
                    ...d,
                    actions: d.actions.map(a => 
                        a.id === action.id ? updatedAction : a
                    )
                };
            }
            return d;
        });

        updateScopeData(scope.id, { ...scope, drawings: newDrawings });
        onClose();
    };

    const handleStepToggle = (stepId) => {
        const newSteps = currentAction.steps.map(step => 
            step.id === stepId ? { ...step, isComplete: !step.isComplete } : step
        );
        setCurrentAction(prev => ({ ...prev, steps: newSteps }));
    };

    const handleAddStep = () => {
        if (newStep.trim()) {
            const step = {
                id: crypto.randomUUID(),
                description: newStep.trim(),
                isComplete: false,
            };
            setCurrentAction(prev => ({ ...prev, steps: [...prev.steps, step] }));
            setNewStep('');
        }
    };

    const handleDeleteStep = (stepId) => {
        const newSteps = currentAction.steps.filter(step => step.id !== stepId);
        setCurrentAction(prev => ({ ...prev, steps: newSteps }));
    };

    const handleImageUpload = (e) => {
        const file = e.target.files[0];
        if (file && file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (event) => {
                setTempImage({
                    name: file.name,
                    dataURL: event.target.result 
                });
            };
            reader.readAsDataURL(file);
        } else if (file) {
            console.error("Please upload a valid image file.");
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-70 p-4" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg md:max-w-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                
                {/* Modal Header */}
                <div className="p-5 border-b flex justify-between items-center sticky top-0 bg-white rounded-t-xl">
                    <h3 className="text-xl font-bold text-gray-800 flex items-center">
                        <FileText className="w-6 h-6 mr-2 text-blue-600"/> {action.description}
                    </h3>
                    <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100 transition">
                        <X className="w-5 h-5 text-gray-500"/>
                    </button>
                </div>

                {/* Modal Content */}
                <div className="p-5 space-y-6">
                    
                    {/* Progress Bar */}
                    <div className="space-y-2">
                        <div className="text-lg font-semibold text-gray-700">Completion Status: {percentComplete}%</div>
                        <div className="w-full bg-gray-200 rounded-full h-3">
                            <div className="h-3 rounded-full transition-all duration-500" style={{ width: `${percentComplete}%`, backgroundColor: percentComplete === 100 ? '#10B981' : (percentComplete > 0 ? '#F59E0B' : '#EF4444') }}></div>
                            </div>
                        </div>
                    

                    {/* Step Tracker */}
                    <div className="bg-gray-50 p-4 rounded-lg border">
                        <h4 className="font-bold text-gray-800 mb-3 flex items-center">
                            <CheckCircle className="w-4 h-4 mr-2 text-green-600"/> Execution Steps ({currentAction.steps.filter(s => s.isComplete).length}/{currentAction.steps.length})
                        </h4>
                        <div className="space-y-2">
                            {currentAction.steps.map(step => (
                                <div key={step.id} className="flex items-center p-2 rounded-md hover:bg-white transition bg-white shadow-sm">
                                    <input 
                                        type="checkbox" 
                                        checked={step.isComplete} 
                                        onChange={() => handleStepToggle(step.id)}
                                        className="h-5 w-5 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer"
                                    />
                                    <span className={`ml-3 text-sm flex-1 ${step.isComplete ? 'line-through text-gray-500' : 'text-gray-800'}`}>
                                        {step.description}
                                    </span>
                                    <button onClick={() => handleDeleteStep(step.id)} className="text-red-400 hover:text-red-600 p-1 transition">
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            ))}
                        </div>

                        {/* Add New Step */}
                        <div className="flex mt-3 space-x-2">
                            <input
                                type="text"
                                placeholder="Add new step..."
                                value={newStep}
                                onChange={(e) => setNewStep(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleAddStep()}
                                className="flex-1 p-2 border rounded-lg text-sm focus:ring-blue-500 focus:border-blue-500"
                            />
                            <button onClick={handleAddStep} className="bg-blue-600 text-white p-2 rounded-lg hover:bg-blue-700 transition">
                                <Plus className="w-5 h-5" />
                            </button>
                        </div>
                    </div>
                    
                    {/* Notes Section */}
                    <div>
                        <h4 className="font-bold text-gray-800 mb-2">Notes</h4>
                        <textarea
                            value={currentAction.notes}
                            onChange={(e) => setCurrentAction(prev => ({ ...prev, notes: e.target.value, lastUpdated: new Date() }))}
                            placeholder="Add detailed notes or observations..."
                            rows="3"
                            className="w-full p-2 text-sm border rounded-lg focus:ring-blue-500 focus:border-blue-500 transition bg-white"
                        />
                    </div>

                    {/* Image Attachment */}
                    <div className="border p-4 rounded-lg bg-gray-50">
                        <h4 className="font-bold text-gray-800 mb-2 flex items-center">
                            <Image className="w-4 h-4 mr-2 text-purple-600"/> Image Attachment
                        </h4>
                        <input
                            type="file"
                            accept="image/jpeg,image/png,image/jpg"
                            onChange={handleImageUpload}
                            id="image-upload-input"
                            className="hidden"
                        />
                        <label htmlFor="image-upload-input" className="cursor-pointer bg-purple-600 text-white p-3 rounded-lg flex items-center justify-center hover:bg-purple-700 transition shadow-md">
                            <Upload className="w-5 h-5 mr-2"/> {tempImage && tempImage.dataURL ? `Replace Image: ${tempImage.name}` : 'Upload Image (JPG/PNG)'}
                        </label>
                        {tempImage && tempImage.dataURL && (
                            <div className="mt-3 p-3 bg-white border rounded-lg">
                                <p className="text-sm font-medium text-gray-700 truncate">{tempImage.name}</p>
                                <img src={tempImage.dataURL} alt="Attachment Preview" className="mt-2 w-full h-40 object-contain border rounded-md" />
                                <p className="text-xs text-red-500 mt-2">
                                    <span className='font-bold'>Note:</span> This image is displayed using local data (Base64) and <span className='font-bold'>will not persist</span> if you refresh the page or view on another device, due to Firestore document size limits.
                                </p>
                            </div>
                        )}
                         {tempImage && !tempImage.dataURL && (
                            <div className="mt-3 p-3 bg-white border rounded-lg">
                                <p className="text-sm font-medium text-gray-700 truncate">Image Placeholder: {tempImage.name}</p>
                                <p className="text-xs text-gray-500 mt-2">Image metadata is saved, but the file content is not stored in Firestore. Re-upload is required to preview after refresh.</p>
                            </div>
                        )}
                    </div>
                </div>

                {/* Modal Footer */}
                <div className="p-4 border-t flex justify-end sticky bottom-0 bg-white rounded-b-xl">
                    <button 
                        onClick={handleSave} 
                        className="bg-green-600 text-white p-3 rounded-lg font-semibold hover:bg-green-700 transition shadow-lg"
                    >
                        Save & Close Action
                    </button>
                </div>
            </div>
        </div>
    );
};


// --- CORE COMPONENTS ---

const Header = ({ currentTitle, toggleSidebar }) => (
  <header className="bg-gray-900 text-white p-4 shadow-xl flex justify-between items-center fixed top-0 w-full z-40">
    <div className="flex items-center">
      <button onClick={toggleSidebar} className="p-2 mr-3 rounded-lg hover:bg-gray-700 transition">
        <Menu className="w-6 h-6" />
      </button>
      <h1 className="text-xl font-extrabold font-inter truncate text-green-400">{currentTitle}</h1>
    </div>
    <div className="flex items-center space-x-2">
      <div className="hidden sm:block text-xs text-gray-400">Public User ID:</div>
      <Settings className="w-5 h-5 text-gray-500"/>
    </div>
  </header>
);

const Sidebar = ({ isOpen, toggleSidebar, navItems, currentPage, setCurrentPage, userId }) => {
  const baseClasses = "fixed inset-y-0 left-0 transform bg-gray-800 text-white w-64 p-4 z-50 transition-transform duration-300 shadow-2xl overflow-y-auto";
  const finalClasses = isOpen ? baseClasses : `${baseClasses} -translate-x-full`;

  const handleNavClick = (page) => {
    setCurrentPage(page);
    toggleSidebar();
  };

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div className="fixed inset-0 bg-black opacity-50 z-40" onClick={toggleSidebar}></div>
      )}

      {/* Sidebar */}
      <div className={finalClasses}>
        <div className="flex justify-between items-center mb-6 border-b border-gray-700 pb-3">
          <h2 className="text-2xl font-extrabold text-green-400">MCR4 TMODs</h2>
          <button onClick={toggleSidebar} className="p-1 rounded-full hover:bg-gray-700">
            <X className="w-5 h-5 text-gray-500"/>
          </button>
        </div>

        <nav className="space-y-2">
          {navItems.map((item) => (
            <button
              key={item}
              onClick={() => handleNavClick(item)}
              className={`w-full text-left p-3 rounded-xl transition duration-150 flex items-center ${
                currentPage === item
                  ? 'bg-green-600 font-bold shadow-lg'
                  : 'hover:bg-gray-700 text-gray-300'
              }`}
            >
              {item === 'MCR4 TMODs Summary' ? <LayoutDashboard className="w-5 h-5 mr-3"/> : <Settings className="w-5 h-5 mr-3"/>}
              {item}
            </button>
          ))}
        </nav>

        <div className="mt-auto pt-6 border-t border-gray-700 absolute bottom-0 left-0 right-0 p-4">
          <p className="text-xs text-gray-500">
            User ID: <span className="font-mono break-all text-gray-400">{userId || 'Loading...'}</span>
          </p>
        </div>
      </div>
    </>
  );
};

const PrereqSection = ({ scope, updateScopeData, allScopes }) => {
  const [selectedPrereqKey, setSelectedPrereqKey] = useState(null);
  const prereqData = scope.prereqs;
  const prereqKeys = Object.keys(prereqData);
  const statusOptions = ['Not Started', 'In Progress', 'Complete', 'N/A'];

  const handleStatusChange = (key, newStatus) => {
    // Only allow changes for Materials and General Prereqs
    if (key === 'leadAbatement') return; 

    const currentData = prereqData[key];
    
    // Determine if we're dealing with a simple string status (legacy/Lead Abatement) or an object
    const updatedPrereq = isStepPrereq(key) 
        ? { ...currentData, status: newStatus }
        : newStatus; 

    const newPrereqs = { ...prereqData, [key]: updatedPrereq };
    updateScopeData(scope.id, { ...scope, prereqs: newPrereqs });
  };
  
  const getDisplayStatus = (key) => {
      const data = prereqData[key];
      
      // NEW LOGIC: If it's Lead Abatement AND we are NOT on the Lead Abatement page:
      if (key === 'leadAbatement' && scope.id !== LEAD_ABATEMENT_ID) {
          const { percent, linkedItemsCount } = getLeadAbatementProgressForScope(allScopes, scope.id);
          
          if (linkedItemsCount === 0) return 'N/A';
          if (percent === 100) return 'Complete';
          if (percent > 0) return 'In Progress';
          
          return 'Not Started'; // 0% complete but items are linked
      }
      
      return typeof data === 'string' ? data : data.status;
  };

  const getStepProgress = (key) => {
      const data = prereqData[key];
      if (isStepPrereq(key) && data && data.steps) {
          const percent = calculatePercentFromSteps(data.steps);
          
          return (
              <div className="flex items-center text-xs ml-4 space-x-2 cursor-pointer text-blue-600 hover:underline">
                  <div className="w-12 h-1.5 bg-gray-300 rounded-full">
                      <div className="h-1.5 rounded-full transition-all duration-500" style={{ width: `${percent}%`, backgroundColor: percent === 100 ? '#10B981' : (percent > 0 ? '#F59E0B' : '#EF4444') }}></div>
                  </div>
                  <span>{percent}%</span>
              </div>
          );
      }
      return null;
  };

  return (
    <section className="mt-6 p-6 bg-white shadow-xl rounded-xl">
      {selectedPrereqKey && (
          <PrereqModal
              prereqKey={selectedPrereqKey}
              prereqData={prereqData[selectedPrereqKey]}
              scope={scope}
              onClose={() => setSelectedPrereqKey(null)}
              updateScopeData={updateScopeData}
          />
      )}

      <h2 className="text-2xl font-bold mb-4 text-gray-800 border-b pb-2">Prerequisite Status</h2>
      <div className="space-y-4">
        {prereqKeys.map((key) => {
          const displayStatus = getDisplayStatus(key);
          const isTrackableItem = isStepPrereq(key);
          const isExternalLeadAbatement = key === 'leadAbatement' && scope.id !== LEAD_ABATEMENT_ID; // New flag

          // Render button for step-based items, or just the label for dropdown-only
          const PrereqLabel = (
            <label className="capitalize font-semibold text-gray-700 mb-1 sm:mb-0">
              {key.replace(/([A-Z])/g, ' $1').trim()}
            </label>
          );
          
          return (
            <div 
              key={key} 
              className={`flex flex-col sm:flex-row justify-between items-start sm:items-center p-4 border-l-8 rounded-lg transition duration-150 shadow-sm ${isTrackableItem && !isExternalLeadAbatement ? 'cursor-pointer hover:bg-gray-100 bg-gray-50' : 'bg-white'}`} 
              style={{borderColor: getStatusColor(displayStatus).match(/border-(\w+-\d+)/)?.[1] || 'gray-300'}}
              onClick={isTrackableItem && !isExternalLeadAbatement ? () => setSelectedPrereqKey(key) : undefined}
            >
              <div className="flex items-center">
                  {PrereqLabel}
                  {isTrackableItem && getStepProgress(key)}
                  
                  {/* NEW: Display external progress for Lead Abatement */}
                  {isExternalLeadAbatement && (() => {
                      const { percent, linkedItemsCount } = getLeadAbatementProgressForScope(allScopes, scope.id);
                      
                      if (linkedItemsCount === 0) {
                          return <span className="ml-4 text-xs font-medium text-gray-500">(No abatement items linked)</span>;
                      }

                      return (
                          <div className="flex items-center text-xs ml-4 space-x-2">
                              <div className="w-12 h-1.5 bg-gray-300 rounded-full">
                                  <div className="h-1.5 rounded-full transition-all duration-500" style={{ width: `${percent}%`, backgroundColor: percent === 100 ? '#10B981' : (percent > 0 ? '#F59E0B' : '#EF4444') }}></div>
                              </div>
                              <span className='font-bold text-gray-700'>{percent}%</span>
                              <span className='text-gray-500'>(Linked Abatement Progress)</span>
                          </div>
                      );
                  })()}
              </div>
              
              <div className="relative inline-block w-full sm:w-auto flex items-center space-x-2">
                {/* Status Display: Read-only derived status for external Lead Abatement */}
                {isExternalLeadAbatement ? (
                    <span className={`block w-full py-2 px-3 text-sm border rounded-lg transition font-semibold text-center shadow-inner ${getStatusColor(displayStatus)}`}>
                        {displayStatus}
                    </span>
                ) : (
                    // Existing Select Dropdown for local/step prereqs
                    <select
                        value={displayStatus}
                        onChange={(e) => handleStatusChange(key, e.target.value)}
                        className={`appearance-none block w-full py-2 pl-3 pr-10 text-sm border rounded-lg focus:ring-2 focus:ring-blue-500 cursor-pointer transition shadow-inner ${getStatusColor(displayStatus)}`}
                        disabled={isTrackableItem}
                    >
                        {statusOptions.map(option => (
                            <option key={option} value={option}>{option}</option>
                        ))}
                    </select>
                )}
                
                {/* Chevron icon for dropdown/modal trigger */}
                {(!isExternalLeadAbatement && !isTrackableItem) && <ChevronDown className="pointer-events-none w-4 h-4 absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-600"/>}

                {/* Edit button for local step prereqs (Materials/General) */}
                {isTrackableItem && !isExternalLeadAbatement && (
                    <button 
                        onClick={(e) => { e.stopPropagation(); setSelectedPrereqKey(key); }}
                        className="p-2 bg-blue-600 rounded-lg text-white hover:bg-blue-700 transition shadow-md flex-shrink-0 ml-2"
                        title="Edit Steps and Notes"
                    >
                        <Edit className="w-4 h-4" />
                    </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};

const ActionList = ({ drawing, scope, updateScopeData, openModal, isAbatement = false }) => {
  const [newActionDescription, setNewActionDescription] = useState('');

  const addAction = () => {
    if (newActionDescription.trim()) {
      const newAction = {
        id: crypto.randomUUID(),
        description: newActionDescription.trim(),
        percentComplete: 0,
        notes: '',
        // Abatement actions always start with a single step for simple checkmark functionality
        steps: [{ id: crypto.randomUUID(), description: isAbatement ? 'Abatement Action Complete?' : 'Define the scope and steps', isComplete: false }],
        imageAttachment: null,
        lastUpdated: new Date(),
      };

      const newDrawings = scope.drawings.map(d => {
        if (d.id === drawing.id) {
          return { ...d, actions: [...d.actions, newAction] };
        }
        return d;
      });

      updateScopeData(scope.id, { ...scope, drawings: newDrawings });
      setNewActionDescription('');
    }
  };

  const deleteAction = (actionId) => {
    const newDrawings = scope.drawings.map(d => {
      if (d.id === drawing.id) {
        return {
          ...d,
          actions: d.actions.filter(a => a.id !== actionId)
        };
      }
      return d;
    });
    updateScopeData(scope.id, { ...scope, drawings: newDrawings });
  };
  
  // Function to handle simple checkbox update (only for abatement)
  const toggleAbatementAction = (actionId) => {
      const newDrawings = scope.drawings.map(d => {
          if (d.id === drawing.id) {
              return {
                  ...d,
                  actions: d.actions.map(a => {
                      if (a.id === actionId) {
                          // Toggle the completion of the *first* (and only) step
                          const updatedSteps = a.steps.map((step, index) => 
                              index === 0 ? { ...step, isComplete: !step.isComplete } : step
                          );
                          return { 
                              ...a, 
                              steps: updatedSteps, 
                              lastUpdated: new Date() 
                          };
                      }
                      return a;
                  })
              };
          }
          return d;
      });
      updateScopeData(scope.id, { ...scope, drawings: newDrawings });
  };


  return (
    <div className="space-y-4">
      <div className="flex flex-col space-y-3">
        <input
          type="text"
          placeholder={isAbatement ? "New abatement action description..." : "New action description..."}
          value={newActionDescription}
          onChange={(e) => setNewActionDescription(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addAction()}
          className="p-3 border border-gray-300 rounded-xl focus:ring-blue-500 focus:border-blue-500 shadow-inner transition"
        />
        <button
          onClick={addAction}
          className="bg-blue-600 text-white p-3 rounded-xl font-semibold hover:bg-blue-700 transition duration-150 flex items-center justify-center shadow-lg"
        >
          <Plus className="w-5 h-5 mr-2" /> {isAbatement ? 'Add Abatement Item' : 'Add Action Item'}
        </button>
      </div>
      
      {/* Abatement Checkbox View (Simplified) */}
      {isAbatement && (
        <div className="space-y-3">
            {drawing.actions.map((action) => {
                const percent = calculatePercentFromSteps(action.steps);
                const isComplete = percent === 100;

                return (
                    <div 
                        key={action.id} 
                        className={`bg-white p-4 rounded-xl shadow-md border ${isComplete ? 'border-green-400 bg-green-50' : 'border-gray-300 hover:border-red-400 bg-gray-50'} flex items-center justify-between transition`}
                    >
                        <div className='flex items-center flex-1 pr-4 cursor-pointer' onClick={() => toggleAbatementAction(action.id)}>
                            <input
                                type="checkbox"
                                checked={isComplete}
                                onChange={() => toggleAbatementAction(action.id)}
                                // This is disabled because the parent div handles the click, but we need it for mobile touch
                                className="h-6 w-6 text-green-600 rounded border-gray-300 focus:ring-green-500 cursor-pointer flex-shrink-0"
                            />
                            <span className={`ml-3 font-medium text-gray-800 flex-1 ${isComplete ? 'line-through text-gray-500' : ''}`}>
                                {action.description}
                            </span>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); deleteAction(action.id); }} className="text-red-500 hover:text-red-700 p-1 rounded-full transition flex-shrink-0" title="Delete Abatement Item">
                            <Trash2 className="w-4 h-4" />
                        </button>
                    </div>
                );
            })}
        </div>
      )}

      {/* Standard Modal View (Non-Abatement Scopes) */}
      {!isAbatement && (
          <div className="space-y-3">
            {drawing.actions.map((action) => {
                const percent = calculatePercentFromSteps(action.steps);
                let icon = <Clock className="w-4 h-4 text-white" />;
                let bgColor = 'red';
                if (percent === 100) { icon = <CheckCircle className="w-4 h-4 text-white" />; bgColor = 'green'; }
                else if (percent > 0) { bgColor = 'orange'; }

                return (
                  <div 
                      key={action.id} 
                      className="bg-white p-4 rounded-xl shadow-md border border-gray-200 cursor-pointer hover:shadow-lg transition"
                      onClick={() => openModal(action)}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <span className="font-medium text-gray-800 pr-4">{action.description}</span>
                      <button onClick={(e) => { e.stopPropagation(); deleteAction(action.id); }} className="text-red-500 hover:text-red-700 p-1 rounded-full transition flex-shrink-0">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    
                    {/* Progress bar and status */}
                    <div className="flex items-center space-x-4">
                        <div className="flex-1">
                            <div className="w-full bg-gray-300 rounded-full h-2.5">
                                <div className="h-2.5 rounded-full transition-all duration-500" style={{ width: `${percent}%`, backgroundColor: percent === 100 ? '#10B981' : (percent > 0 ? '#F59E0B' : '#EF4444') }}></div>
                            </div>
                        </div>
                        <div className="text-sm font-bold w-10 text-right text-gray-700">{percent}%</div>
                        <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 shadow-md" style={{ backgroundColor: bgColor }}>
                            {icon}
                        </div>
                    </div>

                    <div className="flex justify-between items-center mt-3 border-t pt-2">
                        <span className="text-xs text-gray-400">
                            {action.steps?.length || 0} Steps | Click to view details
                        </span>
                        <span className="text-xs text-blue-500 font-medium hover:underline">
                            Last Update: {timeConverter(action.lastUpdated)}
                        </span>
                    </div>
                  </div>
                );
            })}
          </div>
      )}
    </div>
  );
};

const DrawingCard = ({ drawing, scope, updateScopeData, isLeadAbatement, relatedScopes }) => {
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(drawing.name);
  const [selectedAction, setSelectedAction] = useState(null);
  // NEW STATE for holding temporary Base64 string for display only
  const [localImageUrl, setLocalImageUrl] = useState(null); 

  const status = useMemo(() => getDrawingStatus(drawing.actions), [drawing.actions]);

  let statusIcon, statusText;
  switch (status) {
    case 'green':
      statusIcon = <CheckCircle className="w-8 h-8 text-green-500" />;
      statusText = 'Complete';
      break;
    case 'yellow':
      statusIcon = <Clock className="w-8 h-8 text-yellow-500" />;
      statusText = 'In Progress';
      break;
    case 'red':
    default:
      statusIcon = <XCircle className="w-8 h-8 text-red-500" />;
      statusText = 'Not Started';
  }

  const handleRename = () => {
    if (newName.trim() && newName !== drawing.name) {
        const newDrawings = scope.drawings.map(d => 
            d.id === drawing.id ? { ...d, name: newName.trim() } : d
        );
        updateScopeData(scope.id, { ...scope, drawings: newDrawings });
    }
    setIsRenaming(false);
  };

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (file && file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (event) => {
            // DO NOT update Firestore data here. Only update local state for display.
            setLocalImageUrl(event.target.result); 
        };
        reader.readAsDataURL(file);
    }
  };

  const handleRelatedScopeChange = (e) => {
    const newRelatedScopeId = e.target.value;
    const newDrawings = scope.drawings.map(d => 
        d.id === drawing.id ? { ...d, relatedScopeId: newRelatedScopeId } : d
    );
    updateScopeData(scope.id, { ...scope, drawings: newDrawings });
  };
  
  // Use local state if an image was just uploaded, otherwise use the (empty) persisted URL
  const imageSource = localImageUrl || drawing.imageUrl; 

  return (
    <div className={`border-4 rounded-xl shadow-xl transition-all duration-300 ${getStatusBorder(status)} bg-white p-6`}>
      {/* Action Modal is only rendered for non-abatement scopes */}
      {selectedAction && !isLeadAbatement && (
          <ActionModal
              action={selectedAction}
              scope={scope}
              drawing={drawing}
              onClose={() => setSelectedAction(null)}
              updateScopeData={updateScopeData}
          />
      )}

      {/* Header Row */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 pb-4 border-b border-gray-200">
        <div className="flex items-center space-x-3 mb-2 sm:mb-0">
          <div className="w-10 h-10 flex-shrink-0">{statusIcon}</div>
          <div className="flex items-center">
            {isRenaming ? (
                <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onBlur={handleRename}
                    onKeyDown={(e) => e.key === 'Enter' && handleRename()}
                    className="text-2xl font-bold text-gray-800 border-b border-blue-500 focus:outline-none bg-gray-50 p-1 rounded"
                    autoFocus
                />
            ) : (
                <h3 className="text-2xl font-bold text-gray-800">{drawing.name}</h3>
            )}
            <button 
                onClick={() => setIsRenaming(true)} 
                className="ml-2 text-gray-400 hover:text-blue-600 transition p-1 rounded-full"
                title="Rename Part"
            >
                <Edit className="w-5 h-5"/>
            </button>
          </div>
        </div>
        <div className={`text-sm font-bold p-2 px-4 rounded-full min-w-[120px] text-center shadow-inner border ${getStatusColor(statusText)}`}>
          {statusText}
        </div>
      </div>

      {/* Related Scope Identifier (ONLY for Lead Abatement) */}
      {isLeadAbatement && (
          <div className="mt-4 mb-6 p-4 bg-indigo-50 rounded-xl border border-indigo-300 shadow-inner">
              <label htmlFor={`related-scope-${drawing.id}`} className="text-sm font-semibold text-indigo-700 block mb-2">
                  Relates to Scope:
              </label>
              <div className="relative">
                  <select
                      id={`related-scope-${drawing.id}`}
                      value={drawing.relatedScopeId || 'N/A'}
                      onChange={handleRelatedScopeChange}
                      className="appearance-none block w-full py-2 pl-3 pr-10 text-sm border rounded-lg focus:ring-blue-500 focus:border-blue-500 cursor-pointer bg-white shadow-sm"
                  >
                      <option value="N/A" disabled>Select Related Scope</option>
                      {relatedScopes.map(name => {
                          const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
                          return <option key={id} value={id}>{name}</option>;
                      })}
                  </select>
                  <ChevronDown className="pointer-events-none w-4 h-4 absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-600"/>
              </div>
              <p className='text-xs text-indigo-500 mt-1'>Links this abatement item to the modification scope it is supporting.</p>
          </div>
      )}


      {/* Drawing Placeholder and Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Image/Upload Section - 1/3 width on desktop */}
        <div className="lg:col-span-1 p-4 rounded-xl flex flex-col items-center justify-center border-dashed border-2 min-h-[180px] overflow-hidden transition" 
             style={{ borderColor: getStatusBorder(status).replace('border-', '#') }}
        >
            <input
                type="file"
                accept="image/jpeg"
                onChange={handleImageUpload}
                id={`part-image-upload-${drawing.id}`}
                className="hidden"
            />
            {imageSource ? (
                <>
                <img src={imageSource} alt="Part Visual" className="w-full h-full object-contain rounded-lg" />
                <label htmlFor={`part-image-upload-${drawing.id}`} className="mt-2 w-full text-center cursor-pointer text-sm font-medium text-blue-600 p-2 border-t border-gray-100 hover:text-blue-700 transition">
                    Click to Replace Image
                </label>
                </>
            ) : (
                <label htmlFor={`part-image-upload-${drawing.id}`} className="cursor-pointer text-gray-500 text-center text-sm p-4 w-full h-full flex flex-col items-center justify-center hover:bg-gray-100 transition">
                    <Upload className="w-6 h-6 mb-2 text-gray-400"/>
                    <span className='font-semibold'>Upload Part Image (JPG)</span>
                    <p className={`mt-2 text-xs font-mono p-1 rounded ${getStatusColor(statusText)} border`}>
                        Status: {statusText}
                    </p>
                </label>
            )}
            
            {/* Display local-only warning clearly */}
             {(localImageUrl || drawing.imageUrl) && (
                <p className="text-xs text-red-500 mt-2 p-1 bg-white/70 rounded-md text-center font-semibold">
                    Image is temporary (local-only).
                </p>
            )}

        </div>

        {/* Action Section - 2/3 width on desktop */}
        <div className="lg:col-span-2">
          <button
            onClick={() => setIsActionsOpen(!isActionsOpen)}
            className="w-full bg-gray-100 text-gray-700 p-3 rounded-xl font-semibold hover:bg-gray-200 transition duration-150 flex justify-between items-center mb-4 shadow-md border"
          >
            {drawing.actions.length} Action Items {status === 'green' ? '(All Complete)' : `(Progress: ${Math.round(drawing.actions.reduce((acc, a) => acc + calculatePercentFromSteps(a.steps), 0) / drawing.actions.length)}%)`}
            {isActionsOpen ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
          </button>
          {isActionsOpen && (
            <ActionList 
              drawing={drawing} 
              scope={scope} 
              updateScopeData={updateScopeData} 
              openModal={setSelectedAction} 
              isAbatement={isLeadAbatement} // Pass flag down
            />
          )}
        </div>
      </div>
    </div>
  );
};

const ScopePage = ({ scope, updateScopeData, allScopes }) => {
  if (!scope) return <div className="p-4 text-center text-gray-500">Scope data not found.</div>;
  
  // Determine if this is the Lead Abatement page
  const isLeadAbatement = scope.id === LEAD_ABATEMENT_ID;
  const partsTitle = isLeadAbatement ? 'Things needing Abating' : 'Parts Tracking';
  const relatedScopes = OTHER_SCOPES; // List of scopes excluding Lead Abatement

  const addNewDrawing = () => {
    const defaultDrawingName = `${scope.title.substring(0, 4)}-PART-NEW-${Math.floor(Math.random() * 100)}`;
    const newDrawing = {
      id: crypto.randomUUID(),
      name: defaultDrawingName,
      description: 'Newly added part or document for scope tracking',
      imageUrl: '',
      relatedScopeId: null, // Ensure new items have this field
      actions: [
        { 
            id: crypto.randomUUID(), 
            description: 'Define Scope of Work', 
            percentComplete: 0, 
            notes: '', 
            // New items in abatement scopes start with one step
            steps: [{ id: crypto.randomUUID(), description: isLeadAbatement ? 'Abatement Action Complete?' : 'Review required permits', isComplete: false }],
            imageAttachment: null,
            lastUpdated: new Date() 
        },
      ]
    };
    const updatedScope = { ...scope, drawings: [...scope.drawings, newDrawing] };
    updateScopeData(scope.id, updatedScope);
  };
  
  // --- EXPORT FUNCTIONALITY (Print to PDF) ---
  const handleExport = useCallback(() => {
    const reportTitle = `${scope.title} - Progress Report (${new Date().toLocaleDateString()})`;
    
    // Generate HTML for all drawings
    const drawingsHtml = scope.drawings.map(drawing => {
        const status = getDrawingStatus(drawing.actions);
        const statusText = status === 'green' ? 'Complete' : (status === 'yellow' ? 'In Progress' : 'Not Started');
        const statusColor = status === 'green' ? 'green' : (status === 'yellow' ? 'orange' : 'red');
        
        // Calculate part completion percentage
        const actions = drawing.actions || [];
        const totalActionPercent = actions.reduce((acc, a) => acc + calculatePercentFromSteps(a.steps), 0);
        const partCompletion = actions.length > 0 ? Math.round(totalActionPercent / actions.length) : 0;

        const actionItems = actions.map(action => {
            const percent = calculatePercentFromSteps(action.steps);
            return `
                <li style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px dotted #ccc;">
                    <span style="flex-grow: 1;">${action.description}</span>
                    <span style="font-weight: bold; color: ${percent === 100 ? 'green' : (percent > 0 ? 'orange' : 'red')};">${percent}%</span>
                </li>
            `;
        }).join('');

        // Use a placeholder image if imageSource is not available
        // NOTE: We rely on the current browser session's memory (localImageUrl) or the placeholder.
        const imageHtml = drawing.imageUrl ? `<img src="${drawing.imageUrl}" style="max-width: 100%; height: auto; border-radius: 8px;">` : 
            `<div style="width: 100%; height: 150px; background: #eee; border: 1px dashed #aaa; display: flex; align-items: center; justify-content: center; color: #555; border-radius: 8px; font-size: 0.9em; text-align: center;">No Image Uploaded</div>`;

        return `
            <div style="border: 2px solid ${statusColor}; padding: 20px; margin-bottom: 30px; border-radius: 12px; background: #f9f9f9; page-break-inside: avoid;">
                <h4 style="font-size: 1.4em; font-weight: bold; margin-top: 0; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; color: #1f2937;">
                    ${drawing.name}
                    <span style="font-size: 0.9em; font-weight: bold; padding: 5px 10px; border-radius: 15px; color: white; background-color: ${statusColor};">${statusText}</span>
                </h4>
                
                <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 25px;">
                    <div style="min-width: 150px; display: flex; flex-direction: column; align-items: center;">
                        <p style="font-size: 1.1em; font-weight: bold; color: ${partCompletion === 100 ? 'green' : (partCompletion > 0 ? 'orange' : 'red')}; margin-bottom: 5px;">${partCompletion}% Complete</p>
                        ${imageHtml}
                    </div>
                    <div>
                        <p style="font-weight: bold; margin-top: 0; margin-bottom: 10px; font-size: 1.1em; border-bottom: 1px solid #ddd;">Action Items (${actions.length}):</p>
                        <ul style="list-style: none; padding: 0;">
                            ${actionItems}
                        </ul>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // 2. Construct HTML for Print Window
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>${reportTitle}</title>
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
                body { font-family: 'Inter', sans-serif; padding: 30px; margin: 0; color: #333; line-height: 1.4; }
                h1 { color: #1f2937; border-bottom: 4px solid #10B981; padding-bottom: 15px; margin-bottom: 30px; font-size: 2.2em; font-weight: 800; }
                /* Layout for grid in print */
                div[style*="grid-template-columns"] {
                    display: grid;
                    grid-template-columns: 1fr 2fr;
                }
                @media print {
                    .no-print { display: none; }
                }
                /* Ensures images load and are styled correctly */
                img { max-width: 100%; height: auto; display: block; }
            </style>
        </head>
        <body>
            <h1>${scope.title} Parts Tracking Report</h1>
            ${drawingsHtml}
            <div style="margin-top: 40px; font-size: 0.8em; color: #666; border-top: 1px solid #ccc; padding-top: 10px;">
                Report generated by MCR4 TMODs Progress Tracker on ${new Date().toLocaleString()}.
            </div>
            <script>
                // This timeout gives the browser time to render any large Base64 image data 
                // that might be present in the dynamic HTML before printing is initiated.
                window.onload = function() {
                    setTimeout(() => {
                        window.print();
                        setTimeout(() => window.close(), 100); 
                    }, 500); // 500ms delay
                }
            </script>
        </body>
        </html>
    `);
    printWindow.document.close();
  }, [scope]);

  return (
    <div className="p-4 sm:p-6 bg-gray-50 min-h-screen pt-24"> {/* Main content padding for header clearance */}
      
      {/* Prerequisite Section */}
      {!isLeadAbatement && <PrereqSection scope={scope} updateScopeData={updateScopeData} allScopes={allScopes} />}

      <section className="mt-8">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-gray-800">
            {partsTitle}
          </h2>
          {/* Grouped Action Buttons */}
          <div className="flex space-x-3">
            <button
              onClick={handleExport}
              className="bg-purple-600 text-white p-3 rounded-xl font-bold hover:bg-purple-700 transition shadow-lg flex items-center text-sm"
              title="Export Scope Data as PDF"
            >
              <Download className="w-5 h-5 mr-2" /> Export Report (PDF)
            </button>
            <button
              onClick={addNewDrawing}
              className="bg-green-600 text-white p-2 rounded-xl shadow-lg hover:bg-green-700 transition"
              title={`Add New ${isLeadAbatement ? 'Abatement Item' : 'Part'}`}
            >
              <Plus className="w-5 h-5" />
            </button>
          </div>
        </div>
        
        <div className="space-y-8">
          {scope.drawings.map((drawing) => (
            <DrawingCard
              key={drawing.id}
              drawing={drawing}
              scope={scope}
              updateScopeData={updateScopeData}
              isLeadAbatement={isLeadAbatement} 
              relatedScopes={relatedScopes}
            />
          ))}
          {scope.drawings.length === 0 && (
            <p className="text-center text-gray-500 p-10 border border-dashed border-gray-300 rounded-xl bg-white shadow-md">
              {`No ${partsTitle.toLowerCase()} added yet. Click the '+' button to start tracking.`}
            </p>
          )}
        </div>
      </section>
    </div>
  );
};

const SummaryPage = ({ scopes, setCurrentPage }) => {
  const summaryData = useMemo(() => {
    const allDrawings = Object.values(scopes).flatMap(scope => scope.drawings || []);
    const totalDrawings = allDrawings.length;
    let totalActionsSteps = 0;
    let completedActionsSteps = 0;

    // Calculate total steps across all scopes
    allDrawings.forEach(drawing => {
      drawing.actions.forEach(action => {
          totalActionsSteps += action.steps?.length || 0;
          completedActionsSteps += (action.steps || []).filter(s => s.isComplete).length;
      });
    });
    
    // Calculate Project Completion based on number of parts fully complete (using Part Status Logic)
    let completePartCount = 0;
    allDrawings.forEach(drawing => {
        if (getDrawingStatus(drawing.actions) === 'green') {
            completePartCount++;
        }
    });

    const completionRate = totalDrawings > 0 ? (completePartCount / totalDrawings) * 100 : 0;
    const actionCompletionRate = totalActionsSteps > 0 ? (completedActionsSteps / totalActionsSteps) * 100 : 0;

    return {
      completionRate,
      actionCompletionRate,
    };
  }, [scopes]);

  const sortedScopes = useMemo(() => {
    return Object.values(scopes).sort((a, b) => {
      const aDrawings = a.drawings || [];
      const bDrawings = b.drawings || [];
      // Calculate overall status for sorting by severity (Red > Yellow > Green)
      const aStatus = getDrawingStatus(aDrawings.flatMap(d => d.actions));
      const bStatus = getDrawingStatus(bDrawings.flatMap(d => d.actions));

      const statusOrder = { red: 3, yellow: 2, green: 1 };
      return statusOrder[bStatus] - statusOrder[aStatus];
    });
  }, [scopes]);
  
  // New smaller ring component for the breakdown section
  const MiniProgressRing = ({ percentage }) => {
    const radius = 15;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (percentage / 100) * circumference;
    const color = percentage === 100 ? 'text-green-600' : (percentage > 0 ? 'text-yellow-500' : 'text-red-500');

    return (
        <div className="relative w-12 h-12 flex items-center justify-center flex-shrink-0">
            <svg className="w-full h-full transform -rotate-90">
                <circle
                    className="text-gray-300"
                    strokeWidth="3"
                    stroke="currentColor"
                    fill="transparent"
                    r={radius}
                    cx="50%"
                    cy="50%"
                />
                <circle
                    className={color}
                    strokeWidth="3"
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    strokeLinecap="round"
                    stroke="currentColor"
                    fill="transparent"
                    r={radius}
                    cx="50%"
                    cy="50%"
                />
            </svg>
            <span className="absolute text-[10px] font-bold text-gray-800">{percentage}%</span>
        </div>
    );
  };


  const ProgressRing = ({ percentage, color, label }) => {
    const radius = 50;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (percentage / 100) * circumference;

    return (
      <div className="relative w-32 h-32 flex items-center justify-center">
        <svg className="w-full h-full transform -rotate-90">
          <circle
            className="text-gray-300"
            strokeWidth="8"
            stroke="currentColor"
            fill="transparent"
            r={radius}
            cx="50%"
            cy="50%"
          />
          <circle
            className={color}
            strokeWidth="8"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            stroke="currentColor"
            fill="transparent"
            r={radius}
            cx="50%"
            cy="50%"
          />
        </svg>
        <div className="absolute flex flex-col items-center">
          <span className="text-2xl font-extrabold text-gray-800">{Math.round(percentage)}%</span>
          <span className="text-xs text-gray-500">{label}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="p-4 sm:p-8 bg-gray-50 min-h-screen pt-24"> {/* Increased padding-top for header clearance */}
      <h2 className="text-3xl font-extrabold text-gray-900 mb-8 border-b border-gray-300 pb-3">Overall Project Status</h2>

      <div className="flex flex-col sm:flex-row justify-center items-center space-y-6 sm:space-y-0 sm:space-x-12 mb-12 p-8 bg-white rounded-2xl shadow-xl">
        <ProgressRing percentage={summaryData.completionRate} color="text-green-500" label="TMODs completion" />
        <ProgressRing percentage={summaryData.actionCompletionRate} color="text-blue-600" label="Action Item Progress" />
      </div>

      <h2 className="text-2xl font-extrabold text-gray-800 mb-6 border-b pb-2">Scope Breakdown</h2>
      <div className="space-y-4">
        {sortedScopes.map(scope => {
          const drawingCount = scope.drawings?.length || 0;
          
          // Calculate average completion rate for the scope
          let scopeCompletionRate = 0;
          if (drawingCount > 0) {
              const totalPartCompletion = scope.drawings.reduce((sum, d) => {
                  // Calculate average action completion for the part
                  const actions = d.actions || [];
                  if (actions.length === 0) return sum + 0;
                  
                  const totalActionPercent = actions.reduce((acc, a) => acc + calculatePercentFromSteps(a.steps), 0);
                  return sum + (totalActionPercent / actions.length);
              }, 0);
              scopeCompletionRate = Math.round(totalPartCompletion / drawingCount);
          }
          
          const status = getDrawingStatus(scope.drawings?.flatMap(d => d.actions));
          let statusColor = 'bg-gray-100';

          if (drawingCount > 0) {
            if (status === 'green') statusColor = 'bg-green-50 border-green-400';
            else if (status === 'yellow') statusColor = 'bg-yellow-50 border-yellow-400';
            else statusColor = 'bg-red-50 border-red-400';
          }

          return (
            <div 
              key={scope.id} 
              onClick={() => setCurrentPage(scope.title)} // Make clickable for navigation
              className={`p-5 rounded-2xl shadow-md border-l-8 ${statusColor} flex justify-between items-center transition hover:shadow-lg hover:border-l-[12px] cursor-pointer`}
            >
              <h3 className="text-xl font-bold text-gray-800">{scope.title}</h3>
              
              <div className="flex items-center space-x-6">
                <div className="text-right hidden sm:block">
                  <p className="text-sm font-semibold text-gray-600">{drawingCount} Parts</p>
                  <p className={`text-xs font-bold ${scopeCompletionRate === 100 ? 'text-green-600' : (scopeCompletionRate > 0 ? 'text-yellow-600' : 'text-red-600')}`}>
                    {scopeCompletionRate === 100 ? 'Complete' : (scopeCompletionRate > 0 ? 'In Progress' : 'Not Started')}
                  </p>
                </div>
                <MiniProgressRing percentage={scopeCompletionRate} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};


const App = () => {
  const NAV_ITEMS = ['MCR4 TMODs Summary', ...SCOPE_NAMES];
  const [currentPage, setCurrentPage] = useState(NAV_ITEMS[0]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const { scopes, userId, isLoading, error, updateScopeData } = useFirebase();

  const toggleSidebar = () => setIsSidebarOpen(!isSidebarOpen);

  const currentTitle = currentPage === 'MCR4 TMODs Summary' ? currentPage : `TMOD: ${currentPage}`;
  const currentScopeId = currentPage === 'MCR4 TMODs Summary' ? null : currentPage.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const currentScope = currentScopeId ? scopes[currentScopeId] : null;

  // Logging for debugging the user's issue
  useEffect(() => {
    if (isLoading) {
      console.log("APP STATUS: Global Loading...");
    } else if (NAV_ITEMS.includes(currentPage) && !currentScope) {
      console.log(`APP STATUS: Waiting for specific scope data: ${currentPage} (Scopes count: ${Object.keys(scopes).length})`);
    } else if (!isLoading && userId) {
      console.log("APP STATUS: Loaded successfully.");
    }
  }, [isLoading, userId, currentPage, currentScope, scopes]);

  // Handle Loading/Error States
  let content;
  if (error) {
    content = <div className="p-4 pt-20 text-center text-red-600 bg-red-50 min-h-screen"><p className="font-bold">Error:</p><p className="break-words">{error}</p></div>;
  } else if (isLoading || !userId) {
    content = (
      <div className="flex flex-col items-center justify-center min-h-screen text-gray-600">
        <Loader className="w-10 h-10 animate-spin text-blue-600" />
        <p className="mt-4 text-lg font-medium">Loading Project Data...</p>
        <p className="text-sm">Connecting to real-time database.</p>
      </div>
    );
  } else if (currentPage === 'MCR4 TMODs Summary') {
    content = <SummaryPage scopes={scopes} setCurrentPage={setCurrentPage} />;
  } else if (currentScope) {
    // Pass the entire scopes object to ScopePage for cross-reference lookups
    content = <ScopePage scope={currentScope} updateScopeData={updateScopeData} allScopes={scopes} />;
  } else if (NAV_ITEMS.includes(currentPage)) {
      // If a valid navigation item is selected, but the data hasn't fully loaded yet (i.e. currentScope is missing).
      content = (
          <div className="p-4 pt-20 text-center text-gray-500 min-h-screen">
              <Loader className="w-8 h-8 mx-auto mb-3 animate-spin text-blue-500" />
              <p className="font-semibold">Loading scope data or initializing...</p>
              <p className="text-sm">If this persists, check the console for Firebase errors.</p>
          </div>
      );
  } else {
    // Fallback for an unselected or non-existent page
    content = <div className="p-4 pt-20 text-center text-gray-500">Select a scope from the menu to view progress.</div>;
  }

  return (
    <div className="font-sans antialiased bg-gray-50 min-h-screen">
      <style>{`
        /* Custom Styles for Checkbox - ensuring good visibility */
        input[type="checkbox"]:checked {
            background-color: #10B981; /* Green checkmark */
            border-color: #10B981;
        }

      `}</style>
      <Header currentTitle={currentTitle} toggleSidebar={toggleSidebar} />
      <Sidebar
        isOpen={isSidebarOpen}
        toggleSidebar={toggleSidebar}
        navItems={NAV_ITEMS}
        currentPage={currentPage}
        setCurrentPage={setCurrentPage}
        userId={userId}
      />
      <main className="transition-all duration-300">
        {content}
      </main>
    </div>
  );
};

export default App;
